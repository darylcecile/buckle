import { randomUUID } from "node:crypto";
import type { Task, TaskInput } from "@buckles/factory";
import { loadFactory } from "./load.js";
import { runPipeline } from "./pipeline.js";
import type { ParentMessage, WorkerEvent } from "./process.js";
import { errorMessage, type TaskOutcome } from "./types.js";

const controller = new AbortController();
const pending = new Map<string, { resolve(value: string): void; reject(error: Error): void }>();
let started = false;

function send(message: WorkerEvent | { type: "done"; outcome: TaskOutcome } | { type: "createTask"; id: string; input: TaskInput }): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!process.connected || !process.send) { reject(new Error("Parent disconnected")); return; }
		process.send(message, error => error ? reject(error) : resolve());
	});
}

function notify(message: WorkerEvent): void {
	void send(message).catch(error => controller.abort(error));
}

function request(message: { type: "question"; text: string } | { type: "createTask"; input: TaskInput }): Promise<string> {
	controller.signal.throwIfAborted();
	const id = randomUUID();
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		void send({ ...message, id }).catch(error => { pending.delete(id); reject(error); });
	});
}

controller.signal.addEventListener("abort", () => {
	for (const waiter of pending.values()) waiter.reject(new Error("Task cancelled"));
	pending.clear();
});
process.on("disconnect", () => controller.abort(new Error("Parent disconnected")));
process.on("SIGINT", () => controller.abort(new Error("Interrupted")));
process.on("SIGTERM", () => controller.abort(new Error("Terminated")));

async function execute(task: Task): Promise<void> {
	let outcome: TaskOutcome;
	try {
		const file = process.argv[2]!;
		const config = await loadFactory(file);
		outcome = await runPipeline(config, Object.freeze(task), file, {
			signal: controller.signal,
			progress: progress => notify({ type: "progress", progress }),
			report: message => notify({ type: "report", message: String(message).slice(0, 8192) }),
			output: output => {
				const outputId = randomUUID();
				for (let offset = 0; offset < Math.max(1, output.text.length); offset += 8192) {
					notify({ type: "output", outputId, output: { ...output, text: output.text.slice(offset, offset + 8192) } });
				}
			},
			ask: text => request({ type: "question", text: text.slice(0, 8192) }),
			createTask: input => request({ type: "createTask", input }),
		});
	} catch (error) {
		outcome = { state: controller.signal.aborted ? "cancelled" : "failed", error: errorMessage(error), cleanupErrors: [] };
	}
	try { await send({ type: "done", outcome }); }
	catch { process.exitCode = 1; }
	if (process.connected) process.disconnect();
	process.exit(outcome.state === "failed" ? 1 : process.exitCode ?? 0);
}

process.on("message", (message: ParentMessage) => {
	if (message.type === "cancel") controller.abort(new Error("Task cancelled"));
	if (message.type === "reply") {
		const waiter = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) waiter?.reject(new Error(message.error));
		else waiter?.resolve(message.value ?? "");
	}
	if (message.type === "start" && !started) {
		started = true;
		void execute(message.task);
	}
});