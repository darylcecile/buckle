import { createHash } from "node:crypto";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import type { TaskInput } from "@buckles/factory";
import type { Runtime } from "./runtime.js";
import { errorMessage } from "./types.js";

/** Local commands accepted by the owning factory process. */
export type Command = { command: "ping" | "list" | "stop" }
	| { command: "add"; input: TaskInput }
	| { command: "show" | "retry" | "cancel"; id: string }
	| { command: "answer"; id: string; text: string };

type Reply = { ok: true; value: unknown } | { ok: false; error: string };

/** A canonical-path keyed endpoint inside a private per-user temporary directory (POSIX only). */
export async function endpointFor(file: string): Promise<string> {
	if (!process.getuid) throw new Error("Buckles local IPC currently requires macOS or Linux");
	const uid = process.getuid();
	const directory = `/tmp/buckles-${uid}`;
	await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
	const stat = await lstat(directory);
	if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) throw new Error(`Unsafe IPC directory: ${directory}; expected owned directory with mode 0700`);
	return `${directory}/${createHash("sha256").update(file).digest("hex").slice(0, 32)}.sock`;
}

function receiveLine(socket: Socket, limit: number, handle: (text: string) => void): void {
	let buffer = "";
	let received = false;
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		if (received) return;
		buffer += chunk;
		if (Buffer.byteLength(buffer) > limit) { socket.destroy(new Error("IPC message too large")); return; }
		const newline = buffer.indexOf("\n");
		if (newline < 0) return;
		received = true;
		socket.setTimeout(0);
		handle(buffer.slice(0, newline));
	});
}

/** Sends one command. Stop deliberately waits for cooperative cleanup rather than a hard timeout. */
export async function requestCommand(file: string, command: Command): Promise<unknown> {
	const path = await endpointFor(file);
	return new Promise((resolve, reject) => {
		const socket = createConnection(path);
		let replied = false;
		const timer = setTimeout(() => socket.destroy(new Error("Factory connection timed out")), 5000);
		socket.on("connect", () => {
			clearTimeout(timer);
			if (command.command !== "stop") socket.setTimeout(5000, () => socket.destroy(new Error("Factory response timed out")));
			socket.write(`${JSON.stringify(command)}\n`);
		});
		socket.on("error", error => reject(new Error(`Cannot contact factory at ${path}: ${error.message}`)));
		socket.on("close", () => {
			clearTimeout(timer);
			if (!replied) reject(new Error("Factory disconnected before replying; command outcome is unknown"));
		});
		receiveLine(socket, Infinity, text => {
			replied = true;
			try {
				const reply = JSON.parse(text) as Reply;
				if (reply.ok) resolve(reply.value);
				else reject(new Error(reply.error));
			} catch (error) { reject(error); }
			socket.end();
		});
	});
}

/** Running local command service; closed settles after worker cleanup and socket closure. */
export interface CommandServer {
	path: string;
	closed: Promise<void>;
	stop(): Promise<void>;
}

function dispatch(runtime: Runtime, request: Command): unknown {
	switch (request.command) {
		case "ping": return { pid: process.pid };
		case "list": return runtime.list();
		case "show": return runtime.show(request.id);
		case "add": return runtime.add(request.input);
		case "answer": return runtime.answer(request.id, request.text);
		case "retry": return runtime.retry(request.id);
		case "cancel": return runtime.cancel(request.id);
		default: throw new Error("Unknown command");
	}
}

/** Acquires one socket owner; active and stale sockets are reported, never unlinked automatically. */
export async function serveCommands(file: string, runtime: Runtime): Promise<CommandServer> {
	const path = await endpointFor(file);
	let resolveClosed!: () => void;
	let rejectClosed!: (error: Error) => void;
	const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
	let stopping: Promise<void> | undefined;
	const sockets = new Set<Socket>();
	const stop = () => stopping ??= runtime.stop().then(() => new Promise<void>((resolve, reject) => {
		server.close(error => {
			if (error) { rejectClosed(error); reject(error); }
			else { resolveClosed(); resolve(); }
		});
		for (const socket of sockets) socket.end();
	}));
	const server = createServer(socket => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => socket.destroy());
		socket.setTimeout(5000, () => socket.destroy());
		receiveLine(socket, 1024 * 1024, text => {
			void (async () => {
				let reply: Reply;
				let shouldStop = false;
				try {
					const request = JSON.parse(text) as Command;
					if (request.command === "stop") {
						await runtime.stop();
						shouldStop = true;
						reply = { ok: true, value: { stopped: true, cleanupErrors: runtime.list().flatMap(task => task.cleanupErrors) } };
					} else reply = { ok: true, value: dispatch(runtime, request) };
				} catch (error) { reply = { ok: false, error: errorMessage(error) }; }
				socket.end(`${JSON.stringify(reply)}\n`);
				if (shouldStop) void stop().catch(rejectClosed);
			})();
		});
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(path, () => { server.removeListener("error", reject); resolve(); });
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
		let active = true;
		try { await requestCommand(file, { command: "ping" }); }
		catch { active = false; }
		throw new Error(active ? `Factory already running at ${path}` : `Existing socket is stale or unresponsive: ${path}. Not removed; verify its owner is stopped before manually removing it.`);
	}
	server.on("error", error => { void stop().then(() => rejectClosed(error), rejectClosed); });
	try { await chmod(path, 0o600); }
	catch (error) { await stop(); throw error; }
	return { path, closed, stop };
}