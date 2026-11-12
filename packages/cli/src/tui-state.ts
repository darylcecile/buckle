import type { Key } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import type { Command, ServiceSnapshot } from "./ipc.js";
import type { TaskRecord } from "./types.js";

export interface TextField { value: string; cursor: number }
export type TaskForm = { kind: "new"; focus: number; title: TextField; description: TextField; workflow: string }
	| { kind: "answer"; taskId: string; questionId: string; question: string; text: TextField };

export interface TuiState {
	file: string;
	snapshot?: ServiceSnapshot;
	connection: "loading" | "connected" | "disconnected";
	connectionError?: string;
	selectedId?: string;
	view: "list" | "detail";
	scroll: number;
	overlay?: "help" | "stop";
	overlayScroll: number;
	form?: TaskForm;
	notice: string;
	pending?: string;
	stopRequested: boolean;
}

export type TuiAction = { type: "quit" } | { type: "command"; command: Command };

export function createTuiState(file: string): TuiState {
	return { file, connection: "loading", view: "list", scroll: 0, overlayScroll: 0, notice: "Connecting to daemon...", stopRequested: false };
}

export function selectedTask(state: TuiState): TaskRecord | undefined {
	return state.snapshot?.tasks.find(task => task.id === state.selectedId);
}

/** Refreshes server data without disturbing selection or the user's draft. */
export function applySnapshot(state: TuiState, snapshot: ServiceSnapshot): void {
	const restarted = state.snapshot && state.snapshot.pid !== snapshot.pid;
	const reconnected = state.connection === "disconnected";
	state.snapshot = snapshot;
	state.connection = "connected";
	state.connectionError = undefined;
	if (restarted) {
		state.selectedId = snapshot.tasks[0]?.id;
		state.scroll = 0;
		state.notice = "Connected to a new daemon. Previous in-memory history has been released.";
	} else if (!state.selectedId) state.selectedId = snapshot.tasks[0]?.id;
	if (reconnected && !restarted) state.notice = "Reconnected. Draft and selection preserved.";
	else if (state.notice === "Connecting to daemon...") state.notice = "Ready. Tasks keep running when you detach.";
}

export function taskActions(task: TaskRecord | undefined): string[] {
	if (!task) return [];
	const actions: string[] = [];
	if (task.state === "waiting" && task.questions.length) actions.push("a answer oldest question");
	if (["queued", "running", "waiting"].includes(task.state)) actions.push("c cancel");
	if (task.state === "failed") actions.push("r retry (new execution)");
	return actions;
}

function canSubmit(state: TuiState): boolean {
	if (state.pending) { state.notice = `${state.pending} Please wait; Ctrl-C detaches.`; return false; }
	if (state.connection !== "connected") { state.notice = "Waiting for a daemon connection; your draft is kept."; return false; }
	if (state.stopRequested || state.snapshot?.stopping) { state.notice = "Daemon is stopping. q / Ctrl-C detaches while cleanup continues."; return false; }
	return true;
}

function commandAction(command: Command): TuiAction { return { type: "command", command }; }

function formAction(state: TuiState): TuiAction | undefined {
	const form = state.form;
	if (!form || !canSubmit(state)) return;
	if (form.kind === "new") {
		if (!form.title.value.trim()) { state.notice = "A title is required."; form.focus = 0; return; }
		if (!state.snapshot?.workflows.includes(form.workflow)) { state.notice = "Choose an available workflow with the arrow keys."; form.focus = 2; return; }
		return commandAction({ command: "add", input: { title: form.title.value, description: form.description.value, workflow: form.workflow } });
	}
	if (!form.text.value.trim()) { state.notice = "An answer is required."; return; }
	const task = state.snapshot?.tasks.find(task => task.id === form.taskId);
	if (task?.state !== "waiting" || task.questions[0]?.id !== form.questionId) {
		state.notice = "This question is no longer pending. Draft kept; Esc returns to the task.";
		return;
	}
	return commandAction({ command: "answer", id: form.taskId, text: form.text.value });
}

function activeField(form: TaskForm): TextField | undefined {
	if (form.kind === "answer") return form.text;
	return form.focus === 0 ? form.title : form.focus === 1 ? form.description : undefined;
}

/** A paste is one edit, never a sequence of task shortcuts or submissions. */
export function insertFormText(state: TuiState, text: string): void {
	const form = state.form;
	if (!form || state.pending) return;
	const field = activeField(form);
	if (!field) return;
	const multiline = form.kind === "answer" || form.focus === 1;
	let clean = stripVTControlCharacters(text).replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
	if (!multiline) clean = clean.replace(/\n/g, " ");
	const limit = multiline ? 65536 : 4096;
	if (field.value.length + clean.length > limit) { state.notice = `Text exceeds ${limit} characters. Shorten it before inserting.`; return; }
	const chars = Array.from(field.value);
	chars.splice(field.cursor, 0, clean);
	field.value = chars.join("");
	field.cursor += Array.from(clean).length;
}

