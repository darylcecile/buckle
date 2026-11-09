import { randomUUID } from "node:crypto";
import type { DestroyOptions, ExecHandle, ExecOutput, NetworkBuilder, Sandbox, SandboxFsOps } from "microsandbox";

/** @internal Lazy native dependency boundary; importing definitions never loads the addon. */
export const microsandbox = { load: () => import("microsandbox") };

/** A named, process-local reference. Equal names share the same symbol identity. */
export class Reference {
	declare private readonly _brand: void;
	/** Caller-defined name, not an image reference. */
	readonly name: string;
	/** Interned identity shared by references with the same name. */
	readonly identity: symbol;

	/**
	 * Creates an inert reference. For tasks, use a stable name across stages of one execution.
	 * Concurrent or repeated task executions need globally unique names, even if display labels match.
	 */
	constructor(name: string) {
		if (typeof name !== "string" || !name.trim()) throw new TypeError("Reference name must not be empty");
		this.name = name;
		this.identity = Symbol.for(name);
		Object.freeze(this);
	}

	/** Convenience constructor with the same identity semantics as `new Reference(name)`. */
	static create(name: string): Reference { return new Reference(name); }

	/** Joins display names with `/`. Container scope keys use separate identities, not this delimiter. */
	static join(...references: Reference[]): Reference {
		return new Reference(references.map(reference => reference.name).join("/"));
	}
}

/** Official network builder callback, invoked only when starting a new VM. */
export type MicroVMNetwork = (network: InstanceType<typeof NetworkBuilder>) => InstanceType<typeof NetworkBuilder>;

/** Resource requirements for an explicitly managed, local microsandbox VM. */
export interface MicroVMOptions {
	/** OCI image reference, for example `alpine:3.22` or `ubuntu:latest`. */
	image: string;
	/** Positive MB/GB (decimal) or MiB/GiB (binary), rounded up to whole MiB. */
	memory: string;
	/** Positive safe integer CPU allocation; platform limits are checked by the SDK. */
	cpu: number;
	/** Optional unique native name (ASCII letters, digits, `_`, `-`, at most 128 characters). */
	name?: string;
	/** Official port, egress policy, DNS, and TLS configuration. Callback captures remain caller-owned. */
	network?: MicroVMNetwork;
}

/** Last wrapper-observed lifecycle state, not an authoritative remote status query. */
export type MicroVMState = "new" | "starting" | "running" | "paused" | "stopped" | "unknown" | "destroyed";

/** Options for a collected or streaming command, passed to the SDK execution builder. */
export interface MicroVMExecOptions {
	/** Guest working directory. */
	cwd?: string;
	/** Explicit guest environment additions; no host environment is copied by this wrapper. */
	env?: Readonly<Record<string, string>>;
	/** Positive integer execution timeout in milliseconds; defaults to 30000. */
	timeoutMs?: number;
}

function memoryMiB(memory: string): number {
	const match = typeof memory === "string" && /^\s*(\d+(?:\.\d+)?)\s*(MiB|GiB|MB|GB)\s*$/i.exec(memory);
	if (!match) throw new TypeError("memory must be a positive MB, GB, MiB, or GiB quantity");
	const units: Record<string, number> = { mb: 1_000_000, gb: 1_000_000_000, mib: 1_048_576, gib: 1_073_741_824 };
	const amount = Number(match[1]);
	const result = Math.ceil(amount * units[match[2]!.toLowerCase()]! / 1_048_576);
	if (!(amount > 0) || !Number.isSafeInteger(result) || result <= 0) throw new RangeError("memory must fit a positive safe integer MiB allocation");
	return result;
}

function timeout(value: number): number {
	if (!Number.isInteger(value) || value <= 0 || value > 4_294_967_295) {
		throw new RangeError("timeoutMs must be an integer from 1 to 4294967295");
	}
	return value;
}

/** Explicit local VM lifecycle and task-scoped container references. No scheduler is installed. */
export namespace Container {
	const tasks = new Map<symbol, Map<symbol, MicroVM>>();
	const releases = new WeakMap<MicroVM, () => void>();

	/** Lazy local VM. Construction captures configuration; only `start()` provisions resources. */
	export class MicroVM {
		declare private readonly _brand: void;
		/** Shallow-frozen configuration; a network callback is retained without invocation. */
		readonly options: Readonly<MicroVMOptions>;
		/** Unique native sandbox name, generated when omitted. Creation never replaces an existing name. */
		readonly name: string;
		/** Normalized whole-MiB allocation sent to the SDK. */
		readonly memoryMiB: number;
		private sandbox?: Sandbox;
		private lifecycle: Promise<unknown> = Promise.resolve();
		private observedState: MicroVMState = "new";

