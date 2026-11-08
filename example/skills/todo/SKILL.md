---
name: "todo"
description: "Use during Todo to clarify the requested outcome, constraints and acceptance criteria before planning repository work."
---

# Clarify the task

## Procedure

1. Read the task request, plan and userDecisions. These are the only attached contexts;
	do not require repository, dependency or review contexts to begin clarification.
2. Separate the desired outcome from a suggested implementation. Preserve explicit
	choices, exclusions and constraints instead of replacing them with preferences.
3. Use permitted research only to resolve a concrete uncertainty. Record the source
	and what it establishes; do not infer a repository or existing PR from the task name.
4. Define observable acceptance criteria for the requested outcome, including relevant
	failure behavior. Keep verification proportionate and avoid prescribing a new framework.
5. Ask focused questions only where the answer changes scope, acceptance or authority.
	Record confirmed answers in userDecisions and reflect them in plan; keep unanswered
	questions visibly unresolved rather than converting guesses into decisions.

## Handoff

Leave a concise plan containing the outcome, scope boundaries, constraints, acceptance
criteria and a practical way to check them. Identify any repository or PR supplied by
the user, without selecting work that still needs Triage.

The task is ready for configured planning work when the intended outcome and its limits
are clear enough to choose work without making a new product decision. If not, report the
specific question and keep readiness unresolved. Do not invent a return target or assume
another stage is scheduled.

This is research and clarification, not permission to change product code, open PRs or
create additional tasks.

