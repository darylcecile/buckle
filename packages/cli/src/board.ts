import { stripVTControlCharacters } from "node:util";
import type { TaskRecord } from "./types.js";

/** Printable ASCII terminal text; JSON commands preserve original Unicode and escape it on output. */
export function terminalText(value: string): string {
	return stripVTControlCharacters(String(value)).replace(/\s/gu, " ").replace(/[^\x20-\x7e]/gu, "?");
}

function fit(value: string, width: number): string {
	const text = terminalText(value);
	return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}~` : text.padEnd(width);
}

/** Dimensions constrain the board; omitted rows means an unabridged list. No color escapes are emitted. */
export interface BoardOptions { columns?: number; rows?: number; stopping?: boolean }

/** Renders a bounded, monochrome live table with an explicit count for every offscreen task. */
export function renderBoard(tasks: readonly TaskRecord[], options: BoardOptions = {}): string {
	const width = Math.max(1, Math.floor(options.columns ?? 120));
	const height = Math.max(3, Math.floor(options.rows ?? Number.MAX_SAFE_INTEGER));
	const wide = width >= 110;
	const perTask = wide ? 1 : width >= 60 ? 3 : 5;
	const capacity = Math.max(0, Math.floor((height - 3) / perTask));
	const active = new Set(["running", "waiting", "cancelling", "queued"]);
	const ordered = [...tasks].sort((left, right) => Number(active.has(right.state)) - Number(active.has(left.state)));
	const visible = ordered.slice(0, capacity);
	const lines = [`BUCKLES | ${options.stopping ? "STOPPING" : "RUNNING"} | ${tasks.length} tasks`];
	const widths = [8, 20, 12, 12, 10, 10, 3, width - 96];
	const tableRow = (values: string[]) => values.map((value, index) => fit(value, widths[index]!)).join(" | ");
	lines.push(wide ? tableRow(["ID", "TITLE", "WORKFLOW", "STAGE", "STATE", "AGENT", "TRY", "ACTIVITY / ERROR"]) : "ID / STATE / TITLE; workflow, stage, agent, attempt");
	for (const task of visible) {
		const activity = task.error ?? task.questions[0]?.text ?? task.activity;
		if (wide) lines.push(tableRow([task.id.slice(0, 8), task.title, task.workflow, task.stage || "-", task.state, task.agent || "-", String(task.attempt), activity]));
		else if (width >= 60) lines.push(
			`${task.id.slice(0, 8)} ${task.state.padEnd(10)} ${task.title}`,
			`  ${task.workflow} / ${task.stage || "-"} / ${task.agent || "-"} / try ${task.attempt}`,
			`  ${activity}`,
		);
		else lines.push(`${task.id.slice(0, 8)} ${task.state}`, task.title, `${task.workflow} / ${task.stage || "-"}`, `${task.agent || "-"} / try ${task.attempt}`, activity);
	}
	const hidden = tasks.length - visible.length;
	lines.push(hidden ? `${hidden} offscreen of ${tasks.length}; buckles list / show <id>` : `${tasks.length} shown; buckles add / show / answer / cancel / stop`);
	return lines.map(line => fit(line, width).trimEnd()).join("\n");
}

/** Safe append-only event text for pipes and redirected logs. */
export function renderEvent(task: TaskRecord): string {
	return terminalText(`${task.id} ${task.state} [${task.workflow}/${task.stage || "-"}/${task.agent || "-"} #${task.attempt}] ${task.title}: ${task.error ?? task.activity}`);
}

/** Machine-readable JSON without literal control, bidi, or terminal escape characters. */
export function safeJson(value: unknown): string {
	return JSON.stringify(value, null, 2).replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}