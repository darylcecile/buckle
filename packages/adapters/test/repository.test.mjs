import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Github } from "../dist/index.js";
import { gitEnvironment, repositoryHost } from "../dist/repository-auth.js";
import { RepositoryWorkspaces } from "../dist/repository.js";

const exec = promisify(execFile);
const output = (code = 0, stdout = "", stderr = "") => ({ code, stdout: () => stdout, stderr: () => stderr });

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "buckles-repository-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = join(root, "source");
	const remote = join(root, "remote.git");
	const token = "private-github-token-for-test";
	const git = async (cwd, args, env = gitEnvironment()) => (await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "init.templateDir=", ...args], { cwd, env })).stdout.trim();
	await mkdir(source);
	await git(source, ["init", "-b", "main"]);
	await writeFile(join(source, "README.md"), "Initial documentation\n");
	await git(source, ["add", "README.md"]);
	await git(source, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Initial"]);
	await git(root, ["clone", "--bare", source, remote]);
	await git(source, ["remote", "add", "origin", "https://github.com/acme/private-project.git"]);
	await writeFile(join(source, "README.md"), "User's uncommitted local work\n");
	const baseSha = await git(remote, ["rev-parse", "refs/heads/main"]);
	const hostCommands = [];
	t.mock.method(repositoryHost, "run", async (command, args, options) => {
		assert.equal(command, "git");
		assert.equal(args.some(arg => arg.includes(token)), false);
		assert.equal(options.env.GIT_CONFIG_GLOBAL, "/dev/null");
		hostCommands.push([...args]);
		const translated = args.map(arg => arg === "https://github.com/acme/private-project.git" ? remote : arg);
		return git(options.cwd, translated, options.env);
	});
	let pull;
	const statuses = [];
	const reviewRequests = [];
	const headReads = [];
	let staleHeadReads = 0;
	let creations = 0;
	t.mock.method(globalThis, "fetch", async (url, init) => {
		assert.equal(init.headers.Authorization, `Bearer ${token}`);
		const path = new URL(url).pathname;
		if (path === "/repos/acme/private-project") return Response.json({ default_branch: "main" });
		if (path.endsWith("/pulls") && init.method === "POST") {
			const args = JSON.parse(init.body);
			creations++;
			pull = { number: 7, title: args.title, body: args.body, html_url: "https://github.com/acme/private-project/pull/7", state: "open", draft: false, merged: false,
				head: { ref: args.head, sha: await git(remote, ["rev-parse", `refs/heads/${args.head}`]), repo: { full_name: "acme/private-project" } },
				base: { ref: args.base, sha: baseSha, repo: { full_name: "acme/private-project" } } };
			await git(remote, ["update-ref", "refs/pull/7/head", pull.head.sha]);
			return Response.json(pull);
		}
		if (pull) {
			const head = await git(remote, ["rev-parse", `refs/heads/${pull.head.ref}`]);
			await git(remote, ["update-ref", "refs/pull/7/head", head]);
			if (staleHeadReads > 0) staleHeadReads--;
			else pull.head.sha = head;
			if (path.endsWith("/pulls") || path.endsWith("/pulls/7")) headReads.push({ path, headSha: pull.head.sha });
		}
		if (path.endsWith("/pulls")) return Response.json(pull ? [pull] : []);
		if (path.endsWith("/pulls/7")) return Response.json(pull);
		if (path.includes("/statuses/")) { statuses.push({ sha: path.split("/").at(-1), ...JSON.parse(init.body) }); return Response.json({}); }
		if (path.endsWith("/copilot-code-review")) {
			assert.equal(init.method, "POST");
			assert.equal(init.body, undefined);
			reviewRequests.push(path);
			return Response.json({ node_id: `RRR_request_${reviewRequests.length}`, state: "PENDING" }, { status: 201 });
		}
		return Response.json([]);
	});
	const makeGuest = async name => {
		const cwd = join(root, name);
		const transfers = join(root, `${name}-transfers`);
		await mkdir(cwd);
		await mkdir(transfers);
		const guestPath = path => path.startsWith("/tmp/buckles-") ? join(transfers, basename(path)) : path;
		const commands = [];
		const container = {
			upload: (host, guest) => copyFile(host, guestPath(guest)),
			download: (guest, host) => copyFile(guestPath(guest), host),
			exec: async (command, args, options) => {
				commands.push({ command, args });
				if (command === "rm") { await rm(guestPath(args.at(-1)), { force: true }); return output(); }
				if (command === "/bin/sh") {
					if (args[1] === "setup-git") return output();
					if (args[1] === "failing-check") return output(2, "README assertion failed", "Expected a runnable command");
					if (args[1] === "mutating-check") { await writeFile(join(cwd, "README.md"), "Changed by check\n"); return output(); }
					if (args[1] === "verify-extra-source") {
						assert.equal(await readFile(join(cwd, "extra-source.js"), "utf8"), "export const value = 42;\n");
						return output(0, "Extra source verification passed");
					}
					assert.equal(args[1], "verify-readme");
					assert.match(await readFile(join(cwd, "README.md"), "utf8"), /Improved documentation/);
					return output(0, "README verification passed");
				}
				assert.equal(command, "git");
				try {
					const result = await exec("git", args.map(guestPath), { cwd: options.cwd, env: { ...gitEnvironment(), ...options.env } });
					return output(0, result.stdout, result.stderr);
				} catch (error) { return output(error.code, error.stdout, error.stderr); }
			},
		};
		return { cwd, container, commands };
	};
	const manager = new RepositoryWorkspaces();
	const github = new Github.SessionContext();
	let invocation = 0;
	const prepare = async (guest, contexts = []) => {
		const directory = join(root, `invocation-${++invocation}`);
		await mkdir(directory);
		const session = await manager.prepare({ task: { id: "unique-task-id" }, container: guest.container, contexts },
			{ cwd: source, bootstrap: ["setup-git"] }, { cwd: guest.cwd, commandTimeoutMs: 30_000, githubToken: token }, directory, new AbortController().signal);
		return { session, directory };
	};
	const advanceBase = async () => {
		const writer = join(root, "base-writer");
		await git(root, ["clone", remote, writer]);
		await writeFile(join(writer, "base-change.txt"), "Independent base change\n");
		await git(writer, ["add", "base-change.txt"]);
		await git(writer, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Advance base"]);
		await git(writer, ["push", "origin", "HEAD:main"]);
		return git(writer, ["rev-parse", "HEAD"]);
	};
	return { root, source, remote, git, token, baseSha, hostCommands, statuses, reviewRequests, headReads, makeGuest, prepare, github, advanceBase,
		lagRepairHead: () => { staleHeadReads = 2; }, creations: () => creations };
}

test("private checkout preserves real history; publication verifies actual commits and repairs reuse the PR and refresh an independent review VM", async t => {
	const f = await fixture(t);
	const main = await f.makeGuest("main-vm");
	const { session, directory } = await f.prepare(main);
	assert.equal(await readFile(join(main.cwd, "README.md"), "utf8"), "Initial documentation\n");
	assert.equal(await f.git(main.cwd, ["rev-parse", "HEAD"]), f.baseSha);
	assert.equal(await f.git(main.cwd, ["remote", "get-url", "origin"]), "https://github.com/acme/private-project.git");
	assert.equal((await readFile(join(directory, "checkout.bundle"))).includes(Buffer.from(f.token)), false);
	await writeFile(join(main.cwd, "README.md"), "Improved documentation\n");
	const repeated = await f.prepare(main);
	assert.equal(await readFile(join(main.cwd, "README.md"), "utf8"), "Improved documentation\n");
	assert.equal(main.commands.filter(command => command.args[1] === "setup-git").length, 1);
	const publication = { title: "Improve documentation", body: "Document the real workflow", paths: ["README.md"], checks: ["verify-readme"] };
	await assert.rejects(repeated.session.publish(f.github, { ...publication, checks: ["failing-check"] }), /README assertion failed/);
	assert.equal(f.statuses.length, 0);
	assert.equal(f.creations(), 0);
	const published = await repeated.session.publish(f.github, publication);
	assert.equal(published.pullNumber, 7);
	assert.equal(f.github.snapshot.pullRequest.headSha, published.headSha);
	assert.deepEqual(f.statuses.map(status => [status.sha, status.context, status.state]), [[published.headSha, "buckles/verification", "success"]]);
	assert.equal(await f.git(f.remote, ["rev-parse", "refs/heads/main"]), f.baseSha);
	const review = await f.makeGuest("review-vm");
	const firstReview = await f.prepare(review, [f.github]);
	assert.equal(firstReview.session.metadata.headSha, published.headSha);
	assert.equal(await f.git(review.cwd, ["rev-parse", "origin/main"]), f.baseSha);
	assert.equal(await f.git(review.cwd, ["rev-parse", "HEAD"]), published.headSha);
	const advancedBase = await f.advanceBase();
	const advancedReview = await f.prepare(review, [f.github]);
	assert.equal(advancedReview.session.metadata.baseSha, advancedBase);
	assert.equal(await f.git(review.cwd, ["rev-parse", "origin/main"]), advancedBase);
	assert.equal(await f.git(review.cwd, ["rev-parse", "HEAD"]), published.headSha);
	await writeFile(join(main.cwd, "README.md"), "Improved documentation with review repair\n");
	const repairSession = await f.prepare(main, [f.github]);
	f.lagRepairHead();
	const readStart = f.headReads.length;
	const repair = await repairSession.session.publish(f.github, publication);
	assert.notEqual(repair.headSha, published.headSha);
	assert.equal(repair.pullNumber, 7);
	assert.equal(f.creations(), 1);
	assert.equal(f.reviewRequests.length, 2);
	assert.deepEqual(f.headReads.slice(readStart, readStart + 3), [
		{ path: "/repos/acme/private-project/pulls", headSha: published.headSha },
		{ path: "/repos/acme/private-project/pulls/7", headSha: published.headSha },
		{ path: "/repos/acme/private-project/pulls/7", headSha: repair.headSha },
	]);
	await f.prepare(review, [f.github]);
	assert.equal(await f.git(review.cwd, ["rev-parse", "HEAD"]), repair.headSha);
	assert.equal(await f.git(review.cwd, ["rev-parse", "origin/main"]), advancedBase);
	assert.equal(await readFile(join(review.cwd, "README.md"), "utf8"), "Improved documentation with review repair\n");
	assert.equal(await readFile(join(f.source, "README.md"), "utf8"), "User's uncommitted local work\n");
});

test("publication refuses verification that mutates committed source and preserves failure evidence", async t => {
	const f = await fixture(t);
	const main = await f.makeGuest("main-vm");
	const { session } = await f.prepare(main);
	await writeFile(join(main.cwd, "README.md"), "Improved documentation\n");
	await assert.rejects(session.publish(f.github, { title: "Docs", body: "Details", paths: ["README.md"], checks: ["mutating-check"] }), /Tracked source differs/);
	assert.equal(f.statuses.length, 0);
	assert.equal(f.creations(), 0);
	assert.equal(await readFile(join(main.cwd, "README.md"), "utf8"), "Changed by check\n");
});

test("verification waits until its untracked source is included in the published commit", async t => {
	const f = await fixture(t);
	const main = await f.makeGuest("main-vm");
	const { session } = await f.prepare(main);
	await writeFile(join(main.cwd, "README.md"), "Improved documentation\n");
	await writeFile(join(main.cwd, "extra-source.js"), "export const value = 42;\n");
	const publication = { title: "Docs and source", body: "Details", paths: ["README.md"], checks: ["verify-extra-source"] };
	await assert.rejects(session.publish(f.github, publication), /list and commit intended files or remove untracked extras/);
	assert.equal(main.commands.some(command => command.args[1] === "verify-extra-source"), false);
	assert.equal(f.statuses.length, 0);
	const published = await session.publish(f.github, { ...publication, paths: ["README.md", "extra-source.js"] });
	assert.equal(await f.git(f.remote, ["show", `${published.headSha}:extra-source.js`]), "export const value = 42;");
	assert.equal(f.statuses[0].sha, published.headSha);
});
