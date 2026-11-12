#!/usr/bin/env node
import { parseArgs } from "node:util";
import { renderBoard, renderEvent, safeJson, terminalText } from "./board.js";
import { ensureDaemon } from "./daemon.js";
import { readSnapshot, requestCommand, type Command, type ServiceSnapshot } from "./ipc.js";
import { resolveFactoryPath } from "./load.js";
import { runTui } from "./tui.js";
import { errorMessage, type TaskRecord } from "./types.js";

const help = `Usage:
	buckles
	buckles run [factory.ts|factory.js]
	buckles tui [factory.ts|factory.js]
	buckles start [factory.ts|factory.js] [--json]
	buckles status [--json]
	buckles add "title" [--description text] [--workflow name]
	buckles list [--json]
	buckles show <id> [--json]
	buckles answer <id> "text"
	buckles retry <id>
	buckles cancel <id>
	buckles stop

Commands accept --factory <file>. Default: factory.ts, then example/factory.ts.
Run starts or attaches to a background daemon and opens the interactive TUI.
Without a TTY, run prints daemon status and returns. Explicit tui requires a TTY.
TUI: arrows navigate; n new; Enter details; a answer; c cancel; r retry;
     s then y confirm stop; q/Ctrl-C detach; ? help.
Forms: Tab changes fields; Enter inserts description/answer newlines; Ctrl-S submits.
Retry starts a new execution from the beginning; inspect external effects first.
Stop waits for cooperative cancellation and cleanup. Tasks persist in memory until stop.`;

function statusText(snapshot: ServiceSnapshot): string {
	return `Factory ${snapshot.stopping ? "stopping" : "running"} (PID ${snapshot.pid}) | ${snapshot.tasks.length} tasks | ${terminalText(snapshot.factory)}`;
}

async function run(file: string, explicitTui: boolean): Promise<void> {
	const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== "dumb");
	if (explicitTui && !interactive) throw new Error("The TUI requires interactive stdin/stdout and TERM other than dumb. Use buckles start or buckles status for scripts.");
	const snapshot = await ensureDaemon(file);
	if (interactive) await runTui(file);
	else process.stdout.write(`${statusText(snapshot)}\nAttach from an interactive terminal: buckles tui --factory ${terminalText(JSON.stringify(file))}\n`);
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
	if (values.help) { process.stdout.write(`${help}\n`); return; }
	const [name = "run", ...args] = positionals;
	if (name === "run" || name === "tui" || name === "start") {
		if (args.length > 1 || (args.length && values.factory) || (values.json && name !== "start") || values.description || values.workflow) throw new Error(`Usage: buckles ${name} [factory] (or --factory <factory>)${name === "start" ? " [--json]" : ""}`);
		const file = await resolveFactoryPath(args[0] ?? values.factory);
		if (name === "start") {
			const snapshot = await ensureDaemon(file);
			process.stdout.write(`${values.json ? safeJson(snapshot) : statusText(snapshot)}\n`);
		} else await run(file, name === "tui");
		return;
	}
	if (name === "status") {
		if (args.length || values.description || values.workflow) throw new Error("Usage: buckles status [--factory <file>] [--json]");
		const snapshot = await readSnapshot(await resolveFactoryPath(values.factory));
		process.stdout.write(`${values.json ? safeJson(snapshot) : statusText(snapshot)}\n`);
		return;
	}
	const command = commandFrom(name, args, values);
	const result = await requestCommand(await resolveFactoryPath(values.factory), command);
	if (name === "stop" && (result as { cleanupErrors: string[] }).cleanupErrors.length) process.exitCode = 1;
	if (values.json || name === "show") process.stdout.write(`${safeJson(result)}\n`);
	else if (name === "list") process.stdout.write(`${renderBoard(result as TaskRecord[], { columns: process.stdout.columns || 120 })}\n`);
	else if (name === "stop") process.stdout.write(`${safeJson(result)}\n`);
	else process.stdout.write(`${renderEvent(result as TaskRecord)}\n`);
}

void main().catch(error => {
	process.stderr.write(`buckles: ${terminalText(errorMessage(error))}\n`);
	process.exitCode = 1;
});
