This stage has no agents. Its beforeAgents hook checks the canonical userDecisions.delivery.
For `pull-request`, it halts with the actual reviewed PR URL before any merge mutation and
does not run Done. For `merge`, fresh current-head checks and Copilot review gates precede
the direct Merge action. This document describes the intended contract;
it does not execute or enforce those actions or call for manual merge commands.

Approval and merge must respect the current PR head, applicable checks and reviews,
platform permissions and repository branch policy. Evidence from an older head does not
establish readiness for a changed head. Do not bypass protections to complete this stage.

The example does not self-approve. GitHub enforces the repository's actual review rules;
Copilot review completion and admin permissions are not substitutes for required reviews.
Preserve actual action outcomes in the supplied context, including permission failures,
unresolved review requirements, failed checks or merge conflicts. A requested merge or
accepted request is not evidence that the PR merged.

Successful closeout requires an actual merged result with the PR and merge revision or
link available to Done through githubContext. If an action fails or its result is missing,
surface the blocker. No return policy is configured here; do not invent a routing target.
