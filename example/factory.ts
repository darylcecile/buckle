import { factory, Supervisor } from "@buckles/factory";
import { mainWorkflow } from './workflows';

export default factory.define({

	supervisor: new Supervisor({

	}),

	workflows: [
		mainWorkflow
	]

});