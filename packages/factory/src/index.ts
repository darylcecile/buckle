import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, isAbsolute, resolve } from "node:path";
import type { SessionContext } from "./context.js";
import { Container, Reference } from "./container.js";

export { SessionContext, type SessionContextOptions } from "./context.js";
export { Container, Reference, type MicroVMOptions, type MicroVMNetwork, type MicroVMState, type MicroVMExecOptions } from "./container.js";

/** Options shared by adapter model descriptors. */
export interface ModelOptions {
	/** Provider-specific model variant, for example a reasoning effort level. */
	variant: string;
}

/** A model descriptor, not a model client. Construction never contacts a provider. */
export class Model {
	declare private readonly _brand: void;
	/** Adapter identifier used to route a model, such as `github`. */
	readonly provider: string;
	/** Model identifier supplied by the caller; availability is not checked here. */
	readonly id: string;
	/** Provider-specific options retained for later consumption. */
	readonly options: Readonly<ModelOptions>;

	/** Creates an immutable descriptor without credentials or network access. */
	constructor(provider: string, id: string, options: ModelOptions) {
		this.provider = nonempty(provider, "Model provider");
		this.id = nonempty(id, "Model identifier");
		this.options = Object.freeze({ variant: nonempty(options.variant, "Model variant") });
		Object.freeze(this);
	}
}

