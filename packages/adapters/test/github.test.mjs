import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import { Github } from "../dist/index.js";

const head = "a".repeat(40);
const otherHead = "b".repeat(40);
const pull = (sha = head) => ({ number: 7, title: "Improve workflows", body: "Details", html_url: "https://github.com/acme/project/pull/7",
	head: { sha }, base: { ref: "main" }, state: "open", draft: false, merged: false });
const review = (overrides = {}) => ({ id: 1, body: "Reviewed", user: { login: "reviewer" }, state: "APPROVED", commit_id: head,
	submitted_at: "2026-11-08T12:00:00Z", ...overrides });
const comment = (id) => ({ id, body: `Comment ${id}`, user: { login: "author" }, html_url: `https://github.com/comment/${id}` });
const response = (data, options) => Response.json(data, options);

function setup(handler, options = {}) {
	const calls = [];
	const context = new Github.SessionContext({ owner: "acme", repo: "project", pullNumber: 7, token: "test-only-token",
		gateTimeoutMs: 200, pollIntervalMs: 1, ...options,
		fetch: async (url, init) => {
			assert.equal(init.headers.Authorization, "Bearer test-only-token");
			assert.equal(init.redirect, "error");
			const request = { url: new URL(url), method: init.method, body: init.body && JSON.parse(init.body), signal: init.signal };
			calls.push(request);
			return handler(request);
		},
	});
	return { context, calls };
}

test("binding is explicit, inert, shared by write references, and credential-safe", async () => {
	const context = new Github.SessionContext();
	const write = context.expectWrite();
	assert.equal(context.bound, false);
	assert.equal(context.writeExpected, false);
	assert.equal(write.writeExpected, true);
	assert.equal(write.id, context.id);
	await assert.rejects(Github.act.ReadyForAgents(context), /unbound/);
	context.bind({ owner: "acme", repo: "project", pullNumber: 7, token: "test-only-token", fetch: () => { throw new Error("unexpected network"); } });
	assert.equal(write.bound, true);
	assert.deepEqual(write.binding, { owner: "acme", repo: "project", pullNumber: 7 });
	const binding = write.binding;
	binding.repo = "another";
	assert.equal(context.binding.repo, "project");
	assert.equal(write.snapshot, undefined);
	assert.equal(inspect(context, { showHidden: true }).includes("test-only-token"), false);
	assert.equal(JSON.stringify(context).includes("test-only-token"), false);
	assert.throws(() => write.bind({}), /already bound/);
});

test("ReadyForAgents loads paginated discussions and reviews into an isolated readable snapshot", async () => {
	const { context, calls } = setup(({ url }) => {
		if (url.pathname.endsWith("/pulls/7")) return response(pull());
		if (url.pathname.endsWith("/issues/7/comments")) {
			return url.searchParams.get("page") === "1"
				? response([comment(1)], { headers: { link: '<https://api.github.com/next?page=2>; rel="next"' } })
				: response([comment(2)]);
		}
		if (url.pathname.endsWith("/reviews")) return response([review()]);
		if (url.pathname.endsWith("/comments")) return response([{ ...comment(3), path: "index.ts", line: 12 }]);
		throw new Error("Unexpected route");
	}, { apiBaseUrl: "https://enterprise.example/api/v3" });
	await Github.act.ReadyForAgents(context.expectWrite());
	assert.equal(context.snapshot.pullRequest.headSha, head);
	assert.deepEqual(context.snapshot.comments.map(({ body }) => body), ["Comment 1", "Comment 2"]);
	assert.equal(context.snapshot.reviewComments[0].path, "index.ts");
	assert.equal(context.snapshot.reviews[0].state, "APPROVED");
	const copy = context.snapshot;
	copy.comments.length = 0;
	assert.equal(context.snapshot.comments.length, 2);
	assert.ok(calls.every(({ url }) => url.pathname.startsWith("/api/v3/repos/acme/project/")));
});

