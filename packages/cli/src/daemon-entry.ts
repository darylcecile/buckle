import type { DaemonMessage } from "./daemon.js";
import { serveCommands } from "./ipc.js";
import { loadFactory } from "./load.js";
import { Runtime } from "./runtime.js";
import { errorMessage } from "./types.js";

function notify(message: DaemonMessage): Promise<void> {
	return new Promise(resolve => {
		if (!process.connected || !process.send) { resolve(); return; }
		// A launcher may exit at any time. Its IPC lifetime never owns the daemon.
		process.send(message, () => resolve());
	});
}

async function run(): Promise<number> {
	const file = process.argv[2];
	if (!file) throw new Error("Daemon requires a factory path");
	const runtime = new Runtime(await loadFactory(file), file);
	const server = await serveCommands(file, runtime);
	const shutdown = () => { void server.stop().catch(() => {}); };
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	try {
		await notify({ type: "ready" });
		await server.closed;
		return runtime.list().some(task => task.cleanupErrors.length) ? 1 : 0;
	} finally {
		process.off("SIGINT", shutdown);
		process.off("SIGTERM", shutdown);
	}
}

void run().then(code => process.exit(code), async error => {
	await notify({ type: "error", error: errorMessage(error), code: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined });
	process.exit(1);
});
