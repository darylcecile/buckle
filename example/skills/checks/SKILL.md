---
name: "checks"
description: "Use during Checks to assess prepared current-head observations and hand actionable failures back to Implementation before gates run."
---

# Assess prepared checks and reviews

## Procedure

1. Use githubContext to identify the repository, PR and current head. The only other
   attached context is checksFindings, which must receive the assessment. Do not require
   plan, dependencies or reviewFindings to record the available gate evidence.
2. Read `checks` and `snapshot` through read_context. ReadyForChecks prepares these before
   this agent; it returns failed checks promptly even if a Copilot review is still pending.
   Gates run afterwards. Correlate checks.headSha, snapshot.pullRequest.headSha and reviews'
   commitId with the same revision. Pending, missing or stale evidence is not a pass.
3. Read available Copilot comments as well as the completion status. A completed review
   can contain actionable findings. Distinguish blocking findings from nonblocking
   suggestions and comments already addressed on the current head.
4. Require the real `buckles/verification` status and assess every other observed check.
   No names are ignored. This status comes from actual guest commands executed by the
   publication tool; do not wait for an invented workflow or waive a failing external CI job.
5. Write concise findings to checksFindings before requesting a return or advancing.
   Include the tool or check name, status, repository and PR, affected revision, relevant
   link or short log excerpt, and the correction or missing evidence needed. Preserve
   useful prior evidence while clearly distinguishing it from current results.

## Handoff and finish

For failures requiring changes, call complete_stage with `returnTo: "Implementation"`.
Copy the complete actionable evidence into its summary because that stage does not receive
checksFindings directly. Include repository/PR/head, failed names and URLs, observed output,
and the required source correction. This is a repair handoff, not a claim that Checks passed.
For an outdated-base golden-job failure, include the failed job and base/head evidence
available in githubContext, plus the workflow's instruction to rebase in Implementation.
Do not change code, rebase or attempt repairs in Checks.

Advance only when required gate outcomes are current and passing and no blocking findings
remain. If outcomes are pending or unavailable, report that state and what must arrive;
do not substitute an invented pass or infer that gate rejection will invoke this agent.