function nonempty(value: string, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must not be empty`);
	return value;
}

function readReference(path: string, baseDirectory: string, kind: "skill" | "instruction"): Promise<string> {
	if (!isAbsolute(baseDirectory)) throw new TypeError("baseDirectory must be an absolute path");
	let relativePath = path;
	if (!isAbsolute(path) && !path.includes("/") && !path.includes("\\")) {
		relativePath = kind === "skill" && !extname(path)
			? `skills/${path}/SKILL.md`
			: kind === "instruction" ? `instructions/${extname(path) ? path : `${path}.md`}` : path;
	}
	return readFile(resolve(baseDirectory, relativePath), "utf8");
}

/** A deferred skill file reference, distinct from an instruction reference. */
export class Skill {
	declare private readonly _brand: void;
	/** Original name or explicit file path; creation does not access the filesystem. */
	readonly path: string;
	private constructor(path: string) { this.path = nonempty(path, "Skill path"); }

	/** Stores a skill name (e.g. `todo`) or an explicit file path without reading it. */
	static fromFile(path: string): Skill { return new Skill(path); }

	/**
	 * Reads UTF-8 content. Bare names resolve to `skills/<name>/SKILL.md` beneath
	 * the absolute base directory; explicit paths resolve against that directory.
	 * Filesystem errors propagate to the caller. No caching or prompt parsing occurs.
	 */
	load(baseDirectory: string): Promise<string> { return readReference(this.path, baseDirectory, "skill"); }
}

/** A deferred instruction file reference. Inline instructions remain plain strings. */
export class Instruction {
	declare private readonly _brand: void;
	/** Original name or file path, retained without filesystem access. */
	readonly path: string;
	private constructor(path: string) { this.path = nonempty(path, "Instruction path"); }

	/** Stores an instruction name or path; both `checks` and `workflow.md` are accepted. */
	static fromFile(path: string): Instruction { return new Instruction(path); }

	/**
	 * Reads UTF-8 content. Bare filenames resolve under `instructions/`, with `.md`
	 * appended only when no extension exists. Explicit paths resolve against the
	 * absolute base directory. Filesystem errors propagate; no implicit base is used.
	 */
	load(baseDirectory: string): Promise<string> { return readReference(this.path, baseDirectory, "instruction"); }
}

/** Configuration for an agent; it does not start an agent process. */
export interface AgentOptions {
	/** Responsibility assigned to the agent. */
	role: string;
	/** Display name of the agent. */
	name: string;
	/** Adapter-provided model descriptor. */
	model: Model;
	/** Skill names or deferred file references, in application order. */
	skills?: (string | Skill)[];
	/** Interaction policy. Defaults to `self-driving`. */
	mode?: "interactive" | "self-driving";
}

/** Agent configuration with immutable, selected-option overrides. */
export class Agent {
	declare private readonly _brand: void;
	/** Captured options; skills default to an empty list and mode to `self-driving`. */
	readonly options: Readonly<Omit<Required<AgentOptions>, "skills"> & { skills: readonly (string | Skill)[] }>;

	/** Captures the configuration and copies the skill list without loading skills. */
	constructor(options: AgentOptions) {
		this.options = Object.freeze({
			...options,
			skills: Object.freeze([...(options.skills ?? [])]),
			mode: options.mode ?? "self-driving",
		});
	}

	/** Returns a new agent. Supplied fields replace existing fields, including the skill list. */
	with(options: Partial<AgentOptions>): Agent {
		return new Agent({ ...this.options, skills: [...this.options.skills], ...options });
	}
}

/** Optional supervisor metadata; consumers decide how to use it. */
export interface SupervisorOptions {
	/** Adapter-provided model descriptor; no model client is started. */
	model?: Model;
	/** Requested interval in milliseconds, finite and nonnegative; fractions are accepted. No scheduling occurs. */
	wakeupInterval?: number;
}

/** Supervisor definition. It does not schedule workflows or execute agents. */
export class Supervisor {
	declare private readonly _brand: void;
	/** Captured supervisor configuration. */
	readonly options: Readonly<SupervisorOptions>;
	/** Captures optional metadata without starting a timer or contacting a model provider. */
	constructor(options: SupervisorOptions) {
		if (options.wakeupInterval !== undefined && (!Number.isFinite(options.wakeupInterval) || options.wakeupInterval < 0)) {
			throw new RangeError("wakeupInterval must be finite and nonnegative milliseconds");
		}
		this.options = Object.freeze({ ...options });
	}
}

/** Declarative workflow policies; consumers decide how to enforce them. */
export interface WorkflowPolicies {
	/** Maximum concurrent workflow sessions. */
	concurrency?: number;
	/** Retry limit for a consumer executing this workflow. */
	maxRetries?: number;
	/** Handling of learnings produced by the workflow. */
	learnings?: {
		/** Raise a learning, ignore it, or request a decision. */
		outcome?: "raise" | "ignore" | "request";
	};
}

/** A workflow's ordered configuration. */
export interface WorkflowOptions {
	/** Display name of the workflow. */
	name: string;
	/** Default resource template; resolving a stage clones it per task without provisioning. */
	container: Container.MicroVM;
	/** Inline text or a deferred instruction reference shared by stages. */
	instruction: string | Instruction;
	/** Concurrency, retries, and learning policy metadata. */
	policies: WorkflowPolicies;
	/** Stages retained in the supplied order. */
	stages: Stage[];
}

/** Ordered workflow definition; construction does not call hooks, gates, or return policies. */
export class Workflow {
	declare private readonly _brand: void;
	private readonly defaultContainer = Container.createOrReuse(new Reference(`workflow/${randomUUID()}`));
	/** Captured workflow configuration with an independent stage list. */
	readonly options: Readonly<Omit<WorkflowOptions, "stages" | "policies"> & {
		stages: readonly Stage[];
		policies: Readonly<Omit<WorkflowPolicies, "learnings"> & { learnings?: Readonly<WorkflowPolicies["learnings"]> }>;
	}>;
	/** Captures the ordered stages and policy values without executing them. */
	constructor(options: WorkflowOptions) {
		this.options = Object.freeze({ ...options, stages: Object.freeze([...options.stages]), policies: Object.freeze({
			...options.policies,
			learnings: options.policies.learnings && Object.freeze({ ...options.policies.learnings }),
		}) });
	}

	/**
	 * Resolves a stage binding with this workflow's resource defaults. Stages sharing a named
	 * reference share one VM for the same task; unbound stages share a workflow-local default per task.
	 * Distinct task identities never share a VM, even within the same workflow or run.
	 * The consumer must supply a stable task reference with a globally unique name per execution,
	 * including concurrent or repeated executions with matching display labels. Never pass a
	 * workflow-run reference containing multiple tasks. Destroy each resolved VM when the task finishes.
	 * Resolution is inert; explicitly await `vm.start()`.
	 */
	resolveContainer(stage: Stage, taskReference: Reference): Container.MicroVM {
		if (!this.options.stages.includes(stage)) throw new Error("Stage does not belong to this workflow");
		return (stage.options.container ?? this.defaultContainer)(taskReference, this.options.container.options);
	}
}

/** Declarative return, gate, and permission policies for a stage. */
export interface StagePolicies {
	/** Lazy references to possible return stages; supports forward references. */
	returns?: () => Stage[];
	/** Creates gate promises when explicitly invoked by the consumer. Await every result. */
	gates?: () => Promise<void>[];
	/** Permissions granted to an external stage executor. */
	permissions?: {
		/** Whether this stage may create tasks. This package does not create tasks. */
		createNewTasks: boolean;
	};
}

/** Lazy hooks; merely defining a stage never calls them. */
export interface StageHooks {
	/** Actions to invoke before agents. The consumer must await all promises. */
	beforeAgents?: () => Promise<void>[];
	/** Actions to invoke after agents. GitHub actions serialize per session in invocation order. */
	afterAgents?: () => Promise<void>[];
}

/** Configuration for a stage, including its shared context references. */
export interface StageOptions {
	/** Display name of the stage. */
	name: string;
	/** Optional consumer-defined stage category. */
	kind?: string;
	/** Agents participating in this stage. An empty list is allowed. */
	agents: Agent[];
	/** Read references or per-use write references created with `expectWrite()`. */
	contexts: SessionContext[];
	/** Inline instructions or a deferred file reference. */
	instruction: string | Instruction;
	/** Optional task-scoped container lookup; resolved explicitly by `Workflow.resolveContainer`. */
	container?: Container.ReferenceLookup;
	/** Return, gate, and permission policy metadata. */
	policies?: StagePolicies;
	/** Actions invoked explicitly by a consumer, never during construction. */
	hooks?: StageHooks;
}

/** Stage definition, preserving context identity and lazy callbacks. */
export class Stage {
	declare private readonly _brand: void;
	/** Captured stage options with independent agent/context lists and policy objects. */
	readonly options: Readonly<Omit<StageOptions, "agents" | "contexts" | "policies" | "hooks"> & {
		agents: readonly Agent[];
		contexts: readonly SessionContext[];
		policies?: Readonly<Omit<StagePolicies, "permissions"> & { permissions?: Readonly<StagePolicies["permissions"]> }>;
		hooks?: Readonly<StageHooks>;
	}>;
	/** Captures stage configuration without calling any supplied function. */
	constructor(options: StageOptions) {
		this.options = Object.freeze({
			...options,
			agents: Object.freeze([...options.agents]),
			contexts: Object.freeze([...options.contexts]),
			policies: options.policies && Object.freeze({
				...options.policies,
				permissions: options.policies.permissions && Object.freeze({ ...options.policies.permissions }),
			}),
			hooks: options.hooks && Object.freeze({ ...options.hooks }),
		});
	}
}

/** A task submission before the runtime assigns an execution identity and selects a workflow. */
export interface TaskInput {
	/** Display title for the task. */
	title: string;
	/** Optional task details for the executor. */
	description?: string;
	/** Workflow name for runtime selection; omission leaves selection to the runtime. */
	workflow?: string;
}

/** A runtime-resolved task with an identity unique to this execution. */
export interface Task {
	/** Execution-unique identity, including repeated tasks with identical titles. */
	readonly id: string;
	/** Display title for the task. */
	readonly title: string;
	/** Task description resolved by the runtime. */
	readonly description: string;
	/** Name of the selected workflow. */
	readonly workflow: string;
}

/**
 * One agent invocation prepared by a runtime such as a CLI worker. The runtime
 * resolves instructions and task-scoped resources, and enforces the policies
 * governing report, ask, and createTask. Definitions alone grant no capabilities.
 */
export interface ExecutorRequest {
	/** Task being executed; its identity remains stable across its stages. */
	task: Readonly<Task>;
	/** Agent selected for this invocation. */
	agent: Agent;
	/** Selected workflow containing the current stage. */
	workflow: Workflow;
	/** Current stage and its declarative policies. */
	stage: Stage;
	/** Task-scoped VM from inert container lookup; executors may start it explicitly or leave it unused. */
	container: Container.MicroVM;
	/** Runtime-resolved workflow and stage instructions, including the agent's loaded skills. */
	instructions: string;
	/** Context references isolated per task by the runtime, preserving sharing within that task. */
	contexts: readonly SessionContext[];
	/** Runtime cancellation signal that the executor must observe. */
	signal: AbortSignal;
	/** Reports progress through the runtime's reporting policy. */
	report(message: string): void;
	/** Requests user input through the runtime, which enforces the agent's interaction policy. */
	ask(question: string): Promise<string>;
	/** Creates a task and returns its execution ID; the runtime must enforce stage createNewTasks permission. */
	createTask(input: TaskInput): Promise<string>;
}

/** Optional output and routing request from one agent invocation. */
export interface ExecutorResult {
	/** Output produced by the executor. */
	output?: string;
	/** The runtime must check this target against stage.options.policies.returns before routing. */
	returnTo?: Stage;
}

/** A caller-supplied execution strategy; factory definitions never invoke it or start a provider. */
export interface Executor {
	/** Executes one prepared request, owning any provider, tool execution, or VM startup it needs. */
	execute(request: ExecutorRequest): Promise<ExecutorResult | void>;
}

/** Executor, supervisor metadata, and workflows supplied to a factory definition. */
export interface FactoryConfig {
	/** Required execution strategy retained by reference; no default provider is supplied. */
	executor: Executor;
	/** Optional supervisor policies remain descriptive until a consumer uses them. */
	supervisor: Supervisor;
	/** Workflows included in the definition, in supplied order. */
	workflows: Workflow[];
}

/** Construction API only; no scheduler, runner, or implicit side effects. */
export const factory = {
	/** Validates executor.execute, retains the executor instance, and copies the workflow list without executing anything. */
	define(config: FactoryConfig): FactoryConfig {
		if (typeof config.executor?.execute !== "function") throw new TypeError("Executor must provide an execute function");
		return { ...config, workflows: [...config.workflows] };
	},
};