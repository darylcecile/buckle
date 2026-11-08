/** Model contracts are owned by factory to keep package dependencies one-way. */
export type { Model, ModelOptions } from "@buckles/factory";
/** GitHub model descriptors, explicitly bound contexts, and asynchronous gates/actions. */
export * as Github from "./github.js";