---
name: "review"
description: "Use with a review specialty to assess scoped changes, preserve concurrent findings and produce evidence-backed review handoffs."
---

# Shared review procedure

## Review the current work

1. Read plan, userDecisions, dependencies, learnings, githubContext and reviewFindings.
   Establish the intended outcome and current revision. Use the comments prepared by
   ReadyForAgents where available; identify missing context rather than inventing it.
   Review uses its separate VM with a host-prepared checkout of the exact PR head.
   Check its HEAD against snapshot.pullRequest.headSha before evaluating source; never
   substitute the base branch, a fresh unauthenticated clone or the Implementation VM.
2. Apply your assigned specialty to the changed behavior and directly affected callers
   or user flows. Keep product code unchanged. Use available evidence and permitted
   inspection tools; reviewing does not authorize implementing a correction.
3. Check earlier comments against the current head before reporting them again. A fixed
   issue is not a new finding; an unresolved one should retain its existing evidence
   and identity rather than becoming several duplicate reports.
4. Record findings in reviewFindings with discipline, severity, location, affected
   revision, user or system impact, and a concrete correction. Add reproduction steps
   and expected versus observed behavior where relevant. Separate confirmed defects,
   open questions and optional suggestions.
5. Merge duplicate evidence while preserving attribution and other reviewers' entries.
   Record your own discipline's assessment without replacing the shared findings or
   issuing an unsupported verdict for concurrent reviewers. Put important out-of-scope
   discoveries in learnings; do not expand the review or create tasks here.

## Handoff and finish

Return concrete defects requiring changes to Implementation. Return scope, dependency
or plan issues to Triage, explaining the decision needed. These are the available returns;
do not route directly to Todo, merge the PR or silently fix the product.
Use complete_stage's summary and returnTo for a return, carrying the repository/PR/head,
concrete evidence and required source correction into the destination's handoff.

Finish with your discipline's conclusion, inspected revision, evidence and remaining
limits. Distinguish blockers from suggestions. State unavailable fixtures or runtime
checks plainly; missing evidence neither proves a pass nor justifies a speculative gate.
