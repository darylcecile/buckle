import { setTimeout as delay } from "node:timers/promises";
import { Model, SessionContext as FactorySessionContext, type ModelOptions } from "@buckles/factory";
import { boolean, bounded, Client, identifier, nullableText, record, text, type SessionOptions } from "./client.js";

export { ApiError, type SessionOptions } from "./client.js";

/** Describes a GitHub model without checking availability, authenticating, or executing it. */
export function model(id: string, options: ModelOptions): Model {
	return new Model("github-copilot", id, options);
}

/** Credential-free pull request details made available to agents. */
export interface PullRequest {
	/** Pull request number. */
	readonly number: number;
	/** Pull request title. */
	readonly title: string;
	/** Markdown description, or null when absent. */
	readonly body: string | null;
	/** GitHub web URL. */
	readonly url: string;
	/** Exact head commit used for gates and mutation preconditions. */
	readonly headSha: string;
	/** Target branch name. */
	readonly baseRef: string;
	/** Current open/closed state reported by GitHub. */
	readonly state: string;
	/** Whether the pull request is a draft. */
	readonly draft: boolean;
	/** Whether GitHub reports the pull request merged. */
	readonly merged: boolean;
}

/** Issue or inline review comment exposed to agents. */
export interface Comment {
	/** GitHub comment identifier. */
	readonly id: number;
	/** Markdown comment content. */
	readonly body: string;
	/** Author login, or null for a deleted user. */
	readonly author: string | null;
	/** Link to the comment. */
	readonly url: string;
	/** File path for an inline review comment; null for an issue comment. */
	readonly path: string | null;
	/** Current diff line, or null for outdated/file-level/issue comments. */
	readonly line: number | null;
}

/** Submitted or pending review, including the GitHub-provided Copilot classification. */
export interface Review {
	/** GitHub review identifier. */
	readonly id: number;
	/** Markdown review summary. */
	readonly body: string;
	/** Author login, or null for a deleted user. */
	readonly author: string | null;
	/** GitHub review state, e.g. COMMENTED, APPROVED, CHANGES_REQUESTED, or PENDING. */
	readonly state: string;
	/** Reviewed commit; may be null on a pending review. */
	readonly commitId: string | null;
	/** Submission timestamp; null means the review has not been submitted. */
	readonly submittedAt: string | null;
	/** True only when GitHub's `is_copilot_code_review` field is true. */
	readonly isCopilot: boolean;
}

/** Complete, paginated PR discussion snapshot from a successful ReadyForAgents action. */
export interface Snapshot {
	/** Pull request details whose head remained stable across the snapshot read. */
	readonly pullRequest: PullRequest;
	/** All issue-thread comments visible to the token. */
	readonly comments: readonly Comment[];
	/** All inline review comments visible to the token, including outdated comments. */
	readonly reviewComments: readonly Comment[];
	/** All reviews visible to the token in chronological order. */
	readonly reviews: readonly Review[];
	/** ISO timestamp at which loading completed. */
	readonly loadedAt: string;
}

/** Confirmed merge result; queued or merely accepted requests do not count as merged. */
export interface MergeResult {
	/** Merge commit SHA returned by GitHub. */
	readonly sha: string;
	/** True only after GitHub confirms the merge succeeded. */
	readonly merged: true;
}

interface SessionState {
	client?: Client;
	snapshotRequired?: boolean;
	approvalRequired?: boolean;
	checksRequired?: boolean;
	reviewRequired?: boolean;
	snapshot?: Snapshot;
	approval?: Review;
	merge?: MergeResult;
	checksHead?: string;
	reviewHead?: string;
	tail: Promise<void>;
}

const sessions = new WeakMap<SessionContext, SessionState>();

function session(context: SessionContext): SessionState {
	const state = sessions.get(context);
	if (!state) throw new TypeError("Expected a Github.SessionContext");
	return state;
}

function bound(context: SessionContext): { state: SessionState; client: Client } {
	const state = session(context);
	if (!state.client) throw new Error("GitHub session is unbound; call context.bind({ owner, repo, pullNumber, token }) first");
	return { state, client: state.client };
}

/**
 * One GitHub PR session. The no-argument constructor is inert. Bind explicitly
 * before using gates/actions. Write references share binding, results, and queue.
 */
export class SessionContext extends FactorySessionContext {
	declare private readonly _githubBrand: void;

	/** Creates an unbound context, or binds the provided settings without I/O. */
	constructor(options?: SessionOptions) {
		super({ description: "GitHub pull request and discussion" });
		sessions.set(this, { tail: Promise.resolve() });
		if (options) this.bind(options);
	}

