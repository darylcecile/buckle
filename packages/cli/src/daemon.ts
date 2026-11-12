import { fork } from "node:child_process";
import { readSnapshot, type ServiceSnapshot } from "./ipc.js";
import { resolveFactoryPath } from "./load.js";

/** Startup messages use the launcher channel only; task workers remain attached to the daemon. */
export type DaemonMessage = { type: "ready" } | { type: "error"; error: string; code?: string };

/** Attaches to the existing owner, or starts one detached daemon when its endpoint is absent. */
export async function ensureDaemon(file: string): Promise<ServiceSnapshot> {
	file = await resolveFactoryPath(file);
	try { return await readSnapshot(file); }
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ECONNREFUSED") throw new Error(`${(error as Error).message}. The socket may be stale; verify its owner is stopped before manually removing it.`, { cause: error });
		if (code !== "ENOENT") throw error;
	}
	try { await launchDaemon(file); }
	catch (error) {
		// Another launcher can win the socket between our initial read and listen.
		if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
	}
	return readSnapshot(file);
}

function launchDaemon(file: string): Promise<void> {
	const child = fork(new URL("./daemon-entry.js", import.meta.url), [file], {
		detached: true, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"],
	});
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (child.connected) child.disconnect();
			child.unref();
			if (error) reject(error);
			else resolve();
		};
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			finish(new Error(`Daemon startup timed out; process ${child.pid ?? "unknown"} was asked to stop. Check status before starting again.`));
		}, 15000);
		child.on("error", finish);
		child.once("exit", (code, signal) => finish(new Error(`Daemon exited before becoming ready (${signal ?? code})`)));
		child.on("message", (message: DaemonMessage) => {
			if (message.type === "ready") finish();
			if (message.type === "error") finish(Object.assign(new Error(message.error), { code: message.code }));
		});
	});
}
