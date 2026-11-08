---
name: "code-review"
description: "Use during code review to find scoped correctness, security and regression risks in the current implementation and its affected contracts."
---

# Review implementation correctness

Apply the shared review skill and keep product code unchanged.

## Procedure

1. Read the current diff against the intended base and trace the changed behavior into
   its owning code and directly affected callers. Compare it with plan, userDecisions
   and known dependencies; avoid reviewing an obsolete head or unrelated codebase areas.
2. Check behavior against acceptance criteria, including relevant invalid inputs,
   failure paths and boundary conditions. Inspect state transitions, cleanup and
   concurrency only where the changed path makes them material.
3. Examine affected trust boundaries, authorization and sensitive-data handling.
   Trace a concrete reachable path before claiming a vulnerability; distinguish a
   demonstrated risk from an unanswered question about deployment or permissions.
4. Check affected public contracts and stored data for compatibility with existing
   callers and deployed behavior. Identify unintended changes to error handling or
   dependency ordering. Do not prescribe migrations or broad refactors by default.
5. Inspect nearby tests and available verification evidence for the changed behavior.
   Run existing focused checks only when supported and authorized. Report a coverage
   gap in terms of the specific regression it could miss, not a blanket demand for
   more tests, dependencies or a new verification framework.

## Handoff

Prioritize actionable defects by severity. Include a precise location and revision,
the triggering condition, expected versus actual behavior, impact and focused correction.
Recheck existing comments and consolidate duplicates through the shared review procedure.

Separate blockers, questions and optional maintainability suggestions. Record important
out-of-scope discoveries in learnings. When no issues are found, name what was inspected
and any unverified behavior; do not imply that code review proves all runtime paths pass.