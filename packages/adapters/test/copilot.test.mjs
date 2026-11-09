import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { inspect } from "node:util";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { Agent, Container, Model, SessionContext, Stage, Workflow } from "@buckles/factory";
import { Github } from "../dist/index.js";
import { copilotSdk } from "../dist/copilot.js";
import { microsandbox } from "../../factory/dist/container.js";

const resources = { image: "alpine:3.22", memory: "512MiB", cpu: 1 };
const model = { id: "test-model", name: "Test model", capabilities: { supports: { reasoningEffort: true } }, supportedReasoningEfforts: ["xhigh"] };
const output = (code = 0, stdout = "", stderr = "") => ({ code, stdout: () => stdout, stderr: () => stderr });

function request(options = {}) {
	const controller = new AbortController();
	const shared = new SessionContext({ description: "Implementation plan" });
	const github = new Github.SessionContext();
	const agent = new Agent({ name: "Implementer", role: "Implement the task", model: Github.model(model.id, { variant: "xhigh" }), mode: "interactive", ...options.agent });
	const earlier = new Stage({ name: "Plan", agents: [], contexts: [], instruction: "Plan" });
	const stage = new Stage({ name: "Implement", agents: [agent], contexts: [shared, github], instruction: "Implement",
		policies: { returns: () => [earlier], permissions: { createNewTasks: true } }, ...options.stage });
	const container = new Container.MicroVM(resources);
	const workflow = new Workflow({ name: "Main", container: new Container.MicroVM(resources), instruction: "Work carefully", policies: {}, stages: [earlier, stage] });
	const reports = [];
	const created = [];
	return { controller, shared, github, earlier, reports, created,
		invocation: { task: { id: "task-1", title: "Improve build", description: "Details", workflow: "Main" },
			agent, workflow, stage, container, contexts: stage.options.contexts, instructions: "Loaded instructions and skills",
			signal: controller.signal, report: message => reports.push(message), ask: async question => `Answer to ${question}`,
			createTask: async input => { created.push(input); return "task-2"; } },
	};
}

function sdkDriver(context, dispatch, options = {}) {
	const observed = { files: new Map(), commands: [], starts: 0, aborts: 0, disconnects: 0, stops: 0, forces: 0, deleted: [], destroys: 0 };
	context.mock.method(microsandbox, "load", async () => ({
		defaultBackendKind: () => "local",
		Sandbox: { builder(name) {
			observed.vmName = name;
			const sandbox = {
				id: "native-task-vm",
				execWith: async (command, configure) => {
					const execution = { command };
					const builder = {
						args(value) { execution.args = value; return this; },
						cwd(value) { execution.cwd = value; return this; },
						timeout(value) { execution.timeoutMs = value; return this; },
					};
					configure(builder);
					observed.commands.push(execution);
					return command === "mkdir" ? output() : (options.exec?.(execution) ?? output(7, "guest stdout", "guest stderr"));
				},
				fs: () => ({
					write: async (path, data) => { observed.files.set(path, Buffer.from(data)); },
					readStream: async path => ({ async *[Symbol.asyncIterator]() { yield observed.files.get(path); } }),
				}),
				destroy: async () => { observed.destroys++; },
			};
			return { image() { return this; }, cpus() { return this; }, memory() { return this; },
				createWithProgress: async () => {
					observed.starts++;
					return { awaitSandbox: async () => sandbox, cancel() {} };
				} };
		} },
	}));
	context.mock.method(copilotSdk, "create", async configuration => {
		observed.clientConfiguration = configuration;
		const session = {
			sessionId: "owned-session",
			abort: async () => { observed.aborts++; },
			disconnect: async () => { observed.disconnects++; options.disconnect?.(); },
			sendAndWait: async (message, timeout) => {
				observed.message = message;
				observed.timeout = timeout;
				return dispatch({ call: async (name, args) => {
					const tool = observed.sessionConfiguration.tools.find(tool => tool.name === name);
					assert.ok(tool, `Expected tool ${name}`);
					return tool.handler(args, { sessionId: session.sessionId, toolCallId: "tool-call", toolName: name, arguments: args });
				}, observed });
			},
		};
		return {
			start: async () => { if (options.startError) throw options.startError; },
			listModels: async () => options.models ?? [model],
			createSession: async config => { observed.sessionConfiguration = config; return session; },
			deleteSession: async id => { observed.deleted.push(id); },
			stop: async () => { observed.stops++; return options.stopErrors ?? []; },
			forceStop: async () => { observed.forces++; },
		};
	});
	return observed;
}