		/** Validates resources without loading the native SDK, reading credentials, or starting a VM. */
		constructor(options: MicroVMOptions) {
			if (typeof options.image !== "string" || !options.image.trim()) throw new TypeError("image must not be empty");
			if (!Number.isSafeInteger(options.cpu) || options.cpu <= 0) throw new RangeError("cpu must be a positive safe integer");
			this.memoryMiB = memoryMiB(options.memory);
			this.name = options.name ?? `buckles-${randomUUID()}`;
			if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(this.name)) throw new TypeError("name must be 1-128 ASCII letters, digits, underscores, or hyphens, beginning with a letter or digit");
			this.options = Object.freeze({ ...options });
		}

		/** Last successful transition; `unknown` means an SDK lifecycle call failed. */
		get state(): MicroVMState { return this.observedState; }
		/** Native identity once created. Retained after stop and cleared after destruction. */
		get id(): string | undefined { return this.sandbox?.id; }

		/**
		 * Creates and boots a local VM, or restarts its retained disk after stop. Concurrent starts
		 * converge on this instance. A paused VM requires `resume()`. Cloud defaults are rejected.
		 * Once the SDK returns a creation handle, requests cancellation after `timeoutMs` (default
		 * 120000) and awaits creation settlement. Cancellation is cooperative, not a hard deadline.
		 * Failed/cancelled creation provides no sandbox identity; native resources may remain, and
		 * this wrapper cannot safely remove them. Restart uses the SDK budget. No setup is performed.
		 */
		start(timeoutMs = 120_000): Promise<this> {
			return this.enqueue(async () => {
				timeout(timeoutMs);
				this.assertUsable();
				if (this.observedState === "running") return this;
				if (this.observedState === "paused") throw new Error("VM is paused; call resume() to preserve its resident state");
				this.observedState = "starting";
				try {
					if (this.sandbox) {
						this.sandbox = await this.sandbox.restart({ timeoutMs });
					} else {
						const sdk = await microsandbox.load();
						if (sdk.defaultBackendKind() !== "local") throw new Error("Container.MicroVM requires the microsandbox local backend");
						const builder = sdk.Sandbox.builder(this.name).image(this.options.image).cpus(this.options.cpu).memory(this.memoryMiB);
						if (this.options.network) builder.network(this.options.network);
						const creation = await builder.createWithProgress();
						const timer = setTimeout(() => creation.cancel(), Math.min(timeoutMs, 2_147_483_647));
						try {
							this.sandbox = await creation.awaitSandbox();
						} finally {
							clearTimeout(timer);
						}
					}
					this.observedState = "running";
					return this;
				} catch (error) {
					this.observedState = "unknown";
					throw error;
				}
			});
		}

		/** Suspend the resident VM, preserving processes and RAM; does not create a snapshot. */
		pause(): Promise<void> {
			return this.enqueue(async () => {
				if (this.observedState === "paused") return;
				const sandbox = this.running();
				await this.transition(() => sandbox.pause(), "paused");
			});
		}

		/** Resume a resident paused VM. This is not a stop/start or disk restore. */
		resume(): Promise<void> {
			return this.enqueue(async () => {
				this.assertUsable();
				if (this.observedState === "running") return;
				if (this.observedState !== "paused" || !this.sandbox) throw new Error("VM must be paused before resume()");
				await this.transition(() => this.sandbox!.resume(), "running");
			});
		}

		/** Graceful stop retaining disk and identity. Timeout rejects without an implicit kill; default 10000ms. */
		stop(timeoutMs = 10_000): Promise<void> {
			return this.enqueue(async () => {
				timeout(timeoutMs);
				this.assertUsable();
				if (!this.sandbox || this.observedState === "stopped") return;
				if (this.observedState === "paused") await this.transition(() => this.sandbox!.resume(), "running");
				await this.transition(() => this.sandbox!.stopWithTimeout(timeoutMs), "stopped");
			});
		}

		/**
		 * Stop and delete only this VM's native identity, then release its reference cache entry.
		 * Defaults to graceful shutdown with a 10000ms budget. `force: true` requests SDK force-kill.
		 * Graceful destruction resumes a paused VM first; force-kill does not resume guest execution.
		 * Idempotent after success; a failure is reported and may be explicitly retried.
		 * Without an acquired identity, releases local bookkeeping only, not failed-creation resources.
		 */
		async destroy(options: DestroyOptions = {}): Promise<void> {
			const settings = { ...options, timeoutMs: timeout(options.timeoutMs ?? 10_000) };
			return this.enqueue(async () => {
				if (this.observedState === "destroyed") return;
				if (this.observedState === "paused" && !settings.force) await this.transition(() => this.sandbox!.resume(), "running");
				if (this.sandbox) await this.transition(() => this.sandbox!.destroy(settings), "destroyed");
				this.observedState = "destroyed";
				this.sandbox = undefined;
				releases.get(this)?.();
				releases.delete(this);
			});
		}

