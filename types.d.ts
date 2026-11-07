
declare module "@buckles/factory" {
	import type { Model } from "@buckles/adapters";

	/** Supervisor and workflows supplied to a factory definition. */
	export interface FactoryConfig {
		/** Supervisor configured for the factory. */
		supervisor: Supervisor;
		/** Workflows included in the factory configuration. */
		workflows: Workflow[];
	}

	/** Factory definition API. */
	export const factory: {
		/** Defines a factory configuration from its supervisor and workflows. */
		define(config: FactoryConfig): FactoryConfig;
	};

	/** Configuration for an agent. */
	export interface AgentOptions {
		/** Role assigned to the agent. */
		role: string;
		/** Name of the agent. */
		name: string;
		/** Adapter-provided model reference for the agent. */
		model: Model;
		/** Skill references configured for the agent. */
		skills?: string[];
	}

	/** An agent configured with a role, name, model, and optional skills. */
	export class Agent {
		private readonly _brand: void;
		/** Creates an agent from its configuration. */
		constructor(options: AgentOptions);
		/** Configures an agent with selected option overrides. */
		with(options: Partial<AgentOptions>): Agent;
	}

	/** No supervisor options are currently declared. */
	export type SupervisorOptions = Record<string, never>;

	/** Supervisor configured for a factory. */
	export class Supervisor {
		private readonly _brand: void;
		/** Creates a supervisor with an empty options object. */
		constructor(options: SupervisorOptions);
	}

	/** No session context options are currently declared. */
	export type SessionContextOptions = Record<string, never>;

	/** A session context that can be referenced by stages. */
	export class SessionContext {
		private readonly _brand: void;
		/** Creates a session context with an empty options object. */
		constructor(options: SessionContextOptions);
	}

	/** Configuration for a workflow. */
	export interface WorkflowOptions {
		/** Stages included in the workflow. */
		stages: Stage[];
	}

	/** A workflow configured with stages. */
	export class Workflow {
		private readonly _brand: void;
		/** Creates a workflow from its configuration. */
		constructor(options: WorkflowOptions);
	}

	/** Policies configured for a stage. */
	export interface StagePolicies {
		/** Provides the stages referenced by this stage's return policy. */
		returns: () => Stage[];
	}

	/** Configuration for a stage. */
	export interface StageOptions {
		/** Identifier for the stage. */
		id: string;
		/** Agents configured for the stage. */
		agents: Agent[];
		/** Session contexts referenced by the stage. */
		contexts: SessionContext[];
		/** Instruction for the stage's agents. */
		instruction: string;
		/** Optional policies for the stage. */
		policies?: StagePolicies;
	}

	/** A stage configured with agents, contexts, an instruction, and optional policies. */
	export class Stage {
		private readonly _brand: void;
		/** Creates a stage from its configuration. */
		constructor(options: StageOptions);
	}
}

declare module "@buckles/adapters" {
	const modelBrand: unique symbol;

	/** An opaque adapter-provided model reference. */
	export interface Model {
		readonly [modelBrand]: true;
	}

	/** Options for a model reference. */
	export interface ModelOptions {
		/** Variant requested for the model. */
		variant: string;
	}

	/** GitHub model adapter API. */
	export const Github: {
		/** Provides a model reference for the given identifier and options. */
		model(id: string, options: ModelOptions): Model;
	};
}