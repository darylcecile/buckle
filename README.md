# Buckles

Four published ESM packages for defining and running agent workflows and explicitly managing their resources:

- `@buckles/factory`: agents, workflows, stages, deferred prompt files, shared contexts, model descriptors, and local MicroVMs.
- `@buckles/adapters`: the explicit Copilot executor, GitHub model descriptors, PR snapshots, polling gates, approval, and direct merge actions.
- `@buckles/utils`: duration helpers for configuration.
- `@buckles/cli`: background task scheduling, isolated execution, and an interactive terminal UI.

Use Node.js 22.12+ for development, the [CLI](packages/cli/package.json), and the Copilot SDK executor; the core MicroVM API alone retains its Node.js 22+ minimum. Development also requires pnpm 10. The workspace root is a private fifth workspace importer, not a fifth published package. Packages export compiled JavaScript, declarations with JSDoc, and source/declaration maps. `Model` and `ModelOptions` belong to factory and are re-exported as adapter types; adapters and CLI depend on factory, never the reverse.

## Development

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

`pnpm typecheck` builds the packages and checks the example against their real exported declarations. `pnpm test` runs Node tests with mocked GitHub/Copilot transports and microsandbox boundaries, local CLI worker checks, and the real example import smoke test. These checks do not call models or boot VMs. After building, `pnpm test:example` reruns just the import smoke test. `tsx` is a runtime dependency of `@buckles/cli` for loading consumer TypeScript factories, including extensionless imports. The private root also uses it for the example import test.

## CLI

`@buckles/cli` is the execution consumer for the inert `@buckles/factory` definitions. It provides the `buckles` executable on macOS and Linux (Node.js 22.12+). After workspace installation and build:

```sh
pnpm exec buckles run example/factory.ts
```

This starts a background daemon (or attaches to the existing one) and opens the TUI. No second terminal is needed: use **n** to create a task, arrows to select it, **Enter** for details, **a** to answer its pending question, **c** to cancel, and **r** to retry a failed task. Details include progress, questions, retained results and cleanup errors. **?** shows help. **q** or **Ctrl-C** detaches, leaving tasks running; **s then y** confirms stopping the daemon and waits for cleanup. Run the same command again to reconnect with the retained task history.

In forms, **Tab / Shift-Tab** changes fields, arrows edit text or select a workflow, **Enter** adds a newline in descriptions/answers, **Ctrl-S** submits, and **Esc** discards the draft.

For scripts or a daemon without the TUI:

```sh
pnpm exec buckles start example/factory.ts
pnpm exec buckles status --json
pnpm exec buckles add "Fix the failing check" --description "Investigate and repair the reported failure"
pnpm exec buckles list
pnpm exec buckles show <task-id> --json
pnpm exec buckles answer <task-id> "Proceed with the proposed change"
pnpm exec buckles cancel <task-id>
pnpm exec buckles retry <failed-task-id>
pnpm exec buckles stop
```

`pnpm cli ...` is also available from the repository root and directly runs the built entry point. Every command accepts `--factory <file>`. Without a path, resolution checks `factory.ts`, then [example/factory.ts](example/factory.ts), in the current directory; this repository still defaults to the example. `buckles` without a command is equivalent to `buckles run`. `run`, `tui` and `start` accept an optional positional path instead of `--factory`. An explicit path avoids ambiguity when operating elsewhere. `start` prints the daemon PID; `status` reads its current state without starting it. Both support `--json`. `add --workflow "name"` selects a workflow; omission selects the first declared workflow. Full UUIDs and unambiguous ID prefixes are accepted. `--json` also works with task commands; `show` always prints the complete JSON record, including outputs, errors, pending questions and any `retryOf` link.

