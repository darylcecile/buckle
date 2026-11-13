import { Stage, Instruction, Reference, Container } from '@buckles/factory';
import { accessibilityReviewAgent, codeReviewAgent, implementationAgent, todoAgent, triageAgent, visualReviewAgent, checksAgent, doneAgent } from './agents';
import { dependencies, learnings, plan, userDecisions, githubContext, reviewFindings, checksFindings } from './context';
import { Github } from '@buckles/adapters';

const mainContainerReference = new Reference("mainContainer");
const reviewContainerReference = new Reference("reviewContainer");

function delivery(): "merge" | "pull-request" {
	const value = userDecisions.data.get("delivery");
	if (value !== "merge" && value !== "pull-request") {
		throw new Error('Todo must record userDecisions key "delivery" as "merge" or "pull-request" before proceeding');
	}
	return value;
}

function currentHeadGates(): Promise<void>[] {
	return [
		Github.gates.CopilotCodeReview(githubContext, { status: "done" }),
		Github.gates.Checks(githubContext, { ignore: [], expected: ["buckles/verification"] }),
	];
}

export const todoStage = new Stage({
	name: "Todo",
	kind: "todo",
	agents: [ todoAgent ],
	contexts: [ plan, userDecisions ],
	instruction: 'Clarify the outcome, constraints and acceptance criteria. Record userDecisions key "delivery": "merge" by default, or "pull-request" when the user explicitly requests PR-only delivery. Clarify genuinely ambiguous intent.',
	hooks: {
		afterAgents: () => [(async () => { delivery(); })()],
	},
	container: Container.createOrReuse(mainContainerReference),
});

export const triageStage = new Stage({
	name: "Triage & Plan",
	kind: "triage",
	agents: [ triageAgent ],
	contexts: [ plan, userDecisions ],
	policies: {
		returns: () => [ todoStage ]
	},
	instruction: "Select repository work or existing PRs and define responsibilities and dependencies.",
	container: Container.createOrReuse(mainContainerReference),
});

export const implementationStage = new Stage({
	name: "Implementation",
	agents: [ implementationAgent ],
	contexts: [ plan, userDecisions, dependencies, learnings, githubContext, reviewFindings ],
	policies: {
		returns: () => [ todoStage, triageStage ],
		permissions: { createNewTasks: false, publishPullRequest: true },
	},
	instruction: "Implement the chosen task according to the determined priority and next steps.",
	container: Container.createOrReuse(mainContainerReference),
});

export const checksStage = new Stage({
	name: "Checks",
	kind: "checks",
	agents: [ checksAgent ],
	contexts: [ checksFindings.expectWrite(), githubContext ],
	hooks: {
		beforeAgents: () => [Github.act.ReadyForChecks(githubContext, { ignore: [], expected: ["buckles/verification"] })],
	},
	policies: {
		returns: () => [ implementationStage ],
		gates: currentHeadGates,
	},
	instruction: Instruction.fromFile('checks'),
	container: Container.createOrReuse(mainContainerReference),
});

export const reviewStage = new Stage({
	name: "Review",
	kind: "review",
	agents: [ visualReviewAgent, accessibilityReviewAgent, codeReviewAgent ],
	contexts: [ plan, userDecisions, dependencies, learnings, githubContext, reviewFindings ],
	hooks: {
		beforeAgents: () => [
			Github.act.ReadyForAgents(githubContext) // loads comments and other data into context
		]
	},
	policies: {
		returns: () => [ triageStage, implementationStage ],
	},
	instruction: Instruction.fromFile('review'),
	container: Container.createOrReuse(reviewContainerReference),
});

export const mergeStage = new Stage({
	name: "Merge",
	kind: "merge",
	agents: [ ],
	contexts: [ plan, userDecisions, dependencies, learnings, githubContext, reviewFindings, checksFindings ],
	hooks: {
		beforeAgents: () => [(async () => {
			if (delivery() === "pull-request") {
				const url = githubContext.snapshot?.pullRequest.url;
				if (!url) throw new Error("PR-only delivery requested, but the reviewed pull request URL is unavailable; merge stopped");
				throw new Error(`PR-only delivery requested: ${url} is ready for the user's review. Stopped before Merge; no merge was attempted and Done was not run.`);
			}
		})()],
		afterAgents: () => [Github.act.Merge(githubContext)],
	},
	policies: { gates: currentHeadGates },
	instruction: Instruction.fromFile('merge'),
	container: Container.createOrReuse(mainContainerReference),
});

export const doneStage = new Stage({
	name: "Done",
	kind: "done",
	agents: [ doneAgent ],
	contexts: [ plan, userDecisions, learnings, githubContext ],
	hooks: {
		beforeAgents: () => [(async () => {
			if (!githubContext.mergeResult?.merged) throw new Error("Done requires an actual confirmed GitHub merge result");
			await Github.act.ReadyForAgents(githubContext);
		})()],
	},
	policies: {
		permissions: { createNewTasks: true }
	},
	instruction: Instruction.fromFile('done'),
	container: Container.createOrReuse(mainContainerReference)
});
