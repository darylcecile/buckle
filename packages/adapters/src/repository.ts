import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExecutorRequest } from "@buckles/factory";
import { bounded, Client, identifier, record, text } from "./client.js";
import { act, SessionContext } from "./github.js";
import { gitEnvironment, repositoryHost } from "./repository-auth.js";

export interface RepositoryOptions {
	/** Exact authorized owner/repo. Omit to derive the configured host checkout's GitHub origin. */
	name?: string;
	/** Host checkout used only to discover origin; no working files are copied. Defaults to process.cwd(). */
	cwd?: string;
	/** Target branch. Omit to use GitHub's default branch. */
	baseBranch?: string;
	/** Trusted guest setup commands, run once per owned VM before its first checkout. */
	bootstrap?: readonly string[];
}

export interface RepositoryMetadata {
	name: string;
	baseBranch: string;
	baseSha: string;
	headSha: string;
	branch: string;
	pullNumber?: number;
	workspace: string;
}

interface Workspace extends RepositoryMetadata {
	taskId: string;
	review: boolean;
}

interface Settings {
	cwd: string;
	commandTimeoutMs: number;
	githubToken?: string;
	githubApiBaseUrl?: string;
}

export interface Publication {
	title: string;
	body: string;
	paths: readonly string[];
	checks: readonly string[];
}

const gitOptions = ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "init.templateDir=", "-c", "maintenance.auto=false", "-c", "gc.auto=0"];

export function repositoryName(value: string): string {
	if (value !== value.trim() || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?\/(?!\.{1,2}$)[a-z\d._-]+$/i.test(value)) {
		throw new TypeError("repository.name must be an exact owner/repo name");
	}
	return value;
}

function originName(remote: string, hostname: string): string {
	const ssh = /^git@([^:]+):(.+)$/.exec(remote);
	const url = ssh ? new URL(`ssh://git@${ssh[1]}/${ssh[2]}`) : new URL(remote);
	if (url.hostname !== hostname || !["https:", "ssh:"].includes(url.protocol) || url.password || url.search || url.hash) {
		throw new Error("repository.cwd origin must identify the configured GitHub host");
	}
	return repositoryName(url.pathname.slice(1).replace(/\.git$/, ""));
}

function sha(value: string): string {
	if (!/^[a-f\d]{40}$/i.test(value)) throw new Error("Expected a full Git commit SHA");
	return value;
}

