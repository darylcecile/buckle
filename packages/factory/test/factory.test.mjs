import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Agent, Container, factory, Instruction, Model, SessionContext, Skill, Stage, Supervisor, Workflow } from "../dist/index.js";

test("agent overrides preserve the original configuration and model metadata", () => {
	const model = new Model("github", "test-model", { variant: "high" });
	const skills = [Skill.fromFile("todo")];
	const base = new Agent({ name: "Planner", role: "research", model, skills, mode: "interactive" });
	skills.length = 0;
	const override = base.with({ name: "Developer", role: "developer", skills: ["implementation"] });
	assert.equal(base.options.name, "Planner");
	assert.equal(base.options.skills[0].path, "todo");
	assert.equal(override.options.mode, "interactive");
	assert.deepEqual(override.options.skills, ["implementation"]);
	assert.equal(override.options.model, model);
	assert.equal(model.provider, "github");
	assert.equal(model.id, "test-model");
	assert.equal(model.options.variant, "high");
	assert.equal(new Agent({ name: "Default", role: "research", model }).options.mode, "self-driving");
});

test("write references share data without altering read references or subclass private state", () => {
	class Findings extends SessionContext {
		#details = { count: 0 };
		increment() { return ++this.#details.count; }
		createReference() {
			const reference = new Findings(this.options);
			reference.#details = this.#details;
			return reference;
		}
	}
	const context = new Findings({ description: "Findings" });
	const write = context.expectWrite();
	assert.notEqual(write, context);
	assert.equal(context.writeExpected, false);
	assert.equal(write.writeExpected, true);
	assert.equal(write.id, context.id);
	write.data.set("result", "checked");
	assert.equal(context.data.get("result"), "checked");
	assert.equal(write.increment(), 1);
	assert.equal(context.increment(), 2);
	assert.equal(write.expectWrite().increment(), 3);
});

test("file references stay deferred and resolve conventional paths from an explicit base", async () => {
	const base = fileURLToPath(new URL("../../../example/", import.meta.url));
	const skill = Skill.fromFile("todo");
	const instruction = Instruction.fromFile("checks");
	assert.equal(await skill.load(base), await readFile(`${base}/skills/todo/SKILL.md`, "utf8"));
	assert.equal(await instruction.load(base), await readFile(`${base}/instructions/checks.md`, "utf8"));
	assert.equal(await Instruction.fromFile("workflow.md").load(base), await readFile(`${base}/instructions/workflow.md`, "utf8"));
	assert.equal(await Instruction.fromFile("instructions/checks.md").load(base), await instruction.load(base));
	await assert.rejects(Instruction.fromFile("missing-reference").load(base), { code: "ENOENT" });
	assert.throws(() => skill.load("."), /absolute/);
});

test("composition retains order, policies, contexts, and lazy callbacks without executing them", () => {
	const context = new SessionContext({});
	const lazy = () => { throw new Error("must remain lazy"); };
	const stage = new Stage({ name: "Review", agents: [], contexts: [context], instruction: "Review", policies: {
		returns: lazy, gates: lazy, permissions: { createNewTasks: true },
	}, hooks: { beforeAgents: lazy, afterAgents: lazy } });
	const stages = [stage, new Stage({ name: "Done", agents: [], contexts: [], instruction: "Done" })];
	const workflow = new Workflow({ name: "Main", container: new Container.MicroVM({ image: "ubuntu:latest", cpu: 4, memory: "16GB" }),
		instruction: Instruction.fromFile("workflow.md"), policies: { concurrency: 10, maxRetries: 3, learnings: { outcome: "raise" } }, stages });
	stages.reverse();
	const config = factory.define({ supervisor: new Supervisor({}), workflows: [workflow] });
	assert.equal(config.workflows[0].options.stages[0], stage);
	assert.equal(stage.options.contexts[0], context);
	assert.equal(stage.options.hooks.afterAgents, lazy);
	assert.equal(stage.options.policies.permissions.createNewTasks, true);
	assert.equal(workflow.options.policies.maxRetries, 3);
	assert.equal(workflow.options.container.options.memory, "16GB");
});