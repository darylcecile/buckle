import { Stage, Instruction, Reference, Container } from '@buckles/factory';
import { accessibilityReviewAgent, codeReviewAgent, implementationAgent, todoAgent, triageAgent, visualReviewAgent, checksAgent, doneAgent } from './agents';
import { dependencies, learnings, plan, userDecisions, githubContext, reviewFindings, checksFindings } from './context';
import { Github } from '@buckles/adapters';

const mainContainerReference = new Reference("mainContainer");
const reviewContainerReference = new Reference("reviewContainer");

export const todoStage = new Stage({
	name: "Todo",
	kind: "todo",
	agents: [ todoAgent ],
	contexts: [ plan, userDecisions ],
	instruction: "Clarify the outcome, constraints and acceptance criteria.",
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
		returns: () => [ todoStage, triageStage ]
	},
	instruction: "Implement the chosen task according to the determined priority and next steps.",
	container: Container.createOrReuse(mainContainerReference),
});

export const checksStage = new Stage({
	name: "Checks",
	kind: "checks",
	agents: [ checksAgent ],
	contexts: [ checksFindings.expectWrite(), githubContext ],
	policies: {
		returns: () => [ implementationStage ],
		gates: () => [ 
			// github gates are async and will resolve/reject when the respective conditions are met
			Github.gates.CopilotCodeReview(githubContext, { status: "done" }),
			Github.gates.Checks(githubContext, {
				ignore: [ "some-ci-check" ]
			})
		],
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
		// even though each action is async and runs in parallel, github's act will batch and execute them in order
		afterAgents: () => [
			Github.act.TryApprove(githubContext),
			Github.act.Merge(githubContext)
		]
	},
	instruction: Instruction.fromFile('merge'),
	container: Container.createOrReuse(mainContainerReference),
});

export const doneStage = new Stage({
	name: "Done",
	kind: "done",
	agents: [ doneAgent ],
	contexts: [ plan, userDecisions, learnings, githubContext ],
	policies: {
		permissions: { createNewTasks: true }
	},
	instruction: Instruction.fromFile('done'),
	container: Container.createOrReuse(mainContainerReference)
});