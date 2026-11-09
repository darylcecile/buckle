import { posix } from "node:path";
import type { ExecutorRequest, ExecutorResult, SessionContext } from "@buckles/factory";
import type { Tool, ToolResultObject } from "@github/copilot-sdk";
import { SessionContext as GithubContext } from "./github.js";

export interface ToolSettings {
	cwd: string;
	commandTimeoutMs: number;
	maxOutputBytes: number;
	githubToken?: string;
	githubApiBaseUrl?: string;
	repositories: ReadonlySet<string>;
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected an object");
	return value as Record<string, unknown>;
}

function text(value: unknown, name: string, maximum = 65_536): string {
	if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximum) {
		throw new TypeError(`${name} must be nonempty text of at most ${maximum} bytes`);
	}
	return value;
}

const string = { type: "string" };
const contextIndex = { type: "integer", minimum: 0 };

export async function interruptible<Result>(work: Promise<Result>, signal: AbortSignal): Promise<Result> {
	let onAbort = () => {};
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(signal.reason);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
	try { return await Promise.race([work, aborted]); }
	finally { signal.removeEventListener("abort", onAbort); }
}

export class CopilotTools {
	readonly tools: Tool[] = [];
	result?: ExecutorResult;
	#closed = false;
	#tail: Promise<unknown> = Promise.resolve();
	#contexts: readonly SessionContext[];

	constructor(
		private readonly request: ExecutorRequest,
		private readonly settings: ToolSettings,
		private readonly signal: AbortSignal,
		private readonly redact: (message: string) => string,
	) {
		if (request.contexts.some(context => !request.stage.options.contexts.includes(context))) {
			throw new Error("Executor contexts must be references declared by this stage");
		}
		this.#contexts = request.contexts;
		this.add("guest_exec", "Run a shell command inside the task MicroVM, never on the host. Commands have a fixed timeout.",
			{ command: string }, ["command"], async args => {
				const output = await request.container.exec("/bin/sh", ["-c", text(args.command, "command")], {
					cwd: settings.cwd, timeoutMs: settings.commandTimeoutMs,
				});
				return { exitCode: output.code, stdout: this.truncate(output.stdout()), stderr: this.truncate(output.stderr()) };
			});
		this.add("guest_read", "Read a UTF-8 file inside the task MicroVM. Paths are guest paths, relative to the guest working directory.",
			{ path: string }, ["path"], async args => {
				const path = this.path(args.path);
				const stream = await request.container.fs().readStream(path);
				const chunks: Uint8Array[] = [];
				let size = 0;
				for await (const chunk of stream) {
					this.signal.throwIfAborted();
					size += chunk.length;
					if (size > settings.maxOutputBytes) throw new Error("File exceeds maxOutputBytes; read a smaller range with guest_exec");
					chunks.push(chunk);
				}
				return Buffer.concat(chunks).toString("utf8");
			});
		this.add("guest_write", "Write a UTF-8 file inside the task MicroVM. Use guest_exec to create parent directories when needed.",
			{ path: string, content: string }, ["path", "content"], async args => {
				if (typeof args.content !== "string" || Buffer.byteLength(args.content) > settings.maxOutputBytes) {
					throw new TypeError("content must be text no larger than maxOutputBytes");
				}
				await request.container.fs().write(this.path(args.path), Buffer.from(args.content));
				return "File written in the task MicroVM";
			});
		this.add("read_context", "Read a declared context by its zero-based index, including any prepared GitHub snapshot.",
			{ context: contextIndex }, ["context"], args => this.snapshot(this.context(args.context)));
		this.add("write_context", "Set a JSON value in a declared context. Write expectations are hints, not permissions.",
			{ context: contextIndex, key: string, value: {} }, ["context", "key", "value"], args => {
				const context = this.context(args.context);
				const key = text(args.key, "key", 128);
				const serialized = this.json(args.value);
				context.data.set(key, JSON.parse(serialized));
				return "Context updated";
			});
		this.add("bind_github", "Bind a declared GitHub context to an existing pull request in a host-authorized repository for later workflow hooks. Credentials are supplied by the host, never in tool arguments.",
			{ context: contextIndex, owner: string, repo: string, pullNumber: { type: "integer", minimum: 1 } },
			["context", "owner", "repo", "pullNumber"], args => this.bindGithub(args));
		this.add("report", "Report task progress to the live factory task view.", { message: string }, ["message"], args => {
			request.report(this.redact(text(args.message, "message", 4096)));
			return "Progress reported";
		});
		if (request.agent.options.mode === "interactive") {
			this.add("ask_user", "Ask the user a question and wait for their actual answer. Never request credentials.",
				{ question: string }, ["question"], args => interruptible(request.ask(this.redact(text(args.question, "question", 4096))), this.signal), true);
		}
		if (request.stage.options.policies?.permissions?.createNewTasks) {
			this.add("create_task", "Submit a new task to the running factory and return its execution ID.",
				{ title: string, description: string, workflow: string }, ["title"], async args => ({
					id: await request.createTask({
						title: text(args.title, "title", 1024),
						description: args.description === undefined ? undefined : text(args.description, "description"),
						workflow: args.workflow === undefined ? undefined : text(args.workflow, "workflow", 256),
					}),
				}));
		}
		this.add("complete_stage", "Finish this agent invocation successfully with a factual summary. Optionally request a permitted return stage by its exact name. Do not call when blocked or refusing the task.",
			{ summary: string, returnTo: string }, ["summary"], args => {
				const output = this.redact(text(args.summary, "summary", settings.maxOutputBytes));
				let returnTo;
				if (args.returnTo !== undefined) {
					const name = text(args.returnTo, "returnTo", 256);
					const candidates = (request.stage.options.policies?.returns?.() ?? [])
						.filter(stage => request.workflow.options.stages.includes(stage) && stage.options.name === name);
					if (candidates.length !== 1) throw new Error("returnTo must identify exactly one permitted stage in this workflow");
					returnTo = candidates[0];
				}
				this.result = { output, ...(returnTo ? { returnTo } : {}) };
				return "Stage completion recorded";
			}, false, true);
	}

