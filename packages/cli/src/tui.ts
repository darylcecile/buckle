import { emitKeypressEvents, type Key } from "node:readline";
import { PassThrough } from "node:stream";
import { terminalText } from "./board.js";
import { readSnapshot, requestCommand, type Command } from "./ipc.js";
import { renderTui } from "./tui-render.js";
import { applySnapshot, createTuiState, handleTuiKey, insertFormText, type TuiState } from "./tui-state.js";
import { errorMessage, type TaskRecord } from "./types.js";

function operationLabel(command: Command): string {
	switch (command.command) {
		case "add": return "Submitting task...";
		case "answer": return "Sending answer...";
		case "cancel": return "Requesting cancellation...";
		case "retry": return "Creating a new execution...";
		case "stop": return "Stopping daemon; waiting for cooperative cleanup. q / Ctrl-C detaches.";
		default: return "Contacting daemon...";
	}
}

function recordResult(state: TuiState, command: Command, value: unknown): void {
	const task = value as TaskRecord;
	if (!task || typeof task.id !== "string") throw new Error("Daemon returned an invalid task reply; inspect tasks before resubmitting");
	if (state.snapshot) {
		const index = state.snapshot.tasks.findIndex(candidate => candidate.id === task.id);
		if (index < 0) state.snapshot.tasks.push(task);
		else state.snapshot.tasks[index] = task;
	}
	if (command.command === "add" || command.command === "retry") {
		state.selectedId = task.id;
		state.scroll = 0;
		state.notice = `${command.command === "retry" ? "New execution created" : "Task submitted"}: ${task.id}`;
	} else state.notice = command.command === "answer" ? "Answer delivered." : `Cancellation requested: ${task.id}`;
}

/** Connects to an already-started daemon. Detaching never stops its work. */
export async function runTui(file: string): Promise<void> {
	const input = process.stdin;
	const output = process.stdout;
	const state = createTuiState(file);
	const lifetime = new AbortController();
	const keys = new PassThrough();
	const wasRaw = input.isRaw;
	const wasFlowing = input.readableFlowing;
	let closed = false;
	let finalMessage = "Detached. Daemon work continues in the background.";
	let timer: ReturnType<typeof setTimeout> | undefined;
	let repaint: ReturnType<typeof setImmediate> | undefined;
	let polling: Promise<void> | undefined;
	let mutation: Promise<void> | undefined;
	let pageSize = 8;
	let pasted: string | undefined;
	let finish!: () => void;
	let fail!: (error: unknown) => void;
	const done = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });

	function detach(): void {
		if (closed) return;
		closed = true;
		if (state.stopRequested || state.snapshot?.stopping) finalMessage = "Detached. Daemon shutdown and cooperative cleanup continue.";
		else if (state.connection === "disconnected") finalMessage = "Detached. Daemon status is unknown; reconnect to inspect it.";
		lifetime.abort();
		finish();
	}

	function fatal(error: unknown): void {
		closed = true;
		lifetime.abort();
		fail(error);
	}

	function draw(): void {
		repaint = undefined;
		if (closed) return;
		try {
			const frame = renderTui(state, output.columns, output.rows);
			pageSize = frame.pageSize;
			if (frame.scroll !== undefined) {
				if (state.overlay === "help") state.overlayScroll = frame.scroll;
				else state.scroll = frame.scroll;
			}
			let screen = `\x1b[?25l\x1b[H${frame.text.split("\n").map(line => `\x1b[2K${line}`).join("\r\n")}\x1b[J`;
			if (frame.cursor) screen += `\x1b[${frame.cursor.row + 1};${frame.cursor.column + 1}H\x1b[?25h`;
			output.write(screen);
		} catch (error) { fatal(error); }
	}

	function scheduleDraw(): void { if (!closed && !repaint) repaint = setImmediate(draw); }

	async function poll(): Promise<void> {
		try { applySnapshot(state, await readSnapshot(file, lifetime.signal)); }
		catch (error) {
			if (closed) return;
			state.connection = "disconnected";
			state.connectionError = errorMessage(error);
		} finally {
			if (!closed) {
				scheduleDraw();
				timer = setTimeout(() => { polling = poll(); }, 500);
			}
		}
	}

	async function send(command: Command): Promise<void> {
		state.pending = operationLabel(command);
		const form = state.form;
		if (command.command === "stop") state.stopRequested = true;
		scheduleDraw();
		try {
			const result = await requestCommand(file, command, lifetime.signal);
			if (closed) return;
			if (command.command === "stop") {
				const stopped = result as { stopped: boolean; cleanupErrors: string[] };
				if (!stopped?.stopped || !Array.isArray(stopped.cleanupErrors)) throw new Error("Daemon returned an invalid shutdown reply");
				finalMessage = "Daemon stopped. In-memory task history released.";
				if (stopped.cleanupErrors.length) {
					process.exitCode = 1;
					finalMessage += `\nCleanup failures:\n${stopped.cleanupErrors.map(error => `- ${terminalText(error)}`).join("\n")}`;
				}
				closed = true;
				lifetime.abort();
				finish();
			} else {
				recordResult(state, command, result);
				if (state.form === form) state.form = undefined;
			}
		} catch (error) {
			if (closed) return;
			state.notice = `Error: ${errorMessage(error)}. Check refreshed tasks before resubmitting; commands are not replayed.`;
			if (command.command === "stop") state.stopRequested = false;
		} finally { state.pending = undefined; scheduleDraw(); }
	}

	function onKey(text: string | undefined, key: Key): void {
		if (closed) return;
		if (key.name === "paste-start") { pasted = ""; return; }
		if (key.name === "paste-end") {
			if (pasted !== undefined) insertFormText(state, pasted);
			pasted = undefined;
			scheduleDraw();
			return;
		}
		if (pasted !== undefined) { pasted += key.sequence ?? text ?? ""; return; }
		const action = handleTuiKey(state, text ?? "", key, pageSize);
		if (action?.type === "quit") detach();
		if (action?.type === "command") mutation = send(action.command);
		scheduleDraw();
	}

	const onData = (chunk: Buffer) => { try { keys.write(chunk); } catch (error) { fatal(error); } };
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	try {
		emitKeypressEvents(keys);
		keys.on("keypress", onKey);
		input.on("data", onData);
		input.on("end", detach);
		input.on("close", detach);
		input.on("error", fatal);
		output.on("error", fatal);
		output.on("resize", scheduleDraw);
		for (const signal of signals) process.on(signal, detach);
		input.setRawMode(true);
		input.resume();
		output.write("\x1b[?1049h\x1b[?2004h\x1b[?25l");
		draw();
		polling = poll();
		await done;
	} finally {
		closed = true;
		lifetime.abort();
		clearTimeout(timer);
		clearImmediate(repaint);
		input.removeListener("data", onData);
		input.removeListener("end", detach);
		input.removeListener("close", detach);
		input.removeListener("error", fatal);
		output.removeListener("resize", scheduleDraw);
		for (const signal of signals) process.removeListener(signal, detach);
		// Flush readline's pending Escape timeout before removing its private stream.
		keys.write(Buffer.from("\0"));
		keys.removeAllListeners();
		keys.destroy();
		try { if (!input.destroyed) input.setRawMode(Boolean(wasRaw)); }
		finally {
			if (wasFlowing !== true) input.pause();
			output.write("\x1b[?2004l\x1b[?25h\x1b[?1049l");
			await Promise.allSettled([polling, mutation]);
			output.removeListener("error", fatal);
		}
	}
	output.write(`${finalMessage}\n`);
}
