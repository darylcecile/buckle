# Contributing to Buckles

Thanks for helping improve Buckles. For installation, everyday use, and custom workflow configuration, start with the [README](README.md).

## Development setup

Use Node.js **22.12+**, Git, and **pnpm 10**. The root [package.json](package.json) pins pnpm `10.33.3`. Keep optional dependencies enabled for the Copilot SDK runtime and microsandbox platform packages. The CLI supports macOS and Linux; unit tests do not require Copilot credentials or a virtualization-capable host.

```sh
git clone https://github.com/darylcecile/buckle.git
cd buckle
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## Repository layout

| Path | Responsibility |
| --- | --- |
| [`packages/factory`](packages/factory) | Agents, workflows, stages, prompt references, contexts, model contracts, and MicroVM resources. |
| [`packages/adapters`](packages/adapters) | Copilot execution and GitHub contexts, snapshots, gates, and actions. |
| [`packages/cli`](packages/cli) | Factory loading, task workers, background daemon, IPC, and terminal UI. |
| [`packages/utils`](packages/utils) | Duration helpers for configuration. |
| [`example`](example) | A multi-file, seven-stage factory with instructions and skills. |
| [`test/example.test.mjs`](test/example.test.mjs) | Import smoke test for the complete example. |

The four `@buckles/*` packages are ESM. The private root is a workspace importer, not another distributable package. Packages export compiled JavaScript, TypeScript declarations with JSDoc, and source/declaration maps.

Keep dependencies one-way: **adapters and CLI depend on factory, never the reverse**. `Model` and `ModelOptions` belong to factory and are re-exported as types by adapters. `tsx` is a CLI runtime dependency for loading user TypeScript factories, including extensionless imports; the root also uses it for the example test.

## Development commands

Run these from the repository root:

| Command | Purpose |
| --- | --- |
| `pnpm build` | Build all workspace packages. |
| `pnpm typecheck` | Build packages, then check the example against their exported declarations. |
| `pnpm test` | Build packages, run package tests with Node's test runner, then run the example smoke test. |
| `pnpm test:example` | Rerun only the example smoke test; build first. |
| `pnpm cli --help` | Run the built CLI entry point. |
| `pnpm cli run example/factory.ts` | Open the example factory in the TUI; build first and read the README's runtime requirements before submitting tasks. |

For a focused change, build the affected package and run its tests after the initial workspace build. For example:

```sh
pnpm --filter @buckles/cli build
node --test packages/cli/test/*.test.mjs
```

The tests mock GitHub/Copilot transports and microsandbox boundaries, exercise local CLI child processes, and import the real example without loading prompts, authenticating, contacting models, or booting VMs. A passing suite does **not** certify live provider access, native VM operation, or organization-specific GitHub permissions.

## Preparing a change

Keep changes focused, follow nearby code and tests, and add regression tests for changed behavior. Update the README when public APIs, CLI commands, setup requirements, or runtime behavior change. Run `pnpm typecheck` and `pnpm test` before submitting a pull request, and describe any checks you could not run.

Preserve inert configuration: importing a factory must not start agents, load prompts, authenticate, or boot VMs. Return all asynchronous work from hooks and gates, surface failures, and keep credentials out of source, snapshots, task text, and test fixtures. Never use live approval or merge actions as a test.
