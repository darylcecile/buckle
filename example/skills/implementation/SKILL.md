---
name: "implementation"
description: "Use during Implementation to deliver the planned outcome, address returned findings and verify the actual changed behavior."
---

# Implement the chosen work

## Procedure

1. Read plan, userDecisions, dependencies, learnings, githubContext and reviewFindings.
	Read the return handoff too: checksFindings is not attached here, so returned check
	failures must arrive with their job evidence and affected revision. Request missing
	evidence rather than assuming access to that context or guessing the failure.
2. Inspect repository instructions, the worktree and the code that controls the requested
	behavior. Preserve existing dirty work and deliberate user choices. Follow a nearby
	implementation and its verification approach before adding a new abstraction.
3. Make the smallest complete change that meets the agreed criteria. Address current,
	scoped review or check findings; do not add unrelated cleanup or quietly drop required
	behavior to make a check pass. Record important out-of-scope discoveries in learnings.
4. Use existing tools and tests to exercise the changed behavior and relevant failure
	paths. Derive commands from the repository, not a generic tool list. For visible UI
	changes, inspect the rendered result; for API behavior, inspect an authorized response
	where feasible. Report missing fixtures or access as unverified, not passing.
5. For outdated-base golden-job failures, apply the workflow's repository-specific
	recovery policy with the necessary repository permissions. Stage assignment alone
	does not authorize destructive git operations, pushing, migrations or new services.
	Preserve dependency order and PR targets, and obtain fresh evidence for changed heads.
6. Only Implementation has `publishPullRequest` permission. Call `publish_pull_request`
	with githubContext's index, title, body, the intended `paths` and repository-derived
	`checks` commands (both nonempty arrays).
	It executes those commands in the guest, publishes the actual `buckles/verification`
	status on the real PR head, binds githubContext and requests/re-requests Copilot review.
	Use its actual response for the PR URL, revision and verification results. Do not run
	guest git push, gh login, or a credential-bearing clone: private repository access and
	publication use host credentials that are intentionally absent from the guest.
	A failed command remains failed evidence for Checks; repair the source when returned,
	then publish the updated head and rerun checks. Do not claim a status from your summary.

## Handoff and returns

Report the implemented outcome, affected revision, checks actually run and their results,
plus relevant links or concise failure excerpts. Explain any unverified acceptance criteria
or remaining blocker. Update the supplied contexts as appropriate; do not claim remote
actions succeeded without their results.

Return to Todo for an unresolved outcome or user decision. Return to Triage for a work
selection, responsibility, dependency or plan issue. Include the concrete question or
conflict and evidence, not just a stage name.

Before advancing, publish the scoped work and hand off its real PR URL, head SHA, source
changes, commands and results to the next configured stage. An existing PR must likewise
have current-head publication/check evidence. Preserve userDecisions.delivery: PR-only work
still goes through Checks and all three reviewers, then halts before the merge mutation.
Do not run review or merge actions merely because their stage definitions exist.
