import { execFile } from "node:child_process";

interface HostCommand {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	signal: AbortSignal;
	timeoutMs: number;
}

/** @internal Trusted process boundary. Never used to execute repository code. */
export const repositoryHost = {
	run(command: "git" | "gh", args: readonly string[], options: HostCommand): Promise<string> {
		return new Promise((resolve, reject) => {
			execFile(command, [...args], { ...options, timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
				if (error) reject(new Error(command === "gh" ? "Could not resolve GitHub CLI authentication; run gh auth login on the host" : `Host Git failed: ${stderr.trim() || error.message}`));
				else resolve(stdout.trim());
			});
		});
	},
};

export function gitEnvironment(token?: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false", GIT_ALLOW_PROTOCOL: "https:file",
		GIT_CONFIG_COUNT: token ? "1" : "0",
	};
	if (token) {
		env.GIT_CONFIG_KEY_0 = "http.extraHeader";
		env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
	}
	return env;
}

export async function resolveGithubToken(options: { githubToken?: string; githubAuth?: "cli"; githubApiBaseUrl?: string }, signal: AbortSignal): Promise<string | undefined> {
	if (options.githubToken) return options.githubToken;
	if (options.githubAuth !== "cli") return undefined;
	const hostname = options.githubApiBaseUrl ? new URL(options.githubApiBaseUrl).hostname.replace(/^api\.github\.com$/, "github.com") : "github.com";
	const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1" };
	for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete env[name];
	const token = await repositoryHost.run("gh", ["auth", "token", "--hostname", hostname], { env, signal, timeoutMs: 30_000 });
	if (!token.trim()) throw new Error("GitHub CLI returned no token; run gh auth login on the host");
	return token.trim();
}

export function redactSecrets(message: string, secrets: readonly (string | undefined)[]): string {
	for (const secret of secrets) {
		if (secret) for (const value of [secret, Buffer.from(`x-access-token:${secret}`).toString("base64")]) message = message.replaceAll(value, "[redacted]");
	}
	return message;
}
