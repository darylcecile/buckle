import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent, Container, factory, Instruction, Model, SessionContext, Stage, Supervisor, Workflow } from "@buckles/factory";
import { resolveFactoryPath, runPipeline, validateFactory } from "../dist/index.js";

const agent = new Agent({ name: "Builder", role: "build", model: new Model("test", "fake", { variant: "test" }), mode: "interactive" });
const resource = () => new Container.MicroVM({ image: "test", cpu: 1, memory: "128MiB" });
const stage = options => new Stage({ name: "Build", agents: [agent], contexts: [], instruction: "Stage prompt", ...options });
const configFor = (stages, execute, policies = {}) => factory.define({ executor: { execute }, supervisor: new Supervisor({}), workflows: [
	new Workflow({ name: "Main", container: resource(), instruction: "Workflow prompt", policies, stages }),
] });
const task = () => Object.freeze({ id: randomUUID(), title: "A real task", description: "Details", workflow: "Main" });
const host = (overrides = {}) => ({ signal: new AbortController().signal, progress() {}, report() {}, output() {},
	async ask() { return "approved"; }, async createTask() { return "new-id"; }, ...overrides });

test("factory path defaults prefer factory.ts and retain the example fallback and explicit override", async () => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "buckles-path-")));
	const previous = process.cwd();
	try {
		await mkdir(join(directory, "example"));
		await writeFile(join(directory, "example", "factory.ts"), "");
		process.chdir(directory);
		assert.equal(await resolveFactoryPath(), join(directory, "example", "factory.ts"));
		await writeFile(join(directory, "factory.ts"), "");
		assert.equal(await resolveFactoryPath(), join(directory, "factory.ts"));
		assert.equal(await resolveFactoryPath("example/factory.ts"), join(directory, "example", "factory.ts"));
	} finally {
		process.chdir(previous);
		await rm(directory, { recursive: true, force: true });
	}
});

