---
name: "done"
description: "Use during Done to confirm merged delivery, close out acceptance criteria and create justified, nonduplicate learning follow-ups."
---

# Close out merged work

## Procedure

1. Read plan, userDecisions, learnings and githubContext. These are the only attached
   contexts; use available linked evidence rather than assuming direct access to
   checksFindings, reviewFindings or dependencies.
2. Confirm an actual merged PR result and its merge revision or link in githubContext.
   An approval, merge request or attempted action is not enough. If merge evidence is
   absent or contradictory, report the blocker instead of declaring completion.
3. Compare the delivered outcome with the agreed acceptance criteria. Summarize evidence
   and limits concisely. Do not turn unfinished in-scope work into new tasks merely to
   make the original task look complete.
4. Evaluate learnings individually: distinguish already handled items, useful knowledge
   requiring no action, and genuinely needed out-of-scope follow-ups. Keep the reason
   and source evidence for actionable items; avoid sweeping remediation.
5. Check available existing tasks for equivalent work before creating a follow-up.
   Use createNewTasks permission only with supported task-creation tools. Each new task
   needs a concrete outcome, reason, source links and observable acceptance criteria;
   preserve known dependencies without inventing an owner or external assignment.

## Closeout

Report the merged PR or commit, the outcome against the criteria, remaining uncertainty,
and links to follow-ups actually created or already covering the learning. Distinguish
successful creation from a proposed task or failed tool call.

If creation or duplicate lookup is unavailable, report the candidate and limitation
instead of claiming a nonduplicate task was created. If scoped completion is unresolved,
surface it explicitly. Done has no configured returns; do not invent a route or change
product code to conceal a blocker.