function value(result) {
	assert.equal(result.resultType, "success", result.textResultForLlm);
	return JSON.parse(result.textResultForLlm);
}

test("dispatch uses the selected task VM, declared contexts and real runtime callbacks, then returns explicit completion", async context => {
	const task = request();
	const observed = sdkDriver(context, async ({ call }) => {
		value(await call("guest_write", { path: "result.txt", content: "from the guest" }));
		assert.equal(value(await call("guest_read", { path: "result.txt" })), "from the guest");
		assert.deepEqual(value(await call("guest_exec", { command: "run-checks" })), { exitCode: 7, stdout: "guest stdout", stderr: "guest stderr" });
		value(await call("write_context", { context: 0, key: "plan", value: { complete: true } }));
		assert.deepEqual(value(await call("read_context", { context: 0 })).data, { plan: { complete: true } });
		assert.equal(value(await call("ask_user", { question: "Which target?" })), "Answer to Which target?");
		value(await call("report", { message: "Guest check completed" }));
		assert.deepEqual(value(await call("create_task", { title: "Follow up", workflow: "Main" })), { id: "task-2" });
		assert.equal((await call("write_context", { context: 20, key: "outside", value: true })).resultType, "failure");
		assert.equal((await call("complete_stage", { summary: "Retry", returnTo: "Missing stage" })).resultType, "failure");
		value(await call("complete_stage", { summary: "Implemented; return for plan review", returnTo: "Plan" }));
		assert.equal((await call("guest_write", { path: "late.txt", content: "too late" })).resultType, "failure");
	});
	const executor = new Github.CopilotExecutor({ commandTimeoutMs: 200, timeoutMs: 1000 });
	assert.equal(observed.clientConfiguration, undefined);
	const result = await executor.execute(task.invocation);
	assert.deepEqual(result, { output: "Implemented; return for plan review", returnTo: task.earlier });
	assert.deepEqual(JSON.parse(observed.message.prompt).permittedReturnStages, ["Plan"]);
	assert.equal(observed.vmName, task.invocation.container.name);
	assert.equal(task.invocation.workflow.options.container.state, "new");
	assert.deepEqual(observed.commands.at(-1), { command: "/bin/sh", args: ["-c", "run-checks"], cwd: "/workspace", timeoutMs: 200 });
	assert.deepEqual(task.shared.data.get("plan"), { complete: true });
	assert.deepEqual(task.created, [{ title: "Follow up", workflow: "Main", description: undefined }]);
	assert.ok(task.reports.includes("Guest check completed"));
	assert.equal(observed.files.has("/workspace/late.txt"), false);
	assert.equal(observed.disconnects, 1);
	assert.equal(observed.stops, 1);
	assert.deepEqual(observed.deleted, ["owned-session"]);
	assert.equal(observed.destroys, 0);
	assert.equal(task.invocation.container.state, "running");
	await assert.rejects(access(observed.clientConfiguration.workingDirectory), { code: "ENOENT" });
	await task.invocation.container.destroy();
});