	/**
	 * Binds this session once without making requests. Returns this reference.
	 * All expectWrite() views see the binding. Use a new context for another PR.
	 * For a new head or a failed attempt, rerun required preparation on this context.
	 */
	bind(options: SessionOptions): this {
		const state = session(this);
		if (state.client) throw new Error("GitHub session is already bound; create a new context to change its binding");
		state.client = new Client(options);
		return this;
	}

	/** Whether explicit connection settings have been supplied; does not test authentication. */
	get bound(): boolean { return session(this).client !== undefined; }

	/** Defensive copy of the prepared snapshot; undefined until loaded or after invalidation. */
	get snapshot(): Snapshot | undefined { return structuredClone(session(this).snapshot); }

	/** Defensive copy of the confirmed approval; undefined after invalidation or a failed attempt. */
	get approval(): Review | undefined { return structuredClone(session(this).approval); }

	/** Defensive copy of a confirmed merge; undefined until Merge succeeds. */
	get mergeResult(): MergeResult | undefined { return structuredClone(session(this).merge); }

	/** Constructs a valid GitHub context view sharing session state, without copying private fields. */
	protected override createReference(): this {
		if (this.constructor !== SessionContext) throw new TypeError("GitHub context subclasses must implement createReference()");
		const reference = new SessionContext();
		sessions.set(reference, session(this));
		return reference as this;
	}
}

function author(value: unknown): string | null {
	return value === null ? null : text(record(value).login);
}

function pullRequest(value: unknown): PullRequest {
	const raw = record(value);
	const headSha = text(record(raw.head).sha);
	if (!headSha) throw new Error("GitHub pull request has no head SHA");
	return {
		number: identifier(raw.number), title: text(raw.title), body: nullableText(raw.body), url: text(raw.html_url),
		headSha, baseRef: text(record(raw.base).ref), state: text(raw.state), draft: boolean(raw.draft), merged: boolean(raw.merged),
	};
}

function comment(value: unknown): Comment {
	const raw = record(value);
	return {
		id: identifier(raw.id), body: text(raw.body), author: author(raw.user), url: text(raw.html_url),
		path: nullableText(raw.path), line: raw.line === undefined || raw.line === null ? null : identifier(raw.line),
	};
}

function review(value: unknown): Review {
	const raw = record(value);
	return {
		id: identifier(raw.id), body: text(raw.body), author: author(raw.user), state: text(raw.state),
		commitId: nullableText(raw.commit_id), submittedAt: nullableText(raw.submitted_at), isCopilot: raw.is_copilot_code_review === true,
	};
}

function requireOpen(pull: PullRequest): void {
	if (pull.state !== "open" || pull.merged) throw new Error("GitHub pull request is not open");
}

function prepareHead(state: SessionState, head: string): void {
	if (state.snapshot?.pullRequest.headSha !== head) state.snapshot = undefined;
	if (state.approval?.commitId !== head) state.approval = undefined;
	if (state.checksHead !== head) state.checksHead = undefined;
	if (state.reviewHead !== head) state.reviewHead = undefined;
}

function requirePreparedHead(state: SessionState, head: string, includeApproval = true): void {
	const preparations = [
		[state.snapshotRequired, state.snapshot?.pullRequest.headSha, "ReadyForAgents"],
		[state.checksRequired, state.checksHead, "Checks"],
		[state.reviewRequired, state.reviewHead, "CopilotCodeReview"],
		[includeApproval && state.approvalRequired, state.approval?.commitId, "TryApprove"],
	] as const;
	const missing = preparations.filter(([required, sha]) => required && sha !== head).map(([, , name]) => name);
	if (missing.length > 0) {
		throw new Error(`GitHub pull request head changed or required preparation is missing; rerun on the current head: ${missing.join(", ")}`);
	}
}

function queue(context: SessionContext, action: (state: SessionState, client: Client) => Promise<void>): Promise<void> {
	try {
		const { state, client } = bound(context);
		const result = state.tail.then(() => action(state, client));
		state.tail = result;
		void result.catch(() => {
			if (state.tail === result) state.tail = Promise.resolve();
		});
		return result;
	} catch (error) {
		return Promise.reject(error);
	}
}

/**
 * Explicit GitHub actions, serialized in invocation order per session (including
 * write references). A rejection blocks queued followers; after they settle, a
 * later explicit attempt can retry. Rerun required preparation and confirm any
 * uncertain mutation outcome before retrying; mutations are not retried automatically.
 * Always await the returned promises; constructing a factory never invokes them.
 */
