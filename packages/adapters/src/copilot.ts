import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, posix } from "node:path";
import type { Executor, ExecutorRequest, ExecutorResult } from "@buckles/factory";
import type { CopilotClient, CopilotClientOptions, CopilotSession, ModelInfo, SessionConfig } from "@github/copilot-sdk";
import { CopilotTools, interruptible, type ToolSettings } from "./copilot-tools.js";
import { CopilotBudget } from "./copilot-budget.js";
import { RepositoryWorkspaces, repositoryName, type RepositoryOptions } from "./repository.js";
import { redactSecrets, resolveGithubToken } from "./repository-auth.js";

/** @internal Lazy SDK client boundary. Importing an adapter or factory does not load the SDK. */
export const copilotSdk = {
	async create(options: CopilotClientOptions): Promise<CopilotClient> {
		const { CopilotClient } = await import("@github/copilot-sdk");
		return new CopilotClient(options);
	},
};

/** Host-only configuration for the official GitHub Copilot SDK executor. */
export interface CopilotExecutorOptions {
	/** Optional runtime executable. Omit to use the SDK's bundled runtime (or COPILOT_CLI_PATH). */
	cliPath?: string;
	/** Optional Copilot authentication token. Omission uses stored login; ambient GitHub auth tokens are excluded. */
	copilotToken?: string;
	/** Optional REST token for bind_github and later GitHub workflow hooks; never sent to tools or the guest. */
	githubToken?: string;
	/** Explicit opt-in to resolve the host's active gh login at execution time. githubToken takes precedence. */
	githubAuth?: "cli";
	/** Materialize an authenticated repository in each task VM. An empty object discovers the host cwd's GitHub origin lazily. */
	repository?: RepositoryOptions;
	/** Additional exact owner/repo names authorized for model binding, case-insensitive. The configured repository is also authorized. Host-bound contexts are unaffected. */
	repositories?: readonly string[];
	/** Trusted GitHub REST API root for PR binding; defaults to https://api.github.com. */
	githubApiBaseUrl?: string;
	/** Runtime login/data directory. Defaults to COPILOT_HOME or ~/.copilot at execution time. No credentials are copied. */
	baseDirectory?: string;
	/** Absolute guest working directory, created if absent. Defaults to /workspace. Only configured repository Git history is uploaded. */
	cwd?: string;
	/** Active-work budget including model setup, VM startup, and tools; pauses while awaiting a human answer, then resumes its remainder. Default: 600000ms. */
	timeoutMs?: number;
	/** Guest command timeout, including initial directory creation; default 30000ms. */
	commandTimeoutMs?: number;
	/** VM startup budget passed to MicroVM.start; default 120000ms. */
	startupTimeoutMs?: number;
	/** Budget for each provider cleanup operation before force-stop fallback; default 10000ms. */
	shutdownTimeoutMs?: number;
	/** Maximum JSON tool input/result and UTF-8 file bytes; default 65536, range 1024-16777216. Command output is truncated. */
	maxOutputBytes?: number;
}

function duration(value: number | undefined, fallback: number): number {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result <= 0 || result > 2_147_483_647) {
		throw new RangeError("Executor timeouts must be positive 32-bit millisecond integers");
	}
	return result;
}

function allowedRepositories(values: readonly string[] = []): ReadonlySet<string> {
	if (!Array.isArray(values) || values.some(value => typeof value !== "string" || value !== value.trim()
		|| !/^[a-z\d](?:[a-z\d-]*[a-z\d])?\/(?!\.{1,2}$)[a-z\d._-]+$/i.test(value))) {
		throw new TypeError("repositories must be an array of exact owner/repo names without URLs, wildcards, or empty values");
	}
	return new Set(values.map(value => value.toLowerCase()));
}

function validateModel(models: ModelInfo[], request: ExecutorRequest): void {
	const requested = request.agent.options.model;
	const model = models.find(model => model.id === requested.id);
	if (!model || model.policy?.state === "disabled") throw new Error(`Copilot model ${requested.id} is unavailable; choose an available model explicitly`);
	if (!model.capabilities.supports.reasoningEffort || !model.supportedReasoningEfforts?.includes(requested.options.variant)) {
		throw new Error(`Copilot model ${requested.id} does not advertise reasoning variant ${requested.options.variant}; choose a supported variant explicitly`);
	}
}

