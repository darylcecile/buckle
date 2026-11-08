import assert from "node:assert/strict";
import test from "node:test";
import { Agent, Instruction, Skill, Workflow } from "@buckles/factory";
import { Github } from "@buckles/adapters";

test("the unchanged example imports as a real factory definition without network or prompt loading", async (context) => {
	context.mock.method(globalThis, "fetch", () => { throw new Error("Import must not contact GitHub"); });
	context.mock.method(Skill.prototype, "load", () => { throw new Error("Import must not load skills"); });
	context.mock.method(Instruction.prototype, "load", () => { throw new Error("Import must not load instructions"); });
	const { default: config } = await import("../example/factory.ts");
	const stages = await import("../example/stages.ts");
	const { githubContext, checksFindings } = await import("../example/context.ts");
	const { todoAgent, implementationAgent } = await import("../example/agents.ts");
	assert.equal(config.workflows.length, 1);
	assert.ok(config.workflows[0] instanceof Workflow);
	assert.deepEqual(config.workflows[0].options.stages, [stages.todoStage, stages.triageStage, stages.implementationStage,
		stages.checksStage, stages.reviewStage, stages.mergeStage, stages.doneStage]);
	assert.ok(implementationAgent instanceof Agent);
	assert.equal(implementationAgent.options.model.provider, "github");
	assert.equal(implementationAgent.options.mode, "self-driving");
	assert.equal(todoAgent.options.mode, "interactive");
	assert.equal(checksFindings.writeExpected, false);
	assert.equal(stages.checksStage.options.contexts[0].writeExpected, true);
	assert.equal(stages.checksStage.options.contexts[0].id, checksFindings.id);
	assert.ok(githubContext instanceof Github.SessionContext);
	assert.equal(githubContext.bound, false);
});