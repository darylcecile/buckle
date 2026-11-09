import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Container, Stage, Supervisor, Workflow } from "@buckles/factory";
import { renderBoard, Runtime } from "../dist/index.js";

const turn = () => new Promise(resolve => setImmediate(resolve));
const workflow = (name, concurrency) => new Workflow({ name, policies: { concurrency }, instruction: "", container: new Container.MicroVM({ image: "fake", cpu: 1, memory: "128MiB" }),
	stages: [new Stage({ name: "Work", instruction: "", agents: [], contexts: [] })] });
const config = { executor: { async execute() { throw new Error("Parent must remain inert"); } }, supervisor: new Supervisor({}), workflows: [workflow("Main", 1), workflow("Other", 2)] };

function harness() {
	const workers = new Map();
	const runtime = new Runtime(config, "/tmp/factory.ts", (_file, task, event) => {
		let resolve;
		const done = new Promise(settle => { resolve = settle; });
		const worker = { done, finish: outcome => resolve({ cleanupErrors: [], ...outcome }), cancelled: false,
			cancel() { worker.cancelled = true; }, answer(id, text) { worker.answerReceived = { id, text }; }, event };
		workers.set(task.id, worker);
		return worker;
	});
	return { runtime, workers };
}

test("workflow queues independently enforce concurrency and advance after abrupt failure", async () => {
	const { runtime, workers } = harness();
	const first = runtime.add({ title: "First" });
	const queued = runtime.add({ title: "Queued" });
	const other = runtime.add({ title: "Other", workflow: "Other" });
	const parallel = runtime.add({ title: "Parallel", workflow: "Other" });
	await turn();
	assert.equal(workers.size, 3);
	assert.equal(runtime.show(queued.id).state, "queued");
	workers.get(first.id).finish({ state: "failed", error: "Worker exited before cleanup" });
	await turn();
	assert.equal(runtime.show(queued.id).state, "running");
	const retry = runtime.retry(first.id);
	assert.notEqual(retry.id, first.id);
	assert.equal(retry.retryOf, first.id);
	assert.equal(runtime.show(first.id).error, "Worker exited before cleanup");
	assert.equal(runtime.show(other.id).state, "running");
	assert.equal(runtime.show(parallel.id).state, "running");
	const stopping = runtime.stop();
	for (const worker of workers.values()) worker.finish({ state: "cancelled" });
	await stopping;
	assert.equal(runtime.show(retry.id).state, "cancelled");
});

test("questions, output chunks and cancellation remain inspectable until worker cleanup finishes", async () => {
	const { runtime, workers } = harness();
	const task = runtime.add({ title: "Interactive" });
	const queued = runtime.add({ title: "Never started" });
	await turn();
	const worker = workers.get(task.id);
	worker.event({ type: "progress", progress: { stage: "Build", agent: "Builder", attempt: 2, activity: "Working" } });
	worker.event({ type: "question", id: "question-1", text: "Proceed?" });
	assert.equal(runtime.show(task.id).state, "waiting");
	runtime.answer(task.id, "yes");
	assert.deepEqual(worker.answerReceived, { id: "question-1", text: "yes" });
	assert.equal(runtime.show(task.id).state, "running");
	for (const text of ["long ", "output"]) worker.event({ type: "output", outputId: "result", output: { stage: "Build", agent: "Builder", attempt: 2, text } });
	assert.equal(runtime.show(task.id).outputs[0].text, "long output");
	const snapshot = runtime.show(task.id);
	snapshot.outputs[0].text = "mutated";
	assert.equal(runtime.show(task.id).outputs[0].text, "long output");
	worker.event({ type: "question", id: "question-2", text: "Still proceed?" });
	assert.equal(runtime.show(task.id).state, "waiting");
	const stopping = runtime.stop();
	assert.equal(worker.cancelled, true);
	assert.equal(runtime.show(task.id).state, "cancelling");
	assert.deepEqual(runtime.show(task.id).questions, []);
	assert.match(renderBoard(runtime.list(), { columns: 160 }), /Awaiting execution settlement and cleanup/);
	assert.equal(runtime.show(queued.id).state, "cancelled");
	assert.throws(() => runtime.add({ title: "Late task" }), /stopping/);
	worker.finish({ state: "cancelled" });
	await stopping;
	assert.equal(runtime.show(task.id).state, "cancelled");
	assert.equal(workers.size, 1);
});

test("a cancellation arriving after worker completion preserves the actual completed outcome", async () => {
	const { runtime, workers } = harness();
	const task = runtime.add({ title: "Already finished in worker" });
	await turn();
	runtime.cancel(task.id);
	assert.equal(runtime.show(task.id).state, "cancelling");
	workers.get(task.id).finish({ state: "completed" });
	await turn();
	assert.equal(runtime.show(task.id).state, "completed");
	await runtime.stop();
});

test("finished workers send their outcome and exit after hooks and cleanup despite idle executor handles", { timeout: 15000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "buckles-worker-"));
	const file = join(directory, "factory.mjs");
	const marker = join(directory, "cleanup.txt");
	try {
		await writeFile(file, `
import { appendFile } from "node:fs/promises";
import { Agent, Container, Model, Stage, Supervisor, Workflow, factory } from ${JSON.stringify(import.meta.resolve("@buckles/factory"))};
let failCleanup = false;
const mark = text => appendFile(${JSON.stringify(marker)}, text + "\\n");
const workflow = new Workflow({ name: "Main", instruction: "", policies: {},
	container: new Container.MicroVM({ image: "fake", cpu: 1, memory: "128MiB" }),
	stages: [new Stage({ name: "Work", instruction: "", contexts: [],
		agents: [new Agent({ name: "Builder", role: "build", model: new Model("test", "fake", { variant: "test" }), mode: "self-driving" })],
		hooks: { afterAgents: () => [mark("afterAgents")] } })] });
workflow.resolveContainer = () => ({ name: "fake-vm", async destroy() {
	await mark("cleanup");
	if (failCleanup) throw new Error("cleanup rejected");
} });
export default factory.define({ supervisor: new Supervisor({}), workflows: [workflow], executor: { async execute({ task }) {
	setInterval(() => {}, 60000);
	failCleanup = task.title === "failed";
	return { output: "finished" };
} } });
`);
		for (const state of ["completed", "failed"]) {
			await writeFile(marker, "");
			const messages = [];
			const child = fork(new URL("../dist/worker.js", import.meta.url), [file], {
				execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"], timeout: 5000, killSignal: "SIGKILL",
			});
			const closed = once(child, "close");
			child.on("message", message => messages.push(message));
			child.send({ type: "start", task: { id: state, title: state, description: "", workflow: "Main" } });
			assert.deepEqual(await closed, [state === "failed" ? 1 : 0, null], "worker must exit before the 5s deadline");
			assert.equal(await readFile(marker, "utf8"), "afterAgents\ncleanup\n");
			assert.equal(messages.find(message => message.type === "output")?.output.text, "finished");
			const outcome = messages.find(message => message.type === "done")?.outcome;
			assert.equal(outcome?.state, state);
			assert.deepEqual(outcome.cleanupErrors, state === "failed" ? ["fake-vm (unstarted): cleanup rejected"] : []);
			if (state === "failed") assert.match(outcome.error, /cleanup rejected/);
		}
	} finally { await rm(directory, { recursive: true, force: true }); }
});