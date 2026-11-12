# Buckles

Buckles lets you define agent workflows in TypeScript or JavaScript and run them from your terminal. Compose agents into ordered stages, share context between them, and add explicit checks and actions. The CLI runs submitted tasks in the background while you follow progress in an interactive terminal UI.

A **factory** brings together an executor and one or more workflows. Each **workflow** contains **stages**, and each stage assigns work to **agents**. Defining these components does not execute them: the CLI starts work only when you submit a task.

## Requirements

- **Node.js 22.12+**, **pnpm 10**, and **Git** for the source installation below. The CLI supports macOS and Linux. See the [Node.js](https://nodejs.org/en/download) and [pnpm](https://pnpm.io/installation) installation guides if needed.
- **Copilot access** for workflows using `Github.CopilotExecutor`, including a model and reasoning effort available to your account. Authenticate on the host using the [Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli), or supply a `copilotToken` in trusted executor configuration.
- **Local virtualization** for Copilot task MicroVMs: Apple Silicon macOS or Linux with KVM. Keep optional package dependencies enabled; they supply the Copilot runtime and native microsandbox components. No separate microsandbox daemon is required. See [Local MicroVMs](#local-microvms) for platform details.

You can build the packages and load a factory without Copilot credentials or a running VM. Submitting a task to the Copilot executor requires both.

## Install from source

```sh
git clone https://github.com/darylcecile/buckle.git
cd buckle
pnpm install
pnpm build
pnpm cli --help
```

Run the commands in this guide from the cloned repository root. `pnpm cli` runs the built CLI directly, so it works on a first source build without a global installation. The CLI package's executable is named `buckles`; the arguments are the same. These instructions do not depend on the packages being available on npm.

## Quick start

1. Save the [starter factory below](#defining-a-factory) as `factory.ts` in the repository root. Replace its model ID and reasoning effort placeholders with values supported by your Copilot account.
2. Authenticate Copilot on the host. The executor uses stored login from `COPILOT_HOME` or `~/.copilot` by default; `GITHUB_TOKEN` is not a substitute for Copilot authentication.
3. Start the factory and open the TUI:

```sh
pnpm cli run factory.ts
```

Press **n** to add a task such as "Outline a release checklist". The starter drafts an outline and reviews it, sharing the draft through a context. It has no GitHub approval or merge actions. Starting the daemon alone does not call a model or boot a VM.

Use arrows to select a task and **Enter** for details, **a** to answer a pending question, **c** to cancel, and **r** to retry a failed task. **?** shows help. In forms, **Tab / Shift-Tab** changes fields, arrows edit text or select a workflow, **Enter** inserts description/answer newlines, **Ctrl-S** submits, and **Esc** discards the draft.

**q** or **Ctrl-C** detaches without stopping tasks. Run the same command to reconnect. **s then y** confirms stopping the daemon and waits for cleanup. Task history lives only in daemon memory: export results before stopping if you need them later.

The larger [example factory](example/factory.ts) shows Todo, Triage & Plan, Implementation, Checks, Review, Merge, and Done. You can open it with `pnpm cli run example/factory.ts`, but review its [stages](example/stages.ts) and [agents](example/agents.ts) before submitting work: it includes real approval/merge hooks, account-specific model choices, and GitHub binding requirements. It does **not** automatically populate the guest with your repository or provide PR publication.

## CLI commands

Use `pnpm cli --help` for the built-in reference. Every command accepts `--factory <file>`. Without a path, the CLI looks for `factory.ts`, then `example/factory.ts`, in the current directory. Use the same factory path for all commands targeting a daemon.

| Command after `pnpm cli` | What it does |
| --- | --- |
| `run [factory]` | Start or attach to a daemon and open the TUI. This is also the default with no command. |
| `tui [factory]` | Start or attach with an interactive terminal required. |
| `start [factory] [--json]` | Start or reuse the daemon without opening the TUI; print status including its PID. |
| `status [--json]` | Read daemon state without starting it. |
| `add "title" [--description "text"] [--workflow "name"]` | Submit a task; the first declared workflow is the default. |
| `list [--json]` | List all retained tasks. |
| `show <id> [--json]` | Print the complete task record as JSON, including outputs, errors, and pending questions. |
| `answer <id> "text"` | Answer the task's oldest pending question. |
| `retry <id>` | Create a new execution of a failed task, from the beginning. |
| `cancel <id>` | Request cooperative cancellation. |
| `stop` | Stop accepting tasks, cancel queued/active work, and wait for cleanup. |

`run`, `tui`, and `start` accept a positional factory path **or** `--factory`, not both. Task commands also accept `--json`. IDs may be full UUIDs or unambiguous prefixes. `retry` creates a new UUID with a `retryOf` link; it does not resume a failed phase. Check uncertain external effects before retrying so successful mutations are not repeated.

For a non-interactive session using the starter factory:

```sh
pnpm cli start factory.ts
pnpm cli add "Outline a release checklist" --workflow "Writing"
pnpm cli list
```

Inspect a task with `pnpm cli show <task-id>` (replace `<task-id>` with its actual ID). Use `pnpm --silent cli list --json` to export history without pnpm's script banner, then `pnpm cli stop` when finished.

The TUI requires interactive stdin/stdout and `TERM` other than `dumb`. Redirected `run` prints status and an attach instruction, then returns; explicit `tui` fails without a TTY. Terminal views neutralize control sequences and replace non-ASCII text with `?`; JSON preserves the original text using escapes. Colors respect terminal support, `NO_COLOR`, `NODE_DISABLE_COLORS`, and `FORCE_COLOR`; plain views retain labels and selection markers. Executor output is retained in task details, not forwarded to daemon/worker log files. **Never put credentials in task text, reports, or results.**

## Defining a factory

Save this as `factory.ts` at the repository root. It is a complete two-stage definition; replace `YOUR_MODEL_ID` and `YOUR_REASONING_EFFORT` before submitting tasks. Model availability is checked at execution, with no guessed aliases or fallback.

```ts
import {
  Agent, Container, SessionContext, Stage, Supervisor, Workflow, factory,
} from "@buckles/factory";
import { Github } from "@buckles/adapters";

const draft = new SessionContext({ description: "The outline and review feedback." });
const writer = new Agent({
  name: "Writer",
  role: "research",
  model: Github.model("YOUR_MODEL_ID", { variant: "YOUR_REASONING_EFFORT" }),
  mode: "interactive",
});

const outline = new Stage({
  name: "Outline",
  agents: [writer],
  contexts: [draft.expectWrite()],
  instruction: "Draft an outline for the task. Save it in the shared context, using any review feedback.",
});

const review = new Stage({
  name: "Review",
  agents: [writer.with({ name: "Reviewer", role: "reviewer", mode: "self-driving" })],
  contexts: [draft.expectWrite()],
  instruction: "Read the outline. Save feedback and return to Outline if needed; otherwise summarize the result.",
  policies: { returns: () => [outline] },
});

const writing = new Workflow({
  name: "Writing",
  container: new Container.MicroVM({ image: "alpine:3.22", cpu: 1, memory: "512MiB" }),
  instruction: "Create a useful outline without changing repositories or contacting GitHub.",
  policies: { concurrency: 1, maxRetries: 2 },
  stages: [outline, review],
});

export default factory.define({
  supervisor: new Supervisor({}),
  workflows: [writing],
  executor: new Github.CopilotExecutor({}),
});
```

### The building blocks

| Component | What to configure |
| --- | --- |
| `factory.define` | A default-exported configuration with an explicit `executor`, `supervisor`, and `workflows`. |
| `Executor` | The strategy implementing `execute(request)`. `Github.CopilotExecutor` supplies Copilot and guest tools; a custom executor can replace it. The CLI never infers one from model metadata. |
| `Workflow` | A name, ordered stages, shared instruction, container resource template, and policies. Concurrency is per workflow. |
| `Stage` | Agents, attached contexts, instructions, optional container binding, hooks, and policies. An empty agent list is allowed for hook-only stages. |
| `Agent` | Name, role, model, optional skills, and interaction mode. `self-driving` is the default; only `interactive` agents can ask the user questions. |
| `SessionContext` | Shared in-memory data for stages within a task. Pass the same instance to stages that need that state. |
| `Supervisor` | Optional model and wakeup metadata. `new Supervisor({})` is valid; the CLI does not use it to generate autonomous work. |

Configuration exposes `.options`. `Agent.with()` creates a new agent with selected overrides; a supplied skill list replaces, rather than appends to, the original. `Github.model(id, { variant })` is an immutable descriptor, not an authenticated client. `Intervals.minutes(5)` and the other duration helpers in `@buckles/utils` convert values to milliseconds; they do not schedule timers. Wakeup and learning policies remain descriptive metadata in this CLI.

### Prompt files and contexts

Keep short instructions inline, as above, or move reusable prompts into files. Paths resolve relative to the **factory file's directory**, not the module that declares the stage or agent:

| Definition | File loaded by the CLI |
| --- | --- |
| `Instruction.fromFile("workflow")` | `instructions/workflow.md` |
| `Instruction.fromFile("checks.md")` | `instructions/checks.md` |
| `Skill.fromFile("writing")` | `skills/writing/SKILL.md` |

Import `Instruction` and `Skill` from `@buckles/factory`. Use an instruction reference in a workflow or stage's `instruction` field, and skill references in an agent's `skills: [Skill.fromFile("writing")]`. Explicit paths containing separators resolve against the factory directory; absolute paths are used directly. References are deferred: construction does not read files, while `.load(absoluteBaseDirectory)` reads UTF-8 and propagates errors. There is no prompt parser, cache, or file sandbox; load only trusted references.

Contexts expose a `.data` map and stable `.id`. `expectWrite()` creates a reference sharing the same data/identity and marking a write expectation, **not** granting or restricting access. A stage only receives its declared contexts; explicitly store information needed by later stages in a shared context. Custom subclasses must implement `createReference()` with real constructed instances and shared session state, not shallow-copy private fields.

See [example/context.ts](example/context.ts), [instructions](example/instructions), and [skills](example/skills) for a multi-file layout. If you move a factory, move or adjust its prompt paths too.

### Stage order, returns, and hooks

The CLI executes each stage in this order:

```text
beforeAgents hooks -> agents in declaration order -> gates -> afterAgents hooks -> next stage
```

Use `policies.gates: () => [promise, ...]` for requirements that must pass, and `hooks.beforeAgents` / `hooks.afterAgents` for explicit actions. Gates run before after-agent mutations such as approval or merge. Return all work started by a callback: the CLI awaits every returned promise in a batch, even after one rejects, but cannot drain unreturned work. A failed stage stops the task; it is not automatically replayed.

The starter's review can return only to its declared `outline` stage. A custom executor returns `{ returnTo: outline }`; Copilot uses `complete_stage` with the exact permitted stage name. The target must be the same stage instance in both the workflow and the current stage's `policies.returns()`. A return skips the current stage's remaining agents, gates, and after-agent hooks, then re-enters the target's before-agent hooks. Design replayed hooks accordingly.

`maxRetries` bounds **total return transitions**, not provider retries (default 2; 0 forbids returns). Concurrency defaults to 1; both values must be safe integers, with concurrency positive and `maxRetries` nonnegative. Waiting/cancelling tasks occupy their slot until their worker exits. The displayed attempt is the current stage's visit count. Creating additional tasks requires `policies.permissions.createNewTasks: true`; `createTask()` queues work and returns its ID, not its result. Merely defining a stage or writing instructions does not schedule it or grant capabilities.

## Runtime and safety reference

### Execution and local state

Treat factory modules and all their imports as **trusted host code**. Keep construction inert. Each task imports the factory in a fresh Node child process, isolating module globals while preserving context instances and hook closures within that task. The daemon inherits the launcher's directory/environment; reconnecting does not replace them. Stop and restart after configuration or environment changes so daemon metadata and worker imports agree.

One daemon is keyed by each canonical factory path, using a Unix socket under `/tmp/buckles-<uid>` (directory mode `0700`, socket mode `0600`). There is no TCP listener or saved authentication secret; processes running as your own user remain trusted. Concurrent starts attach to the same owner. Loading, permission, stale-owner, and protocol errors are reported, not silently replaced. Never remove a socket until you have verified its owner and resources are stopped. A legacy foreground owner must be stopped with its original CLI.

Tasks, questions, errors, and outputs are **in memory only** until the daemon stops. There are no checkpoints, restart recovery, or installed OS services. Reconnection does not replay commands with uncertain outcomes. Export `list --json` or `show --json` before shutdown if results matter.

Cancellation is cooperative. `cancel`, `stop`, and SIGINT/SIGTERM sent to the **daemon PID** signal executors and wait for hooks, gates, VM cleanup, and worker exit; Ctrl-C in the TUI only detaches. Pending questions are cleared. A non-cooperative executor or hanging hook can delay shutdown; active work is not force-killed. Cancellation arriving only during cleanup does not undo completed stages. Cleanup failures fail the task and make daemon/`stop` exit nonzero, even if a later retry succeeds. Abrupt worker exit reports unconfirmed VM cleanup rather than claiming success.

### Copilot executor

[CopilotExecutor options](packages/adapters/src/copilot.ts) separate provider authentication from GitHub REST credentials. `copilotToken` authenticates Copilot; otherwise stored login is used. `baseDirectory` selects an absolute login/data directory, and `cliPath` can select a custom runtime executable. The executor excludes `GH_TOKEN`, `GITHUB_TOKEN`, and `COPILOT_GITHUB_TOKEN` from the SDK's inherited environment. Keep secrets in trusted host configuration, never task text or source control.

For **model-selected binding to an existing PR**, explicitly configure both a host REST token and an exact repository allowlist. This is the pattern used in [example/factory.ts](example/factory.ts):

```ts
new Github.CopilotExecutor({
  githubToken: process.env.GITHUB_TOKEN,
  repositories: process.env.GITHUB_REPOSITORY ? [process.env.GITHUB_REPOSITORY] : [],
});
```

`repositories` accepts case-insensitive `owner/repo` names, not URLs or wildcards, and defaults to empty. A token alone does not authorize `bind_github`. Host-bound contexts instead use their own explicit credentials. Binding is not a checkout or publication operation.

The guest working directory defaults to `/workspace`, created if absent and otherwise containing only the image and earlier work in the same task VM. **No host checkout, environment, or credentials are uploaded.** Supply tools and source through the image or explicit guest operations. The adapter provides only its declared tools, requires `complete_stage` for successful agent completion, and cleans up its provider session/client before returning. The CLI owns task VM destruction. See the [tool implementation](packages/adapters/src/copilot-tools.ts) before designing integrations that need more capabilities.

### Local MicroVMs

`Container.MicroVM` uses the embedded [microsandbox 0.7.14 SDK](https://github.com/superradcompany/microsandbox/tree/v0.7.14/sdk/node-ts). The core API supports Node.js 22+ on Apple Silicon macOS, Linux with KVM, and Windows 11 with WHP (preview); the Buckles CLI/Copilot setup has the stricter requirements above. Keep optional native packages enabled and consult the [SDK runtime requirements](https://github.com/superradcompany/microsandbox/tree/v0.7.14/sdk/node-ts#runtime-notes). A cloud default backend is rejected rather than silently changing global SDK settings.

Construction and workflow resolution do not load the native addon or boot a VM. The executor starts it when needed. The CLI uses an execution-unique task `Reference` across stages and returns, then destroys every distinct resolved VM on success, failure, or cooperative cancellation. An unbound stage uses the workflow's default VM for that task. To share a named VM across chosen stages, set each stage's `container` to `Container.createOrReuse(Reference.create("workspace"))`; it inherits the workflow resource template unless explicit options are supplied. A different container reference resolves a separate VM. Different tasks never share one.

For custom execution consumers, reference names must be globally unique per task execution: equal names intern to equal identities. Do not pass one workflow-run reference for several tasks. The first resolution supplies a task/container pair's configuration; later lookups reuse it. Explicitly start each VM and destroy each distinct instance in a `finally` block. Successful destruction releases reuse; configuration alone does not perform cleanup.

The [MicroVM API](packages/factory/src/container.ts) provides `start`, `exec`, `execStream`, `fs`, `upload`, `download`, `pause`, `resume`, `stop`, and `destroy`. Important boundaries:

- CPU allocations must be positive safe integers. `MB`/`GB` are decimal; `MiB`/`GiB` are binary and rounded up to whole MiB. Native resource limits still apply. Explicit VM names never replace or attach to another sandbox.
- Await `start()` or `resume()` before guest operations. `exec` returns `.code`, `.success`, `.stdout()`/`.stderr()`, and binary output accessors; a nonzero command exit is a result to handle, not success. Transport/timeouts reject. The default command timeout is 30000 ms. `execStream` supplies output events and process signals; pause/stop can interrupt running commands.
- `fs()` exposes binary-safe SDK filesystem operations; uploads/downloads copy individual files. Acquire a fresh filesystem handle after restart. Invalid-state async operations reject; `fs()` itself throws synchronously.
- `pause`/`resume` preserve resident processes and RAM. `stop` retains disk/identity; a subsequent `start` boots again rather than resuming. Stop/destroy resume paused guests for graceful shutdown; explicit `destroy({ force: true })` does not. Starting a paused VM rejects.
- Lifecycle calls serialize. Startup's default 120000 ms budget begins after the SDK returns a creation handle; cancellation waits for settlement and is not a hard deadline or proof of storage cleanup. Stop/destroy default to 10000 ms and do not silently force-kill on timeout. Cleanup errors propagate and acquired identities can be retried.
- `.state` is wrapper-observed, not a remote query. If creation fails before an identity is acquired, `.id` remains unset and `.state` is `unknown`; native resources may still exist. `destroy()` without an acquired identity releases only local bookkeeping. Verify native ownership before manual recovery; never delete another sandbox by guessing its name.

The typed `network` callback runs at first start and exposes the SDK's [port forwarding and network policies](https://docs.microsandbox.dev/sdk/typescript/networking). Host-local forwarding is not public ingress: the guest service must listen on the mapped port. Fixed host ports conflict across concurrent VMs; allocate separate ports. Do not mutate captured network configuration during startup.

### GitHub contexts, gates, and actions

`Github.SessionContext` holds a PR binding and prepared evidence. Trusted host code can bind it with `context.bind({ owner, repo, pullNumber, token })`, or the constructor can receive those settings. Construction/binding makes no requests and does not discover credentials from the environment or `gh`. Binding is single-use and shared with write references; use a new context to change the binding. Tokens remain private and absent from snapshots/errors.

Configure the following explicitly, as in [example/stages.ts](example/stages.ts):

| API | Behavior |
| --- | --- |
| `Github.act.ReadyForAgents(context)` | Load PR details, issue comments, inline comments, and reviews into a stable-head snapshot. Does not change draft state or request reviews. |
| `Github.gates.Checks(context, { ignore: [], expected: ["ci"] })` | Wait for latest check runs and newest commit statuses on the current head. Replace `ci` with your required check names. |
| `Github.gates.CopilotCodeReview(context, { status: "done" })` | Wait for the latest API-classified Copilot review submitted on the current head. Completed is not the same as approved. |
| `Github.act.TryApprove(context)` | Submit and verify an actual APPROVE review pinned to the current SHA. Permission/self-approval failures are errors. |
| `Github.act.Merge(context)` | Request a direct merge at an exact SHA and require a confirmed merged result and merge SHA. |

Checks match names case-insensitively. Success, neutral, and skipped check conclusions pass; other completed outcomes fail. Pending, empty, ignored-only, or missing expected results wait until timeout. Without `expected`, the gate cannot know which checks have not appeared yet; all observed non-ignored checks still count. Copilot review completion includes COMMENTED, APPROVED, and CHANGES_REQUESTED, not pending/dismissed/old-head reviews; it requires the API's `is_copilot_code_review` classification, not a guessed bot identity.

Head changes invalidate evidence, not previously requested requirements. Repeat required snapshot/check/review preparation on the new head before mutations. Snapshot, approval, and merge-result accessors return defensive copies. Actions serialize in invocation order per session, including through write references. A rejection blocks already-queued followers; await the whole batch before retrying. Gates are read-only and must not run concurrently with mutations. Confirm uncertain external outcomes before an explicit retry: a failed request is not proof that a mutation did not happen.

Merge does not automatically run gates or request approval. It checks any preparation previously required on that context and relies on GitHub's repository rules and the token's permissions. It requests no bypass or admin override and does not enable auto-merge, enter a merge queue, or handle stacked-PR orchestration. Merely writing those intentions in a prompt does not enforce them.

A token whose actor has bypass permissions may still merge without satisfying branch protections or rulesets. Use a token without bypass privileges when those rules must be enforced.

The REST adapter targets API version `2026-03-10`. Credentials need access to PRs, discussions, checks, and statuses; approval/merge need appropriate write permissions. `apiBaseUrl` defaults to `https://api.github.com`; enterprise REST roots must use HTTPS. Requests reject redirects, and paginated URLs stay on the configured API root. Permission/rate-limit errors propagate without hidden retries; `Github.ApiError.status` is available without response bodies or credentials. Defaults are `requestTimeoutMs: 30000`, `gateTimeoutMs: 300000`, `pollIntervalMs: 2000`, and `mergeMethod: "merge"`. Snapshot loading also uses the gate deadline; custom transports must honor `AbortSignal`.

The [check-runs endpoint](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference) covers at most GitHub's 1,000 most recent check suites; the adapter does not enumerate older suites. See also GitHub's [review](https://docs.github.com/en/rest/pulls/reviews), [status](https://docs.github.com/en/rest/commits/statuses#list-commit-statuses-for-a-reference), and [direct merge](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request) APIs.

## Contributing

For development setup, package architecture, and build/test instructions, see [CONTRIBUTING.md](CONTRIBUTING.md). The workspace contains [`@buckles/factory`](packages/factory), [`@buckles/adapters`](packages/adapters), [`@buckles/cli`](packages/cli), and [`@buckles/utils`](packages/utils); their sources and exported declarations provide the detailed API reference.
