import { terminalText } from "./board.js";
import { selectedTask, taskActions, type TextField, type TuiState } from "./tui-state.js";
import type { TaskRecord } from "./types.js";

export interface TuiFrame { text: string; cursor?: { row: number; column: number }; scroll?: number; pageSize: number }
interface Body { lines: string[]; cursor?: { row: number; column: number }; scroll?: number; pageSize?: number }

function clip(text: string, width: number): string {
	const safe = terminalText(text);
	return safe.length <= width ? safe : `${safe.slice(0, Math.max(0, width - 1))}~`;
}

/** Wraps printable text while retaining explicit newlines in descriptions and output. */
export function wrapText(text: string, width: number): string[] {
	const size = Math.max(1, width);
	return String(text).split(/\r\n?|\n/).flatMap(line => {
		const safe = terminalText(line);
		const result: string[] = [];
		for (let index = 0; index < safe.length; index += size) result.push(safe.slice(index, index + size));
		return result.length ? result : [""];
	});
}

export function taskDetailLines(task: TaskRecord, tasks: readonly TaskRecord[], width: number): string[] {
	const lines = [task.title, `ID: ${task.id}`, `State: ${task.state}  |  Workflow: ${task.workflow}`,
		`Stage: ${task.stage || "-"}  |  Agent: ${task.agent || "-"}  |  Visit: ${task.attempt}`,
		`Created: ${task.createdAt}  |  Updated: ${task.updatedAt}`];
	if (task.retryOf) lines.push(`Retry of: ${task.retryOf}`);
	for (const retry of tasks.filter(candidate => candidate.retryOf === task.id)) lines.push(`Retried as: ${retry.id} (${retry.state})`);
	lines.push("", "DESCRIPTION", task.description || "(No description)", "", "ACTIVITY", task.activity || "-");
	if (task.error) lines.push("", "ERROR", task.error);
	if (task.cleanupErrors.length) lines.push("", "CLEANUP FAILURES", ...task.cleanupErrors);
	if (task.questions.length) {
		lines.push("", `QUESTIONS (${task.questions.length}; a answers the oldest)`);
		for (const [index, question] of task.questions.entries()) lines.push(`${index + 1}. ${question.text}`, `Question ID: ${question.id}`);
	}
	lines.push("", `OUTPUTS (${task.outputs.length})`);
	if (!task.outputs.length) lines.push("No output yet.");
	for (const output of task.outputs) lines.push("", `${output.stage} / ${output.agent} / visit ${output.attempt}`, output.text);
	return lines.flatMap(line => wrapText(line, width));
}

function scrollBody(lines: string[], offset: number, height: number): Body {
	const capacity = Math.max(1, height - 1);
	const scroll = Math.min(offset, Math.max(0, lines.length - capacity));
	return { lines: [...lines.slice(scroll, scroll + capacity), `Lines ${scroll + 1}-${Math.min(lines.length, scroll + capacity)} of ${lines.length} | arrows / PgUp / PgDn`], scroll, pageSize: capacity };
}

function preview(task: TaskRecord, width: number): string[] {
	return ["-".repeat(width), `SELECTED: ${task.title}`, `${task.workflow} / ${task.stage || "-"} / ${task.agent || "-"} / visit ${task.attempt}`,
		...wrapText(task.error ?? task.questions[0]?.text ?? (task.description || task.activity), width).slice(0, 2), "Enter: full details, questions, outputs and cleanup"];
}

function taskRows(task: TaskRecord, selected: boolean, width: number): string[] {
	const marker = selected ? "> " : "  ";
	const activity = task.error ?? task.questions[0]?.text ?? task.activity;
	const nameWidth = Math.max(3, Math.min(12, Math.floor((width - 20) / 3)));
	if (width < 105) return [
		`${marker}${task.id.slice(0, 8)}  ${task.state.padEnd(10)}  ${task.title}`,
		`  ${clip(task.stage || "-", nameWidth)} / ${clip(task.agent || "-", nameWidth)} / visit ${task.attempt}  ${activity}`,
	];
	const sizes = [8, 22, 10, 12, 12, 5, width - 77];
	const values = [task.id.slice(0, 8), task.title, task.state, task.stage || "-", task.agent || "-", String(task.attempt), activity];
	return [marker + values.map((value, index) => clip(value, sizes[index]!).padEnd(sizes[index]!)).join(" ")];
}

