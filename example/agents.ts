import { Agent } from "@buckles/factory";
import { Github } from '@buckles/adapters';

export const todoAgent = new Agent({
	role: "research",
	name: "TodoBot",
	model: Github.model("opus-5.5", { variant: "high" })
});