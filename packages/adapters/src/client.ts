import { setImmediate as yieldToEventLoop } from "node:timers/promises";

/** Explicit GitHub connection settings. Credentials stay in memory and are never discovered automatically. */
export interface SessionOptions {
	/** Repository owner or organization. */
	owner: string;
	/** Repository name, without `.git`. */
	repo: string;
	/** Positive pull request number in this repository. */
	pullNumber: number;
	/** Caller-supplied token. Never included in snapshots or error messages. */
	token: string;
	/** HTTPS REST API root. Defaults to `https://api.github.com`; GHES may use `/api/v3`. */
	apiBaseUrl?: string;
	/** Maximum time for each HTTP request including its response body, in milliseconds. Default: 30,000. */
	requestTimeoutMs?: number;
	/** Total time for a gate, including pagination and head rechecks, in milliseconds. Default: 300,000. */
	gateTimeoutMs?: number;
	/** Delay between pending gate observations, in milliseconds. Default: 2,000. */
	pollIntervalMs?: number;
	/** Merge strategy sent to GitHub. Default: `merge`. No protection bypass is requested. */
	mergeMethod?: "merge" | "squash" | "rebase";
	/** Trusted Fetch-compatible transport, primarily for unit tests. Must honor the supplied AbortSignal. */
	fetch?: typeof globalThis.fetch;
}

/** GitHub rejected an HTTP request. Response bodies and auth headers are intentionally not retained. */
export class ApiError extends Error {
	/** HTTP response status, useful for distinguishing authentication, permission, and conflict errors. */
	readonly status: number;
	/** Creates a credential-safe error from an HTTP status code. */
	constructor(status: number) {
		super(`GitHub API request failed (HTTP ${status})`);
		this.name = "GithubApiError";
		this.status = status;
	}
}

export function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid GitHub API object response");
	}
	return value as Record<string, unknown>;
}

export function text(value: unknown): string {
	if (typeof value !== "string") throw new Error("Invalid GitHub API string field");
	return value;
}

export function identifier(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error("Invalid GitHub API identifier");
	}
	return value;
}

export function nullableText(value: unknown): string | null {
	return value === null || value === undefined ? null : text(value);
}

export function boolean(value: unknown): boolean {
	if (typeof value !== "boolean") throw new Error("Invalid GitHub API boolean field");
	return value;
}

function duration(value: number | undefined, fallback: number): number {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result <= 0 || result > 2_147_483_647) {
		throw new RangeError("GitHub timeouts and polling intervals must be positive 32-bit millisecond integers");
	}
	return result;
}

export async function bounded<Result>(
	milliseconds: number,
	message: string,
	operation: (signal: AbortSignal) => Promise<Result>,
	parent?: AbortSignal,
): Promise<Result> {
	const controller = new AbortController();
	const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
	const timer = setTimeout(() => controller.abort(), milliseconds);
	let onAbort: () => void = () => {};
	try {
		const aborted = new Promise<never>((_, reject) => {
			onAbort = () => reject(new Error(message));
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		});
		return await Promise.race([aborted, Promise.resolve().then(() => {
			signal.throwIfAborted();
			return operation(signal);
		})]);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

export class Client {
	#token: string;
	#transport: typeof globalThis.fetch;
	#base: URL;
	#requestTimeout: number;
	readonly repoPath: string;
	readonly pullPath: string;
	readonly gateTimeout: number;
	readonly pollInterval: number;
	readonly mergeMethod: "merge" | "squash" | "rebase";

	constructor(options: SessionOptions) {
		if (!options.owner?.trim() || !options.repo?.trim() || !options.token?.trim()) {
			throw new TypeError("GitHub owner, repo, and token are required");
		}
		if (!Number.isSafeInteger(options.pullNumber) || options.pullNumber <= 0) {
			throw new RangeError("GitHub pullNumber must be a positive integer");
		}
		try { this.#base = new URL(options.apiBaseUrl ?? "https://api.github.com"); }
		catch { throw new TypeError("GitHub apiBaseUrl must be an HTTPS URL"); }
		if (this.#base.protocol !== "https:" || this.#base.username || this.#base.password || this.#base.search || this.#base.hash) {
			throw new TypeError("GitHub apiBaseUrl must use HTTPS without credentials, query, or fragment");
		}
		this.#base.pathname = `${this.#base.pathname.replace(/\/$/, "")}/`;
		this.#token = options.token;
		this.#transport = options.fetch ?? globalThis.fetch;
		this.#requestTimeout = duration(options.requestTimeoutMs, 30_000);
		this.gateTimeout = duration(options.gateTimeoutMs, 300_000);
		this.pollInterval = duration(options.pollIntervalMs, 2_000);
		this.mergeMethod = options.mergeMethod ?? "merge";
		if (!["merge", "squash", "rebase"].includes(this.mergeMethod)) throw new TypeError("Invalid GitHub mergeMethod");
		this.repoPath = `repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`;
		this.pullPath = `${this.repoPath}/pulls/${options.pullNumber}`;
	}

	async request(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<{ data: unknown; next: boolean }> {
		return bounded(this.#requestTimeout, "GitHub request timed out or was cancelled", async (requestSignal) => {
			let response: Response;
			try {
				response = await this.#transport(new URL(path, this.#base).href, {
					method,
					headers: {
						Accept: "application/vnd.github+json",
						Authorization: `Bearer ${this.#token}`,
						"X-GitHub-Api-Version": "2026-03-10",
						"User-Agent": "buckles-adapters",
						"Content-Type": "application/json",
					},
					body: body === undefined ? undefined : JSON.stringify(body),
					signal: requestSignal,
					redirect: "error",
				});
			} catch {
				throw new Error("GitHub transport failed; check connectivity and API configuration");
			}
			if (!response.ok) {
				await response.body?.cancel();
				throw new ApiError(response.status);
			}
			let data: unknown;
			try { data = await response.json(); }
			catch { throw new Error("Invalid GitHub API JSON response"); }
			return { data, next: /<[^>]+>;\s*rel="next"/.test(response.headers.get("link") ?? "") };
		}, signal);
	}

	async get(path: string, signal?: AbortSignal): Promise<unknown> {
		return (await this.request(path, "GET", undefined, signal)).data;
	}

	async list(path: string, key?: string, signal?: AbortSignal): Promise<unknown[]> {
		const result: unknown[] = [];
		let next = true;
		for (let page = 1; next; page++) {
			const separator = path.includes("?") ? "&" : "?";
			const response = await this.request(`${path}${separator}per_page=100&page=${page}`, "GET", undefined, signal);
			const items = key ? record(response.data)[key] : response.data;
			if (!Array.isArray(items)) throw new Error("Invalid GitHub API list response");
			result.push(...items);
			next = response.next;
			if (next) await yieldToEventLoop(undefined, { signal });
		}
		return result;
	}
}