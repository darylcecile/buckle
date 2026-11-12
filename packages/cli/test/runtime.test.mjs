import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Container, Stage, Supervisor, Workflow } from "@buckles/factory";
import { endpointFor, ensureDaemon, readSnapshot, renderBoard, requestCommand, Runtime, serveCommands } from "../dist/index.js";

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

const execute = promisify(execFile);
const cli = (args, options = {}) => execute(process.execPath, [fileURLToPath(new URL("../dist/bin.js", import.meta.url)), ...args], { timeout: 10000, ...options });

async function daemonFixture(cleanupFailure = false) {
	const directory = await mkdtemp(join(tmpdir(), "buckles-daemon-"));
	const file = join(directory, "factory.ts");
	await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
	await writeFile(file, `
import { Agent, Container, Model, Stage, Supervisor, Workflow, factory } from ${JSON.stringify(import.meta.resolve("@buckles/factory"))};
const workflow = new Workflow({ name: "Main", instruction: "", policies: {},
	container: new Container.MicroVM({ image: "fake", cpu: 1, memory: "128MiB" }),
	stages: [new Stage({ name: "Work", instruction: "", contexts: [],
		agents: [new Agent({ name: "Builder", role: "build", model: new Model("test", "fake", { variant: "test" }), mode: "interactive" })] })] });
workflow.resolveContainer = () => ({ name: "fake-vm", async destroy() {
	if (${cleanupFailure}) throw new Error("fixture cleanup rejected");
} });
export default factory.define({ supervisor: new Supervisor({}), workflows: [workflow], executor: { async execute({ task, ask }) {
	if (task.title === "Hold") return { output: await ask("Continue?") };
	return { output: "fixture complete" };
} } });
`);
	return { directory, file: await realpath(file) };
}

async function taskInState(file, id, state) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const snapshot = await readSnapshot(file);
		const task = snapshot.tasks.find(task => task.id === id);
		if (task?.state === state) return task;
		await delay(20);
	}
	assert.fail(`Task ${id} did not reach ${state}`);
}

test("concurrent CLI starts share a daemon that survives launcher exit and retains tasks on reconnect", { timeout: 20000 }, async () => {
	const { directory, file } = await daemonFixture();
	try {
		const starts = await Promise.all([cli(["start", file, "--json"]), cli(["start", file, "--json"])]);
		const snapshots = starts.map(result => JSON.parse(result.stdout));
		assert.equal(snapshots[0].pid, snapshots[1].pid);
		assert.equal(snapshots[0].factory, file);
		assert.deepEqual(snapshots[0].workflows, ["Main"]);
		const task = await requestCommand(file, { command: "add", input: { title: "Hold" } });
		await taskInState(file, task.id, "waiting");
		const detached = await cli([], { cwd: directory });
		assert.match(detached.stdout, /Attach from an interactive terminal/);
		assert.ok(!detached.stdout.includes("\x1b"));
		const reconnected = JSON.parse((await cli(["status", "--factory", file, "--json"])).stdout);
		assert.equal(reconnected.pid, snapshots[0].pid);
		assert.equal(reconnected.tasks[0].id, task.id);
		assert.equal(reconnected.tasks[0].questions[0].text, "Continue?");
		await requestCommand(file, { command: "answer", id: task.id, text: "Retained answer" });
		const completed = await taskInState(file, task.id, "completed");
		assert.equal(completed.outputs[0].text, "Retained answer");
		assert.equal((await ensureDaemon(file)).pid, snapshots[0].pid);
		assert.deepEqual(JSON.parse((await cli(["stop", "--factory", file, "--json"])).stdout), { stopped: true, cleanupErrors: [] });
	} finally {
		await requestCommand(file, { command: "stop" }, AbortSignal.timeout(3000)).catch(() => {});
		await rm(directory, { recursive: true, force: true });
	}
});

test("disconnecting a pending stop leaves cooperative cleanup running and snapshots available", { timeout: 10000 }, async () => {
	const { runtime, workers } = harness();
	const directory = await mkdtemp(join(tmpdir(), "buckles-stop-"));
	const file = join(directory, "factory.ts");
	const server = await serveCommands(file, runtime);
	try {
		const task = runtime.add({ title: "Pending cleanup" });
		await turn();
		const controller = new AbortController();
		const stopping = requestCommand(file, { command: "stop" }, controller.signal);
		const rejected = assert.rejects(stopping, /Client detached/);
		await taskInState(file, task.id, "cancelling");
		controller.abort(new Error("Client detached"));
		await rejected;
		const snapshot = await readSnapshot(file);
		assert.equal(snapshot.stopping, true);
		assert.equal(snapshot.tasks[0].state, "cancelling");
		workers.get(task.id).finish({ state: "cancelled" });
		await server.closed;
		await assert.rejects(readSnapshot(file), { code: "ENOENT" });
	} finally {
		for (const worker of workers.values()) worker.finish({ state: "cancelled" });
		await server.stop();
		await rm(directory, { recursive: true, force: true });
	}
});

test("startup reports load errors and existing incompatible endpoints; pending snapshot reads can detach", { timeout: 10000 }, async () => {
	const { directory, file } = await daemonFixture();
	const path = await endpointFor(file);
	let server;
	try {
		await writeFile(file, 'throw new Error("fixture failed to load");');
		await assert.rejects(ensureDaemon(file), /fixture failed to load/);
		server = createServer(socket => {
			socket.once("data", () => socket.end(`${JSON.stringify({ ok: false, error: "Unknown command" })}\n`));
		});
		await new Promise(resolve => server.listen(path, resolve));
		await assert.rejects(ensureDaemon(file), /incompatible IPC protocol.*original CLI/);
		server.removeAllListeners("connection");
		const connected = once(server, "connection");
		const controller = new AbortController();
		const pending = readSnapshot(file, controller.signal);
		const rejected = assert.rejects(pending, /Client detached/);
		const [socket] = await connected;
		await once(socket, "data");
		const closed = once(socket, "close");
		controller.abort(new Error("Client detached"));
		await rejected;
		await closed;
		await new Promise(resolve => server.close(resolve));
		await writeFile(path, "occupied fixture endpoint");
		await assert.rejects(ensureDaemon(file), /stale|Cannot contact/);
		assert.equal(await readFile(path, "utf8"), "occupied fixture endpoint");
	} finally {
		if (server?.listening) await new Promise(resolve => server.close(resolve));
		await rm(path, { force: true });
		await rm(directory, { recursive: true, force: true });
	}
});

test("cleanup failures make the daemon and stop CLI exit nonzero in both output modes", { timeout: 20000 }, async () => {
	for (const json of [false, true]) {
		const { directory, file } = await daemonFixture(true);
		const child = fork(new URL("../dist/daemon-entry.js", import.meta.url), [file], {
			execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"], timeout: 8000, killSignal: "SIGKILL",
		});
		const closed = once(child, "close");
		try {
			const [ready] = await once(child, "message");
			assert.equal(ready.type, "ready");
			const task = await requestCommand(file, { command: "add", input: { title: "Finish with cleanup failure" } });
			await taskInState(file, task.id, "failed");
			await assert.rejects(cli(["stop", "--factory", file, ...(json ? ["--json"] : [])]), error => {
				assert.equal(error.code, 1);
				const result = JSON.parse(error.stdout);
				assert.equal(result.stopped, true);
				assert.match(result.cleanupErrors[0], /fixture cleanup rejected/);
				return true;
			});
			assert.deepEqual(await closed, [1, null]);
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
			await closed;
			await rm(await endpointFor(file), { force: true });
			await rm(directory, { recursive: true, force: true });
		}
	}
});
