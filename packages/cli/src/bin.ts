#!/usr/bin/env node
import { parseArgs } from "node:util";
import { renderBoard, renderEvent, safeJson, terminalText } from "./board.js";
import { requestCommand, serveCommands, type Command } from "./ipc.js";
import { loadFactory, resolveFactoryPath } from "./load.js";
import { Runtime } from "./runtime.js";
import { errorMessage, type TaskRecord } from "./types.js";

const help = `Usage:
	buckles run [factory.ts|factory.js]
	buckles add "title" [--description text] [--workflow name]
	buckles list [--json]
	buckles show <id> [--json]
	buckles answer <id> "text"
	buckles retry <id>
	buckles cancel <id>
	buckles stop

Commands accept --factory <file>. Default: factory.ts, then example/factory.ts.
Run uses a live TTY board, or append-only events when redirected.
Retry starts a new execution from the beginning; inspect external effects first.
Stop waits for cooperative cancellation and cleanup. State is in memory only.`;

async function run(file: string): Promise<void> {
	const runtime = new Runtime(await loadFactory(file), file);
	const server = await serveCommands(file, runtime);
	const live = Boolean(process.stdout.isTTY && process.env.TERM !== "dumb");
	let scheduled: NodeJS.Timeout | undefined;
	const draw = () => {
		scheduled = undefined;
		process.stdout.write(`\x1b[H\x1b[2J${renderBoard(runtime.list(), { columns: Math.max(1, (process.stdout.columns || 120) - 1), rows: Math.max(3, (process.stdout.rows || 24) - 1), stopping: runtime.isStopping })}`);
	};
	const update = (task: TaskRecord) => {
		if (!live) process.stdout.write(`${renderEvent(task)}\n`);
		else if (!scheduled) scheduled = setTimeout(draw, 50);
	};
	const shutdown = () => {
		void server.stop().catch(error => {
			process.stderr.write(`${terminalText(errorMessage(error))}\n`);
			process.exitCode = 1;
		});
		if (live) draw();
	};
	runtime.on("change", update);
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	if (live) {
		process.stdout.write("\x1b[?1049h\x1b[?25l");
		process.stdout.on("resize", draw);
		draw();
	} else process.stdout.write(`Ready: ${terminalText(file)} | ${terminalText(server.path)}\n`);
	try { await server.closed; }
	finally {
		clearTimeout(scheduled);
		runtime.off("change", update);
		process.off("SIGINT", shutdown);
		process.off("SIGTERM", shutdown);
		process.stdout.off("resize", draw);
		if (live) process.stdout.write("\x1b[?25h\x1b[?1049l");
		const failures = runtime.list().flatMap(task => task.cleanupErrors);
		if (failures.length) {
			process.stderr.write(`Cleanup failures: ${terminalText(failures.join("; "))}\n`);
			process.exitCode = 1;
		}
		process.stdout.write("Factory stopped. In-memory task history released.\n");
	}
}

function commandFrom(name: string, args: string[], values: { description?: string; workflow?: string }): Command {
	const expected = name === "answer" ? 2 : ["add", "show", "retry", "cancel"].includes(name) ? 1 : 0;
	if (args.length !== expected) throw new Error(`Invalid arguments for ${name}; use --help`);
	if (name === "add") return { command: "add", input: { title: args[0]!, description: values.description, workflow: values.workflow } };
	if (values.description !== undefined || values.workflow !== undefined) throw new Error("--description and --workflow are only valid with add");
	if (name === "answer") return { command: name, id: args[0]!, text: args[1]! };
	if (name === "show" || name === "retry" || name === "cancel") return { command: name, id: args[0]! };
	if (name === "list" || name === "stop") return { command: name };
	throw new Error(`Unknown command: ${name}`);
}

async function main(): Promise<void> {
	const { positionals, values } = parseArgs({ allowPositionals: true, options: {
		factory: { type: "string" }, description: { type: "string" }, workflow: { type: "string" },
		json: { type: "boolean" }, help: { type: "boolean", short: "h" },
	} });
	if (values.help || !positionals.length) { process.stdout.write(`${help}\n`); return; }
	const [name, ...args] = positionals;
	if (name === "run") {
		if (args.length > 1 || (args.length && values.factory) || values.json || values.description || values.workflow) throw new Error("Usage: buckles run <factory> (or --factory <factory>)");
		await run(await resolveFactoryPath(args[0] ?? values.factory));
		return;
	}
	const command = commandFrom(name!, args, values);
	const result = await requestCommand(await resolveFactoryPath(values.factory), command);
	if (values.json || name === "show") process.stdout.write(`${safeJson(result)}\n`);
	else if (name === "list") process.stdout.write(`${renderBoard(result as TaskRecord[], { columns: process.stdout.columns || 120 })}\n`);
	else if (name === "stop") {
		process.stdout.write(`${safeJson(result)}\n`);
		if ((result as { cleanupErrors: string[] }).cleanupErrors.length) process.exitCode = 1;
	} else process.stdout.write(`${renderEvent(result as TaskRecord)}\n`);
}

void main().catch(error => {
	process.stderr.write(`buckles: ${terminalText(errorMessage(error))}\n`);
	process.exitCode = 1;
});