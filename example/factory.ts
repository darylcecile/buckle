import { factory, Supervisor } from "@buckles/factory";
import { mainWorkflow } from './workflows';
import { Github } from "@buckles/adapters";
import { Intervals } from "@buckles/utils";

export default factory.define({

	supervisor: new Supervisor({
		model: Github.model("gpt-6-luna", { variant: "xhigh" }),
		wakeupInterval: Intervals.minutes(5),
	}),

	workflows: [
		mainWorkflow
	],

	executor: new Github.CopilotExecutor({
		githubToken: process.env.GITHUB_TOKEN,
		repositories: process.env.GITHUB_REPOSITORY ? [process.env.GITHUB_REPOSITORY] : [],
	})

});