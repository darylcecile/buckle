import { Workflow } from '@buckles/factory';
import { todoStage } from './stages';


export const mainWorkflow = new Workflow({
	stages: [
		todoStage
	]
});