function listBody(state: TuiState, width: number, height: number): Body {
	const tasks = state.snapshot?.tasks ?? [];
	if (!tasks.length) return { lines: state.connection === "loading" ? ["Connecting...", "Waiting for the daemon's task snapshot."]
		: state.connection === "disconnected" ? ["Disconnected. Retrying this endpoint automatically.", "Your daemon may still be running; q detaches."]
		: ["No tasks yet.", "", "Press n to create a task.", "Tasks run in the background when you detach."] };
	const selected = selectedTask(state);
	const tail = selected && width >= 105 && height >= 14 ? preview(selected, width) : [];
	const perTask = width >= 105 ? 1 : 2;
	const capacity = Math.max(1, Math.floor((height - tail.length - 2) / perTask));
	const index = Math.max(0, tasks.findIndex(task => task.id === state.selectedId));
	const start = Math.max(0, Math.min(tasks.length - capacity, index - Math.floor(capacity / 2)));
	const visible = tasks.slice(start, start + capacity);
	const heading = width >= 105 ? "  ID       TITLE                  STATE      STAGE        AGENT        VISIT ACTIVITY / ERROR" : "TASKS | ID / state / title; stage / agent / visit / activity";
	return { lines: [heading, ...visible.flatMap(task => taskRows(task, task.id === state.selectedId, width)),
		`${start + 1}-${start + visible.length} of ${tasks.length} tasks | ${tasks.length - visible.length} offscreen`, ...tail], pageSize: capacity };
}

function editor(field: TextField, width: number, height: number, focused: boolean): Body {
	const size = Math.max(1, width - 2);
	const chars = Array.from(field.value);
	const lines = [""];
	let row = 0;
	let column = 0;
	let cursor = { row: 0, column: 0 };
	for (let index = 0; index <= chars.length; index++) {
		if (column === size && chars[index] !== "\n") { lines.push(""); row++; column = 0; }
		if (index === field.cursor) cursor = { row, column };
		const char = chars[index];
		if (char === undefined) break;
		if (char === "\n") { lines.push(""); row++; column = 0; }
		else { lines[row] += terminalText(char); column++; }
	}
	const start = focused ? Math.max(0, cursor.row - height + 1) : 0;
	const shown = lines.slice(start, start + height).map(line => `  ${line}`);
	while (shown.length < height) shown.push("");
	return { lines: shown, ...(focused ? { cursor: { row: cursor.row - start, column: cursor.column + 2 } } : {}) };
}

function formBody(state: TuiState, width: number, height: number): Body {
	const form = state.form!;
	if (form.kind === "answer") {
		const question = wrapText(form.question, width).slice(0, Math.max(1, Math.min(4, height - 4)));
		const lines = [`ANSWER | ${form.taskId.slice(0, 8)}`, ...question, "> Answer (Enter: newline)"];
		const input = editor(form.text, width, Math.max(1, height - lines.length), true);
		return { lines: [...lines, ...input.lines], cursor: input.cursor && { row: lines.length + input.cursor.row, column: input.cursor.column } };
	}
	const workflows = state.snapshot?.workflows ?? [];
	const workflowIndex = workflows.indexOf(form.workflow);
	// On very short terminals show the focused field; Tab still reaches every field.
	if (height < 9) {
		const names = ["Title", "Description", "Workflow"];
		const heading = `NEW TASK | ${names[form.focus]} (${form.focus + 1}/3)`;
		if (form.focus === 2) return { lines: [heading, `< ${form.workflow} >`, "Left/Right: choose workflow"] };
		const input = editor(form.focus === 0 ? form.title : form.description, width, Math.max(1, height - 1), true);
		return { lines: [heading, ...input.lines], cursor: input.cursor && { row: input.cursor.row + 1, column: input.cursor.column } };
	}
	const title = editor(form.title, width, form.focus === 0 ? 2 : 1, form.focus === 0);
	const description = editor(form.description, width, Math.max(1, height - title.lines.length - 6), form.focus === 1);
	const lines = ["NEW TASK", `${form.focus === 0 ? ">" : " "} Title`, ...title.lines,
		`${form.focus === 1 ? ">" : " "} Description (Enter: newline)`, ...description.lines,
		`${form.focus === 2 ? ">" : " "} Workflow (${workflowIndex + 1}/${workflows.length}) | Left/Right: choose`, `  < ${form.workflow} >`];
	let cursor = title.cursor && { row: title.cursor.row + 2, column: title.cursor.column };
	if (description.cursor) cursor = { row: description.cursor.row + title.lines.length + 3, column: description.cursor.column };
	return { lines, cursor };
}

