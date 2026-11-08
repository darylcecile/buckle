# Buckles

Two ESM packages for defining agent workflows and explicitly interacting with GitHub:

- `@buckles/factory`: agents, workflows, stages, deferred prompt files, shared contexts, and model descriptors.
- `@buckles/adapters`: GitHub model descriptors, PR snapshots, polling gates, approval, and direct merge actions.

Node.js 22+ and pnpm 10 are required for development. The workspace root is private; the two packages export compiled JavaScript, declarations with JSDoc, and source/declaration maps. `Model` and `ModelOptions` belong to factory and are re-exported as adapter types, so dependencies go in one direction: adapters -> factory.

## Development

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

`pnpm typecheck` builds both packages and checks the unchanged example against their real exported declarations. `pnpm test` runs Node unit tests with mocked GitHub transport plus the real example import smoke test. After building, `pnpm test:example` reruns just that smoke test. Development-only `tsx` supports the example's existing extensionless TypeScript imports. Published packages do not need it.

## Definitions, Not Execution

See [example/factory.ts](example/factory.ts) for the complete seven-stage configuration. `factory.define()` constructs configuration only. There is no scheduler, CLI, agent execution engine, or MicroVM provisioner. Policies describe what a future consumer should do; this library does not enforce concurrency, retry, or task-creation policy.

Configuration classes expose `.options`. Arrays and nested policy objects are captured independently; callbacks and context identities are preserved. `Agent.with()` returns a new agent, preserving unspecified options; supplied skill lists replace rather than append. Agents default to `self-driving`.

`Github.model(id, { variant })` returns an immutable model descriptor with `.provider`, `.id`, and `.options.variant`. It performs no authentication or availability check.

## Prompt Files and Contexts

`Skill.fromFile()` and `Instruction.fromFile()` store a `.path`; they do not read files. Explicit `.load(absoluteBaseDirectory)` reads UTF-8 content and propagates filesystem errors:

```ts
await Skill.fromFile("todo").load(absoluteExampleDirectory);
// <base>/skills/todo/SKILL.md
await Instruction.fromFile("checks").load(absoluteExampleDirectory);
// <base>/instructions/checks.md
await Instruction.fromFile("workflow.md").load(absoluteExampleDirectory);
// <base>/instructions/workflow.md
```

Paths containing separators resolve against the supplied base; absolute paths are used directly. No implicit working directory, cache, prompt parser, or sandbox is provided. Only load trusted file references.

`SessionContext` holds an in-memory `.data` map and a stable `.id`. `expectWrite()` returns a separate reference with `.writeExpected === true`, sharing data and identity without changing earlier references. It is metadata, not access control. Custom subclasses must implement the documented `createReference()` factory using real constructed instances and share their own session state; shallow cloning objects with private fields is not supported. The built-in GitHub context already handles its shared state.

## Explicit GitHub Binding

Creating or binding a context makes no requests and never reads environment variables, credential files, or GitHub CLI state. Supply credentials from your application's own secure configuration; do not check them into source.

```ts
import { Github } from "@buckles/adapters";

const context = new Github.SessionContext();
context.bind({ owner, repo, pullNumber, token });
await Github.act.ReadyForAgents(context);
const snapshot = context.snapshot;
```

The constructor also accepts the same settings. `apiBaseUrl` defaults to `https://api.github.com`; an enterprise REST root such as `https://github.example/api/v3` must use HTTPS. Binding is single-use and shared with existing write references. The token stays private, is absent from snapshots/errors, and is never logged or persisted by the adapter. A trusted `fetch` override supports unit tests.

`ReadyForAgents` loads PR details, all issue comments, inline review comments, and reviews. It publishes a complete snapshot only if the PR head is stable across the read. `.snapshot`, `.approval`, and `.mergeResult` return defensive copies. ReadyForAgents does not change draft state or request reviews.

The HTTP helper uses native fetch rather than a runtime SDK dependency: this adapter needs only JSON GET/POST/PUT, explicit bearer authentication, and numbered REST pagination. It does not need OAuth flows, SDK plugins, or mutation retries. Requests reject redirects. Pagination uses the next-link indicator but constructs subsequent page URLs from the configured API root, so a response cannot redirect the token to another host. HTTP errors expose `Github.ApiError.status`, not the response body or request credentials. Rate-limit and permission failures propagate without hidden retries.

