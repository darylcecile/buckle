import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Agent, Container, factory, Instruction, Model, Reference, SessionContext, Skill, Stage, Supervisor, Workflow } from "../dist/index.js";

test("agent overrides preserve the original configuration and model metadata", () => {
	const model = new Model("github", "test-model", { variant: "high" });
	const skills = [Skill.fromFile("todo")];
	const base = new Agent({ name: "Planner", role: "research", model, skills, mode: "interactive" });
	skills.length = 0;
	const override = base.with({ name: "Developer", role: "developer", skills: ["implementation"] });
	assert.equal(base.options.name, "Planner");
	assert.equal(base.options.skills[0].path, "todo");
	assert.equal(override.options.mode, "interactive");
	assert.deepEqual(override.options.skills, ["implementation"]);
	assert.equal(override.options.model, model);
	assert.equal(model.provider, "github");
	assert.equal(model.id, "test-model");
	assert.equal(model.options.variant, "high");
	assert.equal(new Agent({ name: "Default", role: "research", model }).options.mode, "self-driving");
});

test("write references share data without altering read references or subclass private state", () => {
	class Findings extends SessionContext {
		#details = { count: 0 };
		increment() { return ++this.#details.count; }
		createReference() {
			const reference = new Findings(this.options);
			reference.#details = this.#details;
			return reference;
		}
	}
	const context = new Findings({ description: "Findings" });
	const write = context.expectWrite();
	assert.notEqual(write, context);
	assert.equal(context.writeExpected, false);
	assert.equal(write.writeExpected, true);
	assert.equal(write.id, context.id);
	write.data.set("result", "checked");
	assert.equal(context.data.get("result"), "checked");
	assert.equal(write.increment(), 1);
	assert.equal(context.increment(), 2);
	assert.equal(write.expectWrite().increment(), 3);
});

test("file references stay deferred and resolve conventional paths from an explicit base", async () => {
	const base = fileURLToPath(new URL("../../../example/", import.meta.url));
	const skill = Skill.fromFile("todo");
	const instruction = Instruction.fromFile("checks");
	assert.equal(await skill.load(base), await readFile(`${base}/skills/todo/SKILL.md`, "utf8"));
	assert.equal(await instruction.load(base), await readFile(`${base}/instructions/checks.md`, "utf8"));
	assert.equal(await Instruction.fromFile("workflow.md").load(base), await readFile(`${base}/instructions/workflow.md`, "utf8"));
	assert.equal(await Instruction.fromFile("instructions/checks.md").load(base), await instruction.load(base));
	await assert.rejects(Instruction.fromFile("missing-reference").load(base), { code: "ENOENT" });
	assert.throws(() => skill.load("."), /absolute/);
});

test("supervisor retains optional model and interval metadata independently of the supplied options", () => {
	const model = new Model("github", "test-model", { variant: "xhigh" });
	const options = { model, wakeupInterval: 300_000 };
	const supervisor = new Supervisor(options);
	options.wakeupInterval = 1;
	assert.equal(supervisor.options.model, model);
	assert.equal(supervisor.options.wakeupInterval, 300_000);
	assert.equal(Object.isFrozen(supervisor.options), true);
	assert.deepEqual(new Supervisor({}).options, {});
	assert.deepEqual(new Supervisor({ model }).options, { model });
	assert.equal(new Supervisor({ wakeupInterval: 0 }).options.wakeupInterval, 0);
	assert.equal(new Supervisor({ wakeupInterval: 0.5 }).options.wakeupInterval, 0.5);
	for (const wakeupInterval of [-1, NaN, Infinity, -Infinity]) {
		assert.throws(() => new Supervisor({ wakeupInterval }), RangeError);
	}
});

test("composition retains order, policies, contexts, and lazy callbacks without executing them", () => {
	const context = new SessionContext({});
	const lazy = () => { throw new Error("must remain lazy"); };
	let executions = 0;
	const executor = { async execute({ task }) { executions += 1; return { output: task.title }; } };
	const stage = new Stage({ name: "Review", agents: [], contexts: [context], instruction: "Review", policies: {
		returns: lazy, gates: lazy, permissions: { createNewTasks: true, publishPullRequest: true },
	}, hooks: { beforeAgents: lazy, afterAgents: lazy } });
	const stages = [stage, new Stage({ name: "Done", agents: [], contexts: [], instruction: "Done" })];
	const workflow = new Workflow({ name: "Main", container: new Container.MicroVM({ image: "ubuntu:latest", cpu: 4, memory: "16GB" }),
		instruction: Instruction.fromFile("workflow.md"), policies: { concurrency: 10, maxRetries: 3, learnings: { outcome: "raise" } }, stages });
	stages.reverse();
	const config = factory.define({ executor, supervisor: new Supervisor({}), workflows: [workflow] });
	assert.equal(config.executor, executor);
	assert.equal(executions, 0);
	assert.equal(workflow.options.container.state, "new");
	assert.equal(config.workflows[0].options.stages[0], stage);
	assert.equal(stage.options.contexts[0], context);
	assert.equal(stage.options.hooks.afterAgents, lazy);
	assert.equal(stage.options.policies.permissions.createNewTasks, true);
	assert.equal(stage.options.policies.permissions.publishPullRequest, true);
	assert.equal(workflow.options.policies.maxRetries, 3);
	assert.equal(workflow.options.container.options.memory, "16GB");
});

test("factory definitions require an executor with a callable execute method", () => {
	for (const executor of [undefined, null, {}, { execute: true }]) {
		assert.throws(() => factory.define({ executor, supervisor: new Supervisor({}), workflows: [] }), {
			name: "TypeError", message: "Executor must provide an execute function",
		});
	}
});

test("workflow resolution shares containers across a task's stages and isolates tasks, Review, and defaults", async () => {
	const resources = { image: "alpine:3.22", memory: "512MiB", cpu: 1, name: "workflow-test" };
	const makeStage = (name, container) => new Stage({ name, container, agents: [], contexts: [], instruction: name });
	const main = Reference.create("main");
	const stages = [makeStage("Todo", Container.createOrReuse(main)), makeStage("Implement", Container.createOrReuse(new Reference("main"))),
		makeStage("Review", Container.createOrReuse(new Reference("review"), { ...resources, cpu: 2 })), makeStage("Unbound"), makeStage("Unbound2")];
	const workflow = new Workflow({ name: "Main", container: new Container.MicroVM(resources), instruction: "", policies: {}, stages });
	const taskA = Reference.create("factory-test-task-a");
	const taskB = Reference.create("factory-test-task-b");
	assert.equal(taskA.identity, Reference.create(taskA.name).identity);
	assert.equal(Reference.join(main, taskA).name, "main/factory-test-task-a");
	const vm = workflow.resolveContainer(stages[0], taskA);
	const review = workflow.resolveContainer(stages[2], taskA);
	const fallback = workflow.resolveContainer(stages[3], taskA);
	const otherTask = workflow.resolveContainer(stages[0], taskB);
	const otherFallback = workflow.resolveContainer(stages[3], taskB);
	assert.equal(vm, workflow.resolveContainer(stages[1], taskA));
	assert.equal(otherTask, workflow.resolveContainer(stages[1], taskB));
	assert.notEqual(vm, review);
	assert.notEqual(vm, otherTask);
	assert.notEqual(vm.name, otherTask.name);
	assert.equal(vm.options.image, resources.image);
	assert.equal(review.options.cpu, 2);
	assert.equal(vm.state, "new");
	assert.equal(fallback, workflow.resolveContainer(stages[4], taskA));
	assert.equal(otherFallback, workflow.resolveContainer(stages[4], taskB));
	assert.notEqual(fallback, otherFallback);
	assert.notEqual(fallback, vm);
	assert.notEqual(fallback, workflow.options.container);
	assert.throws(() => workflow.resolveContainer(makeStage("Outsider"), taskA), /belong/);
	await vm.destroy();
	assert.equal(otherTask, workflow.resolveContainer(stages[1], taskB));
	assert.equal(otherTask.state, "new");
	const replacement = workflow.resolveContainer(stages[1], taskA);
	assert.notEqual(replacement, vm);
	assert.notEqual(replacement, otherTask);
	assert.equal(replacement.state, "new");
	await Promise.all([review, fallback, otherTask, otherFallback, replacement].map(container => container.destroy()));
});

test("direct lookups require resources and use separate task and container identity keys", async () => {
	const options = { image: "alpine:3.22", memory: "512MiB", cpu: 1 };
	const lookup = Container.createOrReuse(Reference.create("a/b"));
	assert.throws(() => lookup(Reference.create("c")), /resource options/);
	const first = lookup(Reference.create("c"), options);
	const second = Container.createOrReuse(Reference.create("a"), options)(Reference.create("b/c"));
	assert.notEqual(first, second);
	assert.equal(first, Container.createOrReuse(Reference.create("a/b"))(Reference.create("c")));
	await Promise.all([first.destroy(), second.destroy()]);
});