export const act = {
	/**
	 * Loads PR details, issue comments, inline comments, and reviews into context.snapshot.
	 * Publishes only a complete read with a stable head; API and pagination errors reject.
	 * A new head clears stale evidence, but retains all previously requested requirements.
	 * This reads data only; it does not mark drafts ready or request reviews.
	 */
	ReadyForAgents(context: SessionContext): Promise<void> {
		return queue(context, async (state, client) => {
			state.snapshotRequired = true;
			state.snapshot = undefined;
			await bounded(client.gateTimeout, "GitHub snapshot loading timed out", async (signal) => {
				const pull = pullRequest(await client.get(client.pullPath, signal));
				prepareHead(state, pull.headSha);
				const comments = (await client.list(`${client.repoPath}/issues/${pull.number}/comments`, undefined, signal)).map(comment);
				const reviewComments = (await client.list(`${client.pullPath}/comments`, undefined, signal)).map(comment);
				const reviews = (await client.list(`${client.pullPath}/reviews`, undefined, signal)).map(review);
				const latest = pullRequest(await client.get(client.pullPath, signal));
				if (latest.headSha !== pull.headSha) throw new Error("GitHub pull request head changed while loading context; rerun required preparation");
				signal.throwIfAborted();
				state.snapshot = { pullRequest: latest, comments, reviewComments, reviews, loadedAt: new Date().toISOString() };
			});
		});
	},
	/**
	 * Submits APPROVE as the configured token's actor, pinned to the current head.
	 * Rejects on changed preparation, drafts, auth/permission errors, or an unconfirmed
	 * approval. Despite the name, failure is not swallowed and prevents a queued merge.
	 * Replaces any prior approval; Merge requires this attempt to succeed, even after failure.
	 */
	TryApprove(context: SessionContext): Promise<void> {
		return queue(context, async (state, client) => {
			state.approvalRequired = true;
			state.approval = undefined;
			const pull = pullRequest(await client.get(client.pullPath));
			requireOpen(pull);
			requirePreparedHead(state, pull.headSha, false);
			if (pull.draft) throw new Error("Cannot approve a draft pull request");
			const result = review((await client.request(`${client.pullPath}/reviews`, "POST", { event: "APPROVE", commit_id: pull.headSha })).data);
			if (result.state !== "APPROVED" || result.commitId !== pull.headSha || !result.submittedAt) {
				throw new Error("GitHub did not confirm an approval on the expected head");
			}
			state.approval = result;
		});
	},
	/**
	 * Requests a direct merge with an exact head SHA and the configured merge method.
	 * Rejects stale/missing required preparation or a response without merged=true and a commit SHA.
	 * Does not enable auto-merge, enter a merge queue, bypass rules, or use admin flags.
	 */
	Merge(context: SessionContext): Promise<void> {
		return queue(context, async (state, client) => {
			const pull = pullRequest(await client.get(client.pullPath));
			requireOpen(pull);
			requirePreparedHead(state, pull.headSha);
			if (pull.draft) throw new Error("Cannot merge a draft pull request");
			const result = record((await client.request(`${client.pullPath}/merge`, "PUT", { sha: pull.headSha, merge_method: client.mergeMethod })).data);
			if (result.merged !== true || typeof result.sha !== "string" || !result.sha) throw new Error("GitHub did not confirm a successful merge");
			state.merge = { merged: true, sha: result.sha };
		});
	},
};

/** Options for waiting for a submitted Copilot review of the current head. */
export interface CopilotCodeReviewOptions {
	/** Wait for a completed review, not merely a request for review. */
	status: "done";
}

/** Options for checking both GitHub check runs and legacy commit statuses. */
export interface ChecksOptions {
	/** Names excluded from both sources, matched case-insensitively. */
	ignore: string[];
	/**
	 * Optional names that must appear before passing. Other non-ignored checks still
	 * count. Missing names wait until timeout. A name cannot be expected and ignored.
	 * Without expected names, at least one non-ignored check/status must exist.
	 */
	expected?: string[];
}

function names(values: readonly string[]): Set<string> {
	return new Set(values.map((value) => {
		if (typeof value !== "string" || !value.trim()) throw new TypeError("Check names must be nonempty strings");
		return value.toLowerCase();
	}));
}

interface Check {
	name: string;
	state: "passed" | "pending" | "failed";
}

function checkRuns(values: unknown[], headSha: string): Check[] {
	return values.map((value) => {
		const raw = record(value);
		if (text(raw.head_sha) !== headSha) throw new Error("GitHub returned checks for a different head");
		const state = text(raw.status) !== "completed" ? "pending"
			: ["success", "neutral", "skipped"].includes(text(raw.conclusion)) ? "passed" : "failed";
		return { name: text(raw.name).toLowerCase(), state };
	});
}