test("pipeline resolves prompt files, shares contexts/VM across returns, and gates mutations", async () => {
	const directory = await mkdtemp(join(tmpdir(), "buckles-prompts-"));
	try {
		await mkdir(join(directory, "instructions"));
		await mkdir(join(directory, "skills", "build"), { recursive: true });
		await writeFile(join(directory, "instructions", "stage.md"), "Loaded stage");
		await writeFile(join(directory, "skills", "build", "SKILL.md"), "Loaded skill");
		const context = new SessionContext({});
		const sequence = [];
		const outputs = [];
		const containers = [];
		let executions = 0;
		const build = stage({ agents: [agent.with({ skills: ["build"] })], contexts: [context.expectWrite()], instruction: Instruction.fromFile("stage"),
			hooks: { beforeAgents: () => [Promise.resolve().then(() => { sequence.push("prepare"); context.data.set("ready", true); })],
				afterAgents: () => [Promise.resolve().then(() => sequence.push("mutation"))] },
			policies: { gates: () => [Promise.resolve().then(() => sequence.push("gate"))], returns: () => [build] },
		});
		const config = configFor([build], async request => {
			sequence.push("agent");
			executions++;
			containers.push(request.container);
			assert.equal(request.contexts[0].data.get("ready"), true);
			assert.equal(request.instructions, "Workflow prompt\n\nLoaded stage\n\nLoaded skill");
			assert.equal(request.task.description, "Details");
			assert.deepEqual(request.handoff, executions === 1 ? undefined : {
				stage: "Build", agent: "Builder", attempt: 1, output: "Needs revision",
			});
			return executions === 1 ? { returnTo: build, output: "Needs revision" } : { output: "Finished" };
		}, { maxRetries: 1 });
		const result = await runPipeline(config, task(), join(directory, "factory.ts"), host({ output: output => outputs.push(output) }));
		assert.equal(result.state, "completed");
		assert.deepEqual(sequence, ["prepare", "agent", "prepare", "agent", "gate", "mutation"]);
		assert.equal(containers[0], containers[1]);
		assert.equal(containers[0].state, "destroyed");
		assert.deepEqual(outputs.map(output => [output.attempt, output.text]), [[1, "Needs revision"], [2, "Finished"]]);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("pipeline hands off outputs across agents, stages, and Checks returns without sharing findings contexts", async () => {
	const findings = new SessionContext({ description: "Checks findings" });
	const recorder = agent.with({ name: "Recorder" });
	const checker = agent.with({ name: "Checker" });
	const implementation = stage({ name: "Implementation", agents: [agent, recorder] });
	const checks = stage({ name: "Checks", agents: [checker], contexts: [findings.expectWrite()],
		policies: { returns: () => [implementation] } });
	const done = stage({ name: "Done" });
	const initial = { stage: "Implementation", agent: "Builder", attempt: 1, output: "Implemented the planned change at abc123" };
	const failed = { stage: "Checks", agent: "Checker", attempt: 1, output: "typecheck failed at abc123: missing handoff type. Add the type and rerun typecheck." };
	const corrected = { stage: "Implementation", agent: "Builder", attempt: 2, output: "Added the missing handoff type at def456" };
	const passed = { stage: "Checks", agent: "Checker", attempt: 2, output: "typecheck passed at def456" };
	const received = [];
	const outputs = [];
	let implementationVisits = 0;
	let checksVisits = 0;
	const config = configFor([implementation, checks, done], async request => {
		received.push([request.stage.options.name, request.agent.options.name, request.handoff]);
		if (request.stage === implementation) {
			assert.deepEqual(request.contexts, []);
			if (request.agent === recorder) return;
			implementationVisits++;
			return { output: implementationVisits === 1 ? initial.output : corrected.output };
		}
		if (request.stage === checks) {
			checksVisits++;
			const output = checksVisits === 1 ? failed.output : passed.output;
			request.contexts[0].data.set("summary", output);
			return checksVisits === 1 ? { output, returnTo: implementation } : { output };
		}
	}, { maxRetries: 1 });
	const result = await runPipeline(config, task(), "/tmp/factory.ts", host({ output: output => outputs.push(output) }));
	assert.equal(result.state, "completed");
	assert.deepEqual(received, [
		["Implementation", "Builder", undefined],
		["Implementation", "Recorder", initial],
		["Checks", "Checker", initial],
		["Implementation", "Builder", failed],
		["Implementation", "Recorder", corrected],
		["Checks", "Checker", corrected],
		["Done", "Builder", passed],
	]);
	assert.deepEqual(outputs, [initial, failed, corrected, passed].map(({ output, ...sender }) => ({ ...sender, text: output })));
});

test("failed gate awaits its entire batch, skips mutations, and fails without retrying", async () => {
	let release;
	const slowGate = new Promise(resolve => { release = resolve; });
	let gateStarted;
	const enteredGate = new Promise(resolve => { gateStarted = resolve; });
	let mutation = false;
	let executions = 0;
	let container;
	const config = configFor([stage({ policies: { gates: () => { gateStarted(); return [Promise.reject(new Error("gate rejected")), slowGate]; } },
		hooks: { afterAgents: () => { mutation = true; return []; } } })], async request => { container = request.container; executions++; });
	const running = runPipeline(config, task(), "/tmp/factory.ts", host());
	await enteredGate;
	assert.equal(container.state, "new");
	assert.equal(mutation, false);
	release();
	const outcome = await running;
	assert.equal(outcome.state, "failed");
	assert.match(outcome.error, /gate rejected/);
	assert.equal(container.state, "destroyed");
	assert.equal(executions, 1);
	assert.equal(mutation, false);
});

test("zero return budget and undeclared target identities fail explicitly", async () => {
	const loop = stage({ policies: { returns: () => [loop] } });
	const zero = await runPipeline(configFor([loop], async () => ({ returnTo: loop }), { maxRetries: 0 }), task(), "/tmp/factory.ts", host());
	assert.equal(zero.state, "failed");
	assert.match(zero.error, /return limit/);
	const imposter = stage({ name: loop.options.name });
	const undeclared = await runPipeline(configFor([loop], async () => ({ returnTo: imposter })), task(), "/tmp/factory.ts", host());
	assert.match(undeclared.error, /undeclared return target/);
});

test("executor capabilities enforce stage permissions and interactive mode", async () => {
	let asked = false;
	let created = false;
	const restricted = stage({ agents: [agent.with({ mode: "self-driving" })] });
	const config = configFor([restricted], async request => {
		await assert.rejects(request.ask("May I?"), /interactive/);
		await assert.rejects(request.createTask({ title: "Child" }), /may not create/);
	});
	assert.equal((await runPipeline(config, task(), "/tmp/factory.ts", host({ ask: async () => { asked = true; return "yes"; }, createTask: async () => { created = true; return "id"; } }))).state, "completed");
	assert.equal(asked, false);
	assert.equal(created, false);
	const allowed = configFor([stage({ policies: { permissions: { createNewTasks: true } } })], async request => {
		assert.equal(await request.ask("Proceed?"), "approved");
		assert.equal(await request.createTask({ title: "Follow-up" }), "new-id");
	});
	assert.equal((await runPipeline(allowed, task(), "/tmp/factory.ts", host())).state, "completed");
});

test("cancellation waits for a legacy hook before cleanup and never starts the next agent", async () => {
	let release;
	let entered;
	const ready = new Promise(resolve => { entered = resolve; });
	const hook = new Promise(resolve => { release = resolve; });
	const controller = new AbortController();
	let executed = false;
	const config = configFor([stage({ hooks: { beforeAgents: () => { entered(); return [hook]; } } })], async () => { executed = true; });
	let settled = false;
	const running = runPipeline(config, task(), "/tmp/factory.ts", host({ signal: controller.signal })).then(result => { settled = true; return result; });
	await ready;
	controller.abort();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(settled, false);
	release();
	assert.equal((await running).state, "cancelled");
	assert.equal(executed, false);
});

test("abort during cleanup preserves completed stages and their afterAgents hook", async () => {
	const controller = new AbortController();
	const sequence = [];
	const config = configFor([stage({ hooks: { afterAgents: () => { sequence.push("afterAgents"); return []; } } })], async () => {});
	config.workflows[0].resolveContainer = () => ({ name: "test-vm", async destroy() { sequence.push("destroy"); controller.abort(); } });
	const outcome = await runPipeline(config, task(), "/tmp/factory.ts", host({ signal: controller.signal }));
	assert.deepEqual(sequence, ["afterAgents", "destroy"]);
	assert.equal(controller.signal.aborted, true);
	assert.deepEqual(outcome, { state: "completed", cleanupErrors: [] });
});

test("execution and cleanup failures are both retained", async () => {
	const config = configFor([stage({})], async () => { throw new Error("external action uncertain"); });
	config.workflows[0].resolveContainer = () => ({ name: "test-vm", async destroy() { throw new Error("VM destroy rejected"); } });
	const outcome = await runPipeline(config, task(), "/tmp/factory.ts", host());
	assert.equal(outcome.state, "failed");
	assert.match(outcome.error, /external action uncertain.*VM destroy rejected/);
	assert.deepEqual(outcome.cleanupErrors, ["test-vm (unstarted): VM destroy rejected"]);
	for (const concurrency of [0, -1, 0.5, Infinity, NaN]) assert.throws(() => validateFactory(configFor([stage({})], async () => {}, { concurrency })), /concurrency/);
});