async function deadline<Result>(operation: Promise<Result>, milliseconds: number): Promise<Result> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("Copilot provider cleanup timed out")), milliseconds);
	try { return await interruptible(operation, controller.signal); }
	finally { clearTimeout(timer); }
}

/**
 * Runs Github.model agents using the official SDK with a custom-tool-only allowlist.
 * Construction is inert. Each execute call owns its provider client and session, but
 * only starts (never destroys) the caller's task VM. Guest files come from its image
 * or an explicit repository's Git history; no dirty host files, environment, or credentials are copied.
 * Interactive agents can ask the runtime's user; self-driving agents cannot fabricate
 * answers. A successful invocation requires complete_stage, not merely an idle model.
 * Cancellation aborts the provider and drains admitted guest operations before release;
 * native startup/filesystem/command settlement can outlast the invocation deadline.
 */
export class CopilotExecutor implements Executor {
	#options: Readonly<CopilotExecutorOptions>;
	#tools: ToolSettings;
	#timeoutMs: number;
	#startupTimeoutMs: number;
	#shutdownTimeoutMs: number;
	#repositories = new RepositoryWorkspaces();

	/** Captures private options without loading the SDK, reading prompts, authenticating, or starting a VM. */
	constructor(options: CopilotExecutorOptions = {}) {
		const cwd = options.cwd ?? "/workspace";
		if (!posix.isAbsolute(cwd) || cwd.includes("\0")) throw new TypeError("cwd must be an absolute guest path without NUL");
		if (options.baseDirectory !== undefined && !isAbsolute(options.baseDirectory)) throw new TypeError("baseDirectory must be absolute");
		if (options.githubAuth !== undefined && options.githubAuth !== "cli") throw new TypeError('githubAuth must be "cli" when supplied');
		if (options.repository?.name !== undefined) repositoryName(options.repository.name);
		if (options.repository?.cwd !== undefined && !isAbsolute(options.repository.cwd)) throw new TypeError("repository.cwd must be an absolute host path");
		if (options.repository?.bootstrap !== undefined && (!Array.isArray(options.repository.bootstrap) || options.repository.bootstrap.some(command => typeof command !== "string" || !command.trim()))) {
			throw new TypeError("repository.bootstrap must be an array of nonempty trusted guest commands");
		}
		for (const name of ["cliPath", "copilotToken", "githubToken"] as const) {
			if (options[name] !== undefined && (typeof options[name] !== "string" || !options[name]!.trim())) {
				throw new TypeError(`${name} must be nonempty when supplied`);
			}
		}
		const maxOutputBytes = options.maxOutputBytes ?? 65_536;
		if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 16_777_216) {
			throw new RangeError("maxOutputBytes must be an integer from 1024 to 16777216");
		}
		this.#options = Object.freeze({ ...options, repository: options.repository && Object.freeze({ ...options.repository, bootstrap: options.repository.bootstrap && Object.freeze([...options.repository.bootstrap]) }) });
		this.#timeoutMs = duration(options.timeoutMs, 600_000);
		this.#startupTimeoutMs = duration(options.startupTimeoutMs, 120_000);
		this.#shutdownTimeoutMs = duration(options.shutdownTimeoutMs, 10_000);
		this.#tools = { cwd, maxOutputBytes, commandTimeoutMs: duration(options.commandTimeoutMs, 30_000),
			githubToken: options.githubToken, githubApiBaseUrl: options.githubApiBaseUrl, repositories: allowedRepositories(options.repositories) };
	}

	/** Executes one prepared agent, validating its exact model/variant and requiring explicit stage completion. */
	async execute(request: ExecutorRequest): Promise<ExecutorResult> {
		if (request.agent.options.model.provider !== "github-copilot") throw new Error("CopilotExecutor requires a Github.model (github-copilot provider)");
		request.signal.throwIfAborted();
		const controller = new AbortController();
		const signal = AbortSignal.any([request.signal, controller.signal]);
		const secrets = [this.#options.copilotToken, this.#options.githubToken];
		const redact = (message: string) => redactSecrets(message, secrets);
		const settings = { ...this.#tools, repositories: new Set(this.#tools.repositories) };
		const tools = new CopilotTools({ ...request, ask: async question => {
			budget.pause();
			try {
				signal.throwIfAborted();
				return await interruptible(request.ask(question), signal);
			} finally { budget.resume(); }
		} }, settings, signal, redact);
		const budget = new CopilotBudget(this.#timeoutMs, signal, () => controller.abort(new Error("Copilot execution timed out")));
		let client: CopilotClient | undefined;
		let session: CopilotSession | undefined;
		let work: Promise<ExecutorResult> | undefined;
		let directory: string | undefined;
		let result: ExecutorResult | undefined;
		const errors: unknown[] = [];
		try {
			directory = await mkdtemp(join(tmpdir(), "buckles-copilot-"));
			const env = { ...process.env };
			for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "COPILOT_GITHUB_TOKEN"]) delete env[name];
			client = await copilotSdk.create({
				connection: { kind: "stdio", path: this.#options.cliPath },
				env,
				mode: "empty", logLevel: "none", workingDirectory: directory,
				baseDirectory: this.#options.baseDirectory ?? process.env.COPILOT_HOME ?? join(homedir(), ".copilot"),
				gitHubToken: this.#options.copilotToken,
				useLoggedInUser: this.#options.copilotToken === undefined,
			});
			const ownedClient = client;
			const configuration = this.sessionConfig(request, tools, directory, signal);
			work = (async () => {
				signal.throwIfAborted();
				await ownedClient.start();
				signal.throwIfAborted();
				validateModel(await ownedClient.listModels(), request);
				signal.throwIfAborted();
				settings.githubToken = await resolveGithubToken(this.#options, signal);
				secrets.push(settings.githubToken);
				signal.throwIfAborted();
				request.report("Starting task MicroVM");
				await request.container.start(this.#startupTimeoutMs);
				signal.throwIfAborted();
				const directoryResult = await request.container.exec("mkdir", ["-p", "--", this.#tools.cwd], { timeoutMs: this.#tools.commandTimeoutMs });
				if (directoryResult.code !== 0) throw new Error("Could not create the guest working directory");
				signal.throwIfAborted();
				if (this.#options.repository) {
					request.report("Preparing authenticated repository checkout in the task MicroVM");
					tools.repository = await this.#repositories.prepare(request, this.#options.repository, settings, directory!, signal);
					settings.repositories.add(tools.repository.metadata.name.toLowerCase());
				}
				session = await ownedClient.createSession(configuration);
				signal.throwIfAborted();
				request.report(`Running ${request.agent.options.name} with ${request.agent.options.model.id}`);
				// SDK 1.0.29 chunks Infinity safely; our cancellable active-work budget owns the deadline.
				const response = await session.sendAndWait({ prompt: redact(JSON.stringify({ task: request.task, agent: request.agent.options.name,
					role: request.agent.options.role, stage: request.stage.options.name, contexts: tools.contextDescriptions(),
					repository: tools.repository?.metadata, handoff: request.handoff,
					permittedReturnStages: (request.stage.options.policies?.returns?.() ?? [])
						.filter(stage => request.workflow.options.stages.includes(stage)).map(stage => stage.options.name),
				})) }, Infinity);
				await tools.drain();
				signal.throwIfAborted();
				if (tools.blocked) throw new Error(`Copilot stage blocked: ${tools.blocked}`);
				if (!tools.result) {
					const final = Buffer.from(redact(response?.data.content ?? "")).subarray(-Math.min(settings.maxOutputBytes, 8192)).toString("utf8");
					throw new Error(`Copilot ended without complete_stage; the stage was not completed${final ? `\nFinal assistant response: ${final}` : ""}`);
				}
				return tools.result;
			})();
			result = await interruptible(work, signal);
		} catch (error) {
			errors.push(error);
			controller.abort(error);
		} finally {
			budget.dispose();
			tools.close();
			const cleanup = async (operation: () => Promise<unknown>) => {
				try { await deadline(operation(), this.#shutdownTimeoutMs); }
				catch (error) { errors.push(error); }
			};
			if (session && signal.aborted) await cleanup(() => session!.abort());
			await tools.drain();
			const beforeCleanup = errors.length;
			if (session) {
				await cleanup(() => session!.disconnect());
			}
			if (client) {
				await cleanup(async () => { errors.push(...await client!.stop()); });
				if (errors.length > beforeCleanup) await cleanup(() => client!.forceStop());
			}
			await work?.catch(() => undefined);
			// Remove configDirectory's persisted session state after the client shuts down.
			if (directory) await cleanup(() => rm(directory!, { recursive: true, force: true }));
		}
		if (errors.length > 1) throw new AggregateError(errors.map(error => this.safeError(error, redact)), "Copilot execution or cleanup failed");
		if (errors.length === 1) throw this.safeError(errors[0], redact);
		request.signal.throwIfAborted();
		return result!;
	}

	private sessionConfig(request: ExecutorRequest, tools: CopilotTools, directory: string, signal: AbortSignal): SessionConfig {
		const allowed = new Set(tools.tools.map(tool => tool.name));
		return {
			model: request.agent.options.model.id, allowedModels: [request.agent.options.model.id],
			reasoningEffort: request.agent.options.model.options.variant,
			workingDirectory: directory, configDirectory: directory,
			tools: tools.tools, availableTools: [...allowed].map(name => `custom:${name}`), excludedTools: ["builtin:*", "mcp:*"],
			mcpServers: {}, customAgents: [], enableConfigDiscovery: false, skipCustomInstructions: true,
			enableSkills: false, enableFileHooks: false, enableHostGitOperations: false,
			enableOnDemandInstructionDiscovery: false, enableSessionStore: false, enableSessionTelemetry: false,
			memory: { enabled: false }, infiniteSessions: { enabled: false }, largeOutput: { enabled: false },
			onPermissionRequest: permission => {
				if (!signal.aborted && !tools.ended && permission.kind === "custom-tool"
					&& allowed.has(permission.toolName) && permission.managedApprovalRequired !== true) {
					return { kind: "approve-once" };
				}
				return { kind: "reject", feedback: "Only this invocation's declared VM and task tools are permitted" };
			},
			hooks: { onPreToolUse: input => signal.aborted || tools.ended || !allowed.has(input.toolName) ? { permissionDecision: "deny" } : undefined },
			systemMessage: { mode: "append", content: `${request.instructions}\n\n` +
				`All code, files, shell commands, and repository operations must use guest tools in the task MicroVM at ${this.#tools.cwd}. ` +
				"If repository metadata is supplied, the guest already contains the exact Git checkout and its history; preserve work from prior stages. Otherwise the guest contains only its image and prior work. No dirty host files or credentials are uploaded. " +
				"Use read_context/write_context for declared shared state; use bind_github to select a PR for GitHub workflow hooks. " +
				"Use publish_pull_request when available to commit explicit changed files, run real guest verification commands, and publish or repair the same task PR. Guest Git has no credentials; never use guest git push for authenticated publication. " +
				"Never ask for tokens or place credentials in tool arguments. Use report for progress. " +
				"Call complete_stage with a factual summary only when this invocation has succeeded, or request a permitted return stage by name. " +
				"If blocked, call block_stage with the concrete reason and do not claim completion. A handoff in the request is the actual prior agent output; address it before completing a return. " +
				(request.agent.options.mode === "interactive" ? "Use ask_user when a human decision is needed." : "This is self-driving mode; no human answer is available during this invocation.") },
		};
	}

	private safeError(error: unknown, redact: (message: string) => string): Error {
		if (error instanceof AggregateError) return new AggregateError(error.errors.map(error => this.safeError(error, redact)), redact(error.message));
		return new Error(redact(error instanceof Error ? error.message : "Copilot execution failed"));
	}
}