	contextDescriptions(): unknown[] {
		return this.#contexts.map((context, index) => ({ index, description: context.options.description,
			writeExpected: context.writeExpected, github: context instanceof GithubContext }));
	}

	close(): void { this.#closed = true; }
	async drain(): Promise<void> { await this.#tail; }

	private add(name: string, description: string, properties: Record<string, unknown>, required: string[],
		action: (args: Record<string, unknown>) => unknown, overridesBuiltInTool = false, isTerminal = false): void {
		this.tools.push({ name, description, parameters: { type: "object", properties, required, additionalProperties: false },
			defer: "never", overridesBuiltInTool, isTerminal,
			handler: (input, invocation) => {
				const operation = this.#tail.then(async (): Promise<ToolResultObject> => {
					try {
						this.signal.throwIfAborted();
						invocation.signal?.throwIfAborted();
						if (this.#closed || this.result) throw new Error("Agent invocation has ended; no further tools may run");
						const args = object(input);
						if (Object.keys(args).some(key => !Object.hasOwn(properties, key)) || required.some(key => !Object.hasOwn(args, key))) {
							throw new TypeError("Tool arguments do not match the declared schema");
						}
						this.json(args);
						const value = await action(args);
						this.signal.throwIfAborted();
						return { resultType: "success", textResultForLlm: this.redact(this.json(value)) };
					} catch (error) {
						return { resultType: "failure", textResultForLlm: this.redact(this.truncate(error instanceof Error ? error.message : "Tool failed")) };
					}
				});
				this.#tail = operation;
				return operation;
			},
		});
	}

	private context(index: unknown): SessionContext {
		if (typeof index !== "number" || !Number.isSafeInteger(index) || !this.#contexts[index]) {
			throw new RangeError("context must be the index of a context declared by this stage");
		}
		return this.#contexts[index]!;
	}

	private snapshot(context: SessionContext): unknown {
		return { data: Object.fromEntries(context.data), ...(context instanceof GithubContext ? {
			github: { bound: context.bound, snapshot: context.snapshot, approval: context.approval, mergeResult: context.mergeResult },
		} : {}) };
	}

	private bindGithub(args: Record<string, unknown>): unknown {
		const context = this.context(args.context);
		if (!(context instanceof GithubContext)) throw new TypeError("Selected context is not a Github.SessionContext");
		if (!this.settings.githubToken) throw new Error("PR binding requires CopilotExecutor({ githubToken }); supply the token on the host, not in chat");
		if (typeof args.pullNumber !== "number" || !Number.isSafeInteger(args.pullNumber) || args.pullNumber <= 0) {
			throw new TypeError("pullNumber must be a positive safe integer");
		}
		const owner = text(args.owner, "owner", 100);
		const repo = text(args.repo, "repo", 100);
		if (!this.settings.repositories.has(`${owner}/${repo}`.toLowerCase())) {
			throw new Error("Repository is not authorized for model binding; ask the host to add its exact owner/repo to CopilotExecutor({ repositories: [...] })");
		}
		context.bind({ owner, repo,
			pullNumber: args.pullNumber, token: this.settings.githubToken, apiBaseUrl: this.settings.githubApiBaseUrl });
		return { bound: context.bound };
	}

	private path(value: unknown): string {
		const path = text(value, "path", 4096);
		if (path.includes("\0")) throw new TypeError("Guest paths cannot contain NUL");
		return posix.resolve(this.settings.cwd, path);
	}

	private json(value: unknown): string {
		const serialized = JSON.stringify(value);
		if (serialized === undefined || Buffer.byteLength(serialized) > this.settings.maxOutputBytes) {
			throw new Error("Tool data must be JSON serializable and fit maxOutputBytes");
		}
		return serialized;
	}

	private truncate(value: string): string {
		const safe = this.redact(value);
		const bytes = Buffer.from(safe);
		const limit = Math.floor(this.settings.maxOutputBytes / 4);
		return bytes.length > limit ? `${bytes.subarray(0, limit).toString("utf8")}\n[truncated]` : safe;
	}
}