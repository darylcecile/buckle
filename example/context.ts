import { SessionContext } from "@buckles/factory";
import { Github } from '@buckles/adapters';

export const plan = new SessionContext({ 
	description: "The overall plan for the project."
});
export const userDecisions = new SessionContext({
	description: "Decisions made by the user regarding the project."
});
export const dependencies = new SessionContext({
	description: "Task dependencies identified"
});
export const learnings = new SessionContext({
	description: "Lessons learned and insights gained during the project."
});

// GitHub related context for the session
// Provides store for GitHub session-related data and state.
// Automatically loads comments and other relevant GitHub session data once the PR/Issue info is set.
export const githubContext = new Github.SessionContext();

export const reviewFindings = new SessionContext({
	description: "Findings from the review stage."
});
export const checksFindings = new SessionContext({
	description: "Findings from the checks stage."
});