const help = [
	"KEYBOARD", "", "Up/Down or j/k  Select tasks; scroll details or help", "Page Up/Down   Move a page", "Home/End       First/last task or detail line", "Enter          Open full task details", "Esc            Back to tasks; close help or discard a form", "n              Create a task", "a              Answer the selected task's oldest pending question", "c              Cancel queued, running or waiting work", "r              Retry a failed task as a new execution", "s              Confirm daemon shutdown", "q / Ctrl-C     Detach; work keeps running", "?              Toggle this help", "", "FORMS", "Tab/Shift-Tab  Next/previous new-task field", "Left/Right     Move cursor; choose a workflow in its field", "Up/Down        Move between text lines; choose a workflow", "Home/End       Start/end of the text line", "Backspace/Del  Edit text at the cursor", "Enter          Newline in description/answer; advance from title", "Ctrl-S         Explicitly submit the form", "Esc            Discard draft and return", "Ctrl-C         Detach from the daemon", "Paste          Insert text into the focused field", "", "DAEMON LIFETIME", "Detaching leaves tasks and history in the daemon's memory.", "Stopping cancels active work, waits for cleanup, then releases that history.", "If the connection drops, the UI keeps stale data and drafts and retries reads.", "Commands are sent once. A lost reply can mean an unknown outcome; inspect the refreshed task list before resubmitting.", "", "TEXT", "Task/provider text is sanitized to printable ASCII for terminal safety.", "Original Unicode in form submissions is preserved.",
];

function bodyFor(state: TuiState, width: number, height: number): Body {
	if (state.form) return formBody(state, width, height);
	if (state.overlay === "help") return scrollBody(["LAST MESSAGE", state.notice, "", ...help].flatMap(line => wrapText(line, width)), state.overlayScroll, height);
	if (state.overlay === "stop") return { lines: ["STOP DAEMON?", "", ...wrapText("This cancels queued and active work, waits for cooperative cleanup, and releases all in-memory task history.", width), "", ...wrapText("To leave work running, press q to detach instead.", width), "", "y stop daemon  |  Esc / n go back"] };
	if (state.view === "detail") {
		const task = selectedTask(state);
		return task ? scrollBody(taskDetailLines(task, state.snapshot?.tasks ?? [], width), state.scroll, height) : { lines: ["Selected task is not in this daemon's snapshot.", "Esc returns to the task list."] };
	}
	return listBody(state, width, height);
}

function footerLines(state: TuiState, width: number): string[] {
	let keys: string[];
	if (state.form) keys = ["Ctrl-S submit | Esc discard | Ctrl-C detach", ...(state.form.kind === "new" ? ["Tab/Shift-Tab fields | arrows edit/choose"] : []), "Enter newline | Home/End | Backspace/Delete"];
	else if (state.overlay === "stop") keys = ["y stop | Esc back | q detach"];
	else if (state.overlay === "help") keys = ["q detach | Esc back | arrows/PgUp/PgDn scroll"];
	else if (state.pending || state.stopRequested || state.snapshot?.stopping) keys = ["q detach | ? help | Esc back", "arrows/jk select | Enter details"];
	else if (state.connection !== "connected") keys = ["q detach | ? help | Esc back", "arrows/jk select | Enter details", "Reconnecting; task actions unavailable"];
	else keys = ["q detach | n new | ? help | s stop", "arrows/jk select | Enter details | Esc back", ...taskActions(selectedTask(state))];
	return keys.flatMap(line => wrapText(line, width));
}

/** Produces a bounded frame; only the terminal driver emits control sequences. */
export function renderTui(state: TuiState, columns = 100, rows = 24): TuiFrame {
	const width = Math.max(1, Math.floor(columns) - 1);
	const height = Math.max(1, Math.floor(rows));
	const stopping = state.stopRequested || state.snapshot?.stopping;
	const status = state.connection === "connected" ? stopping ? "STOPPING" : `CONNECTED | pid ${state.snapshot?.pid}` : state.connection === "disconnected" ? "DISCONNECTED | STALE DATA" : "CONNECTING";
	const header = [`BUCKLES | ${status}`, `Factory: ${state.snapshot?.factory ?? state.file}`].slice(0, height > 5 ? 2 : 1);
	const footer = footerLines(state, width).slice(0, Math.max(1, Math.min(7, Math.floor(height / 3))));
	const message = state.pending ?? (state.notice.startsWith("Error:") ? state.notice : stopping ? "Waiting for cooperative cleanup. q / Ctrl-C detaches." : state.connection === "disconnected" ? `Retrying connection: ${state.connectionError ?? "connection lost"}. Drafts are kept.` : state.notice);
	const notice = height > 5 ? wrapText(message, width).slice(0, 2) : [];
	const bodyHeight = Math.max(0, height - header.length - footer.length - notice.length);
	const body = bodyFor(state, width, bodyHeight);
	const lines = [...header, ...body.lines.slice(0, bodyHeight)];
	while (lines.length < header.length + bodyHeight) lines.push("");
	lines.push(...notice, ...footer);
	const cursor = body.cursor && body.cursor.row < bodyHeight ? { row: header.length + body.cursor.row, column: Math.min(width - 1, body.cursor.column) } : undefined;
	return { text: lines.slice(0, height).map(line => clip(line, width)).join("\n"), cursor, scroll: body.scroll, pageSize: body.pageSize ?? Math.max(1, bodyHeight - 1) };
}
