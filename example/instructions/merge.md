This stage has no agents. Its configured afterAgents actions request TryApprove, then
Merge, through GitHub action batching. This document describes the intended contract;
it does not execute or enforce those actions or call for manual merge commands.

Approval and merge must respect the current PR head, applicable checks and reviews,
platform permissions and repository branch policy. Evidence from an older head does not
establish readiness for a changed head. Do not bypass protections to complete this stage.

TryApprove is an approval attempt, not a guarantee of approval. Preserve actual action
outcomes in the available results or supplied context, including permission failures,
unresolved review requirements, failed checks or merge conflicts. A requested merge or
successful approval attempt is not evidence that the PR merged.

Successful closeout requires an actual merged result with the PR and merge revision or
link available to Done through githubContext. If an action fails or its result is missing,
surface the blocker. No return policy is configured here; do not invent a routing target.