Keep each task focused on its requested outcome and carry evidence into the next stage.
For github/github, resolve outdated-base golden-job CI failures by rebasing in Implementation. From Checks, return that work with failed-job evidence. Refresh a shared base before restacking its children, preserving dependency order and PR targets. Run normal review and CI on the new heads.

Follow only the configured stage order and available return targets. Defining a stage or
skill does not schedule it. These instructions guide behavior; they do not execute actions,
enforce gates or grant permissions.

Use the contexts attached to the active stage and the tools actually available. Include
needed evidence in the handoff when the destination does not receive its source context.
Preserve explicit constraints and user decisions; surface missing information or authority
instead of assuming access, widening scope or silently reducing the requested outcome.

The example explicitly enables host repository access using GITHUB_TOKEN or the host's
existing gh login. It resolves GITHUB_REPOSITORY or the launch directory's origin lazily,
and prepares guest checkouts without copying credentials. Read source with guest tools;
publication is available only in Implementation. Other stages never need guest GitHub auth.
Carry exact source identity, actual results and required corrections in complete_stage's
summary when returning to a configured stage. Do not complete blocked work to force progress.

Todo records userDecisions.delivery as `merge` (default) or `pull-request` (explicit PR-only).
PR-only requests still receive checks and all three reviews, then stop before Merge with the
real PR URL. Done is reserved for a confirmed merged result.