function editField(field: TextField, key: Key): void {
	const chars = Array.from(field.value);
	const before = chars.slice(0, field.cursor);
	const lineStart = before.lastIndexOf("\n") + 1;
	const nextBreak = chars.indexOf("\n", field.cursor);
	const lineEnd = nextBreak < 0 ? chars.length : nextBreak;
	switch (key.name) {
		case "left": field.cursor = Math.max(0, field.cursor - 1); break;
		case "right": field.cursor = Math.min(chars.length, field.cursor + 1); break;
		case "home": field.cursor = key.ctrl ? 0 : lineStart; break;
		case "end": field.cursor = key.ctrl ? chars.length : lineEnd; break;
		case "backspace": if (field.cursor) chars.splice(--field.cursor, 1); break;
		case "delete": chars.splice(field.cursor, 1); break;
		case "up": {
			if (lineStart === 0) break;
			const previousStart = chars.slice(0, lineStart - 1).lastIndexOf("\n") + 1;
			field.cursor = Math.min(lineStart - 1, previousStart + field.cursor - lineStart);
			break;
		}
		case "down": if (lineEnd < chars.length) {
			const followingBreak = chars.indexOf("\n", lineEnd + 1);
			field.cursor = Math.min(followingBreak < 0 ? chars.length : followingBreak, lineEnd + 1 + field.cursor - lineStart);
		} break;
	}
	field.value = chars.join("");
}

function formKey(state: TuiState, text: string, key: Key): TuiAction | undefined {
	const form = state.form!;
	if (key.name === "escape") { state.form = undefined; state.notice = "Draft discarded."; return; }
	if (key.ctrl && key.name === "s") return formAction(state);
	if (state.pending) return;
	if (form.kind === "new" && key.name === "tab") { form.focus = (form.focus + (key.shift ? 2 : 1)) % 3; return; }
	if (form.kind === "new" && form.focus === 2) {
		const workflows = state.snapshot?.workflows ?? [];
		const direction = ["left", "up"].includes(key.name ?? "") ? -1 : ["right", "down"].includes(key.name ?? "") ? 1 : 0;
		if (direction && workflows.length) {
			const index = workflows.indexOf(form.workflow);
			form.workflow = workflows[(index + direction + workflows.length) % workflows.length]!;
		}
		return;
	}
	if (key.name === "return" || key.name === "enter" || (key.ctrl && key.name === "j")) {
		if (form.kind === "new" && form.focus === 0) form.focus = 1;
		else insertFormText(state, "\n");
		return;
	}
	const field = activeField(form);
	if (field && ["left", "right", "home", "end", "backspace", "delete", "up", "down"].includes(key.name ?? "")) editField(field, key);
	else if (!key.ctrl && !key.meta && text) insertFormText(state, text);
}

function navigate(state: TuiState, key: Key, text: string, pageSize: number): boolean {
	const name = key.name;
	let delta = name === "up" || text === "k" ? -1 : name === "down" || text === "j" ? 1 : 0;
	if (name === "pageup") delta = -pageSize;
	if (name === "pagedown") delta = pageSize;
	if (!delta && name !== "home" && name !== "end") return false;
	if (state.view === "detail" || state.overlay === "help") {
		const field = state.overlay ? "overlayScroll" : "scroll";
		state[field] = name === "home" ? 0 : name === "end" ? Number.MAX_SAFE_INTEGER : Math.max(0, state[field] + delta);
	} else {
		const tasks = state.snapshot?.tasks ?? [];
		const index = Math.max(0, tasks.findIndex(task => task.id === state.selectedId));
		const next = name === "home" ? 0 : name === "end" ? tasks.length - 1 : Math.max(0, Math.min(tasks.length - 1, index + delta));
		state.selectedId = tasks[next]?.id;
		state.scroll = 0;
	}
	return true;
}

function taskKey(state: TuiState, text: string): TuiAction | undefined {
	if (!canSubmit(state)) return;
	const task = selectedTask(state);
	if (text === "n") {
		if (!state.snapshot?.workflows.length) { state.notice = "This daemon has no available workflows."; return; }
		state.form = { kind: "new", focus: 0, title: { value: "", cursor: 0 }, description: { value: "", cursor: 0 }, workflow: state.snapshot.workflows[0]! };
		state.notice = "New task. Ctrl-S submits; Esc discards the draft.";
	} else if (text === "s") { state.overlay = "stop"; }
	else if (!task) state.notice = "Select a task first.";
	else if (text === "a" && task.state === "waiting" && task.questions[0]) {
		const question = task.questions[0];
		state.form = { kind: "answer", taskId: task.id, questionId: question.id, question: question.text, text: { value: "", cursor: 0 } };
		state.notice = "Answering the oldest question. Ctrl-S sends the answer.";
	} else if (text === "c" && ["queued", "running", "waiting"].includes(task.state)) return commandAction({ command: "cancel", id: task.id });
	else if (text === "r" && task.state === "failed") return commandAction({ command: "retry", id: task.id });
	else state.notice = text === "r" ? "Only failed tasks can be retried. Retry creates a new execution." : text === "a" ? "No answerable question on this task." : "This task is not cancellable.";
}

/** Interprets one decoded key. I/O and mutations run separately in runTui. */
export function handleTuiKey(state: TuiState, text: string, key: Key, pageSize = 8): TuiAction | undefined {
	if (key.ctrl && (key.name === "c" || key.name === "d")) return { type: "quit" };
	if (state.form) return formKey(state, text, key);
	if (text === "q") return { type: "quit" };
	if (key.name === "escape") {
		if (state.overlay) state.overlay = undefined;
		else state.view = "list";
		return;
	}
	if (state.overlay === "stop") {
		if (text === "n") state.overlay = undefined;
		if (text === "y" && canSubmit(state)) { state.overlay = undefined; return commandAction({ command: "stop" }); }
		return;
	}
	if (navigate(state, key, text, pageSize)) return;
	if (text === "?") { state.overlay = state.overlay ? undefined : "help"; state.overlayScroll = 0; return; }
	if (state.overlay) return;
	if (key.name === "return" && selectedTask(state)) { state.view = "detail"; state.scroll = 0; return; }
	if (["n", "a", "c", "r", "s"].includes(text)) return taskKey(state, text);
}
