import type { Task, TaskInput } from "@buckles/factory";

/** Observed task lifecycle; cancelling includes waiting for legacy hooks to settle. */
export type TaskState = "queued" | "running" | "waiting" | "cancelling" | "completed" | "failed" | "cancelled";

/** One retained agent result, including the stage visit that produced it. */
export interface TaskOutput {
	stage: string;
	agent: string;
	attempt: number;
	text: string;
}

/** Current phase reported by the isolated worker. Attempt counts stage visits. */
export interface TaskProgress {
	stage: string;
	agent: string;
	attempt: number;
	activity: string;
}

/** Inspectable in-memory snapshot; manual retries link to the original execution. */
export interface TaskRecord extends Task, TaskProgress {
	state: TaskState;
	createdAt: string;
	updatedAt: string;
	retryOf?: string;
	error?: string;
	questions: { id: string; text: string }[];
	outputs: TaskOutput[];
	cleanupErrors: string[];
}

/** Final outcome is emitted only after cleanup of every resolved container has settled. */
export interface TaskOutcome {
	state: "completed" | "failed" | "cancelled";
	error?: string;
	cleanupErrors: string[];
}

/** Parent-provided capabilities, used by the pipeline without serializing definitions. */
export interface PipelineHost {
	signal: AbortSignal;
	progress(progress: TaskProgress): void;
	output(output: TaskOutput): void;
	report(message: string): void;
	ask(question: string): Promise<string>;
	createTask(input: TaskInput): Promise<string>;
}

export function errorMessage(error: unknown): string {
	if (error instanceof AggregateError) return error.errors.map(errorMessage).join("; ");
	return error instanceof Error ? error.message : String(error);
}