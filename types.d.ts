
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
		skills?: (string | Skill)[];
		/** interactivity mode */
		mode?: "interactive" | "self-driving"; // default self-driving
	}

	/** An opaque skill reference. */
	export class Skill {
		private readonly _brand: void;
		private constructor();
		/** Creates a skill reference from a file path. */
		static fromFile(path: string): Skill;
	}

	/** An opaque instruction reference. */
	export class Instruction {
		private readonly _brand: void;
		private constructor();
		/** Creates an instruction reference from a file path. */
		static fromFile(path: string): Instruction;
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

	/** Configuration for a session context. */
	export interface SessionContextOptions {
		/** Description of the context's purpose. */
		description?: string;
	}

	/** A session context that can be referenced by stages. */
	export class SessionContext {
		private readonly _brand: void;
		/** Creates a session context from its configuration. */
		constructor(options: SessionContextOptions);
		/** References this context with an expected write. */
		expectWrite(): this;
	}

	/** Configuration for a MicroVM container. */
	export interface MicroVMOptions {
		/** Image used by the container. */
		image: string;
		/** Memory allocation requested for the container. */
		memory: string;
		/** CPU allocation requested for the container. */
		cpu: number;
	}

	/** Container configuration API. */
	export namespace Container {
		/** An opaque MicroVM container reference. */
		export class MicroVM {
			private readonly _brand: void;
			/** Creates a MicroVM container from its configuration. */
			constructor(options: MicroVMOptions);
		}
	}

	/** Policies configured for a workflow. */
	export interface WorkflowPolicies {
		/** Concurrency limit configured for the workflow. */
		concurrency?: number;
		/** Maximum retries configured for the workflow. */
		maxRetries?: number;
		/** Policy for workflow learnings. */
		learnings?: {
			/** Outcome requested for workflow learnings. */
			outcome?: "raise" | "ignore" | "request";
		};
	}

	/** Configuration for a workflow. */
	export interface WorkflowOptions {
		/** Name of the workflow. */
		name: string;
		/** Container configured for the workflow. */
		container: Container.MicroVM;
		/** Instruction shared by the workflow. */
		instruction: string | Instruction;
		/** Policies configured for the workflow. */
		policies: WorkflowPolicies;
		/** Stages included in the workflow. */
		stages: Stage[];
	}

	/** A workflow configured with a container, instruction, policies, and stages. */
	export class Workflow {
		private readonly _brand: void;
		/** Creates a workflow from its configuration. */
		constructor(options: WorkflowOptions);
	}

	/** Policies configured for a stage. */
	export interface StagePolicies {
		/** Provides the stages referenced by this stage's return policy. */
		returns?: () => Stage[];
		/** Provides async gates that resolve or reject for the stage. */
		gates?: () => Promise<void>[];
		/** Permissions granted to the stage. */
		permissions?: {
			/** Whether the stage may create new tasks. */
			createNewTasks: boolean;
		};
	}

	/** Hooks configured around a stage's agents. */
	export interface StageHooks {
		/** Provides async actions before the stage's agents. */
		beforeAgents?: () => Promise<void>[];
		/** Provides async actions after the stage's agents. */
		afterAgents?: () => Promise<void>[];
	}

	/** Configuration for a stage. */
	export interface StageOptions {
		/** Name of the stage. */
		name: string;
		/** Kind of stage. */
		kind?: string;
		/** Agents configured for the stage. */
		agents: Agent[];
		/** Session contexts referenced by the stage. */
		contexts: SessionContext[];
		/** Instruction for the stage's agents. */
		instruction: string | Instruction;
		/** Optional policies for the stage. */
		policies?: StagePolicies;
		/** Optional hooks around the stage's agents. */
		hooks?: StageHooks;
	}

	/** A stage configured with agents, contexts, an instruction, and optional policies and hooks. */
	export class Stage {
		private readonly _brand: void;
		/** Creates a stage from its configuration. */
		constructor(options: StageOptions);
	}
}

declare module "@buckles/adapters" {
	import type { SessionContext as FactorySessionContext } from "@buckles/factory";

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

	/** GitHub model, context, gate, and action APIs. */
	export namespace Github {
		/** Provides a model reference for the given identifier and options. */
		export function model(id: string, options: ModelOptions): Model;

		/** A GitHub session context usable by stages, gates, and actions. */
		export class SessionContext extends FactorySessionContext {
			private readonly _githubBrand: void;
			/** Creates a GitHub session context. */
			constructor();
		}

		/** Async GitHub gate API. */
		export const gates: {
			/** Gates on the requested Copilot code review status. */
			CopilotCodeReview(context: SessionContext, options: {
				/** Copilot code review status required by the gate. */
				status: "done";
			}): Promise<void>;
			/** Gates on GitHub checks, excluding the configured names. */
			Checks(context: SessionContext, options: {
				/** Names of checks ignored by the gate. */
				ignore: string[];
			}): Promise<void>;
		};

		/** Async GitHub actions batched for execution in call order. */
		export const act: {
			/** Prepares GitHub session context for agents. */
			ReadyForAgents(context: SessionContext): Promise<void>;
			/** Attempts approval for the GitHub session. */
			TryApprove(context: SessionContext): Promise<void>;
			/** Requests a merge for the GitHub session. */
			Merge(context: SessionContext): Promise<void>;
		};
	}
}