test("only source-qualified custom VM/task tools are exposed; host tools and managed approvals are denied", async context => {
	const task = request({ agent: { mode: "self-driving" }, stage: { policies: {} } });
	const observed = sdkDriver(context, async ({ call, observed }) => {
		const config = observed.sessionConfiguration;
		assert.ok(config.availableTools.every(name => name.startsWith("custom:")));
		assert.ok(config.excludedTools.includes("builtin:*"));
		assert.ok(config.excludedTools.includes("mcp:*"));
		assert.equal(config.availableTools.includes("custom:ask_user"), false);
		assert.equal(config.availableTools.includes("custom:create_task"), false);
		for (const kind of ["shell", "read", "write", "mcp", "url", "hook"]) {
			assert.equal(config.onPermissionRequest({ kind, toolName: "guest_exec" }).kind, "reject");
		}
		assert.equal(config.onPermissionRequest({ kind: "custom-tool", toolName: "guest_exec" }).kind, "approve-once");
		assert.equal(config.onPermissionRequest({ kind: "custom-tool", toolName: "guest_exec", managedApprovalRequired: true }).kind, "reject");
		assert.equal(config.onPermissionRequest({ kind: "custom-tool", toolName: "bash" }).kind, "reject");
		assert.equal(config.hooks.onPreToolUse({ toolName: "bash" }).permissionDecision, "deny");
		assert.equal(config.enableConfigDiscovery, false);
		assert.equal(config.enableSkills, false);
		assert.equal(config.enableFileHooks, false);
		assert.equal(config.enableHostGitOperations, false);
		assert.deepEqual(config.mcpServers, {});
		assert.equal(config.tools.find(tool => tool.name === "complete_stage").isTerminal, true);
		value(await call("complete_stage", { summary: "Finished" }));
	});
	await new Github.CopilotExecutor().execute(task.invocation);
	assert.equal(observed.clientConfiguration.mode, "empty");
	assert.equal(observed.clientConfiguration.useLoggedInUser, true);
	assert.equal(observed.sessionConfiguration.model, model.id);
	assert.deepEqual(observed.sessionConfiguration.allowedModels, [model.id]);
	assert.equal(observed.sessionConfiguration.reasoningEffort, "xhigh");
	await task.invocation.container.destroy();
});

test("Copilot authentication excludes ambient tokens without changing the host environment", async context => {
	const ambient = { GITHUB_TOKEN: "test-ambient-github", GH_TOKEN: "test-ambient-gh",
		COPILOT_GITHUB_TOKEN: "test-ambient-copilot", BUCKLES_COPILOT_TEST_ENV: "preserved" };
	const previous = Object.entries(ambient).map(([name]) => [name, process.env[name]]);
	context.after(() => {
		for (const [name, original] of previous) {
			if (original === undefined) delete process.env[name];
			else process.env[name] = original;
		}
	});
	Object.assign(process.env, ambient);
	const observed = sdkDriver(context, async ({ call }) => { value(await call("complete_stage", { summary: "Done" })); });
	for (const copilotToken of [undefined, "test-explicit-copilot"]) {
		const task = request();
		await new Github.CopilotExecutor({ githubToken: ambient.GITHUB_TOKEN, copilotToken }).execute(task.invocation);
		const config = observed.clientConfiguration;
		assert.ok(config.env !== process.env);
		for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "COPILOT_GITHUB_TOKEN"]) {
			assert.equal(Object.hasOwn(config.env, name), false);
		}
		assert.equal(config.env.BUCKLES_COPILOT_TEST_ENV, "preserved");
		assert.equal(config.gitHubToken, copilotToken);
		assert.equal(config.useLoggedInUser, copilotToken === undefined);
		for (const [name, expected] of Object.entries(ambient)) assert.equal(process.env[name], expected);
		await task.invocation.container.destroy();
	}
});

test("unavailable or unsupported models fail before VM startup or a model request, without substitution", async context => {
	const task = request();
	const observed = sdkDriver(context, () => assert.fail("No paid request should run"), { models: [{ ...model, supportedReasoningEfforts: ["low"] }] });
	await assert.rejects(new Github.CopilotExecutor().execute(task.invocation), /does not advertise reasoning variant xhigh/);
	assert.equal(observed.starts, 0);
	assert.equal(observed.sessionConfiguration, undefined);
	assert.equal(observed.stops, 1);
	const other = task.invocation.agent.with({ model: new Model("other", "test", { variant: "xhigh" }) });
	await assert.rejects(new Github.CopilotExecutor().execute({ ...task.invocation, agent: other }), /requires a Github.model/);
});

test("missing completion rejects; cleanup failures remain visible alongside the primary error", async context => {
	const task = request();
	const observed = sdkDriver(context, async () => undefined, { stopErrors: [new Error("stop failed")] });
	await assert.rejects(new Github.CopilotExecutor().execute(task.invocation), error => {
		assert.ok(error instanceof AggregateError);
		assert.match(error.errors[0].message, /ended without complete_stage/);
		assert.match(error.errors[1].message, /stop failed/);
		return true;
	});
	assert.equal(observed.aborts, 1);
	assert.equal(observed.disconnects, 1);
	assert.equal(observed.forces, 1);
	await task.invocation.container.destroy();
});