		/** Collect stdout/stderr (text and bytes) and exit status; nonzero exit codes remain in `result.code`. */
		async exec(command: string, args: readonly string[] = [], options: MicroVMExecOptions = {}): Promise<ExecOutput> {
			return this.running().execWith(command, builder => this.configureExec(builder, args, options));
		}

		/** Stream output and control stdin/signals using the official SDK handle, independently of lifecycle calls. */
		async execStream(command: string, args: readonly string[] = [], options: MicroVMExecOptions = {}): Promise<ExecHandle> {
			return this.running().execStreamWith(command, builder => this.configureExec(builder, args, options));
		}

		/** Live SDK filesystem operations (binary reads/writes, streams, directories, stat, copy, rename). Requires running state. */
		fs(): SandboxFsOps { return this.running().fs(); }

		/** Copy one host file into the guest, binary-safe, without invoking a shell. */
		async upload(hostPath: string, guestPath: string): Promise<void> { return this.fs().copyFromHost(hostPath, guestPath); }

		/** Copy one guest file to the host, binary-safe, without invoking a shell. */
		async download(guestPath: string, hostPath: string): Promise<void> { return this.fs().copyToHost(guestPath, hostPath); }

		private configureExec(builder: Parameters<Parameters<Sandbox["execWith"]>[1]>[0], args: readonly string[], options: MicroVMExecOptions) {
			builder.args([...args]).timeout(timeout(options.timeoutMs ?? 30_000));
			if (options.cwd !== undefined) builder.cwd(options.cwd);
			if (options.env !== undefined) builder.envs({ ...options.env });
			return builder;
		}

		private assertUsable(): void {
			if (this.observedState === "destroyed") throw new Error("VM has been destroyed; resolve or construct a new VM");
		}

		private running(): Sandbox {
			if (this.observedState !== "running" || !this.sandbox) throw new Error(`VM is ${this.observedState}; await start() or resume() before guest operations`);
			return this.sandbox;
		}

		private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
			const result = this.lifecycle.then(operation);
			this.lifecycle = result.catch(() => undefined);
			return result;
		}

		private async transition(operation: () => Promise<void>, state: MicroVMState): Promise<void> {
			try {
				await operation();
				this.observedState = state;
			} catch (error) {
				this.observedState = "unknown";
				throw error;
			}
		}

	}

	/**
	 * Resolves the same named VM across a task's stages using a stable, execution-unique task identity.
	 * Defaults come from `Workflow.resolveContainer` or the explicit argument.
	 */
	export type ReferenceLookup = (taskReference: Reference, defaults?: MicroVMOptions) => MicroVM;

	/**
	 * Returns an inert lookup. The same task/container identities share one VM across stages and lookups;
	 * distinct task identities never share a VM, even within the same workflow or run.
	 * The consumer supplies a stable task reference, unique across concurrent and repeated executions
	 * even when display labels match. Never pass a workflow-run reference containing multiple tasks.
	 * Supply resource options here for a dedicated template, or let the workflow supply its defaults.
	 * The first resolution supplies configuration for that identity. Destroy releases the cached VM.
	 */
	export function createOrReuse(reference: Reference, options?: MicroVMOptions): ReferenceLookup {
		const template = options && Object.freeze({ ...options });
		return (taskReference, defaults) => {
			let taskContainers = tasks.get(taskReference.identity);
			const existing = taskContainers?.get(reference.identity);
			if (existing) return existing;
			const configuration = template ?? defaults;
			if (!configuration) throw new Error("Container lookup requires resource options or Workflow.resolveContainer(stage, taskReference)");
			const vm = new MicroVM({ ...configuration, name: configuration.name ? `${configuration.name.slice(0, 91)}-${randomUUID()}` : undefined });
			if (!taskContainers) tasks.set(taskReference.identity, taskContainers = new Map());
			taskContainers.set(reference.identity, vm);
			releases.set(vm, () => {
				taskContainers.delete(reference.identity);
				if (taskContainers.size === 0) tasks.delete(taskReference.identity);
			});
			return vm;
		};
	}
}