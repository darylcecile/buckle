import assert from "node:assert/strict";
import test from "node:test";
import { Container } from "../dist/index.js";
import { microsandbox } from "../dist/container.js";

const resources = { image: "alpine:3.22", memory: "512MiB", cpu: 1 };

function driver(context, overrides = {}) {
	const observed = { creates: 0, destroys: 0, restarts: 0, loads: 0 };
	const output = { code: 7, success: false, stdout: () => "out", stderr: () => "failure",
		stdoutBytes: () => new Uint8Array([0, 255]), stderrBytes: () => new Uint8Array([1]) };
	const filesystem = {
		copyFromHost: async (...paths) => { observed.upload = paths; },
		copyToHost: async (...paths) => { observed.download = paths; },
	};
	const execBuilder = {
		args(value) { observed.args = value; return this; },
		timeout(value) { observed.timeout = value; return this; },
		cwd(value) { observed.cwd = value; return this; },
		envs(value) { observed.env = value; return this; },
	};
	const stream = { collect: async () => output, kill: async () => {} };
	const sandbox = {
		id: "native-identity",
		execWith: async (command, configure) => { observed.command = command; configure(execBuilder); return output; },
		execStreamWith: async (command, configure) => { observed.command = command; configure(execBuilder); return stream; },
		fs: () => filesystem,
		pause: async () => { observed.paused = true; },
		resume: async () => { observed.paused = false; },
		stopWithTimeout: async value => { observed.stopTimeout = value; },
		restart: async () => { observed.restarts++; return sandbox; },
		destroy: async options => {
			if (observed.paused && !options.force) throw new Error("Resume before graceful destruction");
			observed.destroys++;
			observed.destroyOptions = options;
		},
		...overrides,
	};
	const network = {
		portBind(bind, host, guest) { observed.port = { bind, host, guest }; return this; },
		policy(value) { observed.policy = value; return this; },
	};
	const sdk = {
		defaultBackendKind: () => "local",
		Sandbox: { builder: name => {
			observed.name = name;
			return {
				image(value) { observed.image = value; return this; },
				memory(value) { observed.memory = value; return this; },
				cpus(value) { observed.cpus = value; return this; },
				network(configure) { configure(network); return this; },
				async createWithProgress() {
					observed.creates++;
					return { awaitSandbox: async () => sandbox, cancel() {} };
				},
			};
		} },
	};
	context.mock.method(microsandbox, "load", async () => { observed.loads++; return sdk; });
	return { observed, sdk, sandbox, output, filesystem, stream };
}

test("resource capture is inert and maps decimal/binary memory and network configuration at start", async context => {
	const { observed } = driver(context);
	const policy = { defaultIngress: "allow", defaultEgress: "deny", rules: [] };
	const options = { ...resources, memory: "1.5GiB", cpu: 2,
		network: network => network.portBind("127.0.0.1", 18080, 8080).policy(policy) };
	const vm = new Container.MicroVM(options);
	options.cpu = 9;
	assert.equal(observed.loads, 0);
	assert.equal(observed.port, undefined);
	assert.equal(Object.isFrozen(vm.options), true);
	assert.equal(vm.memoryMiB, 1536);
	for (const [memory, expected] of [["16GB", 15259], ["16GiB", 16384], ["512MB", 489], ["512MiB", 512]]) {
		assert.equal(new Container.MicroVM({ ...resources, memory }).memoryMiB, expected);
	}
	for (const memory of ["0GB", "-1GB", "NaN", "InfinityGB", "16", "1TB"]) {
		assert.throws(() => new Container.MicroVM({ ...resources, memory }));
	}
	for (const cpu of [0, -1, 0.5, NaN, Infinity]) assert.throws(() => new Container.MicroVM({ ...resources, cpu }));
	await vm.start();
	assert.equal(observed.memory, 1536);
	assert.equal(observed.cpus, 2);
	assert.equal(observed.image, resources.image);
	assert.deepEqual(observed.port, { bind: "127.0.0.1", host: 18080, guest: 8080 });
	assert.equal(observed.policy, policy);
	await vm.destroy();
});

test("exec preserves failure status and raw output; streaming and transfers use official handles", async context => {
	const { observed, output, filesystem, stream } = driver(context);
	const vm = new Container.MicroVM(resources);
	assert.throws(() => vm.fs(), /await start/);
	await vm.start();
	const result = await vm.exec("program", ["argument with spaces", ";literal"], { cwd: "/work", env: { MODE: "test" }, timeoutMs: 250 });
	assert.equal(result, output);
	assert.equal(result.code, 7);
	assert.equal(result.stderr(), "failure");
	assert.deepEqual(result.stdoutBytes(), new Uint8Array([0, 255]));
	assert.deepEqual(observed.args, ["argument with spaces", ";literal"]);
	assert.equal(observed.cwd, "/work");
	assert.equal(observed.timeout, 250);
	assert.deepEqual(observed.env, { MODE: "test" });
	assert.equal(await vm.execStream("program"), stream);
	assert.equal(vm.fs(), filesystem);
	await vm.upload("/host/a ' file", "/guest/a ' file");
	await vm.download("/guest/output", "/host/output");
	assert.deepEqual(observed.upload, ["/host/a ' file", "/guest/a ' file"]);
	assert.deepEqual(observed.download, ["/guest/output", "/host/output"]);
	await vm.destroy();
});