function commitStatuses(values: unknown[]): Check[] {
	const latest = new Map<string, Check>();
	for (const value of values) {
		const raw = record(value);
		const name = text(raw.context).toLowerCase();
		if (latest.has(name)) continue;
		const state = text(raw.state);
		if (!["success", "pending", "failure", "error"].includes(state)) throw new Error("Unknown GitHub commit status state");
		latest.set(name, { name, state: state === "success" ? "passed" : state === "pending" ? "pending" : "failed" });
	}
	return [...latest.values()];
}

async function checksPass(client: Client, headSha: string, ignore: Set<string>, expected: Set<string>, signal: AbortSignal): Promise<boolean> {
	const path = `${client.repoPath}/commits/${encodeURIComponent(headSha)}`;
	const runs = checkRuns(await client.list(`${path}/check-runs?filter=latest`, "check_runs", signal), headSha);
	const statuses = commitStatuses(await client.list(`${path}/statuses`, undefined, signal));
	const checks = [...runs, ...statuses].filter((check) => !ignore.has(check.name));
	const failed = checks.filter((check) => check.state === "failed").map((check) => check.name);
	if (failed.length > 0) throw new Error(`GitHub checks failed for the current head: ${failed.join(", ")}`);
	const present = new Set(checks.map((check) => check.name));
	return checks.length > 0 && [...expected].every((name) => present.has(name)) && checks.every((check) => check.state === "passed");
}

async function poll(
	context: SessionContext,
	label: string,
	observe: (client: Client, headSha: string, signal: AbortSignal) => Promise<boolean>,
	accept: (state: SessionState, headSha: string) => void,
): Promise<void> {
	const { client, state } = bound(context);
	await bounded(client.gateTimeout, `GitHub ${label} gate timed out`, async (signal) => {
		let expectedHead: string | undefined;
		while (true) {
			const pull = pullRequest(await client.get(client.pullPath, signal));
			requireOpen(pull);
			if (expectedHead === undefined) {
				expectedHead = pull.headSha;
				prepareHead(state, expectedHead);
			}
			if (pull.headSha !== expectedHead) throw new Error("GitHub pull request head changed during gate polling");
			const ready = await observe(client, pull.headSha, signal);
			const latest = pullRequest(await client.get(client.pullPath, signal));
			requireOpen(latest);
			if (latest.headSha !== expectedHead) throw new Error("GitHub pull request head changed during gate polling");
			if (ready) {
				signal.throwIfAborted();
				accept(state, expectedHead);
				return;
			}
			await delay(client.pollInterval, undefined, { signal });
		}
	});
}

/**
 * Explicit, bounded polling gates. Each call may prepare a new head, clearing stale
 * evidence but retaining required preparation. Head changes during observation reject.
 * Errors reject; gates do not execute agents or mutate GitHub.
 */
export const gates = {
	/**
	 * Waits for the latest GitHub-classified Copilot review to be submitted on the
	 * current head. COMMENTED, APPROVED, and CHANGES_REQUESTED mean done, not approved.
	 * Pending, dismissed, requested-only, or obsolete-head reviews cannot pass.
	 * Requires an API version exposing is_copilot_code_review; no guessed bot fallback.
	 */
	async CopilotCodeReview(context: SessionContext, options: CopilotCodeReviewOptions): Promise<void> {
		if (options.status !== "done") throw new TypeError("CopilotCodeReview only supports status: done");
		const state = session(context);
		state.reviewRequired = true;
		state.reviewHead = undefined;
		await poll(context, "Copilot review", async (client, headSha, signal) => {
			const reviews = (await client.list(`${client.pullPath}/reviews`, undefined, signal)).map(review);
			const latest = reviews.filter((entry) => entry.isCopilot).at(-1);
			return latest !== undefined && latest.commitId === headSha && Boolean(latest.submittedAt)
				&& ["COMMENTED", "APPROVED", "CHANGES_REQUESTED"].includes(latest.state);
		}, (state, headSha) => { state.reviewHead = headSha; });
	},
	/**
	 * Waits for all non-ignored latest check runs and commit statuses on the current
	 * head. Success/neutral/skipped check conclusions pass; other completed outcomes
	 * fail immediately with failing check/status names. Pending or missing checks wait.
	 * Statuses use the newest result per case-insensitive context. All pages are read;
	 * changed heads reject.
	 */
	async Checks(context: SessionContext, options: ChecksOptions): Promise<void> {
		const ignore = names(options.ignore);
		const expected = names(options.expected ?? []);
		if ([...expected].some((name) => ignore.has(name))) throw new TypeError("Expected checks cannot also be ignored");
		const state = session(context);
		state.checksRequired = true;
		state.checksHead = undefined;
		await poll(context, "checks", (client, headSha, signal) => checksPass(client, headSha, ignore, expected, signal),
			(state, headSha) => { state.checksHead = headSha; });
	},
};