test("ReadyForAgents rejects a head change during loading and retries on the same context", async () => {
	let reads = 0;
	const { context, calls } = setup(({ url }) => response(url.pathname.endsWith("/pulls/7") ? pull(++reads === 1 ? head : otherHead) : []));
	await assert.rejects(Github.act.ReadyForAgents(context), /head changed while loading/);
	assert.equal(context.snapshot, undefined);
	await assert.rejects(Github.act.Merge(context), /ReadyForAgents/);
	assert.equal(calls.some(({ method }) => method !== "GET"), false);
	await Github.act.ReadyForAgents(context.expectWrite());
	assert.equal(context.snapshot.pullRequest.headSha, otherHead);
});

test("actions serialize approval before merge even when invoked in a Promise array through different references", async () => {
	let approvalCompleted = false;
	const { context, calls } = setup(async ({ url, method, body }) => {
		if (method === "GET") return response(pull());
		if (url.pathname.endsWith("/reviews")) {
			assert.deepEqual(body, { event: "APPROVE", commit_id: head });
			await new Promise((resolve) => setImmediate(resolve));
			approvalCompleted = true;
			return response(review());
		}
		assert.equal(approvalCompleted, true);
		assert.deepEqual(body, { sha: head, merge_method: "squash" });
		return response({ merged: true, sha: "merge-commit" });
	}, { mergeMethod: "squash" });
	await Promise.all([Github.act.TryApprove(context), Github.act.Merge(context.expectWrite())]);
	assert.equal(context.approval.commitId, head);
	assert.deepEqual(context.mergeResult, { merged: true, sha: "merge-commit" });
	assert.deepEqual(calls.filter(({ method }) => method !== "GET").map(({ method }) => method), ["POST", "PUT"]);
});

test("failed approval blocks its queued batch, but a later explicit retry succeeds on the same context", async () => {
	let allowApproval = false;
	const failed = setup(({ method }) => {
		if (method === "GET") return response(pull());
		if (method === "POST") return allowApproval ? response(review()) : response({ message: "test-only-token" }, { status: 403 });
		return response({ merged: true, sha: "retried-merge" });
	});
	const independent = setup(({ method }) => method === "GET" ? response(pull()) : response({ merged: true, sha: "merged" }));
	const results = await Promise.allSettled([Github.act.TryApprove(failed.context), Github.act.Merge(failed.context.expectWrite()), Github.act.Merge(independent.context)]);
	assert.deepEqual(results.map(({ status }) => status), ["rejected", "rejected", "fulfilled"]);
	assert.ok(results[0].reason instanceof Github.ApiError);
	assert.equal(results[0].reason.status, 403);
	assert.equal(inspect(results[0].reason).includes("test-only-token"), false);
	assert.equal(failed.calls.filter(({ method }) => method === "GET").length, 1);
	await assert.rejects(Github.act.Merge(failed.context), /TryApprove/);
	assert.equal(failed.calls.some(({ method }) => method === "PUT"), false);
	allowApproval = true;
	await Promise.all([Github.act.TryApprove(failed.context.expectWrite()), Github.act.Merge(failed.context)]);
	assert.equal(failed.context.approval.commitId, head);
	assert.deepEqual(failed.context.mergeResult, { merged: true, sha: "retried-merge" });
});

test("changed heads and unconfirmed approval or merge responses fail closed", async () => {
	let reads = 0;
	const changed = setup(({ method, body }) => {
		if (method === "GET") return response(pull(++reads === 1 ? head : otherHead));
		if (method === "POST") return response(review({ commit_id: body.commit_id }));
		assert.equal(body.sha, otherHead);
		return response({ merged: true, sha: "new-head-merge" });
	});
	await Github.act.TryApprove(changed.context);
	await assert.rejects(Github.act.Merge(changed.context), /head changed/);
	assert.equal(changed.calls.some(({ method }) => method === "PUT"), false);
	await Github.act.TryApprove(changed.context);
	assert.equal(changed.context.approval.commitId, otherHead);
	await Github.act.Merge(changed.context);
	assert.equal(changed.context.mergeResult.sha, "new-head-merge");
	const pending = setup(({ method }) => response(method === "GET" ? pull() : review({ state: "PENDING", submitted_at: undefined })));
	const pendingResults = await Promise.allSettled([Github.act.TryApprove(pending.context), Github.act.Merge(pending.context)]);
	assert.ok(pendingResults.every(({ status }) => status === "rejected"));
	await assert.rejects(Github.act.Merge(pending.context), /TryApprove/);
	const refused = setup(({ method }) => response(method === "GET" ? pull() : { merged: false, sha: "" }));
	await assert.rejects(Github.act.Merge(refused.context), /did not confirm/);
	assert.equal(refused.context.mergeResult, undefined);
});