test("provider startup failure cleans up its client and host workspace without exposing credentials", async context => {
	const token = "test-startup-secret";
	const task = request();
	const observed = sdkDriver(context, () => assert.fail("No model call after startup failure"), {
		startError: new Error(`Authentication failed ${token}`),
	});
	await assert.rejects(new Github.CopilotExecutor({ copilotToken: token }).execute(task.invocation), error => {
		assert.equal(error.message, "Authentication failed [redacted]");
		assert.equal(inspect(error, { showHidden: true }).includes(token), false);
		return true;
	});
	assert.equal(observed.stops, 1);
	assert.equal(observed.starts, 0);
	await assert.rejects(access(observed.clientConfiguration.workingDirectory), { code: "ENOENT" });
});

test("cancellation aborts Copilot and waits for admitted guest work before releasing the invocation", async context => {
	const task = request();
	const entered = Promise.withResolvers();
	const release = Promise.withResolvers();
	let commandSettled = false;
	const observed = sdkDriver(context, async ({ call }) => { await call("guest_exec", { command: "long-running-check" }); }, {
		exec: async () => { entered.resolve(); await release.promise; commandSettled = true; return output(); },
		disconnect: () => assert.equal(commandSettled, true),
	});
	let settled = false;
	const execution = new Github.CopilotExecutor().execute(task.invocation).finally(() => { settled = true; });
	const rejected = assert.rejects(execution, /cancelled by user/);
	await entered.promise;
	task.controller.abort(new Error("cancelled by user"));
	await setImmediate();
	assert.equal(observed.aborts, 1);
	assert.equal(settled, false);
	release.resolve();
	await rejected;
	assert.equal(observed.disconnects, 1);
	assert.equal(observed.stops, 1);
	assert.equal(observed.destroys, 0);
	await task.invocation.container.destroy();
});

test("an unanswered human question observes the invocation deadline instead of inventing an answer", { timeout: 2000 }, async context => {
	const task = request();
	task.invocation.ask = () => new Promise(() => {});
	const observed = sdkDriver(context, async ({ call }) => {
		const response = await call("ask_user", { question: "Need a decision" });
		assert.equal(response.resultType, "failure");
	});
	await assert.rejects(new Github.CopilotExecutor({ timeoutMs: 50 }).execute(task.invocation), /timed out/);
	assert.equal(observed.aborts, 1);
	assert.equal(observed.stops, 1);
	await task.invocation.container.destroy();
});

test("PR binding shares the original context and exposes prepared snapshots without either host token", async context => {
	const task = request();
	const githubToken = "test-github-secret";
	const copilotToken = "test-copilot-secret";
	const snapshots = [];
	context.mock.method(globalThis, "fetch", async (url, init) => {
		assert.equal(init.headers.Authorization, `Bearer ${githubToken}`);
		assert.ok(String(url).startsWith("https://api.github.com/repos/acme/project/"));
		return Response.json(String(url).endsWith("/pulls/7") ? { number: 7, title: "PR title", body: "Details", html_url: "https://github.com/acme/project/pull/7",
			head: { sha: "a".repeat(40) }, base: { ref: "main" }, state: "open", draft: false, merged: false } : []);
	});
	const observed = sdkDriver(context, async ({ call }) => {
		snapshots.push(await call("bind_github", { context: 1, owner: "acme", repo: "project", pullNumber: 7 }));
		assert.equal(task.github.bound, true);
		await Github.act.ReadyForAgents(task.github.expectWrite());
		const snapshot = await call("read_context", { context: 1 });
		snapshots.push(snapshot);
		assert.equal(value(snapshot).github.snapshot.pullRequest.number, 7);
		const command = value(await call("guest_exec", { command: "tool-output-check" }));
		assert.ok(command.stdout.startsWith("x".repeat(16_380)));
		assert.equal(command.stdout.includes("test"), false);
		assert.ok(command.stdout.endsWith("[truncated]"));
		snapshots.push(command);
		value(await call("report", { message: `Accidental echo ${githubToken}` }));
		value(await call("complete_stage", { summary: `Done ${copilotToken}` }));
	}, { exec: () => output(0, `${"x".repeat(16_380)}${githubToken}`) });
	const executor = new Github.CopilotExecutor({ githubToken, copilotToken, repositories: ["AcMe/PrOjEcT"] });
	assert.equal(inspect(executor, { showHidden: true }).includes(githubToken), false);
	assert.equal(JSON.stringify(executor).includes(copilotToken), false);
	assert.deepEqual(await executor.execute(task.invocation), { output: "Done [redacted]" });
	assert.equal(observed.clientConfiguration.gitHubToken, copilotToken);
	assert.equal(observed.clientConfiguration.useLoggedInUser, false);
	for (const token of [githubToken, copilotToken]) {
		assert.equal(JSON.stringify([snapshots, observed.sessionConfiguration, task.reports, observed.commands]).includes(token), false);
	}
	await task.invocation.container.destroy();
});

