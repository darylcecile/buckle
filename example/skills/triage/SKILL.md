---
name: "triage"
description: "Use during Triage to select repository work or existing PRs and plan responsibilities, dependencies and implementation order."
---

# Select and plan work

## Procedure

1. Read plan and userDecisions for the agreed outcome and constraints. These are the
	only attached contexts; record responsibility and dependency facts in plan rather
	than assuming access to dependencies or githubContext.
2. Inspect relevant repository information or existing PRs using available, permitted
	research tools. Identify the selected repository and work, with links and revisions
	where known. Prefer continuing suitable existing work over proposing a duplicate.
3. Choose the smallest complete set of changes that satisfies the acceptance criteria.
	Name the affected areas and responsibilities, distinguishing confirmed owners from
	proposed assignments. Do not imply that recording an owner assigns them externally.
4. Record prerequisites, dependent work and implementation order in plan. For stacked
	PRs, preserve known parent relationships and targets; identify missing or conflicting
	dependency information before recommending an order.
5. Describe the key implementation steps and existing verification paths supported by
	the repository evidence. Note access or environment gaps without inventing commands,
	context APIs or completed checks.

## Handoff

Leave the selected work, selection rationale, responsibilities, dependency order and
acceptance checks in plan, with enough evidence for Implementation to find the work.
This stage plans work; it does not modify code or branches.

If the outcome, constraints or scope need a user decision, return to Todo with the exact
question and why it prevents planning. Todo is the only configured return target.
For unavailable research or access, report the blocker rather than claiming the plan is
ready. Otherwise follow the configured workflow; do not assume Implementation is enrolled.

