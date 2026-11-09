import assert from "node:assert/strict";
import test from "node:test";
import { renderBoard, renderEvent, safeJson, terminalText } from "../dist/index.js";

const record = { id: "12345678-0000", title: "Long title ".repeat(12), description: "", workflow: "Main", stage: "Review", state: "waiting", agent: "Reviewer", attempt: 2,
	activity: "Waiting", questions: [{ id: "question", text: "Approve?" }], outputs: [], cleanupErrors: [] };

test("wide and narrow boards fit their viewport and count offscreen tasks", () => {
	const tasks = Array.from({ length: 10 }, (_, index) => ({ ...record, id: `${index}-12345678` }));
	for (const columns of [20, 40, 60, 80, 120, 160]) {
		const board = renderBoard(tasks, { columns, rows: 12 });
		const lines = board.split("\n");
		assert.ok(lines.every(line => line.length <= columns), board);
		assert.ok(lines.length <= 12, board);
		assert.match(lines.at(-1), /\d+ offscreen/);
	}
	const board = renderBoard([record], { columns: 160 });
	for (const field of ["12345678", "Main", "Review", "waiting", "Reviewer", "Approve?"]) assert.ok(board.includes(field));
});

test("terminal text neutralizes ANSI, OSC, control and bidi input; JSON roundtrips originals", () => {
	const title = "\x1b[2J\x1b]0;changed\x07Title\r\n\t\x08\u202e\u4e2d";
	const event = renderEvent({ ...record, title });
	assert.match(event, /Title/);
	assert.ok(/^[\x20-\x7e]*$/.test(event));
	assert.equal(terminalText("\x1b[31mred\x1b[0m"), "red");
	const json = safeJson({ title });
	assert.equal(JSON.parse(json).title, title);
	assert.ok(/^[\x20-\x7e\n]*$/.test(json));
});