test("HTTP errors, transport errors, and request timeouts reject without exposing credentials", async () => {
	const unauthorized = setup(() => response({ message: "secret" }, { status: 401 }));
	await assert.rejects(Github.act.ReadyForAgents(unauthorized.context), { status: 401 });
	const transport = setup(() => { throw new Error("test-only-token"); });
	await assert.rejects(Github.act.ReadyForAgents(transport.context), (error) => !inspect(error).includes("test-only-token"));
	let aborted = false;
	const hung = setup(({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => {
		aborted = true;
		reject(new Error("aborted"));
	})), { requestTimeoutMs: 10 });
	await assert.rejects(Github.act.ReadyForAgents(hung.context), /timed out/);
	assert.equal(aborted, true);
});

const check = (name, overrides = {}) => ({ name, head_sha: head, status: "completed", conclusion: "success", ...overrides });

test("ReadyForChecks exposes failed current-head evidence before the agent without waiting for Copilot or passing gates", async () => {
	let currentHead = head;
	const { context, calls } = setup(({ url }) => {
		if (url.pathname.endsWith("/pulls/7")) return response(pull(currentHead));
		if (url.pathname.endsWith("/check-runs")) return response({ check_runs: [check("Build", { conclusion: "failure", html_url: "https://github.com/acme/project/actions/runs/1" })] });
		if (url.pathname.endsWith("/statuses")) return response([{ context: "buckles/verification", state: "failure", target_url: "https://github.com/acme/project/pull/7" }]);
		if (url.pathname.endsWith("/reviews")) return response([review({ is_copilot_code_review: true, state: "PENDING", submitted_at: null })]);
		return response([comment(1)]);
	});
	await Github.act.ReadyForChecks(context, { ignore: [], expected: ["buckles/verification"] });
	assert.deepEqual(context.checks.checks, [
		{ name: "build", state: "failed", url: "https://github.com/acme/project/actions/runs/1" },
		{ name: "buckles/verification", state: "failed", url: "https://github.com/acme/project/pull/7" },
	]);
	assert.equal(context.checks.headSha, head);
	assert.equal(context.snapshot.pullRequest.headSha, head);
	assert.equal(context.snapshot.reviews[0].state, "PENDING");
	assert.equal(calls.filter(({ url }) => url.pathname.endsWith("/check-runs")).length, 1);
	const copy = context.checks;
	copy.checks.length = 0;
	assert.equal(context.expectWrite().checks.checks.length, 2);
	await assert.rejects(Github.act.Merge(context), /Checks, CopilotCodeReview/);
	currentHead = otherHead;
	await Github.act.ReadyForAgents(context);
	assert.equal(context.checks, undefined);
	assert.equal(context.snapshot.pullRequest.headSha, otherHead);
});

test("ReadyForChecks waits for expected checks and classified review settlement, then authoritative gates still run", async () => {
	let observations = 0;
	const { context } = setup(({ url, method }) => {
		if (url.pathname.endsWith("/pulls/7")) return response(pull());
		if (url.pathname.endsWith("/check-runs")) {
			observations++;
			return response({ check_runs: [check("external-ci")] });
		}
		if (url.pathname.endsWith("/statuses")) return response(observations === 1 ? [] : [{ context: "buckles/verification", state: "success" }]);
		if (url.pathname.endsWith("/reviews")) return response([review({ is_copilot_code_review: true, commit_id: observations < 3 ? otherHead : head })]);
		if (method === "PUT") return response({ merged: true, sha: "merged-current-head" });
		return response([]);
	});
	await Github.act.ReadyForChecks(context, { ignore: [], expected: ["buckles/verification"] });
	assert.equal(observations, 3);
	assert.equal(context.snapshot.reviews[0].commitId, head);
	assert.equal(context.checks.checks.length, 2);
	await assert.rejects(Github.act.Merge(context), /Checks, CopilotCodeReview/);
	await Promise.all([
		Github.gates.Checks(context, { ignore: [], expected: ["buckles/verification"] }),
		Github.gates.CopilotCodeReview(context, { status: "done" }),
	]);
	await Github.act.Merge(context);
	assert.equal(context.mergeResult.sha, "merged-current-head");
});

