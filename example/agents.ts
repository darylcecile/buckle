import { Agent, Skill } from '@buckles/factory';
import { Github } from '@buckles/adapters';

export const todoAgent = new Agent({
	role: "research",
	name: "TodoBot",
	model: Github.model("opus-5.5", { variant: "high" }),
	skills: [Skill.fromFile('todo')],
	mode: "interactive"
});

export const triageAgent = new Agent({
	role: "research",
	name: "TriageBot",
	model: Github.model("opus-5.5", { variant: "high" }),
	skills: [Skill.fromFile('triage')],
	mode: "self-driving"
});

export const implementationAgent = new Agent({
	role: "developer",
	name: "ImplementationBot",
	model: Github.model("gpt-6-astra", { variant: "xhigh" }),
	skills: [Skill.fromFile('implementation')]
});

export const checksAgent = new Agent({
	role: "reviewer",
	name: "ChecksBot",
	model: Github.model("opus-5.5", { variant: "medium" }),
	skills: [Skill.fromFile('checks')]
});

export const visualReviewAgent = new Agent({
	role: "reviewer",
	name: "Visual ReviewBot",
	model: Github.model("opus-5.5", { variant: "xhigh" }),
	skills: [Skill.fromFile('review'), Skill.fromFile('visual-review')]
});

export const accessibilityReviewAgent = new Agent({
	role: "reviewer",
	name: "Accessibility ReviewBot",
	model: Github.model("opus-5.5", { variant: "xhigh" }),
	skills: [Skill.fromFile('review'), Skill.fromFile('accessibility-review')]
});

export const codeReviewAgent = new Agent({
	role: "reviewer",
	name: "Code ReviewBot",
	model: Github.model("opus-5.5", { variant: "xhigh" }),
	skills: [Skill.fromFile('review'), Skill.fromFile('code-review')]
});

export const doneAgent = new Agent({
	role: "reviewer",
	name: "DoneBot",
	model: Github.model("opus-5.5", { variant: "medium" }),
	skills: [Skill.fromFile('done')]
});