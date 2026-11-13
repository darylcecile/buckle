#!/usr/bin/env node
// Explicit live verification: creates a disposable base and runs the actual example.
// Invoke only after the product batch has built and the live run is authorized.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../../", import.meta.url));
const approvedRepository = "darylcecile/buckle";
const terminal = new Set(["completed", "failed", "cancelled"]);
const expectedAgents = [
  ["Todo", "TodoBot", "claude-opus-5.5", "high"],
  ["Triage & Plan", "TriageBot", "claude-opus-5.5", "high"],
  ["Implementation", "ImplementationBot", "gpt-6-astra", "xhigh"],
  ["Checks", "ChecksBot", "claude-opus-5.5", "medium"],
  ["Review", "Visual ReviewBot", "claude-opus-5.5", "xhigh"],
  ["Review", "Accessibility ReviewBot", "claude-opus-5.5", "xhigh"],
  ["Review", "Code ReviewBot", "claude-opus-5.5", "xhigh"],
  ["Done", "DoneBot", "claude-opus-5.5", "medium"],
];

function safe(value, limit = 1600) {
  let text = String(value ?? "");
  for (const [key, secret] of Object.entries(process.env)) {
    if (secret && /TOKEN|SECRET|PASSWORD|API_KEY/i.test(key)) text = text.replaceAll(secret, "[redacted]");
  }
  text = text.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{20,})\b/g, "[redacted]");
  text = text.replace(/(authorization\s*[:=]\s*(?:bearer|token)\s+)[^\s"']+/ig, "$1[redacted]");
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;
}
const digest = value => createHash("sha256").update(String(value ?? "")).digest("hex");
const taskBranch = id => `buckles/task-${digest(id).slice(0, 24)}`;
const summarizeOutput = text => ({ length: text?.length ?? 0, digest: digest(text), text: safe(text) });
const json = async path => JSON.parse(await readFile(path, "utf8"));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const append = (path, value) => appendFile(path, JSON.stringify(value) + "\n", { mode: 0o600 });

async function receipts(directory) {
  try { return (await readFile(join(directory, "receipts.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

function command(program, args, { input, timeoutMs = 30000 } = {}) {
  const env = { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GIT_TERMINAL_PROMPT: "0" };
  delete env.GH_DEBUG;
  return new Promise((resolveCommand, reject) => {
    const child = execFile(program, args, { cwd: root, env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const failure = new Error(`${program} ${args[0]} failed: ${safe(stderr || error.message)}`);
        failure.stderr = safe(stderr);
        failure.code = error.code;
        reject(failure);
      } else resolveCommand(stdout.trim());
    });
    child.stdin.on("error", () => {}); // A rejected command may close stdin before reading its request.
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

async function api(endpoint, { method = "GET", body, pages = false, missing = false, timeoutMs } = {}) {
  const args = ["api", "--hostname", "github.com", "--method", method,
    "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2026-03-10", endpoint];
  if (body !== undefined) args.push("--input", "-");
  if (pages) args.push("--paginate", "--slurp");
  try {
    const output = await command("gh", args, { input: body, timeoutMs });
    return output ? JSON.parse(output) : null;
  } catch (error) {
    if (missing && /\(HTTP 404\)/.test(error.stderr)) return null;
    throw error;
  }
}

function pullSummary(pull) {
  return { number: pull.number, url: pull.html_url, state: pull.state, merged: pull.merged,
    mergedAt: pull.merged_at, createdAt: pull.created_at,
    author: pull.user?.login, base: pull.base.ref, baseSha: pull.base.sha, head: pull.head.ref,
    headSha: pull.head.sha, repository: pull.base.repo.full_name, headRepository: pull.head.repo?.full_name };
}

function assertOwnedPull(pull, manifest) {
  assert.equal(pull.base.repo.full_name.toLowerCase(), manifest.repo.toLowerCase(), "PR base repository must be the explicitly approved repository");
  assert.equal(pull.head.repo?.full_name.toLowerCase(), manifest.repo.toLowerCase(), "PR head must be in the owned repository");
  assert.equal(pull.base.ref, manifest.baseBranch, "PR must target only the disposable base");
  assert.equal(pull.head.ref, manifest.headBranch, "PR must use this task's exact owned branch");
  assert.notEqual(pull.base.ref, "main");
  assert.ok(Date.parse(pull.created_at) >= Date.parse(manifest.startedAt) - 1000, "PR must have been created during this run");
}

function contextReceipt(request, Github) {
  const context = request.contexts.find(value => value instanceof Github.SessionContext && value.bound);
  if (!context) return undefined;
  return { binding: context.binding, snapshotHead: context.snapshot?.pullRequest.headSha,
    snapshotBase: context.snapshot?.pullRequest.baseRef, checksHead: context.checks?.headSha,
    checks: context.checks?.checks, mergeResult: context.mergeResult,
    reviews: context.snapshot?.reviews.map(review => ({ id: review.id, commitId: review.commitId,
      state: review.state, isCopilot: review.isCopilot, submittedAt: review.submittedAt })) };
}

/** Used only by the generated fixture factory. Delegates every real agent unchanged. */
export async function instrumentFactory(config, manifestPath) {
  const { Github } = await import("@buckles/adapters");
  const directory = dirname(manifestPath);
  const receiptPath = join(directory, "receipts.jsonl");
  const actual = config.executor;
  const visits = new Map();
  const merge = Github.act.Merge;
  Github.act.Merge = async context => {
    const manifest = await json(manifestPath);
    const binding = context.binding;
    assert.ok(binding, "Live fixture Merge requires an explicit PR binding");
    assert.equal(`${binding.owner}/${binding.repo}`.toLowerCase(), manifest.repo.toLowerCase());
    const publication = (await receipts(directory)).findLast(receipt => receipt.type === "agent"
      && receipt.stage === "Implementation" && !receipt.returnTo && receipt.publication);
    assert.ok(publication, "Merge requires an observed publication receipt from this fixture's Implementation");
    assert.equal(publication.taskId, manifest.taskId);
    assert.equal(publication.publication.number, binding.pullNumber, "Merge must use the last forward Implementation publication");
    const pull = await api(`repos/${manifest.repo}/pulls/${binding.pullNumber}`);
    assertOwnedPull(pull, manifest);
    assert.equal(pull.head.sha, publication.gitHead, "Merge must use the exact observed implementation revision");
    await append(receiptPath, { type: "merge-start", at: new Date().toISOString(), pull: pullSummary(pull) });
    // The real action performs its own fresh-head checks and GitHub merge; no fabricated result.
    await merge(context);
    await append(receiptPath, { type: "merge-complete", at: new Date().toISOString(),
      number: binding.pullNumber, result: context.mergeResult });
  };
  return { ...config, executor: { async execute(request) {
    let result;
    let failure;
    try { result = await actual.execute(request); }
    catch (error) { failure = error; }
    const stage = request.stage.options.name;
    if (request.agent === request.stage.options.agents[0]) visits.set(stage, (visits.get(stage) ?? 0) + 1);
    const attempt = visits.get(stage);
    const receipt = { type: "agent", at: new Date().toISOString(), taskId: request.task.id,
      stage: request.stage.options.name, agent: request.agent.options.name, attempt,
      model: request.agent.options.model.id, variant: request.agent.options.model.options.variant,
      handoff: request.handoff ? { stage: request.handoff.stage, agent: request.handoff.agent,
        attempt: request.handoff.attempt, outputDigest: digest(request.handoff.output) } : null,
      output: summarizeOutput(result?.output), returnTo: result?.returnTo?.options.name,
      vm: { id: request.container.id, name: request.container.name, state: request.container.state,
        image: request.container.options.image, memory: request.container.options.memory, cpu: request.container.options.cpu },
      github: contextReceipt(request, Github), error: failure ? safe(failure.message) : undefined };
    try {
      if (request.container.state === "running") {
        const head = await request.container.exec("git", ["rev-parse", "HEAD"], { cwd: "/workspace", timeoutMs: 5000 });
        assert.equal(head.code, 0, "Guest HEAD inspection failed");
        receipt.gitHead = head.stdout().trim();
        assert.match(receipt.gitHead, /^[a-f\d]{40}$/i);
        if (receipt.stage === "Review") {
          const clean = await request.container.exec("/bin/sh", ["-c", "git diff --quiet && git diff --cached --quiet"],
            { cwd: "/workspace", timeoutMs: 5000 });
          receipt.trackedWorktreeClean = clean.code === 0;
          assert.ok(receipt.trackedWorktreeClean, "Review must leave the tracked working tree and index unchanged");
        }
      }
      if (!failure && receipt.stage === "Implementation" && !receipt.returnTo) {
        const manifest = await json(manifestPath);
        const binding = receipt.github?.binding;
        assert.ok(binding, "Implementation must publish and bind a real PR");
        const pull = await api(`repos/${manifest.repo}/pulls/${binding.pullNumber}`);
        assertOwnedPull(pull, manifest);
        receipt.publication = pullSummary(pull);
      }
    } catch (error) {
      receipt.inspectionError = safe(error.message);
      failure ??= error;
    }
    await append(receiptPath, receipt);
    if (failure) throw failure;
    return result;
  } } };
}

function taskSummary(task) {
  return { ...task, description: undefined, activity: safe(task.activity), outputs: task.outputs.map(output => ({ ...output, text: safe(output.text),
    length: output.text.length, digest: digest(output.text) })), error: task.error && safe(task.error),
    questions: task.questions.map(question => ({ id: question.id, text: safe(question.text) })) };
}

function fixtureFacts(manifest) {
  return `Repository: ${manifest.repo}. Work only on ${manifest.file}. Replace the exact line "Result: pending" with "Result: ${manifest.marker}"; preserve every other byte. `
    + `Publish exactly one PR into the disposable base ${manifest.baseBranch}. Delivery is explicitly "merge": merge that PR ONLY into ${manifest.baseBranch} after the actual configured checks and reviews pass. `
    + `Do not target or modify main, change repository settings/workflows, approve your own PR, skip checks, or create follow-up tasks. No existing PR is supplied. `
    + `Use the configured host-authenticated repository/publisher capabilities; never request credentials. This is a tiny Markdown-only fixture, with no UI change or application build requirement. `
    + `Publish only paths ["${manifest.file}"] with these nonempty guest verification commands: ${JSON.stringify(manifest.checks)}. `
    + `The expected complete file is:\n${manifest.expectedContent}\nThese are all preauthorized decisions; record userDecisions.delivery = "merge". If anything beyond these facts is required, report the concrete blocker.`;
}

async function prepareFixture(manifest, directory) {
  const manifestPath = join(directory, "manifest.json");
  await save(manifestPath, manifest);
  // The actual pipeline resolves the original deferred instructions relative to this factory.
  await symlink(join(root, "example/instructions"), join(directory, "instructions"), "dir");
  await symlink(join(root, "example/skills"), join(directory, "skills"), "dir");
  const source = `import { createExampleFactory } from ${JSON.stringify(pathToFileURL(join(root, "example/factory.ts")).href)};\n`
    + `import { instrumentFactory } from ${JSON.stringify(import.meta.url)};\n`
    + `const config = createExampleFactory(${JSON.stringify({ repository: manifest.repo, cwd: root, baseBranch: manifest.baseBranch })});\n`
    + `export default await instrumentFactory(config, ${JSON.stringify(manifestPath)});\n`;
  await writeFile(join(directory, "factory.ts"), source, { mode: 0o600 });
  manifest.factory = await realpath(manifest.factory);
  assert.notEqual(manifest.factory, await realpath(join(root, "example/factory.ts")));
}

async function factoryPreflight(manifest) {
  const { tsImport } = await import("tsx/esm/api");
  const module = await tsImport(pathToFileURL(join(root, "example/factory.ts")).href, import.meta.url);
  assert.equal(typeof module.createExampleFactory, "function", "The completed example must export createExampleFactory");
  const config = module.createExampleFactory({ repository: manifest.repo, cwd: root, baseBranch: manifest.baseBranch });
  assert.equal(config.workflows.length, 1);
  const workflow = config.workflows[0];
  assert.deepEqual(workflow.options.stages.map(stage => stage.options.name), ["Todo", "Triage & Plan", "Implementation", "Checks", "Review", "Merge", "Done"]);
  const actualAgents = workflow.options.stages.flatMap(stage => stage.options.agents.map(agent =>
    [stage.options.name, agent.options.name, agent.options.model.id, agent.options.model.options.variant]));
  assert.deepEqual(actualAgents, expectedAgents, "Live verification must preserve the real configured models and agents");
  manifest.workflow = workflow.options.name;
  manifest.resources = workflow.options.container.options;
  manifest.models = actualAgents;
  manifest.maxReturns = workflow.options.policies.maxRetries ?? 2;
  manifest.stages = workflow.options.stages.map(stage => ({ name: stage.options.name,
    agents: stage.options.agents.map(agent => agent.options.name),
    returns: (stage.options.policies?.returns?.() ?? []).map(target => target.options.name) }));
}

async function createBase(manifest, persist) {
  const repository = await api(`repos/${manifest.repo}`);
  assert.equal(repository.private, true, "This verification targets the explicitly authorized private repository");
  assert.equal(repository.default_branch, "main");
  manifest.mainBefore = (await api(`repos/${manifest.repo}/git/ref/heads/main`)).object.sha;
  const existing = await api(`repos/${manifest.repo}/git/ref/heads/${manifest.baseBranch}`, { missing: true });
  assert.equal(existing, null, "The disposable base must not already exist");
  manifest.baseCreationRequested = true;
  await persist();
  await api(`repos/${manifest.repo}/git/refs`, { method: "POST", body: { ref: `refs/heads/${manifest.baseBranch}`, sha: manifest.mainBefore } });
  manifest.baseCreated = true;
  await persist();
  const fixture = await api(`repos/${manifest.repo}/contents/${manifest.file}`, { method: "PUT", body: {
    message: `Prepare isolated Buckles verification ${manifest.runId}`, branch: manifest.baseBranch,
    content: Buffer.from(manifest.initialContent).toString("base64"),
  } });
  manifest.fixtureCommit = fixture.commit.sha;
  await persist();
}

async function cli(factory, args, timeoutMs = 30000) {
  return JSON.parse(await command(process.execPath, [join(root, "packages/cli/dist/bin.js"), ...args,
    "--factory", factory, "--json"], { timeoutMs }));
}

async function assertOwnedService(manifest, snapshot) {
  const factory = await realpath(manifest.factory);
  assert.notEqual(factory, await realpath(join(root, "example/factory.ts")), "The fixture must never control the user's example factory");
  assert.equal(snapshot.factory, factory, "Only the exact canonical fixture factory may be controlled");
  if (manifest.daemonPid !== undefined) assert.equal(snapshot.pid, manifest.daemonPid, "The owned daemon PID must remain stable");
}

async function waitForTask(manifest, directory, deadline, interrupted) {
  const answered = new Set();
  let previous;
  while (Date.now() < deadline) {
    if (interrupted()) throw new Error("Live verification interrupted; cleaning up only its own factory");
    const snapshot = await cli(manifest.factory, ["status"]);
    await assertOwnedService(manifest, snapshot);
    assert.equal(snapshot.tasks.length, 1, "The fixture must not create follow-up tasks");
    const task = snapshot.tasks.find(task => task.id === manifest.taskId);
    assert.ok(task, "The owned task must remain in the owned factory");
    const progress = { state: task.state, stage: task.stage, agent: task.agent, attempt: task.attempt, activity: safe(task.activity) };
    if (JSON.stringify(progress) !== previous) {
      await append(join(directory, "progress.jsonl"), { at: new Date().toISOString(), ...progress });
      previous = JSON.stringify(progress);
    }
    await save(join(directory, "task-latest.json"), taskSummary(task));
    if (terminal.has(task.state)) return task;
    for (const question of task.questions) {
      if (answered.has(question.id)) continue;
      assert.ok(answered.size < 5, "More than five clarification questions exceeds this bounded fixture");
      assert.doesNotMatch(question.text, /(?:provide|paste|enter|share).{0,40}(?:token|password|secret)|bypass|disable.{0,30}(?:check|rule)/i,
        "The fixture cannot answer requests for secrets or bypasses");
      const answer = fixtureFacts(manifest);
      await append(join(directory, "answers.jsonl"), { id: question.id, question: safe(question.text), answer: safe(answer, 6000) });
      answered.add(question.id);
      await cli(manifest.factory, ["answer", manifest.taskId, answer]);
    }
    await delay(2000);
  }
  throw new Error("The 15-minute live workflow budget expired; the task will be cancelled without a retry");
}

async function discoverPull(manifest) {
  if (!manifest.headBranch) return undefined;
  const pages = await api(`repos/${manifest.repo}/pulls?state=all&head=${encodeURIComponent(`${manifest.repo.split("/")[0]}:${manifest.headBranch}`)}&per_page=100`, { pages: true });
  const pulls = pages.flat();
  assert.ok(pulls.length <= 1, "Only one PR may be created for the owned task branch");
  if (!pulls.length) return undefined;
  const pull = await api(`repos/${manifest.repo}/pulls/${pulls[0].number}`);
  assertOwnedPull(pull, manifest);
  return pull;
}

async function githubEvidence(manifest, pull, directory) {
  const endpoint = `repos/${manifest.repo}`;
  const head = pull.head.sha;
  const merge = (await receipts(directory)).findLast(receipt => receipt.type === "merge-complete");
  const mergeSha = merge?.result.merged === true ? merge.result.sha : undefined;
  if (mergeSha) assert.match(mergeSha, /^[a-f\d]{40}$/i);
  const commitEndpoint = mergeSha && `${endpoint}/git/commits/${mergeSha}`;
  const contentEndpoint = mergeSha && `${endpoint}/contents/${manifest.file}?ref=${mergeSha}`;
  const [filePages, reviewPages, runPages, statusPages, commit, content] = await Promise.all([
    api(`${endpoint}/pulls/${pull.number}/files?per_page=100`, { pages: true }),
    api(`${endpoint}/pulls/${pull.number}/reviews?per_page=100`, { pages: true }),
    api(`${endpoint}/commits/${head}/check-runs?filter=latest&per_page=100`, { pages: true }),
    api(`${endpoint}/commits/${head}/statuses?per_page=100`, { pages: true }),
    commitEndpoint ? api(commitEndpoint) : undefined,
    contentEndpoint ? api(contentEndpoint) : undefined,
  ]);
  const latestStatuses = new Map();
  for (const status of statusPages.flat()) {
    const name = status.context.toLowerCase();
    if (!latestStatuses.has(name)) latestStatuses.set(name, { name, state: status.state, id: status.id });
  }
  const evidence = { pull: pullSummary(pull), files: filePages.flat().map(file => ({ path: file.filename, status: file.status })),
    reviews: reviewPages.flat().map(review => ({ id: review.id, commitId: review.commit_id, state: review.state,
      isCopilot: review.is_copilot_code_review, submittedAt: review.submitted_at, author: review.user?.login })),
    checks: runPages.flatMap(page => page.check_runs).map(run => ({ id: run.id, name: run.name, headSha: run.head_sha,
      status: run.status, conclusion: run.conclusion })), statuses: [...latestStatuses.values()],
    verifiedMerge: commit && { sha: commit.sha, parents: commit.parents.map(parent => parent.sha), treeSha: commit.tree.sha,
      contentRef: mergeSha, provenance: { receipt: "receipts.jsonl:merge-complete", commitEndpoint, contentEndpoint } },
    mergedFile: content && Buffer.from(content.content, "base64").toString("utf8") };
  await save(join(directory, "github.json"), evidence);
  return evidence;
}

function verifyRouting(manifest, allReceipts) {
  const visits = new Map();
  const completedStages = new Set();
  const roles = new Set();
  const models = new Map(expectedAgents.map(([stage, agent, model, variant]) => [`${stage}/${agent}`, [model, variant]]));
  let stageIndex = 0;
  let agentIndex = 0;
  let returns = 0;
  for (const receipt of allReceipts.filter(receipt => ["agent", "merge-complete"].includes(receipt.type))) {
    const stage = manifest.stages[stageIndex];
    assert.ok(stage, "No effects may occur after the configured workflow finishes");
    if (stage.agents.length === 0) {
      assert.equal(stage.name, "Merge");
      assert.equal(receipt.type, "merge-complete", "The real Merge effect must precede Done");
      completedStages.add(stage.name);
      stageIndex++;
      continue;
    }
    assert.equal(receipt.type, "agent");
    assert.equal(receipt.stage, stage.name, "Agent routing must follow the actual configured stage order or a declared return");
    assert.equal(receipt.agent, stage.agents[agentIndex], "Agents must run in their configured order within each stage visit");
    if (agentIndex === 0) visits.set(stage.name, (visits.get(stage.name) ?? 0) + 1);
    assert.equal(receipt.attempt, visits.get(stage.name), "Attempt metadata must identify the stage visit, including partial Review visits");
    const role = `${receipt.stage}/${receipt.agent}`;
    assert.deepEqual([receipt.model, receipt.variant], models.get(role));
    roles.add(role);
    if (receipt.returnTo) {
      assert.ok(stage.returns.includes(receipt.returnTo), "Only a declared return target is valid");
      assert.ok(++returns <= manifest.maxReturns, "Configured workflow maxRetries bounds return transitions");
      stageIndex = manifest.stages.findIndex(target => target.name === receipt.returnTo);
      assert.ok(stageIndex >= 0, "Return target must belong to this workflow");
      agentIndex = 0;
    } else if (++agentIndex === stage.agents.length) {
      completedStages.add(stage.name);
      stageIndex++;
      agentIndex = 0;
    }
  }
  assert.equal(stageIndex, manifest.stages.length, "Every stage must eventually finish in the real configured workflow");
  assert.equal(completedStages.size, 7);
  assert.deepEqual([...roles].sort(), [...models.keys()].sort(), "All eight configured agent roles must eventually execute");
  return { returns, stageVisits: Object.fromEntries(visits), stages: completedStages.size, agentRoles: roles.size };
}

export function verifyResults(manifest, task, allReceipts, github) {
  assert.equal(task.state, "completed", task.error || "The real workflow must complete");
  assert.deepEqual(task.cleanupErrors, [], "The pipeline must confirm cleanup of every task VM");
  const agents = allReceipts.filter(receipt => receipt.type === "agent");
  const routing = verifyRouting(manifest, allReceipts);
  assert.deepEqual(task.outputs.map(output => [output.stage, output.agent, output.attempt]),
    agents.map(receipt => [receipt.stage, receipt.agent, receipt.attempt]), "Every real output must match its invocation receipt one-for-one");
  assert.equal(agents.at(-1).stage, "Done");
  const firstImplementation = agents.findIndex(receipt => receipt.stage === "Implementation");
  const finalImplementation = agents.findLastIndex(receipt => receipt.stage === "Implementation" && !receipt.returnTo);
  assert.ok(finalImplementation >= 0 && agents[finalImplementation].publication, "The final forward Implementation must publish the owned PR");
  assert.equal(agents[finalImplementation].publication.headSha, github.pull.headSha);
  const mainVm = agents[0].vm.id;
  const reviewVm = agents.find(receipt => receipt.stage === "Review").vm.id;
  assert.ok(mainVm && reviewVm && mainVm !== reviewVm, "Review must use a separate real VM");
  for (const [index, receipt] of agents.entries()) {
    assert.equal(receipt.error, undefined);
    assert.equal(receipt.inspectionError, undefined);
    assert.equal(receipt.taskId, manifest.taskId);
    assert.ok(receipt.output.length > 0);
    assert.equal(receipt.output.digest, digest(task.outputs[index].text));
    assert.equal(receipt.vm.id, receipt.stage === "Review" ? reviewVm : mainVm);
    if (index < firstImplementation) assert.equal(receipt.gitHead, manifest.fixtureCommit, "Initial Todo/Triage must use the fixture base");
    if (index >= finalImplementation) {
      assert.equal(receipt.gitHead, github.pull.headSha, "The final Implementation-through-Done pass must use the final PR head");
      assert.equal(receipt.github?.snapshotHead, github.pull.headSha);
    }
    if (receipt.github?.binding) assert.equal(receipt.github.binding.pullNumber, github.pull.number, "Repairs must retain the single owned PR");
    if (receipt.stage === "Review") {
      assert.equal(receipt.gitHead, receipt.github?.snapshotHead, "Each Review visit must use its own actual current PR snapshot");
      assert.equal(receipt.trackedWorktreeClean, true);
    }
    if (index === 0) assert.equal(receipt.handoff, null);
    else assert.deepEqual(receipt.handoff, { stage: agents[index - 1].stage, agent: agents[index - 1].agent,
      attempt: agents[index - 1].attempt, outputDigest: agents[index - 1].output.digest });
  }
  const checks = agents.findLast(receipt => receipt.stage === "Checks" && !receipt.returnTo).github;
  assert.equal(checks.checksHead, github.pull.headSha);
  assert.ok(checks.checks.some(check => check.name === "buckles/verification" && check.state === "passed"));
  assert.ok(checks.reviews.some(review => review.isCopilot && review.commitId === github.pull.headSha && review.submittedAt));
  const merges = allReceipts.filter(receipt => receipt.type === "merge-complete");
  assert.equal(merges.length, 1);
  assert.equal(merges[0].result.merged, true);
  assert.equal(github.pull.merged, true, "GitHub itself must confirm the merge");
  assert.equal(github.pull.base, manifest.baseBranch);
  const starts = allReceipts.filter(receipt => receipt.type === "merge-start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].pull.number, github.pull.number);
  assert.equal(merges[0].number, github.pull.number);
  assert.equal(starts[0].pull.base, manifest.baseBranch);
  assert.equal(starts[0].pull.head, manifest.headBranch);
  assert.equal(starts[0].pull.headSha, github.pull.headSha);
  assert.equal(github.verifiedMerge.sha, merges[0].result.sha, "GitHub must return the actual commit named by the successful Merge RPC");
  assert.deepEqual(github.verifiedMerge.parents, [starts[0].pull.baseSha, starts[0].pull.headSha], "The merge commit must join the exact owned base and reviewed head");
  assert.equal(github.verifiedMerge.contentRef, github.verifiedMerge.sha, "Merged bytes must be read at the verified merge SHA");
  assert.deepEqual(github.files, [{ path: manifest.file, status: "modified" }]);
  assert.equal(github.mergedFile, manifest.expectedContent);
  assert.ok(github.reviews.some(review => review.isCopilot === true && review.commitId === github.pull.headSha
    && review.submittedAt && ["COMMENTED", "APPROVED", "CHANGES_REQUESTED"].includes(review.state)), "A real classified Copilot review of this exact head is required");
  assert.ok(github.statuses.some(status => status.name === "buckles/verification" && status.state === "success"));
  assert.ok(github.statuses.every(status => status.state === "success"), "Every latest commit status must pass");
  assert.ok(github.checks.every(check => check.headSha === github.pull.headSha && check.status === "completed"
    && ["success", "neutral", "skipped"].includes(check.conclusion)), "Every actual current-head check must settle successfully");
  return { ...routing, agentInvocations: agents.length, mainVm, reviewVm,
    vmDestruction: "Confirmed by real pipeline terminal outcome with empty cleanupErrors (emitted only after destroy settles)",
    mergeCommit: github.verifiedMerge.sha, pr: github.pull.url };
}

async function stopOwnedFactory(manifest, directory, result) {
  if (!manifest.startRequested) return true;
  try {
    let snapshot = await cli(manifest.factory, ["status"]);
    await assertOwnedService(manifest, snapshot);
    manifest.daemonPid ??= snapshot.pid;
    // Reconcile an uncertain add response from this unique factory, never replay it.
    if (!manifest.taskId && snapshot.tasks.length === 1 && snapshot.tasks[0].title === `Verify isolated workflow ${manifest.runId}`) {
      manifest.taskId = snapshot.tasks[0].id;
      manifest.headBranch = taskBranch(manifest.taskId);
    }
    await save(join(directory, "factory-before-stop.json"), { ...snapshot, tasks: snapshot.tasks.map(taskSummary) });
    for (const task of snapshot.tasks) {
      if (!terminal.has(task.state)) await cli(manifest.factory, ["cancel", task.id]);
    }
    const cleanupDeadline = Date.now() + 120000;
    while (snapshot.tasks.some(task => !terminal.has(task.state)) && Date.now() < cleanupDeadline) {
      await delay(2000);
      snapshot = await cli(manifest.factory, ["status"]);
      await assertOwnedService(manifest, snapshot);
      await save(join(directory, "factory-before-stop.json"), { ...snapshot, tasks: snapshot.tasks.map(taskSummary) });
    }
    // Export the terminal task/cleanup outcome before stop discards daemon history.
    const task = snapshot.tasks.find(task => task.id === manifest.taskId);
    if (task) await save(join(directory, "task-final.json"), taskSummary(task));
    const settled = snapshot.tasks.every(task => terminal.has(task.state));
    const stopped = await cli(manifest.factory, ["stop"], settled ? 30000 : 5000);
    result.factoryStop = stopped;
    assert.equal(stopped.stopped, true);
    assert.deepEqual(stopped.cleanupErrors, []);
    assert.ok(settled, "Task cleanup did not settle within the export budget; final history was not confirmed");
    return true;
  } catch (error) {
    result.cleanupErrors.push(`Own factory stop/VM cleanup unconfirmed: ${safe(error.message)}`);
    return false;
  }
}

async function cleanupRemote(manifest, directory, result) {
  const endpoint = `repos/${manifest.repo}`;
  const pull = await discoverPull(manifest);
  if (pull) {
    await save(join(directory, "pull-before-cleanup.json"), pullSummary(pull));
    if (!pull.merged && pull.state !== "closed") {
      await api(`${endpoint}/pulls/${pull.number}`, { method: "PATCH", body: { state: "closed" } });
      result.closedPull = pull.number;
    }
  }
  if (manifest.headBranch) {
    const head = await api(`${endpoint}/git/ref/heads/${manifest.headBranch}`, { missing: true });
    if (head) {
      const ancestry = await api(`${endpoint}/compare/${manifest.fixtureCommit}...${head.object.sha}`);
      assert.equal(ancestry.merge_base_commit.sha, manifest.fixtureCommit, "Only delete a task branch descended from the owned fixture commit");
      await api(`${endpoint}/git/refs/heads/${manifest.headBranch}`, { method: "DELETE" });
      result.deletedHead = manifest.headBranch;
    }
  }
  if (manifest.baseCreationRequested) {
    const base = await api(`${endpoint}/git/ref/heads/${manifest.baseBranch}`, { missing: true });
    if (base) {
      assert.notEqual(manifest.baseBranch, "main");
      assert.ok(manifest.baseBranch.startsWith(`buckles-verify/${manifest.runId}/`));
      await api(`${endpoint}/git/refs/heads/${manifest.baseBranch}`, { method: "DELETE" });
      result.deletedBase = manifest.baseBranch;
    }
  }
}

async function main() {
  const { values } = parseArgs({ options: { repo: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) {
    console.log("Usage: node .groundwork/scripts/live-workflow.mjs --repo darylcecile/buckle\nLIVE: one actual seven-stage workflow, disposable PR/base, 15-minute run budget plus cooperative cleanup. Requires the completed build and host gh/Copilot login. Main is never a mutation target.");
    return;
  }
  assert.equal(values.repo, approvedRepository, "Explicit --repo darylcecile/buckle is required; no other repository is authorized");
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const directory = join(root, ".groundwork/tmp", `live-workflow-${runId}`);
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const file = `BUCKLES_WORKFLOW_VERIFY_${runId}.md`;
  const marker = `verified-${randomUUID()}`;
  const initialContent = `# Buckles live workflow verification\n\nRun: ${runId}\n\nResult: pending\n`;
  const manifest = { kind: "buckles-owned-live-workflow", runId, repo: values.repo, startedAt: new Date().toISOString(),
    baseBranch: `buckles-verify/${runId}/base`, file, marker, initialContent,
    expectedContent: initialContent.replace("Result: pending", `Result: ${marker}`),
    checks: [`grep -Fxq 'Result: ${marker}' '${file}'`, "git diff --check"],
    factory: join(directory, "factory.ts"), evidenceDirectory: directory, budgetMs: 900000 };
  const persist = () => save(join(directory, "manifest.json"), manifest);
  const result = { status: "failed", cleanupErrors: [], context: { publicCliWorkerPipeline: true, newTuiKeyboardRun: false } };
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await persist();
    manifest.revision = await command("git", ["rev-parse", "HEAD"]);
    manifest.sourceStatus = await command("git", ["status", "--short"]);
    await factoryPreflight(manifest);
    await prepareFixture(manifest, directory);
    await createBase(manifest, persist);
    manifest.startRequested = true;
    await persist();
    const service = await cli(manifest.factory, ["start"]);
    await assertOwnedService(manifest, service);
    assert.deepEqual(service.tasks, []);
    manifest.daemonPid = service.pid;
    await persist();
    const task = await cli(manifest.factory, ["add", `Verify isolated workflow ${runId}`, "--description", fixtureFacts(manifest), "--workflow", manifest.workflow]);
    manifest.taskId = task.id;
    manifest.headBranch = taskBranch(task.id);
    await persist();
    const completed = await waitForTask(manifest, directory, Date.parse(manifest.startedAt) + manifest.budgetMs, () => interrupted);
    await save(join(directory, "task-final.json"), taskSummary(completed));
    result.taskOutcome = { state: completed.state, error: completed.error && safe(completed.error, 4000), cleanupErrors: completed.cleanupErrors };
    try {
      const pull = await discoverPull(manifest);
      if (pull) result.github = await githubEvidence(manifest, pull, directory);
    } catch (error) {
      result.githubEvidenceError = safe(error.message);
      if (completed.state === "completed") throw error;
    }
    assert.equal(completed.state, "completed", completed.error || "The actual task failed");
    assert.ok(result.github, "The task must create an actual owned PR");
    result.verified = verifyResults(manifest, completed, await receipts(directory), result.github);
    result.status = "passed";
  } catch (error) {
    result.error = safe(error.message, 4000);
  } finally {
    const stopped = await stopOwnedFactory(manifest, directory, result);
    if (stopped) {
      try { await cleanupRemote(manifest, directory, result); }
      catch (error) { result.cleanupErrors.push(`Owned GitHub cleanup: ${safe(error.message)}`); }
    } else result.cleanupErrors.push("Owned remote resources retained because worker shutdown could not be confirmed; consult manifest.json before manual cleanup");
    if (manifest.mainBefore) {
      try {
        manifest.mainAfter = (await api(`repos/${manifest.repo}/git/ref/heads/main`)).object.sha;
        result.mainUnchanged = manifest.mainAfter === manifest.mainBefore;
        if (!result.mainUnchanged) {
          result.mainAttribution = "Inconclusive: main changed during the run, but this comparison does not identify the actor. No restore/reset was attempted.";
          if (result.status === "passed") result.status = "inconclusive";
        }
      } catch (error) { result.cleanupErrors.push(`main comparison: ${safe(error.message)}`); }
    }
    if (result.cleanupErrors.length) result.status = "failed";
    result.elapsedMs = Date.now() - Date.parse(manifest.startedAt);
    result.finishedAt = new Date().toISOString();
    await persist();
    await save(join(directory, "result.json"), result);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    console.log(JSON.stringify({ status: result.status, error: result.error, taskOutcome: result.taskOutcome, verified: result.verified,
      mainUnchanged: result.mainUnchanged, mainAttribution: result.mainAttribution,
      cleanupErrors: result.cleanupErrors, evidenceDirectory: directory }, null, 2));
    process.exitCode = result.status === "passed" ? 0 : result.status === "inconclusive" ? 2 : 1;
  }
}

if (process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => "") === fileURLToPath(import.meta.url)) await main();