test("ReadyForChecks bounds missing results and rejects a changing head without exposing stale observations", async () => {
	let reads = 0;
	const changing = setup(({ url }) => {
		if (url.pathname.endsWith("/pulls/7")) return response(pull(++reads < 4 ? head : otherHead));
		if (url.pathname.endsWith("/check-runs")) return response({ check_runs: [check("build")] });
		return response([]);
	});
	await Github.act.ReadyForChecks(changing.context, { ignore: [], copilotReview: false });
	await assert.rejects(Github.act.ReadyForChecks(changing.context, { ignore: [], copilotReview: false }), /head changed/);
	assert.equal(changing.context.checks, undefined);
	assert.equal(changing.context.snapshot, undefined);
	const missing = setup(({ url }) => {
		if (url.pathname.endsWith("/pulls/7")) return response(pull());
		return response(url.pathname.endsWith("/check-runs") ? { check_runs: [] } : []);
	}, { gateTimeoutMs: 20 });
	await assert.rejects(Github.act.ReadyForChecks(missing.context, { ignore: [], expected: ["buckles/verification"] }), /timed out/);
	assert.equal(missing.context.checks, undefined);
});

test("RequestCopilotReview confirms dedicated initial and subsequent requests without treating acceptance or errors as completion", async () => {
	let currentHead = head;
	let reviewedHead;
	const { context, calls } = setup(({ url, method, body }) => {
		if (method === "POST") {
			assert.equal(url.pathname, "/repos/acme/project/pulls/7/copilot-code-review");
			assert.equal(body, undefined);
			return response({ node_id: "RRR_request", state: "PENDING" }, { status: 201 });
		}
		if (url.pathname.endsWith("/pulls/7")) return response(pull(currentHead));
		if (url.pathname.endsWith("/reviews")) return response(reviewedHead ? [review({ is_copilot_code_review: true, commit_id: reviewedHead })] : []);
		throw new Error("Unexpected route");
	});
	await Github.act.RequestCopilotReview(context.expectWrite());
	await assert.rejects(Github.act.Merge(context), /CopilotCodeReview/);
	reviewedHead = head;
	await Github.gates.CopilotCodeReview(context, { status: "done" });
	currentHead = otherHead;
	await Github.act.RequestCopilotReview(context);
	await assert.rejects(Github.act.Merge(context), /CopilotCodeReview/);
	assert.equal(calls.filter(({ method }) => method === "POST").length, 2);
	for (const confirmation of [{ node_id: "RRR_request", state: "DONE" }, { node_id: " ", state: "PENDING" }]) {
		const malformed = setup(({ method }) => response(method === "POST" ? confirmation : pull(), method === "POST" ? { status: 201 } : undefined));
		await assert.rejects(Github.act.RequestCopilotReview(malformed.context), /did not confirm a pending Copilot code-review request/);
		await assert.rejects(Github.act.Merge(malformed.context), /CopilotCodeReview/);
	}
	for (const status of [403, 409, 500]) {
		const rejected = setup(({ method }) => response(method === "POST" ? {} : pull(), method === "POST" ? { status } : undefined));
		await assert.rejects(Github.act.RequestCopilotReview(rejected.context), {
			name: "GithubApiError", status,
			message: `GitHub API request failed (HTTP ${status}) while requesting Copilot code review for repos/acme/project/pulls/7`,
		});
	}
});