function branch(value: string): string {
	if (!value || value.startsWith("-") || /[\s\x00-\x1f~^:?*\[\\]/.test(value) || value.includes("..") || value.includes("@{") || value.endsWith("/") || value.endsWith(".") || value.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock"))) {
		throw new Error("Invalid repository branch name");
	}
	return value;
}

function taskBranch(taskId: string): string {
	return `buckles/task-${createHash("sha256").update(taskId).digest("hex").slice(0, 24)}`;
}

/** Executor-local ownership; shared VMs keep edits, independent review VMs receive exact PR heads. */
export class RepositoryWorkspaces {
	#workspaces = new WeakMap<ExecutorRequest["container"], Workspace>();
	#bootstrapped = new WeakSet<ExecutorRequest["container"]>();

	async prepare(request: ExecutorRequest, options: RepositoryOptions, settings: Settings, directory: string, signal: AbortSignal): Promise<RepositorySession> {
		if (!settings.githubToken) throw new Error('Repository checkout requires githubToken or githubAuth: "cli" on CopilotExecutor');
		const hostname = settings.githubApiBaseUrl ? new URL(settings.githubApiBaseUrl).hostname.replace(/^api\.github\.com$/, "github.com") : "github.com";
		const origin = options.name ?? originName(await repositoryHost.run("git", [...gitOptions, "config", "--local", "--no-includes", "--get", "remote.origin.url"], {
			cwd: options.cwd ?? process.cwd(), env: gitEnvironment(), signal, timeoutMs: settings.commandTimeoutMs,
		}), hostname);
		const name = repositoryName(origin);
		const existing = this.#workspaces.get(request.container);
		if (existing && (existing.taskId !== request.task.id || existing.name.toLowerCase() !== name.toLowerCase())) {
			throw new Error("Guest repository workspace belongs to a different task or repository");
		}
		const session = new RepositorySession(request, settings, directory, signal, name, hostname, existing);
		if (!this.#bootstrapped.has(request.container)) {
			for (const command of options.bootstrap ?? []) await session.command(command);
			this.#bootstrapped.add(request.container);
		}
		const workspace = await session.prepare(options);
		this.#workspaces.set(request.container, workspace);
		return session;
	}
}

export class RepositorySession {
	#client: Client;
	#bare: string;
	#initialized = false;
	#remote: string;
	#workspace?: Workspace;
	#currentHead?: string;

	constructor(private readonly request: ExecutorRequest, private readonly settings: Settings, private readonly directory: string,
		private readonly signal: AbortSignal, private readonly name: string, hostname: string, workspace?: Workspace) {
		const [owner, repo] = name.split("/");
		// Reuse the adapter's authenticated, bounded transport. Repository calls do not use pullPath.
		this.#client = new Client({ owner: owner!, repo: repo!, pullNumber: 1, token: settings.githubToken!, apiBaseUrl: settings.githubApiBaseUrl });
		this.#bare = join(directory, "repository.git");
		this.#remote = `https://${hostname}/${name}.git`;
		this.#workspace = workspace;
	}

	get metadata(): RepositoryMetadata {
		const { taskId: _taskId, review: _review, ...metadata } = this.workspace();
		return { ...metadata, headSha: this.#currentHead ?? metadata.headSha };
	}

	async command(command: string): Promise<{ stdout: string; stderr: string }> {
		this.signal.throwIfAborted();
		const result = await this.request.container.exec("/bin/sh", ["-c", command], { cwd: this.settings.cwd, timeoutMs: this.settings.commandTimeoutMs });
		this.signal.throwIfAborted();
		if (result.code !== 0) throw new Error(`Guest command failed (exit ${result.code}): ${command}\n${result.stdout()}\n${result.stderr()}`);
		return { stdout: result.stdout(), stderr: result.stderr() };
	}

	async prepare(options: RepositoryOptions): Promise<Workspace> {
		const bound = this.request.contexts.find((context): context is SessionContext => context instanceof SessionContext && context.bound);
		const binding = bound?.binding;
		if (binding && `${binding.owner}/${binding.repo}`.toLowerCase() !== this.name.toLowerCase()) {
			throw new Error("Bound pull request does not match the configured repository");
		}
		if (this.#workspace && !this.#workspace.review) {
			this.#currentHead = sha(await this.guestGit(["rev-parse", "HEAD"]));
			return this.#workspace;
		}
		const pull = binding ? record(await this.#client.get(`${this.#client.repoPath}/pulls/${binding.pullNumber}`, this.signal)) : undefined;
		const baseBranch = branch(pull ? text(record(pull.base).ref) : options.baseBranch ?? text(record(await this.#client.get(this.#client.repoPath, this.signal)).default_branch));
		if (pull && options.baseBranch && baseBranch !== options.baseBranch) throw new Error("Bound PR targets a different repository.baseBranch");
		const targetHead = pull ? sha(text(record(pull.head).sha)) : undefined;
		const targetBase = pull ? sha(text(record(pull.base).sha)) : undefined;
		await this.initHost();
		await this.hostGit(["fetch", "--no-tags", this.#remote, `+refs/heads/${baseBranch}:refs/heads/${baseBranch}`]);
		const baseSha = sha(await this.hostGit(["rev-parse", `refs/heads/${baseBranch}`]));
		if (targetBase) await this.hostGit(["merge-base", "--is-ancestor", targetBase, baseSha]);
		if (this.#workspace && this.#workspace.headSha === targetHead && this.#workspace.baseSha === baseSha) {
			await this.assertCleanSource();
			if (sha(await this.guestGit(["rev-parse", "HEAD"])) !== targetHead) throw new Error("Review checkout no longer matches the pull request head");
			return this.#workspace;
		}
		if (pull) {
			await this.hostGit(["fetch", "--no-tags", this.#remote, `+refs/pull/${binding!.pullNumber}/head:refs/heads/buckles-review-head`]);
			if (sha(await this.hostGit(["rev-parse", "refs/heads/buckles-review-head"])) !== targetHead) throw new Error("PR head changed during checkout; retry with a fresh snapshot");
		}
		const headSha = targetHead ?? baseSha;
		await this.transferCheckout(baseBranch, headSha, Boolean(this.#workspace));
		this.#workspace = { name: this.name, baseBranch, baseSha, headSha, branch: taskBranch(this.request.task.id),
			workspace: this.settings.cwd, taskId: this.request.task.id, review: Boolean(pull), pullNumber: binding?.pullNumber };
		return this.#workspace;
	}

	async publish(context: SessionContext, publication: Publication): Promise<unknown> {
		const workspace = this.workspace();
		if (workspace.review) throw new Error("Publication requires the task's implementation workspace, not a review checkout");
		if (await this.guestGit(["branch", "--show-current"]) !== workspace.branch) throw new Error("Switch back to the task-owned branch before publication");
		this.validatePublication(publication);
		const binding = context.binding;
		if (binding && (`${binding.owner}/${binding.repo}`.toLowerCase() !== this.name.toLowerCase() || binding.pullNumber !== workspace.pullNumber)) {
			throw new Error("Selected context is bound to a different pull request");
		}
		const checks = await this.commitAndVerify(publication);
		const headSha = sha(await this.guestGit(["rev-parse", "HEAD"]));
		await this.pushCommit(headSha);
		const pull = await this.pullRequest(publication, headSha);
		workspace.headSha = headSha;
		this.#currentHead = headSha;
		workspace.pullNumber = identifier(pull.number);
		const [owner, repo] = this.name.split("/");
		if (!context.bound) context.bind({ owner: owner!, repo: repo!, pullNumber: workspace.pullNumber, token: this.settings.githubToken!, apiBaseUrl: this.settings.githubApiBaseUrl });
		await this.#client.request(`${this.#client.repoPath}/statuses/${headSha}`, "POST", {
			state: "success", context: "buckles/verification", description: `${checks.length} guest verification command(s) passed on this commit`,
		}, this.signal);
		await act.ReadyForAgents(context);
		await act.RequestCopilotReview(context);
		return { ...this.metadata, url: text(pull.html_url), verification: { headSha, checks } };
	}

	private validatePublication(publication: Publication): void {
		if (!publication.paths.length || publication.paths.some(path => !path || path !== posix.normalize(path) || path.startsWith("/") || path.startsWith("../") || path === "." || path.split("/").includes(".git") || path.includes("\0"))) {
			throw new Error("Publication paths must be explicit repository-relative changed file paths");
		}
		if (!publication.checks.length || publication.checks.some(command => !command.trim())) throw new Error("Publication requires at least one nonempty verification command");
	}

	private async commitAndVerify(publication: Publication): Promise<unknown[]> {
		const paths = [...new Set(publication.paths)];
		await this.guestGit(["--literal-pathspecs", "add", "--", ...paths]);
		const staged = (await this.guestGit(["diff", "--cached", "--name-only", "--no-renames", "-z"])).split("\0").filter(Boolean);
		if (staged.some(path => !paths.includes(path))) throw new Error("Index contains files not listed in publication.paths; explicitly list every changed file");
		if (staged.length) await this.guestGit(["-c", "user.name=Buckles", "-c", "user.email=buckles@users.noreply.github.com", "-c", "commit.gpgSign=false", "commit", "-m", publication.title]);
		const committed = (await this.guestGit(["diff", "--name-only", "--no-renames", "-z", this.workspace().headSha, "HEAD"])).split("\0").filter(Boolean);
		if (committed.some(path => !paths.includes(path))) throw new Error("Task commits contain changed files not listed in publication.paths");
		await this.assertCleanSource(true);
		const before = await this.guestGit(["rev-parse", "HEAD"]);
		const checks = [];
		for (const command of publication.checks) {
			const output = await this.command(command);
			checks.push({ command, exitCode: 0, stdout: output.stdout.slice(-4096), stderr: output.stderr.slice(-4096) });
		}
		await this.assertCleanSource();
		if (before !== await this.guestGit(["rev-parse", "HEAD"])) throw new Error("Verification commands changed HEAD; publish and verify the intended commit again");
		return checks;
	}

	private async assertCleanSource(includeUntracked = false): Promise<void> {
		if (await this.guestGit(["status", "--porcelain", `--untracked-files=${includeUntracked ? "normal" : "no"}`])) {
			throw new Error(includeUntracked
				? "Working tree contains unpublished source; list and commit intended files or remove untracked extras before verification"
				: "Tracked source differs from the commit; commit the intended source and rerun verification");
		}
	}

	private async pushCommit(headSha: string): Promise<void> {
		await this.initHost();
		const workspace = this.workspace();
		const guestBundle = posix.join(this.settings.cwd, ".git", "buckles-publish.bundle");
		const bundle = join(this.directory, "publish.bundle");
		await this.guestGit(["bundle", "create", guestBundle, `refs/heads/${workspace.branch}`]);
		await this.request.container.download(guestBundle, bundle);
		await this.hostGit(["fetch", "--no-tags", bundle, `refs/heads/${workspace.branch}:refs/heads/buckles-publish`]);
		if (sha(await this.hostGit(["rev-parse", "refs/heads/buckles-publish"])) !== headSha) throw new Error("Transferred commit does not match the verified head");
		await this.hostGit(["fetch", "--no-tags", this.#remote, `refs/heads/${workspace.baseBranch}:refs/heads/buckles-base`]);
		await this.hostGit(["merge-base", "--is-ancestor", workspace.baseSha, headSha]);
		if (workspace.branch === workspace.baseBranch) throw new Error("Task branch cannot equal the base branch");
		// No force-push: repair commits must descend from the last published head.
		await this.hostGit(["push", this.#remote, `refs/heads/buckles-publish:refs/heads/${workspace.branch}`]);
	}

	private async pullRequest(publication: Publication, headSha: string): Promise<Record<string, unknown>> {
		const workspace = this.workspace();
		const owner = this.name.split("/")[0]!;
		const candidates = await this.#client.list(`${this.#client.repoPath}/pulls?state=all&head=${encodeURIComponent(`${owner}:${workspace.branch}`)}`, undefined, this.signal);
		if (candidates.length > 1) throw new Error("More than one pull request uses the task branch");
		let pull = candidates.length ? record(candidates[0]) : undefined;
		if (pull) this.assertTaskPull(pull);
		if (!pull) pull = record((await this.#client.request(`${this.#client.repoPath}/pulls`, "POST", {
			title: publication.title, body: publication.body, head: workspace.branch, base: workspace.baseBranch,
		}, this.signal)).data);
		this.assertTaskPull(pull);
		if (sha(text(record(pull.head).sha)) === headSha) return pull;
		const pullNumber = identifier(pull.number);
		return bounded(this.settings.commandTimeoutMs,
			`GitHub did not report verified head ${headSha} for task PR #${pullNumber} before timeout or cancellation; confirm the pushed branch and retry publication`,
			async signal => {
				while (true) {
					const current = record(await this.#client.get(`${this.#client.repoPath}/pulls/${pullNumber}`, signal));
					this.assertTaskPull(current, pullNumber);
					if (sha(text(record(current.head).sha)) === headSha) return current;
					await delay(this.#client.pollInterval, undefined, { signal });
				}
			}, this.signal);
	}

	private assertTaskPull(pull: Record<string, unknown>, pullNumber = this.workspace().pullNumber): void {
		const base = record(pull.base);
		const head = record(pull.head);
		if (pull.state !== "open" || pull.merged === true || (pullNumber !== undefined && identifier(pull.number) !== pullNumber)
			|| text(base.ref) !== this.workspace().baseBranch || text(head.ref) !== this.workspace().branch
			|| [base, head].some(ref => text(record(ref.repo).full_name).toLowerCase() !== this.name.toLowerCase())) {
			throw new Error("Pull request is closed or does not match the task repository, branch, and base; confirm its scope before retrying publication");
		}
	}

	private async transferCheckout(baseBranch: string, headSha: string, refresh: boolean): Promise<void> {
		const bundle = join(this.directory, "checkout.bundle");
		const guestBundle = `/tmp/buckles-${randomUUID()}.bundle`;
		await this.hostGit(["bundle", "create", bundle, "--branches"]);
		await this.request.container.upload(bundle, guestBundle);
		const errors: unknown[] = [];
		try {
			if (refresh) {
				await this.assertCleanSource();
				await this.guestGit(["fetch", "--no-tags", guestBundle, `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`, "+refs/heads/buckles-review-head:refs/remotes/origin/buckles-review-head"]);
			} else {
				await this.guestGit(["clone", "--no-checkout", "--branch", baseBranch, guestBundle, this.settings.cwd], "/");
				await this.guestGit(["remote", "set-url", "origin", this.#remote]);
			}
			await this.guestGit(["checkout", "-B", taskBranch(this.request.task.id), headSha]);
			if (sha(await this.guestGit(["rev-parse", "HEAD"])) !== headSha) throw new Error("Guest checkout does not match the requested commit");
		} catch (error) {
			errors.push(error);
		} finally {
			try {
				const result = await this.request.container.exec("rm", ["-f", "--", guestBundle], { timeoutMs: this.settings.commandTimeoutMs });
				if (result.code !== 0) throw new Error("Could not remove guest checkout bundle");
			} catch (error) { errors.push(error); }
		}
		if (errors.length > 1) throw new AggregateError(errors, "Repository checkout or cleanup failed");
		if (errors.length) throw errors[0];
	}

	private workspace(): Workspace {
		if (!this.#workspace) throw new Error("Repository checkout is not prepared");
		return this.#workspace;
	}

	private async initHost(): Promise<void> {
		if (this.#initialized) return;
		await mkdir(this.#bare, { recursive: true });
		await this.hostGit(["init", "--bare", this.#bare]);
		this.#initialized = true;
	}

	private hostGit(args: readonly string[]): Promise<string> {
		this.signal.throwIfAborted();
		return repositoryHost.run("git", [...gitOptions, ...args], { cwd: this.#bare, env: gitEnvironment(this.settings.githubToken), signal: this.signal, timeoutMs: this.settings.commandTimeoutMs });
	}

	private async guestGit(args: readonly string[], cwd = this.settings.cwd): Promise<string> {
		this.signal.throwIfAborted();
		const result = await this.request.container.exec("git", [...gitOptions, ...args], { cwd, env: { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, timeoutMs: this.settings.commandTimeoutMs });
		this.signal.throwIfAborted();
		if (result.code !== 0) throw new Error(`Guest Git failed (exit ${result.code}): ${result.stderr()}`);
		return result.stdout().replace(/\r?\n$/, "");
	}
}
