---
name: "checks"
description: "Use during Checks to assess available current-head gate outcomes and hand actionable failures back to Implementation."
---

# Assess gate results

## Procedure

1. Use githubContext to identify the repository, PR and current head. The only other
   attached context is checksFindings, which must receive the assessment. Do not require
   plan, dependencies or reviewFindings to record the available gate evidence.
2. Inspect available outcomes for CopilotCodeReview with status `done` and Checks.
   Correlate each result with the current PR and revision. Pending, missing, cancelled
   or stale results do not establish a pass; identify the gap explicitly.
3. Read available Copilot comments as well as the completion status. A completed review
   can contain actionable findings. Distinguish blocking findings from nonblocking
   suggestions and comments already addressed on the current head.
4. Record `some-ci-check` as excluded by the configured ignore list. Do not label it
   passed, expand the ignore list or waive another failing check.
5. Write concise findings to checksFindings before requesting a return or advancing.
   Include the tool or check name, status, repository and PR, affected revision, relevant
   link or short log excerpt, and the correction or missing evidence needed. Preserve
   useful prior evidence while clearly distinguishing it from current results.

## Handoff and finish

For failures requiring changes, return only to Implementation. Copy the complete actionable
evidence into the handoff because that stage does not receive checksFindings directly.
For an outdated-base golden-job failure, include the failed job and base/head evidence
available in githubContext, plus the workflow's instruction to rebase in Implementation.
Do not change code, rebase or attempt repairs in Checks.

Advance only when required gate outcomes are current and passing and no blocking findings
remain. If outcomes are pending or unavailable, report that state and what must arrive;
do not substitute an invented pass or infer that gate rejection will invoke this agent.