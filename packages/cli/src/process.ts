import { fork } from "node:child_process";
import type { Task, TaskInput } from "@buckles/factory";
import type { TaskOutcome, TaskOutput, TaskProgress } from "./types.js";

/** Small JSON messages from a worker; definitions and context instances never cross IPC. */
export type WorkerEvent =
	| { type: "progress"; progress: TaskProgress }
	| { type: "report"; message: string }
	| { type: "output"; output: TaskOutput; outputId: string }
	| { type: "question"; id: string; text: string };

/** A worker remains active until its process exits, including cancellation and cleanup. */
export interface WorkerHandle {
	done: Promise<TaskOutcome>;
	cancel(): void;
	answer(id: string, text: string): void;
}

/** Process boundary injectable for focused scheduler tests. Production uses launchWorker. */
export type WorkerFactory = (file: string, task: Task, event: (event: WorkerEvent) => void,
	createTask: (input: TaskInput) => Promise<string>) => WorkerHandle;

export type ParentMessage =
	| { type: "start"; task: Task }
	| { type: "cancel" }
	| { type: "reply"; id: string; value?: string; error?: string };

type ChildMessage = WorkerEvent | { type: "done"; outcome: TaskOutcome }
	| { type: "createTask"; id: string; input: TaskInput };

/** Forks one independent Node process per task, without sharing module-level contexts. */
export const launchWorker: WorkerFactory = (file, task, event, createTask) => {
	const child = fork(new URL("./worker.js", import.meta.url), [file], {
		execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"],
	});
	let outcome: TaskOutcome | undefined;
	let transportError: string | undefined;
	const send = (message: ParentMessage) => {
		if (!child.connected) return;
		child.send(message, error => { if (error) transportError = error.message; });
	};
	const done = new Promise<TaskOutcome>(resolve => {
		child.on("error", error => { transportError = error.message; });
		child.on("message", (message: ChildMessage) => {
			if (message.type === "done") { outcome = message.outcome; return; }
			if (message.type === "createTask") {
				void createTask(message.input).then(
					value => send({ type: "reply", id: message.id, value }),
					error => send({ type: "reply", id: message.id, error: error instanceof Error ? error.message : String(error) }),
				);
			} else event(message);
		});
		child.on("close", (code, signal) => {
			if (outcome && code === (outcome.state === "failed" ? 1 : 0)) resolve(outcome);
			else resolve({ state: "failed", cleanupErrors: outcome?.cleanupErrors ?? [],
				error: [outcome?.error, transportError, `Worker exited (${signal ?? code})${outcome ? "" : " before reporting cleanup; VM cleanup is unconfirmed"}`].filter(Boolean).join("; ") });
		});
	});
	send({ type: "start", task });
	return { done, cancel: () => send({ type: "cancel" }), answer: (id, text) => send({ type: "reply", id, value: text }) };
};