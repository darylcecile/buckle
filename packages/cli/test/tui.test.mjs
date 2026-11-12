import assert from "node:assert/strict";
import test from "node:test";
import { applySnapshot, createTuiState, handleTuiKey, insertFormText, selectedTask, taskActions } from "../dist/tui-state.js";
import { renderTui, taskDetailLines } from "../dist/tui-render.js";

const task = (id, values = {}) => ({ id, title: `Task ${id}`, description: "Implement the requested change.\nKeep existing behaviour.", workflow: "Build", stage: "Review", agent: "Reviewer", attempt: 2,
	state: "running", activity: "Inspecting changes", createdAt: "2026-11-12T10:00:00Z", updatedAt: "2026-11-12T10:00:01Z", questions: [], outputs: [], cleanupErrors: [], ...values });
const snapshot = tasks => ({ pid: 123, factory: "/fixtures/factory.ts", stopping: false, workflows: ["Build", "Review"], tasks });
function connected(tasks = [task("first"), task("second")]) {
	const state = createTuiState("/fixtures/factory.ts");
	applySnapshot(state, snapshot(tasks));
	return state;
}
const key = (state, name, extra = {}) => handleTuiKey(state, "", { name, ...extra });
const type = (state, text) => handleTuiKey(state, text, { name: text });

test("refresh and reconnect preserve selected identity and an in-progress form", () => {
	const state = connected();
	key(state, "down");
	type(state, "n");
	insertFormText(state, "My draft");
	key(state, "tab");
	insertFormText(state, "Description\nsecond line");
	const form = structuredClone(state.form);
	state.connection = "disconnected";
	assert.equal(key(state, "s", { ctrl: true }), undefined);
	applySnapshot(state, snapshot([task("new"), task("second", { state: "completed" }), task("first")]));
	assert.equal(selectedTask(state).id, "second");
	assert.deepEqual(state.form, form);
	assert.equal(state.connection, "connected");
	key(state, "escape");
	assert.equal(state.selectedId, "second");
});

test("new task form edits multiline input, selects server workflows and submits only explicitly", () => {
	const state = connected();
	type(state, "n");
	insertFormText(state, "New task");
	key(state, "return");
	assert.equal(type(state, "n"), undefined);
	key(state, "return");
	insertFormText(state, "q\r\nc\ttext\x1b[31m!");
	assert.equal(state.form.description.value, "n\nq\nc  text!");
	key(state, "tab");
	key(state, "right");
	key(state, "tab", { shift: true });
	assert.equal(state.form.focus, 1);
	const action = key(state, "s", { ctrl: true });
	assert.deepEqual(action, { type: "command", command: { command: "add", input: { title: "New task", description: "n\nq\nc  text!", workflow: "Review" } } });
	assert.equal(state.view, "list");
});

test("text editing keeps Unicode intact and moves through real line boundaries", () => {
	const state = connected();
	type(state, "n");
	insertFormText(state, "A😀B");
	key(state, "left");
	key(state, "backspace");
	insertFormText(state, "中");
	assert.equal(state.form.title.value, "A中B");
	key(state, "home");
	key(state, "delete");
	key(state, "end");
	assert.equal(state.form.title.cursor, 2);
	key(state, "tab");
	insertFormText(state, "abcd\nxy\nlast");
	key(state, "home");
	key(state, "up");
	assert.equal(state.form.description.cursor, 5);
	key(state, "end");
	key(state, "up");
	assert.equal(state.form.description.cursor, 2);
	key(state, "down");
	assert.equal(state.form.description.cursor, 7);
});

test("answer draft stays attached to its question and survives errors or changed questions", () => {
	const waiting = task("waiting", { state: "waiting", questions: [{ id: "oldest", text: "Which approach?" }, { id: "next", text: "Proceed?" }] });
	const state = connected([waiting]);
	type(state, "a");
	assert.equal(key(state, "s", { ctrl: true }), undefined);
	assert.match(state.notice, /answer is required/);
	insertFormText(state, "First approach");
	key(state, "return");
	insertFormText(state, "With tests");
	assert.deepEqual(key(state, "s", { ctrl: true }), { type: "command", command: { command: "answer", id: "waiting", text: "First approach\nWith tests" } });
	applySnapshot(state, snapshot([task("waiting", { state: "waiting", questions: [{ id: "next", text: "Proceed?" }] })]));
	assert.equal(key(state, "s", { ctrl: true }), undefined);
	assert.match(state.notice, /no longer pending/);
	assert.equal(state.form.text.value, "First approach\nWith tests");
});

test("task actions match lifecycle and stop confirmation never prevents detach", () => {
	const state = connected([task("failed", { state: "failed" })]);
	assert.deepEqual(taskActions(selectedTask(state)), ["r retry (new execution)"]);
	assert.deepEqual(type(state, "r"), { type: "command", command: { command: "retry", id: "failed" } });
	assert.equal(type(state, "c"), undefined);
	applySnapshot(state, snapshot([task("failed", { state: "running" })]));
	assert.deepEqual(type(state, "c"), { type: "command", command: { command: "cancel", id: "failed" } });
	type(state, "s");
	assert.equal(state.overlay, "stop");
	assert.equal(key(state, "return"), undefined);
	assert.deepEqual(type(state, "y"), { type: "command", command: { command: "stop" } });
	state.pending = "Stopping daemon...";
	state.stopRequested = true;
	assert.deepEqual(type(state, "q"), { type: "quit" });
	assert.deepEqual(key(state, "c", { ctrl: true }), { type: "quit" });
});

test("rendering keeps selection reachable and task/provider text safe at narrow sizes", () => {
	const tasks = Array.from({ length: 30 }, (_, index) => task(`id-${index.toString().padStart(4, "0")}`, { title: `Title ${index}\x1b[2J\u202e`, activity: "Working\x1b]0;title\x07" }));
	const state = connected(tasks);
	key(state, "end");
	for (const columns of [20, 40, 80, 120]) {
		const frame = renderTui(state, columns, 24);
		assert.match(frame.text, /> id-0029/);
		assert.match(frame.text, /q detach/);
		assert.ok(frame.text.split("\n").every(line => line.length < columns));
		assert.ok(frame.text.split("\n").length <= 24);
		assert.ok(/^[\x20-\x7e\n]*$/.test(frame.text));
	}
});

test("full details retain descriptions, outputs, questions, cleanup failures and retry lineage while scrolling", () => {
	const original = task("original", { state: "failed", error: "Provider failed", cleanupErrors: ["Container cleanup failed"], questions: [{ id: "question-id", text: "Confirm the full specification?" }], outputs: [{ stage: "Review", agent: "Reviewer", attempt: 2, text: "Start\n" + "Long output\n".repeat(30) + "Final output line" }] });
	const retry = task("retry-id", { retryOf: "original" });
	const lines = taskDetailLines(original, [original, retry], 40).join("\n");
	for (const expected of ["Keep existing behaviour.", "Provider failed", "Container cleanup failed", "question-id", "Retried as: retry-id", "Final output line"]) assert.ok(lines.includes(expected), expected);
	assert.match(taskDetailLines(retry, [original, retry], 80).join("\n"), /Retry of: original/);
	const state = connected([original, retry]);
	key(state, "return");
	key(state, "end");
	const frame = renderTui(state, 40, 15);
	assert.match(frame.text, /Final output line/);
	assert.ok(frame.scroll > 0);
	state.scroll = frame.scroll;
	key(state, "up");
	assert.equal(state.scroll, frame.scroll - 1);
	assert.ok(renderTui(state, 40, 15).text.split("\n").length <= 15);
});
