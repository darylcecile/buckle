import assert from "node:assert/strict";
import test from "node:test";
import { Agent, Instruction, Reference, Skill, Workflow } from "@buckles/factory";
import { Github } from "@buckles/adapters";
import { microsandbox } from "../packages/factory/dist/container.js";
import { copilotSdk } from "../packages/adapters/dist/copilot.js";
import { repositoryHost } from "../packages/adapters/dist/repository-auth.js";

test("the example imports as a real factory definition without network or prompt loading", async (context) => {
	context.mock.method(globalThis, "fetch", () => { throw new Error("Import must not contact GitHub"); });
	context.mock.method(Skill.prototype, "load", () => { throw new Error("Import must not load skills"); });
	context.mock.method(Instruction.prototype, "load", () => { throw new Error("Import must not load instructions"); });
	context.mock.method(microsandbox, "load", () => { throw new Error("Import and resolution must not load the native SDK"); });
	context.mock.method(copilotSdk, "create", () => { throw new Error("Import must not create a Copilot SDK client"); });
	context.mock.method(repositoryHost, "run", () => { throw new Error("Import must not resolve host authentication or Git source"); });
	const { default: config, createExampleFactory } = await import("../example/factory.ts");
	const disposable = createExampleFactory({ repository: "acme/project", baseBranch: "verification-base", cwd: process.cwd() });
	const stages = await import("../example/stages.ts");
	const { githubContext, checksFindings } = await import("../example/context.ts");
	const { todoAgent, implementationAgent } = await import("../example/agents.ts");
	assert.equal(config.workflows.length, 1);
	assert.ok(config.executor instanceof Github.CopilotExecutor);
	assert.ok(disposable.executor instanceof Github.CopilotExecutor);
	assert.equal(disposable.workflows[0], config.workflows[0]);
	assert.ok(config.workflows[0] instanceof Workflow);
	assert.deepEqual(config.workflows[0].options.stages, [stages.todoStage, stages.triageStage, stages.implementationStage,
		stages.checksStage, stages.reviewStage, stages.mergeStage, stages.doneStage]);
	assert.ok(implementationAgent instanceof Agent);
	assert.equal(implementationAgent.options.model.provider, "github-copilot");
	assert.equal(implementationAgent.options.mode, "self-driving");
	assert.equal(todoAgent.options.mode, "interactive");
	assert.equal(stages.implementationStage.options.policies.permissions.publishPullRequest, true);
	assert.equal(checksFindings.writeExpected, false);
	assert.equal(stages.checksStage.options.contexts[0].writeExpected, true);
	assert.equal(stages.checksStage.options.contexts[0].id, checksFindings.id);
	assert.ok(githubContext instanceof Github.SessionContext);
	assert.equal(githubContext.bound, false);
	assert.equal(config.supervisor.options.wakeupInterval, 300_000);
	assert.equal(config.supervisor.options.model.id, "gpt-6-luna");
	const workflow = config.workflows[0];
	const taskA = Reference.create("example-smoke-task-a");
	const taskB = Reference.create("example-smoke-task-b");
	const main = workflow.resolveContainer(stages.todoStage, taskA);
	const review = workflow.resolveContainer(stages.reviewStage, taskA);
	const otherMain = workflow.resolveContainer(stages.todoStage, taskB);
	assert.equal(main, workflow.resolveContainer(stages.implementationStage, taskA));
	assert.equal(otherMain, workflow.resolveContainer(stages.implementationStage, taskB));
	assert.notEqual(main, otherMain);
	assert.notEqual(main, review);
	assert.equal(main.options.image, workflow.options.container.options.image);
	assert.equal(main.options.cpu, workflow.options.container.options.cpu);
	assert.equal(main.state, "new");
	await Promise.all([main.destroy(), review.destroy(), otherMain.destroy()]);
});

test("the example records delivery early and stops PR-only work before Merge with the actual PR URL", async () => {
	const { todoStage, mergeStage, doneStage } = await import("../example/stages.ts");
	const { userDecisions, githubContext } = await import("../example/context.ts");
	await assert.rejects(Promise.all(todoStage.options.hooks.afterAgents()), /Todo must record.*delivery/);
	userDecisions.data.set("delivery", "pull-request");
	await Promise.all(todoStage.options.hooks.afterAgents());
	const url = "https://github.com/acme/project/pull/42";
	let merged = false;
	githubContext.bind({ owner: "acme", repo: "project", pullNumber: 42, token: "test-only-token", fetch: async (request, init) => {
		if (init.method === "PUT") {
			assert.equal(userDecisions.data.get("delivery"), "merge");
			merged = true;
			return Response.json({ merged: true, sha: "confirmed-merge-sha" });
		}
		assert.equal(init.method, "GET");
		return Response.json(new URL(request).pathname.endsWith("/pulls/42") ? {
			number: 42, title: "README", body: "PR-only", html_url: url, head: { sha: "a".repeat(40) },
			base: { ref: "main" }, state: merged ? "closed" : "open", draft: false, merged,
		} : []);
	} });
	await Github.act.ReadyForAgents(githubContext);
	await assert.rejects(Promise.all(mergeStage.options.hooks.beforeAgents()), error => error.message.includes(url) && /Stopped before Merge/.test(error.message));
	await assert.rejects(Promise.all(doneStage.options.hooks.beforeAgents()), /actual confirmed GitHub merge result/);
	userDecisions.data.set("delivery", "merge");
	await Promise.all(mergeStage.options.hooks.beforeAgents());
	await Github.act.Merge(githubContext);
	await Promise.all(doneStage.options.hooks.beforeAgents());
	assert.equal(githubContext.snapshot.pullRequest.merged, true);
	assert.equal(githubContext.snapshot.pullRequest.state, "closed");
	assert.equal(githubContext.mergeResult.sha, "confirmed-merge-sha");
	userDecisions.data.clear();
});