test("Promise-returning operations reject invalid states and destroy timeouts asynchronously", async context => {
	driver(context);
	const vm = new Container.MicroVM(resources);
	await assert.rejects(vm.destroy({ timeoutMs: 0 }), /timeoutMs/);
	assert.equal(vm.state, "new");
	await vm.start();
	for (const transition of [() => vm.pause(), () => vm.stop()]) {
		await transition();
		const error = new RegExp(`VM is ${vm.state}`);
		await assert.rejects(vm.exec("program"), error);
		await assert.rejects(vm.execStream("program"), error);
		await assert.rejects(vm.upload("/host/input", "/guest/input"), error);
		await assert.rejects(vm.download("/guest/output", "/host/output"), error);
	}
	await vm.destroy();
});

test("concurrent starts converge; pending exec does not block pause, resume, or stop/restart", async context => {
	const pending = Promise.withResolvers();
	const { observed, output } = driver(context, { execWith: () => pending.promise });
	const vm = new Container.MicroVM(resources);
	const started = await Promise.all([vm.start(), vm.start()]);
	assert.equal(started[0], vm);
	assert.equal(started[1], vm);
	assert.equal(observed.creates, 1);
	const execution = vm.exec("long-command");
	await vm.pause();
	assert.equal(vm.state, "paused");
	assert.equal(observed.paused, true);
	await assert.rejects(vm.start(), /resume/);
	await vm.resume();
	assert.equal(observed.paused, false);
	assert.equal(vm.state, "running");
	pending.resolve(output);
	assert.equal(await execution, output);
	await vm.pause();
	await vm.stop(500);
	assert.equal(observed.paused, false);
	assert.equal(observed.stopTimeout, 500);
	assert.equal(vm.state, "stopped");
	assert.equal(vm.id, "native-identity");
	await vm.start();
	assert.equal(observed.restarts, 1);
	assert.equal(observed.creates, 1);
	await vm.pause();
	await vm.destroy();
	await vm.destroy();
	assert.equal(observed.paused, false);
	assert.equal(observed.destroys, 1);
	assert.equal(vm.state, "destroyed");
	await assert.rejects(vm.start(), /destroyed/);
});

test("destroy waits for an in-flight create and removes its exact acquired identity", async context => {
	const { sdk, sandbox, observed } = driver(context);
	const created = Promise.withResolvers();
	const creating = Promise.withResolvers();
	const builder = sdk.Sandbox.builder("race");
	builder.createWithProgress = async () => {
		creating.resolve();
		return { awaitSandbox: () => created.promise, cancel() {} };
	};
	sdk.Sandbox.builder = () => builder;
	const vm = new Container.MicroVM(resources);
	const start = vm.start();
	await creating.promise;
	const destroy = vm.destroy({ force: true, timeoutMs: 500 });
	created.resolve(sandbox);
	await Promise.all([start, destroy]);
	assert.equal(observed.destroys, 1);
	assert.deepEqual(observed.destroyOptions, { force: true, timeoutMs: 500 });
	assert.equal(vm.state, "destroyed");
});

test("lifecycle failures remain visible and allow explicit identity-safe cleanup retry", async context => {
	const failure = new Error("native timeout");
	const { sandbox, observed } = driver(context, { stopWithTimeout: async () => { throw failure; } });
	const vm = new Container.MicroVM(resources);
	await vm.start();
	await assert.rejects(vm.stop(10), error => error === failure);
	assert.equal(vm.state, "unknown");
	sandbox.destroy = async () => { throw failure; };
	await assert.rejects(vm.destroy(), error => error === failure);
	assert.equal(vm.id, "native-identity");
	sandbox.destroy = async () => { observed.destroys++; };
	await vm.destroy({ force: true });
	assert.equal(observed.destroys, 1);
	assert.equal(vm.id, undefined);
});

test("creation timeout requests native cancellation and waits for it before destruction", async context => {
	const { sdk, observed } = driver(context);
	const pending = Promise.withResolvers();
	let cancelled = false;
	const builder = sdk.Sandbox.builder("timeout");
	builder.createWithProgress = async () => ({ awaitSandbox: () => pending.promise, cancel() {
		cancelled = true;
		pending.reject(new Error("creation cancelled"));
	} });
	sdk.Sandbox.builder = () => builder;
	const vm = new Container.MicroVM(resources);
	await assert.rejects(vm.start(1), /creation cancelled/);
	assert.equal(cancelled, true);
	await vm.destroy();
	assert.equal(observed.destroys, 0);
});

test("name conflicts and cloud defaults never attach to or delete an unowned sandbox", async context => {
	const { sdk, observed } = driver(context);
	const builder = sdk.Sandbox.builder("taken");
	builder.createWithProgress = async () => { throw new Error("name already exists"); };
	sdk.Sandbox.builder = () => builder;
	const vm = new Container.MicroVM({ ...resources, name: "taken" });
	await assert.rejects(vm.start(), /already exists/);
	await vm.destroy();
	assert.equal(observed.destroys, 0);
	sdk.defaultBackendKind = () => "cloud";
	const local = new Container.MicroVM(resources);
	await assert.rejects(local.start(), /local backend/);
	await local.destroy();
});