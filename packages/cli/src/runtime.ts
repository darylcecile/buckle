import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { FactoryConfig, TaskInput } from "@buckles/factory";
import { validateFactory } from "./load.js";
import { launchWorker, type WorkerEvent, type WorkerFactory, type WorkerHandle } from "./process.js";
import { errorMessage, type TaskOutcome, type TaskOutput, type TaskRecord } from "./types.js";

/** Validates submissions at both the socket and executor-created task boundary. */
export function validateTaskInput(input: TaskInput): void {
	if (!input || typeof input.title !== "string" || !input.title.trim() || input.title.length > 4096) throw new TypeError("Task title must contain 1-4096 characters");
	if (input.description !== undefined && (typeof input.description !== "string" || input.description.length > 65536)) throw new TypeError("Description must be a string of at most 65536 characters");
	if (input.workflow !== undefined && (typeof input.workflow !== "string" || !input.workflow.trim())) throw new TypeError("Workflow must be a nonempty name");
}

/** In-memory scheduler. Emits `change` with a defensive TaskRecord snapshot on each transition. */
export class Runtime extends EventEmitter {
	private readonly records = new Map<string, TaskRecord>();
	private readonly active = new Map<string, { worker: WorkerHandle; settled: Promise<void> }>();
	private readonly outputChunks = new Map<string, TaskOutput>();
	private stopping = false;

	/** Keeps parent configuration inert; only workers invoke its independently imported executor. */
	constructor(private readonly config: FactoryConfig, private readonly file: string, private readonly spawn: WorkerFactory = launchWorker) {
		super();
		validateFactory(config);
	}

	/** True once stop has begun, including time spent waiting for legacy hooks and cleanup. */
	get isStopping(): boolean { return this.stopping; }

	/** Returns all records in submission order, including finished tasks. */
	list(): TaskRecord[] { return structuredClone([...this.records.values()]); }

	/** Finds a full UUID or an unambiguous prefix; never silently picks an ambiguous task. */
	show(id: string): TaskRecord { return structuredClone(this.find(id)); }

	/** Enqueues a task; omission selects the first declared workflow. */
	add(input: TaskInput, retryOf?: string): TaskRecord {
		if (this.stopping) throw new Error("Factory is stopping; no new tasks accepted");
		validateTaskInput(input);
		const workflow = input.workflow ?? this.config.workflows[0]!.options.name;
		if (!this.config.workflows.some(candidate => candidate.options.name === workflow)) throw new Error(`Unknown workflow: ${workflow}`);
		const now = new Date().toISOString();
		const record: TaskRecord = { id: randomUUID(), title: input.title.trim(), description: input.description ?? "", workflow,
			state: "queued", stage: "", agent: "", attempt: 0, activity: "Queued", createdAt: now, updatedAt: now,
			questions: [], outputs: [], cleanupErrors: [], ...(retryOf ? { retryOf } : {}) };
		this.records.set(record.id, record);
		this.changed(record);
		queueMicrotask(() => this.pump());
		return structuredClone(record);
	}

	/** Explicit replay starts a fresh UUID, process, contexts and containers; original results remain. */
	retry(id: string): TaskRecord {
		const record = this.find(id);
		if (record.state !== "failed") throw new Error("Only failed tasks can be retried");
		return this.add(record, record.id);
	}

	/** Answers the oldest pending question; answers are not retained in task snapshots. */
	answer(id: string, text: string): TaskRecord {
		if (typeof text !== "string" || !text.trim() || text.length > 65536) throw new TypeError("Answer must contain 1-65536 characters");
		const record = this.find(id);
		const question = record.questions[0];
		const active = this.active.get(record.id);
		if (!question || !active || record.state !== "waiting") throw new Error("Task has no answerable question");
		active.worker.answer(question.id, text);
		record.questions.shift();
		record.state = record.questions.length ? "waiting" : "running";
		record.activity = record.questions[0]?.text ?? "Answer delivered";
		this.changed(record);
		return this.show(record.id);
	}

	/** Cooperative cancellation; active tasks retain their slot until the worker exits. */
	cancel(id: string): TaskRecord {
		const record = this.find(id);
		if (record.state === "queued") record.state = "cancelled";
		else if (this.active.has(record.id)) {
			record.state = "cancelling";
			this.active.get(record.id)!.worker.cancel();
		} else return this.show(id);
		record.questions = [];
		record.activity = record.state === "cancelling" ? "Awaiting execution settlement and cleanup" : "Cancelled before execution";
		this.changed(record);
		return this.show(record.id);
	}

	/** Rejects new tasks, cancels all queued/active tasks, and awaits every worker's cleanup and exit. */
	async stop(): Promise<void> {
		this.stopping = true;
		for (const record of this.records.values()) this.cancel(record.id);
		await Promise.all([...this.active.values()].map(active => active.settled));
	}

	private find(id: string): TaskRecord {
		if (typeof id !== "string" || !id) throw new Error("Task ID is required");
		const matches = [...this.records.values()].filter(record => record.id.startsWith(id));
		if (matches.length !== 1) throw new Error(matches.length ? "Ambiguous task ID" : `Unknown task: ${id}`);
		return matches[0]!;
	}

	private changed(record: TaskRecord): void {
		record.updatedAt = new Date().toISOString();
		this.emit("change", structuredClone(record));
	}

	private pump(): void {
		if (this.stopping) return;
		for (const workflow of this.config.workflows) {
			const name = workflow.options.name;
			let count = [...this.active.keys()].filter(id => this.records.get(id)!.workflow === name).length;
			for (const record of this.records.values()) {
				if (count >= (workflow.options.policies.concurrency ?? 1)) break;
				if (record.workflow !== name || record.state !== "queued") continue;
				count++;
				this.start(record);
			}
		}
	}

	private start(record: TaskRecord): void {
		record.state = "running";
		record.activity = "Loading isolated worker";
		this.changed(record);
		try {
			const task = { id: record.id, title: record.title, description: record.description, workflow: record.workflow };
			const worker = this.spawn(this.file, task, event => this.receive(record, event), async input => {
				if (record.state === "cancelling") throw new Error("Task is cancelling");
				return this.add(input).id;
			});
			const settled = worker.done.then(outcome => this.finish(record, outcome), error => this.finish(record, {
				state: "failed", error: errorMessage(error), cleanupErrors: [],
			}));
			this.active.set(record.id, { worker, settled });
		} catch (error) { this.finish(record, { state: "failed", error: errorMessage(error), cleanupErrors: [] }); }
	}

	private receive(record: TaskRecord, event: WorkerEvent): void {
		if (event.type === "progress") Object.assign(record, event.progress);
		if (event.type === "report") record.activity = event.message;
		if (event.type === "question" && record.state !== "cancelling") {
			record.questions.push({ id: event.id, text: event.text });
			record.state = "waiting";
			record.activity = event.text;
		}
		if (event.type === "output") {
			const key = `${record.id}/${event.outputId}`;
			const previous = this.outputChunks.get(key);
			if (previous) previous.text += event.output.text;
			else {
				const output = { ...event.output };
				this.outputChunks.set(key, output);
				record.outputs.push(output);
			}
		}
		this.changed(record);
	}

	private finish(record: TaskRecord, outcome: TaskOutcome): void {
		Object.assign(record, outcome);
		record.questions = [];
		record.activity = record.error ?? record.state;
		this.active.delete(record.id);
		for (const key of this.outputChunks.keys()) if (key.startsWith(`${record.id}/`)) this.outputChunks.delete(key);
		this.changed(record);
		queueMicrotask(() => this.pump());
	}
}