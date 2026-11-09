import { access, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import type { FactoryConfig } from "@buckles/factory";

/** Resolves symlinks; defaults to factory.ts, then example/factory.ts in the current directory. */
export async function resolveFactoryPath(file?: string): Promise<string> {
	if (file) return realpath(resolve(file));
	for (const candidate of ["factory.ts", "example/factory.ts"]) {
		try { await access(candidate); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		return realpath(resolve(candidate));
	}
	throw new Error("No factory found; pass --factory <file> (or run <file>)");
}

/** Validates runtime policies without invoking hooks, return declarations, or executors. */
export function validateFactory(config: FactoryConfig): void {
	if (typeof config?.executor?.execute !== "function") throw new TypeError("Factory requires executor.execute");
	if (!Array.isArray(config.workflows) || !config.workflows.length) throw new TypeError("Factory requires at least one workflow");
	const names = new Set<string>();
	for (const workflow of config.workflows) {
		const { name, policies, stages } = workflow.options;
		if (typeof name !== "string" || !name.trim() || names.has(name)) throw new TypeError("Workflow names must be nonempty and unique");
		names.add(name);
		const concurrency = policies.concurrency ?? 1;
		const maxRetries = policies.maxRetries ?? 2;
		if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError(`${name}: concurrency must be a positive safe integer`);
		if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new RangeError(`${name}: maxRetries must be a nonnegative safe integer`);
		if (!Array.isArray(stages) || !stages.length) throw new TypeError(`${name}: at least one stage is required`);
	}
}

/** Imports trusted TS/JS definitions. Each production task calls this in a fresh child process. */
export async function loadFactory(file: string): Promise<FactoryConfig> {
	const loaded = await tsImport(pathToFileURL(file).href, import.meta.url);
	const config = loaded.default as FactoryConfig;
	validateFactory(config);
	return config;
}