test("rechecking a new head preserves required snapshot, review, and approval until each is refreshed", async () => {
	let currentHead = head;
	const { context, calls } = setup(({ url, method, body }) => {
		if (url.pathname.endsWith("/pulls/7")) return response(pull(currentHead));
		if (method === "POST") {
			assert.equal(body.commit_id, currentHead);
			return response(review({ commit_id: currentHead }));
		}
		if (method === "PUT") {
			assert.equal(body.sha, otherHead);
			return response({ merged: true, sha: "prepared-new-head" });
		}
		if (url.pathname.endsWith("/check-runs")) return response({ check_runs: [check("build", { head_sha: currentHead })] });
		if (url.pathname.endsWith("/reviews")) return response([review({ is_copilot_code_review: true, commit_id: currentHead })]);
		return response([]);
	});
	await Github.act.ReadyForAgents(context);
	await Github.gates.Checks(context, { ignore: [] });
	await Github.gates.CopilotCodeReview(context, { status: "done" });
	await Github.act.TryApprove(context);
	currentHead = otherHead;
	await assert.rejects(Github.act.Merge(context), /head changed/);
	await Github.gates.Checks(context.expectWrite(), { ignore: [] });
	assert.equal(context.snapshot, undefined);
	assert.equal(context.approval, undefined);
	await assert.rejects(Github.act.TryApprove(context), /ReadyForAgents, CopilotCodeReview/);
	await Github.act.ReadyForAgents(context);
	assert.equal(context.snapshot.pullRequest.headSha, otherHead);
	await assert.rejects(Github.act.Merge(context), /CopilotCodeReview/);
	await Github.gates.CopilotCodeReview(context, { status: "done" });
	await assert.rejects(Github.act.Merge(context), /TryApprove/);
	assert.equal(calls.some(({ method }) => method === "PUT"), false);
	await Promise.all([Github.act.TryApprove(context.expectWrite()), Github.act.Merge(context)]);
	assert.equal(context.approval.commitId, otherHead);
	assert.equal(context.mergeResult.sha, "prepared-new-head");
});

test("Checks polls both paginated sources, ignores names, and uses the latest status per context", async () => {
	let polls = 0;
	const { context, calls } = setup(({ url }) => {
		if (url.pathname.endsWith("/pulls/7")) return response(pull());
		if (url.pathname.endsWith("/check-runs")) {
			assert.equal(url.searchParams.get("filter"), "latest");
			if (url.searchParams.get("page") === "1") {
				polls++;
				return response({ check_runs: [check("build", polls === 1 ? { status: "in_progress", conclusion: null } : {})] },
					{ headers: { link: '<https://api.github.com/checks?page=2>; rel="next"' } });
			}
			return response({ check_runs: [check("ignored", { conclusion: "failure" }), check("lint", { conclusion: "neutral" })] });
		}
		if (url.searchParams.get("page") === "1") return response([{ context: "legacy", state: "success" }],
			{ headers: { link: '<https://api.github.com/statuses?page=2>; rel="next"' } });
		return response([{ context: "LEGACY", state: "failure" }, { context: "ignored", state: "error" }]);
	});
	await Github.gates.Checks(context, { ignore: ["ignored"], expected: ["build", "legacy", "lint"] });
	assert.equal(polls, 2);
	assert.ok(calls.some(({ url }) => url.pathname.endsWith("/statuses") && url.searchParams.get("page") === "2"));
});

test("failed checks/statuses reject promptly; empty, ignored-only, and missing expected results time out", async () => {
	for (const fixture of [
		{ runs: [check("build", { conclusion: "timed_out" })], statuses: [], failure: /checks failed.*build/ },
		{ runs: [check("build", { conclusion: "failure" }), check("ignored", { conclusion: "failure" })],
			statuses: [{ context: "legacy", state: "error", description: "test-only-token" }], failure: /checks failed.*build, legacy$/ },
		{ runs: [], statuses: [] },
		{ runs: [check("ignored")], statuses: [] },
		{ runs: [check("build")], statuses: [], expected: ["deploy"] },
	]) {
		const { context } = setup(({ url }) => {
			if (url.pathname.endsWith("/pulls/7")) return response(pull());
			return response(url.pathname.endsWith("/check-runs") ? { check_runs: fixture.runs } : fixture.statuses);
		}, { gateTimeoutMs: 25 });
		await assert.rejects(Github.gates.Checks(context, { ignore: ["ignored"], expected: fixture.expected }), fixture.failure ?? /gate timed out/);
	}
});