## Gates and Actions

- `Github.gates.Checks(context, { ignore, expected? })` combines latest check runs with newest commit statuses per context, reading every page. Ignore/expected names are case-insensitive. Success, neutral, and skipped check conclusions pass; other completed outcomes fail with the failing check/status names, without response bodies or credentials. Pending, empty, ignored-only, and missing expected results wait until timeout. Without `expected`, the gate cannot know which checks have not appeared yet; specify expected names when that matters. All observed non-ignored checks still count.
- `Github.gates.CopilotCodeReview(context, { status: "done" })` requires the latest API-classified Copilot review to be submitted on the current head. COMMENTED, APPROVED, and CHANGES_REQUESTED mean completed, not approved. Pending, dismissed, requested-only, and old-head reviews cannot pass. APIs lacking `is_copilot_code_review` cannot satisfy this gate; there is no guessed bot-identity fallback.
- Both gates check the head before and after each observation. A head change during an observation rejects. A later gate or `ReadyForAgents` call can begin preparation for a new head on the same context, clearing stale evidence without forgetting any requested snapshot, checks, review, or approval requirements. Repeating preparation invalidates that operation's prior result until it succeeds again.
- `Github.act.TryApprove(context)` actually submits APPROVE at the current SHA and validates the returned review state, SHA, and submission. It requires current snapshot/gate evidence for all previously requested preparation, but can replace an old approval. A failed approval still leaves approval required for Merge. It does not suppress errors (including self-approval or permission failures).
- `Github.act.Merge(context)` sends an exact expected SHA and checks `merged: true` plus the returned merge SHA. It rejects stale or missing required preparation. If Checks passed on head A, loading a snapshot or passing another gate on head B does not remove the need for Checks to pass on B. It does not request admin bypass, auto-merge, or a merge queue. Standalone Merge checks the head when its queued action executes, but does not automatically run gates or request approval; callers must explicitly run required gates/actions, and GitHub enforces repository rules according to the token's permissions.

All `act` calls serialize in invocation order per session, including calls through write references. A rejection blocks the remaining actions already queued in that batch. Once those promises settle, a later explicit attempt can use the same context. Await every promise in a failed batch (for example with `Promise.allSettled`) before retrying. After a failure or head change, rerun required preparation; confirm any uncertain mutation outcome with GitHub before explicitly retrying it. There is no automatic retry, and a failed request is not proof that a mutation did not happen. Separate contexts are independent, even when bound to the same PR; a new context is needed only to change the binding.

```ts
await Promise.all([
  Github.act.TryApprove(context),
  Github.act.Merge(context),
]);
```

This array approves first, then merges only if approval succeeds. Consumers must await all hook/gate promises and must not proceed after a gate rejection. Gates are read-only and do not participate in the action queue. Do not execute gates concurrently with mutation actions.

Defaults: `requestTimeoutMs: 30000`, `gateTimeoutMs: 300000`, `pollIntervalMs: 2000`, `mergeMethod: "merge"`. Snapshot loading also uses the gate deadline. Custom transports must honor AbortSignal. No network activity occurs until a gate or action is explicitly called.

## API Scope and Sources

The adapter targets GitHub REST API version `2026-03-10`. It requires token access to the relevant PR, discussions, checks, and statuses; approval and merge additionally require appropriate write permissions. Tests make no live requests and do not certify organization-specific permissions or rules.

- [Reviews and Copilot classification](https://docs.github.com/en/rest/pulls/reviews)
- [Check runs](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference): the reference endpoint covers at most GitHub's 1,000 most recent check suites. This adapter does not enumerate historical suites beyond that API limit.
- [Commit statuses](https://docs.github.com/en/rest/commits/statuses#list-commit-statuses-for-a-reference)
- [Pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)
- [Direct merge](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request): this endpoint does not support stacked PRs or merge queues. Those workflows need a different integration; they are not reported as successfully merged here.
- [pnpm workspaces](https://pnpm.io/workspaces), [TypeScript declarations](https://www.typescriptlang.org/tsconfig/#declaration), and [tsx preload](https://tsx.hirok.io/dev-api/node-cli)