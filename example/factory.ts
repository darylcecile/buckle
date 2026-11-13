import { factory, Supervisor } from "@buckles/factory";
import { mainWorkflow } from './workflows';
import { Github } from "@buckles/adapters";
import { Intervals } from "@buckles/utils";

/** Host repository settings. Resolution/authentication happen only when an agent executes. */
export interface ExampleFactoryOptions {
	repository?: string;
	cwd?: string;
	baseBranch?: string;
}

/** Reuses the actual seven-stage example, including its gates, reviewers, and delivery policy. */
export function createExampleFactory(options: ExampleFactoryOptions = {}) {
	const repository = options.repository ?? (process.env.GITHUB_REPOSITORY || undefined);
	return factory.define({
		supervisor: new Supervisor({
			model: Github.model("gpt-6-luna", { variant: "xhigh" }),
			wakeupInterval: Intervals.minutes(5),
		}),
		workflows: [mainWorkflow],
		executor: new Github.CopilotExecutor({
			commandTimeoutMs: 120_000,
			githubAuth: "cli",
			githubToken: process.env.GITHUB_TOKEN,
			repositories: repository ? [repository] : [],
			repository: {
				name: repository,
				cwd: options.cwd ?? process.cwd(),
				...(options.baseBranch ? { baseBranch: options.baseBranch } : {}),
				bootstrap: ["apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git ca-certificates"],
			},
		}),
	});
}

export default createExampleFactory();