test("repository authorization denies model-selected targets but preserves deliberate host bindings", async context => {
	const githubToken = "test-repository-secret";
	for (const repositories of ["acme/project", null, [""], ["acme"], ["acme/"], ["/project"], ["acme/*"],
		["https://github.com/acme/project"], ["acme/project/extra"], [" acme/project"], ["acme/project\n"], ["acme/.."]]) {
		assert.throws(() => new Github.CopilotExecutor({ repositories }), /repositories must be an array of exact owner\/repo/);
	}
	const fetch = context.mock.method(globalThis, "fetch", async (url, init) => {
		assert.equal(init.headers.Authorization, `Bearer ${githubToken}`);
		assert.ok(String(url).startsWith("https://api.github.com/repos/host/selected/"));
		return Response.json(String(url).endsWith("/pulls/7") ? { number: 7, title: "Host-selected PR", body: "Details",
			html_url: "https://github.com/host/selected/pull/7", head: { sha: "a".repeat(40) }, base: { ref: "main" },
			state: "open", draft: false, merged: false } : []);
	});
	for (const repositories of [undefined, [], ["acme/project"]]) {
		const task = request();
		sdkDriver(context, async ({ call }) => {
			const targets = repositories?.length ? [["other", "project"], ["acme", "other"], ["acme", "project-extra"]] : [["acme", "project"]];
			for (const [owner, repo] of targets) {
				const binding = await call("bind_github", { context: 1, owner, repo, pullNumber: 7 });
				assert.equal(binding.resultType, "failure");
				assert.match(binding.textResultForLlm, /not authorized.*CopilotExecutor\(\{ repositories/);
				assert.equal(binding.textResultForLlm.includes(githubToken), false);
				assert.equal(task.github.bound, false);
			}
			await assert.rejects(Github.act.ReadyForAgents(task.github.expectWrite()), /unbound/);
			value(await call("complete_stage", { summary: "No authorized PR selected" }));
		});
		await new Github.CopilotExecutor({ githubToken, repositories }).execute(task.invocation);
		await task.invocation.container.destroy();
	}
	assert.equal(fetch.mock.callCount(), 0);
	const task = request();
	task.github.bind({ owner: "host", repo: "selected", pullNumber: 7, token: githubToken });
	sdkDriver(context, async ({ call }) => {
		await Github.act.ReadyForAgents(task.github.expectWrite());
		const snapshot = value(await call("read_context", { context: 1 }));
		assert.equal(snapshot.github.snapshot.pullRequest.title, "Host-selected PR");
		assert.equal(JSON.stringify(snapshot).includes(githubToken), false);
		value(await call("complete_stage", { summary: "Used the host-selected PR" }));
	});
	await new Github.CopilotExecutor().execute(task.invocation);
	assert.ok(fetch.mock.callCount() > 0);
	await task.invocation.container.destroy();
});

test("missing PR binding credentials fail only on bind_github, and tool inputs are bounded and validated", async context => {
	const task = request();
	sdkDriver(context, async ({ call }) => {
		const binding = await call("bind_github", { context: 1, owner: "acme", repo: "project", pullNumber: 7 });
		assert.equal(binding.resultType, "failure");
		assert.match(binding.textResultForLlm, /requires CopilotExecutor/);
		assert.equal(task.github.bound, false);
		assert.equal((await call("guest_exec", { command: 4 })).resultType, "failure");
		assert.equal((await call("guest_exec", { command: "echo", token: "forbidden" })).resultType, "failure");
		assert.equal((await call("guest_write", { path: "large", content: "x".repeat(2000) })).resultType, "failure");
		value(await call("complete_stage", { summary: "Finished a task without a PR" }));
	});
	await new Github.CopilotExecutor({ maxOutputBytes: 1024 }).execute(task.invocation);
	await task.invocation.container.destroy();
});