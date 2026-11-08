import { Workflow, Container, Instruction } from '@buckles/factory';
import { checksStage, doneStage, implementationStage, mergeStage, reviewStage, todoStage, triageStage } from './stages';

export const mainWorkflow = new Workflow({
	name: 'Main Workflow',
	container: new Container.MicroVM({
		image: 'ubuntu:latest',
		memory: '16GB',
		cpu: 4
	}),
	instruction: Instruction.fromFile('workflow.md'),
	policies: {
		concurrency: 10,
		maxRetries: 3,
		learnings: {
			outcome: "raise"
		}
	},
	stages: [
		todoStage,
		triageStage,
		implementationStage,
		checksStage,
		reviewStage,
		mergeStage,
		doneStage
	]
});