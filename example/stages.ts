import { Stage } from '@buckles/factory';
import { todoAgent } from './agents';
import { todoContext } from './context';


export const todoStage = new Stage({
	id: "todo",
	agents: [ 
		todoAgent.with({
			skills: ["skills/triage"]
		}) 
	],
	contexts: [ todoContext ],
	instruction: "Pick a task and triage it, determining its priority and next steps."
});

export const implementationStage = new Stage({
	id: "implementation",
	agents: [ todoAgent ],
	contexts: [ todoContext ],
	instruction: "Implement the chosen task according to the determined priority and next steps.",
	policies: {
		returns: () => [ todoStage ]
	}
});
