import { dirname } from "node:path";
import { Reference, Skill, type Container, type ExecutorHandoff, type FactoryConfig, type Stage, type Task, type Workflow } from "@buckles/factory";
import { errorMessage, type PipelineHost, type TaskOutcome } from "./types.js";

interface RunState {
	handoff?: Readonly<ExecutorHandoff>;
}

async function settleBatch(callback: (() => Promise<void>[]) | undefined): Promise<void> {
	const results = await Promise.allSettled(callback?.() ?? []);
	const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
	if (errors.length) throw new AggregateError(errors, "Hook or gate failed");
}

async function instructionText(instruction: Workflow["options"]["instruction"], directory: string): Promise<string> {
	return typeof instruction === "string" ? instruction : instruction.load(directory);
}

async function runStage(config: FactoryConfig, workflow: Workflow, stage: Stage, task: Task,
	container: Container.MicroVM, directory: string, attempt: number, host: PipelineHost, state: RunState): Promise<Stage | undefined> {
	const progress = (activity: string, agent = "") => host.progress({ stage: stage.options.name, agent, attempt, activity });
	const phase = async (name: string, callback: (() => Promise<void>[]) | undefined) => {
		host.signal.throwIfAborted();
		progress(name);
		await settleBatch(callback);
		host.signal.throwIfAborted();
	};
	await phase("beforeAgents", stage.options.hooks?.beforeAgents);
	const shared = await Promise.all([
		instructionText(workflow.options.instruction, directory),
		instructionText(stage.options.instruction, directory),
	]);
	for (const agent of stage.options.agents) {
		host.signal.throwIfAborted();
		progress("Executing", agent.options.name);
		const skills = await Promise.all(agent.options.skills.map(skill =>
			(typeof skill === "string" ? Skill.fromFile(skill) : skill).load(directory)));
		host.signal.throwIfAborted();
		const result = await config.executor.execute({
			task, agent, workflow, stage, container, contexts: stage.options.contexts,
			handoff: state.handoff,
			instructions: [...shared, ...skills].join("\n\n"), signal: host.signal,
			report: message => host.report(message),
			ask: async question => {
				host.signal.throwIfAborted();
				if (agent.options.mode !== "interactive") throw new Error("Only interactive agents may ask questions");
				return host.ask(question);
			},
			createTask: async input => {
				host.signal.throwIfAborted();
				if (!stage.options.policies?.permissions?.createNewTasks) throw new Error("Stage may not create tasks");
				return host.createTask(input);
			},
		});
		if (result?.output !== undefined) {
			state.handoff = Object.freeze({ stage: stage.options.name, agent: agent.options.name, attempt, output: result.output });
			host.output({ stage: stage.options.name, agent: agent.options.name, attempt, text: result.output });
		}
		host.signal.throwIfAborted();
		if (result?.returnTo) {
			const target = result.returnTo;
			if (!workflow.options.stages.includes(target) || !stage.options.policies?.returns?.().includes(target)) {
				throw new Error(`Stage ${stage.options.name} requested an undeclared return target`);
			}
			return target;
		}
	}
	await phase("gates", stage.options.policies?.gates);
	await phase("afterAgents", stage.options.hooks?.afterAgents);
}

/** Runs ordered agents and all-settled hooks/gates; never automatically retries a failed side effect. */
export async function runPipeline(config: FactoryConfig, task: Readonly<Task>, file: string, host: PipelineHost): Promise<TaskOutcome> {
	const containers = new Set<Container.MicroVM>();
	const outcome: TaskOutcome = { state: "completed", cleanupErrors: [] };
	let finishedStages = false;
	try {
		const workflow = config.workflows.find(candidate => candidate.options.name === task.workflow);
		if (!workflow) throw new Error(`Unknown workflow: ${task.workflow}`);
		const reference = new Reference(`buckles/task/${task.id}`);
		const state: RunState = {};
		const visits = new Map<Stage, number>();
		let returns = 0;
		let index = 0;
		while (index < workflow.options.stages.length) {
			host.signal.throwIfAborted();
			const stage = workflow.options.stages[index]!;
			const attempt = (visits.get(stage) ?? 0) + 1;
			visits.set(stage, attempt);
			const container = workflow.resolveContainer(stage, reference);
			containers.add(container);
			const target = await runStage(config, workflow, stage, task, container, dirname(file), attempt, host, state);
			if (target) {
				if (++returns > (workflow.options.policies.maxRetries ?? 2)) throw new Error("Workflow return limit (maxRetries) exceeded");
				index = workflow.options.stages.indexOf(target);
			} else index++;
		}
		finishedStages = true;
	} catch (error) {
		outcome.state = host.signal.aborted ? "cancelled" : "failed";
		outcome.error = errorMessage(error);
	} finally {
		const resolved = [...containers];
		const results = await Promise.allSettled(resolved.map(container => container.destroy()));
		for (const [index, result] of results.entries()) {
			if (result.status !== "rejected") continue;
			const container = resolved[index]!;
			outcome.cleanupErrors.push(`${container.name} (${container.id ?? "unstarted"}): ${errorMessage(result.reason)}`);
		}
		if (outcome.cleanupErrors.length) {
			outcome.state = "failed";
			outcome.error = [outcome.error, `Cleanup failed: ${outcome.cleanupErrors.join("; ")}`].filter(Boolean).join("; ");
		} else if (!finishedStages && host.signal.aborted) outcome.state = "cancelled";
	}
	return outcome;
}