The TUI refreshes read-only task snapshots about every half second. It requires interactive stdin and stdout and `TERM` other than `dumb`. Redirected `run` starts/reuses the daemon, prints status and an attach instruction, then returns without terminal escape sequences; explicit `tui` reports an error in that environment. `list` remains a complete, non-interactive board. The TUI uses terminal-palette colors for task/service states, headings and focused fields, with bold selection. It respects Node's terminal support and `NO_COLOR`, `NODE_DISABLE_COLORS` and `FORCE_COLOR` settings; plain rendering retains the same labels and selection marker. `list` and JSON remain uncolored. Colors are applied only after untrusted terminal control sequences have been neutralized and text has been fitted to the screen. Non-ASCII characters are replaced with `?` in terminal views; JSON escapes and preserves the original text. Executor output is retained for details and `show`, while `report()` supplies activity updates; daemon and worker stdout/stderr are not forwarded or saved to log files. Do not put credentials in task text, reports or executor results.

### Execution and Policies

- The factory's default export must provide an explicit `executor.execute(request)` through `factory.define({ executor, supervisor, workflows })`. Starting the daemon only loads the definition and waits for submissions; it never invokes agents without tasks. The detached Node process inherits the launcher's working directory and environment; reconnecting does not replace that environment. TS/JS imports use the [tsx programmatic loader](https://tsx.hirok.io/dev-api/ts-import). Treat factory modules and their imports as trusted executable code, and keep construction inert.
- Each task runs in a fresh [Node child process](https://nodejs.org/docs/latest-v22.x/api/child_process.html#child_processforkmodulepath-args-options). The child independently imports the factory, preserving real context instances and hook closures while isolating module globals from other tasks. Only task data and small progress messages cross IPC. After the pipeline and VM cleanup settle and the final outcome's IPC send callback succeeds, the owned worker disconnects and exits, so idle executor/native handles cannot retain a completed task slot. Failed outcomes and transport failures remain failures. Parent configuration supplies workflow metadata; restart the owner after changing a definition so metadata and child imports agree.
- Workflow concurrency is independent per workflow, defaults to 1, and must be a positive safe integer. Waiting and cancelling tasks occupy their slot until their worker exits. The parent never invokes its own executor or hooks.
- Stage order is **beforeAgents hooks -> agents in declaration order -> gates -> afterAgents hooks -> next stage**. Gates deliberately run before afterAgents mutations such as approval/merge. Every promise returned in a hook/gate batch is awaited, including after a sibling rejects. A failed stage stops the task; it is never reported completed and no automatic failure replay occurs. Callbacks must return all work they start; synchronous throws after launching unreturned work cannot be drained by the runtime.
- Workflow/stage instruction references and agent skill references load relative to the factory file's directory. The executor receives the combined text, actual task, stage/context instances, and an inert task-scoped VM. The executor owns VM startup. One execution-unique task `Reference` is reused across stages and returns; all distinct resolved VMs are destroyed on completion, failure or cooperative cancellation. Cleanup failures include the VM name/ID and make the task fail.
- An executor's `returnTo` must be the same stage instance present in both this workflow and the current stage's declared `policies.returns()`. A valid return skips remaining agents, gates and afterAgents in the returning stage, then re-enters the target's beforeAgents phase. Declared returns can replay earlier stages and hooks; use them only where that replay is intended. Total return transitions are bounded by `maxRetries` (default 2; explicit 0 forbids returns), a nonnegative safe integer. The board's attempt is the visit count for the current stage, not a model/provider retry counter.
- `ask()` is allowed only for interactive agents. The task becomes `waiting`; `answer` supplies the oldest pending question's response without retaining that answer separately. `createTask()` is allowed only with `stage.options.policies.permissions.createNewTasks: true`; it queues a real task and returns its ID, not its eventual result.
- `retry` is an explicit **new execution from the beginning**, with a fresh UUID, process, contexts and VMs, linked to the retained failed record. It does not resume a failed phase. Reconcile uncertain external effects and cleanup failures before requesting it; successful mutations may otherwise be repeated.
- `cancel`, `stop`, and SIGINT/SIGTERM sent directly to the **daemon PID** are cooperative. Ctrl-C in the TUI only detaches. Executors receive an `AbortSignal`; legacy hook/gate callbacks do not, so they must settle before cleanup. Pending questions are cleared and the task remains `cancelling` during this wait. An abort arriving only during cleanup does not undo successfully completed stages; a cleanup failure still fails the task. `stop` refuses new tasks, cancels queued/active tasks, and waits for cleanup and worker exit without force-killing active work. Disconnecting a client during stop leaves that shutdown in progress. A non-cooperative executor or hanging hook can therefore delay shutdown. An abrupt worker exit marks the task failed, advances its queue, and explicitly reports unconfirmed VM cleanup. Recorded cleanup failures make the daemon and `stop` (including `--json`) exit nonzero, even after a later manual retry succeeds.

### Local State and Limits

One daemon listens on a [Unix socket](https://nodejs.org/docs/latest-v22.x/api/net.html#ipc-support) keyed by the canonical factory path, under `/tmp/buckles-<uid>` (directory mode `0700`, socket mode `0600`). There is no TCP listener or saved authentication secret. Other users cannot access it through filesystem permissions; processes running as your own user remain trusted. Concurrent starts attach to the same owner. Startup is bounded and reports loading/socket errors; permission errors and stale, unresponsive or incompatible owners are reported instead of replaced. Existing sockets are never automatically unlinked; verify the previous owner and its resources are stopped before manual removal. A legacy foreground owner must be stopped using its original CLI before starting the new daemon. Different canonical factory paths may run independently.

Tasks, questions, errors and outputs are in memory until the daemon stops, independent of any attached terminal. There are no checkpoints, persistence, OS service installation or restart recovery; stopping or losing the daemon releases that history. Export `list --json` / `show --json` before stopping if results are needed later. Reconnecting reads current state and never automatically replays commands whose result was uncertain. `supervisor`, `wakeupInterval` and learning policies remain descriptive metadata: this CLI does not invent autonomous work, learning decisions or merging policy, and does not use wakeup intervals as display refresh intervals. GitHub mutations occur only through explicitly configured hooks/executors.

The package exports its documented runtime, pipeline, loader, renderer, `ensureDaemon`, `runTui`, `readSnapshot`, and IPC types/helpers from `@buckles/cli`. Focused checks are `pnpm --filter @buckles/cli build` and `node --test packages/cli/test/*.test.mjs`; they do not call models or boot native VMs.

## Copilot Executor

Select the executor explicitly, as in [example/factory.ts](example/factory.ts). For a factory at the repository root:

```ts
import { Github } from "@buckles/adapters";
import { factory, Supervisor } from "@buckles/factory";
import { mainWorkflow } from "./example/workflows";

export default factory.define({
  supervisor: new Supervisor({}),
  workflows: [mainWorkflow],
  executor: new Github.CopilotExecutor({
    cwd: "/workspace",
    repositories: process.env.GITHUB_REPOSITORY ? [process.env.GITHUB_REPOSITORY] : [],
    githubToken: process.env.GITHUB_TOKEN,
  }),
});
```

[CopilotExecutor](packages/adapters/src/copilot.ts) imports and construction are inert: they do not load the SDK, authenticate, read prompt files, or start a VM. Execution requires Copilot access through an authenticated stored login, or a separately supplied `copilotToken`. Stored login defaults to `COPILOT_HOME` or `~/.copilot`; `baseDirectory` can select another absolute login/data directory. Keep optional dependencies enabled for the SDK's bundled runtime; `cliPath` can select a custom runtime executable instead.

`githubToken` is a separate host-only REST credential, not Copilot authentication. The executor excludes `GH_TOKEN`, `GITHUB_TOKEN` and `COPILOT_GITHUB_TOKEN` from the SDK's inherited environment. For **model-selected PR binding only**, the example requires both explicit `GITHUB_REPOSITORY=owner/repo` and `GITHUB_TOKEN`. Its `repositories?: readonly string[]` allowlist accepts exact case-insensitive `owner/repo` entries, not URLs or wildcards, and defaults to empty: a token alone does not enable [bind_github](packages/adapters/src/copilot-tools.ts). Host-bound GitHub contexts remain supported and use their own explicit credentials. Binding neither fetches a checkout nor uploads credentials to the guest.

At execution, the adapter validates the exact `Github.model(id, { variant })` against the authenticated provider's model list and advertised reasoning efforts. An unavailable/disabled model or unsupported variant fails explicitly; there is no alias guessing or fallback. Model descriptors in the example are configuration, not a claim that the authenticated account has access.

The guest working directory defaults to `/workspace`, created if absent and empty unless the image or earlier stages supply content. No host checkout, environment or credentials are uploaded. Supply required tooling and source through the image or explicit guest commands; running a task does not populate the repository automatically. Guest command/file tools operate in the task VM; the adapter exposes only its declared tools, requires `complete_stage` for success, and cleans up its provider session/client before returning. The CLI then destroys resolved task VMs.

A custom [Executor](packages/factory/src/index.ts) implementing `execute(request)` can replace CopilotExecutor in the same factory configuration; the CLI does not infer a provider from model metadata. The tests use mocked provider/VM boundaries and local child processes. They do not demonstrate a real model invocation or a live VM workflow run.

## Definitions, Not Execution

See [example/factory.ts](example/factory.ts) for the complete seven-stage configuration. `factory.define()` constructs configuration only; importing the factory module does not start workflows, authenticate, or boot VMs. `@buckles/cli` runs submitted tasks using the explicitly supplied executor. The CLI enforces concurrency, return-transition budgets and task-creation permissions; factory definitions themselves do not schedule or enforce those policies. Hooks own GitHub mutation decisions, the executor owns agent/provider work and VM startup, and the CLI owns task VM cleanup. Supervisor, wakeup and learning metadata do not imply an autonomous scheduler.

Configuration classes expose `.options`. Arrays and nested policy objects are captured independently; callbacks and context identities are preserved. `Agent.with()` returns a new agent, preserving unspecified options; supplied skill lists replace rather than append. Agents default to `self-driving`.

`Github.model(id, { variant })` returns an immutable model descriptor with `.provider`, `.id`, and `.options.variant`. It performs no authentication or availability check.

`Supervisor` accepts optional `model` and `wakeupInterval` metadata and still accepts `{}`. `Intervals.milliseconds/seconds/minutes/hours/days` from `@buckles/utils` convert finite, nonnegative values to milliseconds; fractions are retained and days mean exactly 24 hours. Neither API schedules timers.

## Local MicroVMs

`Container.MicroVM` uses the official embedded [microsandbox 0.7.14 SDK](https://github.com/superradcompany/microsandbox/tree/v0.7.14/sdk/node-ts). No daemon setup is required. Native execution requires Node.js 22+ and Apple Silicon macOS, Linux with KVM, or Windows 11 with WHP (preview). Keep package-manager optional dependencies enabled: the platform package supplies the native addon and runtime. See the [versioned SDK requirements and runtime precedence](https://github.com/superradcompany/microsandbox/tree/v0.7.14/sdk/node-ts#runtime-notes). This wrapper rejects a cloud default backend instead of changing process-global SDK configuration.

Construction and workflow resolution are inert, including native-addon loading. `start()` creates a uniquely named local VM from an OCI image. Explicit names are allowed but never replace or attach to another sandbox. CPU allocations must be positive safe integers. `MB`/`GB` are decimal; `MiB`/`GiB` are binary, rounded up to whole MiB (`16GB` is 15259 MiB; `16GiB` is 16384 MiB). Platform resource limits are enforced by the SDK.

```ts
import { Container } from "@buckles/factory";

const vm = new Container.MicroVM({
  image: "alpine:3.22", cpu: 1, memory: "512MiB",
  network: network => network
    .portBind("127.0.0.1", 18080, 8080)
    .policy({ defaultIngress: "allow", defaultEgress: "allow", rules: [] }),
});

try {
  await vm.start();
  const result = await vm.exec("sh", ["-c", "printf hello"], { timeoutMs: 5000 });
  console.log(result.code, result.stdout(), result.stderr());
  await vm.fs().write("/tmp/message", "hello");
  await vm.download("/tmp/message", "./message.txt");
  await vm.upload("./message.txt", "/tmp/copied-message");
  await vm.pause();
  await vm.resume();
  await vm.stop();
  await vm.start();
} finally {
  await vm.destroy();
}
```

- `exec(command, args, { cwd?, env?, timeoutMs? })` returns the SDK's `ExecOutput`: `.code`, `.success`, `.stdout()`/`.stderr()`, and binary `.stdoutBytes()`/`.stderrBytes()`. Nonzero command exit is a result, not a successful-work assertion. Transport and timeout failures reject. The default execution budget is 30000ms.
- `execStream` accepts the same arguments and returns the official stream handle for output events, collection, and process signals. Commands do not hold the lifecycle queue, so pause/stop can interrupt an active command. Await `start()`/`resume()` before issuing guest operations.
- `fs()` exposes the SDK's binary-safe reads/writes, streams, directories, metadata, copy, rename, and removal. Upload/download copy individual files using native transfer APIs, not shell quoting or base64. Acquire a fresh filesystem handle after restart; already-acquired handles follow SDK lifecycle behavior. Invalid state in `exec`, `execStream`, `upload`, or `download` rejects the returned Promise; `fs()` itself throws synchronously.
- `pause()` suspends resident processes and RAM; `resume()` preserves them. `stop(timeoutMs = 10000)` shuts down but retains disk/identity; stopping a paused VM first resumes it. `start()` on a paused VM rejects rather than restarting it. Restart after stop creates a new boot, not a resident resume.
- `destroy({ force?, timeoutMs? })` stops and removes only the acquired native identity, releases reference reuse, and is idempotent after success. Without an acquired identity, it releases local bookkeeping only; it does not clean up resources from failed creation. Graceful shutdown is the default with a 10000ms budget and resumes a paused VM before stopping it; timeout does not silently force-kill. Explicit `force: true` destroys without resuming paused guest execution. Invalid timeout options reject the returned Promise. Lifecycle errors propagate and cleanup of an acquired identity can be retried.
- `start(timeoutMs = 120000)` starts its cancellation timer once the SDK returns a creation handle, then awaits creation settlement rather than abandoning the pending Promise. Cancellation is cooperative, not a hard deadline, and settlement does not guarantee storage cleanup. Calls to start/pause/resume/stop/destroy serialize per VM. Duplicate starts do not create multiple VMs, and destroy waits for an in-flight start.
- `.name`, `.id`, `.memoryMiB`, and `.state` expose identity, normalized allocation, and **wrapper-observed** state. `unknown` means a lifecycle operation failed. State does not poll external changes or claim an authoritative remote pause query.

If creation rejects before `awaitSandbox()` succeeds, `.id` remains unset and `.state` becomes `unknown`. The SDK may have persisted native resources, but its [creation handle](https://github.com/superradcompany/microsandbox/blob/v0.7.14/sdk/node-ts/native/sandbox_builder.rs#L905) exposes no creation ID or ownership proof on failure. The wrapper does not look up and destroy by name, which could delete a preexisting user's sandbox. Inspect native state and verify ownership before manual recovery; calling `destroy()` without an acquired identity is not evidence that native storage was removed.

Networking uses the SDK's typed [network callback](https://docs.microsandbox.dev/sdk/typescript/networking), evaluated at first start. `MicroVMNetwork` accepts and returns `InstanceType<typeof NetworkBuilder>`, preserving method completion and argument checking. The example maps host `127.0.0.1:18080` to guest TCP port `8080`; a guest service must listen there. This is host-local forwarding, not automatic public internet ingress. The same callback exposes UDP, DNS, TLS, and the official egress policy builder/object, including deny-by-default policies. Callback closures remain caller-owned; do not mutate captured configuration while starting VMs. Fixed host ports cannot be reused by concurrently running VMs, so allocate separate ports for concurrent runs.

## Container References

`Reference.create(name)` and `new Reference(name)` have the same interned `.identity` via `Symbol.for(name)`. `.name` is a logical identifier, never an image. `Reference.join()` retains slash-joined names; internal container caches use separate task and container identity keys to avoid delimiter collisions.

```ts
import { Container, Reference } from "@buckles/factory";
import { mainWorkflow } from "./example/workflows";
import { todoStage, implementationStage, reviewStage } from "./example/stages";

const taskA = Reference.create("task-42/execution-1");
const taskB = Reference.create("task-43/execution-1");
const main = mainWorkflow.resolveContainer(todoStage, taskA);
const implementation = mainWorkflow.resolveContainer(implementationStage, taskA);
const review = mainWorkflow.resolveContainer(reviewStage, taskA);
const otherMain = mainWorkflow.resolveContainer(todoStage, taskB);
const otherImplementation = mainWorkflow.resolveContainer(implementationStage, taskB);
// main === implementation; otherMain === otherImplementation; main !== otherMain; main !== review.

const lookup = Container.createOrReuse(Reference.create("tools"), {
  image: "alpine:3.22", cpu: 1, memory: "512MiB",
});
const tools = lookup(taskA);
// Alternatively: Container.createOrReuse(reference)(taskReference, resourceOptions).
```

Bindings sharing a task reference and a named container reference share one VM across stages, including bindings created by separate `Container.createOrReuse` calls. Different task identities never share a VM, even within the same workflow or workflow run. A different container reference within one task resolves a separate VM, as with Review above.

The consumer must provide a stable task reference across that task's stages. Its name must be globally unique across concurrent and repeated task executions, even when display labels match: equal names produce equal identities. Never pass a workflow-run reference when it contains multiple tasks. The callable type shape is unchanged, but the reference argument now means a task execution, not a workflow run.

A stage binding inherits the workflow's container resource template unless it supplies explicit options. Unbound stages share a workflow-local default VM per task, never the template instance itself. Explicit template names become prefixes with unique suffixes. The first resolution supplies that task/container pair's configuration; later lookups reuse it. Missing resources fail clearly. Custom execution consumers must explicitly start each VM and destroy each unique resolved VM in a `finally` block when the task finishes; the CLI handles task cleanup for its executors. Successful destruction evicts only that task/container pair so another lookup can create a fresh instance without affecting other tasks. Factory definitions do not run background cleanup or scheduling themselves.

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

The REST HTTP helper uses native fetch rather than a GitHub REST SDK: PR actions need only JSON GET/POST/PUT, explicit bearer authentication, and numbered REST pagination. The separate Copilot executor uses the official Copilot SDK. The REST helper does not need OAuth flows, SDK plugins, or mutation retries. Requests reject redirects. Pagination uses the next-link indicator but constructs subsequent page URLs from the configured API root, so a response cannot redirect the token to another host. HTTP errors expose `Github.ApiError.status`, not the response body or request credentials. Rate-limit and permission failures propagate without hidden retries.

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

Defaults: `requestTimeoutMs: 30000`, `gateTimeoutMs: 300000`, `pollIntervalMs: 2000`, `mergeMethod: "merge"`. Snapshot loading also uses the gate deadline. Custom transports must honor AbortSignal. This REST context API makes no requests until a gate or action is explicitly called; CopilotExecutor separately contacts its provider during `execute()`.

## API Scope and Sources

The adapter targets GitHub REST API version `2026-03-10`. It requires token access to the relevant PR, discussions, checks, and statuses; approval and merge additionally require appropriate write permissions. Tests make no live requests and do not certify organization-specific permissions or rules.

- [Reviews and Copilot classification](https://docs.github.com/en/rest/pulls/reviews)
- [Check runs](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference): the reference endpoint covers at most GitHub's 1,000 most recent check suites. This adapter does not enumerate historical suites beyond that API limit.
- [Commit statuses](https://docs.github.com/en/rest/commits/statuses#list-commit-statuses-for-a-reference)
- [Pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)
- [Direct merge](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request): this endpoint does not support stacked PRs or merge queues. Those workflows need a different integration; they are not reported as successfully merged here.
- [pnpm workspaces](https://pnpm.io/workspaces), [TypeScript declarations](https://www.typescriptlang.org/tsconfig/#declaration), and [tsx preload](https://tsx.hirok.io/dev-api/node-cli)