test("gates reject old-head data and head changes instead of accepting stale green checks", async () => {
	const old = setup(({ url }) => {
		if (url.pathname.endsWith("/pulls/7")) return response(pull());
		return response({ check_runs: [check("build", { head_sha: otherHead })] });
	});
	await assert.rejects(Github.gates.Checks(old.context, { ignore: [] }), /different head/);
	let reads = 0;
	const changed = setup(({ url }) => {
		if (url.pathname.endsWith("/pulls/7")) return response(pull(++reads === 1 ? head : otherHead));
		return response(url.pathname.endsWith("/check-runs") ? { check_runs: [check("build")] } : []);
	});
	await assert.rejects(Github.gates.Checks(changed.context, { ignore: [] }), /head changed/);
	const stable = setup(({ url, method, body }) => {
		if (url.pathname.endsWith("/pulls/7")) return response(pull(reads === 0 ? head : otherHead));
		if (method === "PUT") {
			assert.equal(body.sha, otherHead);
			return response({ merged: true, sha: "rechecked-merge" });
		}
		assert.equal(method, "GET");
		return response(url.pathname.endsWith("/check-runs") ? { check_runs: [check("build", { head_sha: reads === 0 ? head : otherHead })] } : []);
	});
	reads = 0;
	await Github.gates.Checks(stable.context, { ignore: [] });
	reads = 1;
	await assert.rejects(Github.act.Merge(stable.context), /head changed/);
	await Github.act.ReadyForAgents(stable.context);
	await assert.rejects(Github.act.Merge(stable.context), /Checks/);
	assert.equal(stable.calls.some(({ method }) => method === "PUT"), false);
	await Github.gates.Checks(stable.context, { ignore: [] });
	await Github.act.Merge(stable.context);
	assert.equal(stable.context.mergeResult.sha, "rechecked-merge");
});

test("Copilot gate waits for a classified, submitted current-head review across pages", async () => {
	let polls = 0;
	const { context } = setup(({ url }) => {
		if (url.pathname.endsWith("/pulls/7")) return response(pull());
		if (url.searchParams.get("page") === "1") {
			polls++;
			return response([review({ is_copilot_code_review: true, commit_id: otherHead })],
				{ headers: { link: '<https://api.github.com/reviews?page=2>; rel="next"' } });
		}
		return response([review({ id: 2, is_copilot_code_review: true, state: polls === 1 ? "PENDING" : "COMMENTED",
			submitted_at: polls === 1 ? undefined : "2026-11-08T12:00:00Z" })]);
	});
	await Github.gates.CopilotCodeReview(context, { status: "done" });
	assert.equal(polls, 2);
});

test("requested-only, pending, human, and obsolete Copilot reviews cannot satisfy the gate", async () => {
	for (const reviews of [[], [review()], [review({ is_copilot_code_review: true, commit_id: otherHead })],
		[review({ is_copilot_code_review: true, state: "PENDING", submitted_at: undefined })]]) {
		const { context } = setup(({ url }) => response(url.pathname.endsWith("/pulls/7") ? { ...pull(), requested_reviewers: [{ login: "copilot" }] } : reviews),
			{ gateTimeoutMs: 20 });
		await assert.rejects(Github.gates.CopilotCodeReview(context, { status: "done" }), /gate timed out/);
	}
});

test("gate deadlines bound pagination and propagate API failures", async () => {
	const forever = setup(({ url }) => url.pathname.endsWith("/pulls/7") ? response(pull())
		: response([review()], { headers: { link: '<https://api.github.com/reviews?page=2>; rel="next"' } }), { gateTimeoutMs: 10 });
	await assert.rejects(Github.gates.CopilotCodeReview(forever.context, { status: "done" }), /timed out/);
	const forbidden = setup(() => response({}, { status: 403 }));
	await assert.rejects(Github.gates.Checks(forbidden.context, { ignore: [] }), { status: 403 });
	await assert.rejects(Github.gates.Checks(new Github.SessionContext(), { ignore: [] }), /unbound/);
});
