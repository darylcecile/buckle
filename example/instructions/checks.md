Read githubContext with read_context: binding identifies the repository/PR, checks contains
current-head check observations, and snapshot contains the PR and paginated discussion/reviews.
ReadyForChecks loads this evidence before you run; the authoritative gates run AFTER you.
Record concise, actionable findings in checksFindings before requesting a return or advancing.

Pending, missing or stale results are not passes. No checks are ignored. The required
`buckles/verification` status records the publication tool's actual guest check commands;
other observed CI checks still count. A completed Copilot review can still contain findings;
inspect its comments as well as its current-head completion status.

Return failures requiring changes only to Implementation. Include the check or tool name,
status, affected revision, relevant link or log excerpt, and required correction in the
handoff: Implementation does not receive checksFindings directly. For outdated-base
golden-job failures, include the failed-job evidence and the workflow's rebase direction.
Use complete_stage with returnTo: "Implementation" and a summary containing that complete
handoff, including source identity and required source changes. Do not fix code or rebase in Checks.

Advance in the configured workflow only when required outcomes are current and passing
and no blocking findings remain. Otherwise report what is failed, pending or unavailable;
do not manufacture a result or assume a rejected gate automatically invokes an agent.
