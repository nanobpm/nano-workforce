// Convergence comment-gate — unit tests for the canonical router (app/convergeGate.ts), the
// suppressed-advisory / ack-marker parsers + review-thread fetch helpers (app/github.ts), the
// pr.converge-gate worker (fail-closed, with injected GitHub readers), and a structural guard over
// the committed convergence-loop BPMN.
//
// The loop used to declare convergence on the agent's self-reported `status = "converged"` with no
// deterministic check that Copilot's comments were addressed. On Magikcraft/nano-bpm#770 a
// suppressed advisory was never applied across 20 rounds, yet the PR converged and auto-merged. The
// fix inserts a deterministic `pr.converge-gate` step on the converged path that blocks convergence
// while any review thread is unresolved OR any suppressed advisory lacks a RESOLVED `nano-ack:`
// thread, escalating to the human `wait-answer` task instead of finalizing.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "#test-assert";
import { evaluateConvergeGate } from "./convergeGate.ts";
import {
  parseAckedAdvisories,
  parseReviewThreadsPage,
  parseSuppressedAdvisories,
  pickLatestCopilotReviewBody,
  type ReviewThread,
} from "./github.ts";

// ── The canonical router ────────────────────────────────────────────────────

test("evaluateConvergeGate: a clean PR (no unresolved threads, no advisories) converges", () => {
  const r = evaluateConvergeGate({ unresolvedThreadCount: 0, suppressedKeys: [], acknowledgedKeys: [] });
  assertEquals(r.convergeBlocked, false);
  assertEquals(r.convergeBlockReason, "");
});

test("evaluateConvergeGate: an unresolved review thread blocks convergence", () => {
  const r = evaluateConvergeGate({ unresolvedThreadCount: 2, suppressedKeys: [], acknowledgedKeys: [] });
  assertEquals(r.convergeBlocked, true);
  assertStringIncludes(r.convergeBlockReason, "2 unresolved review threads");
});

test("evaluateConvergeGate: an unacknowledged suppressed advisory blocks convergence", () => {
  const r = evaluateConvergeGate({
    unresolvedThreadCount: 0,
    suppressedKeys: ["spec/a.json:613"],
    acknowledgedKeys: [],
  });
  assertEquals(r.convergeBlocked, true);
  assertStringIncludes(r.convergeBlockReason, "spec/a.json:613");
  // Singular noun for exactly one advisory (explicit, not "advisor" + "y/ies" concatenation).
  assertStringIncludes(r.convergeBlockReason, "1 unacknowledged suppressed advisory (");
});

test("evaluateConvergeGate: an ACKNOWLEDGED suppressed advisory no longer blocks convergence", () => {
  const r = evaluateConvergeGate({
    unresolvedThreadCount: 0,
    suppressedKeys: ["spec/a.json:613"],
    acknowledgedKeys: ["spec/a.json:613"],
  });
  assertEquals(r.convergeBlocked, false);
});

test("evaluateConvergeGate: multiple unacknowledged advisories use the plural noun", () => {
  const r = evaluateConvergeGate({
    unresolvedThreadCount: 0,
    suppressedKeys: ["x.ts:10", "y.ts:20"],
    acknowledgedKeys: [],
  });
  assertEquals(r.convergeBlocked, true);
  assertStringIncludes(r.convergeBlockReason, "2 unacknowledged suppressed advisories (");
});

test("evaluateConvergeGate: reports both a thread and an advisory when both are outstanding", () => {
  const r = evaluateConvergeGate({
    unresolvedThreadCount: 1,
    suppressedKeys: ["x.ts:10", "y.ts:20"],
    acknowledgedKeys: ["x.ts:10"],
  });
  assertEquals(r.convergeBlocked, true);
  assertStringIncludes(r.convergeBlockReason, "1 unresolved review thread");
  assertStringIncludes(r.convergeBlockReason, "y.ts:20");
  assert(!r.convergeBlockReason.includes("x.ts:10"), "an acknowledged advisory must not be listed");
});

// ── The parsers (app/github.ts) ─────────────────────────────────────────────

const SAMPLE_REVIEW_BODY = [
  "## Pull Request Overview",
  "Some prose that mentions **not/an/advisory:1** in passing.",
  "",
  "<details>",
  "<summary>Suppressed comments (2)</summary>",
  "",
  "**spec-app/nano-app.schema.json:613**",
  "- The description could be clearer about the loopback default.",
  "",
  "**server/src/main.rs:42**",
  "- Consider narrowing this type.",
  "</details>",
].join("\n");

test("parseSuppressedAdvisories: extracts only the keys inside the Suppressed comments block", () => {
  const keys = parseSuppressedAdvisories(SAMPLE_REVIEW_BODY);
  assertEquals(keys, ["spec-app/nano-app.schema.json:613", "server/src/main.rs:42"]);
});

test("parseSuppressedAdvisories: returns [] when there is no suppressed block", () => {
  assertEquals(parseSuppressedAdvisories("## Overview\nLooks good, **file.ts:1** is fine."), []);
  assertEquals(parseSuppressedAdvisories(null), []);
  assertEquals(parseSuppressedAdvisories(undefined), []);
});

test("parseAckedAdvisories: only RESOLVED threads carrying a nano-ack marker count", () => {
  const threads: ReviewThread[] = [
    { isResolved: true, path: "a.ts", bodies: ["Fixed. nano-ack: spec-app/nano-app.schema.json:613"] },
    { isResolved: false, path: "b.ts", bodies: ["nano-ack: server/src/main.rs:42"] }, // open -> ignored
    { isResolved: true, path: "c.ts", bodies: ["unrelated resolved comment"] },
  ];
  const acked = parseAckedAdvisories(threads);
  assertEquals(acked, ["spec-app/nano-app.schema.json:613"]);
});

test("parseReviewThreadsPage: maps nodes and reports a complete (final) page", () => {
  const page = parseReviewThreadsPage({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ isResolved: false, path: "a.ts", comments: { nodes: [{ body: "please fix" }] } }],
          },
        },
      },
    },
  });
  assertEquals(page, {
    threads: [{ isResolved: false, path: "a.ts", bodies: ["please fix"] }],
    hasNextPage: false,
    endCursor: null,
  });
});

test("parseReviewThreadsPage: a TRUNCATED page reports hasNextPage + its cursor (caller pages on)", () => {
  // >100 threads: the first:100 page cannot see thread 101+, so instead of silently dropping the
  // overflow the mapper surfaces `hasNextPage`/`endCursor` and `fetchReviewThreads` pages to
  // completeness (or fails closed once its bounded page cap is exhausted).
  const page = parseReviewThreadsPage({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: true, endCursor: "CURSOR123" },
            nodes: [{ isResolved: true, path: "a.ts", comments: { nodes: [{ body: "ok" }] } }],
          },
        },
      },
    },
  });
  assertEquals(page, {
    threads: [{ isResolved: true, path: "a.ts", bodies: ["ok"] }],
    hasNextPage: true,
    endCursor: "CURSOR123",
  });
});

test("parseReviewThreadsPage: FAILS CLOSED (null) when the reviewThreads block is MISSING", () => {
  // GraphQL errors, permission issues, or a malformed payload can omit `reviewThreads`. Treating that
  // as "no threads" (empty array) is a fail-OPEN — an unverifiable read must return null so the worker
  // blocks/escalates rather than converging on a read that never happened.
  assertEquals(parseReviewThreadsPage({}), null);
  assertEquals(parseReviewThreadsPage({ data: { repository: { pullRequest: {} } } }), null);
});

test("parseReviewThreadsPage: FAILS CLOSED (null) when the completeness signal is UNREADABLE", () => {
  // A present block whose `pageInfo.hasNextPage` is not a readable boolean is unverifiable — we cannot
  // tell whether more pages exist, so we cannot safely page or map it.
  const page = parseReviewThreadsPage({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [{ isResolved: true, path: "a.ts", comments: { nodes: [{ body: "ok" }] } }],
          },
        },
      },
    },
  });
  assertEquals(page, null);
});

test("pickLatestCopilotReviewBody: picks the NEWEST Copilot review body (oldest\u2192newest order)", () => {
  const body = pickLatestCopilotReviewBody(
    [
      { user: { login: "human" }, body: "human review" },
      { user: { login: "Copilot" }, body: "old copilot review" },
      { user: { login: "Copilot" }, body: "newest copilot review" },
    ],
    false,
  );
  assertEquals(body, "newest copilot review");
});

test('pickLatestCopilotReviewBody: a complete read with NO Copilot review is verified empty ("")', () => {
  assertEquals(pickLatestCopilotReviewBody([{ user: { login: "human" }, body: "hi" }], false), "");
  assertEquals(pickLatestCopilotReviewBody([], false), "");
});

test("pickLatestCopilotReviewBody: FAILS CLOSED (null) when the reviews read was TRUNCATED", () => {
  // >100 reviews (a long convergence loop): a first-page-only read returns the OLDEST 100 and misses
  // the genuinely newest Copilot review, so an unverifiable (truncated) read must block, never return
  // a stale page's body \u2014 a fail-OPEN on the advisory dimension is the class this gate prevents.
  assertEquals(
    pickLatestCopilotReviewBody(
      [{ user: { login: "Copilot" }, body: "possibly stale" }],
      true,
    ),
    null,
  );
});

async function makeUnderTest(deps: {
  readThreads: (repo: string, n: number) => Promise<ReviewThread[] | null>;
  readReviewBody: (repo: string, n: number) => Promise<string | null>;
}) {
  const { makeHandler } = await import("../workers/converge-gate/worker.ts");
  return makeHandler(deps);
}

test("converge-gate: a clean PR is allowed to converge", async () => {
  const handler = await makeUnderTest({
    readThreads: async () => [{ isResolved: true, path: "a.ts", bodies: ["ok"] }],
    readReviewBody: async () => "## Overview\nNo suppressed block.",
  });
  const out = await handler({ variables: { prKey: "o/r#1", repo: "o/r", prNumber: 1 } } as any, {} as any);
  assertEquals(out, { convergeBlocked: false, convergeBlockReason: "" });
});

test("converge-gate: an unresolved thread blocks convergence", async () => {
  const handler = await makeUnderTest({
    readThreads: async () => [{ isResolved: false, path: "a.ts", bodies: ["please fix"] }],
    readReviewBody: async () => "",
  });
  const out = await handler({ variables: { prKey: "o/r#1", repo: "o/r", prNumber: 1 } } as any, {} as any);
  assertEquals(out.convergeBlocked, true);
  assertStringIncludes(out.convergeBlockReason ?? "", "unresolved review thread");
});

test("converge-gate: an unacknowledged suppressed advisory blocks convergence", async () => {
  const handler = await makeUnderTest({
    readThreads: async () => [],
    readReviewBody: async () => SAMPLE_REVIEW_BODY,
  });
  const out = await handler({ variables: { prKey: "o/r#1", repo: "o/r", prNumber: 1 } } as any, {} as any);
  assertEquals(out.convergeBlocked, true);
  assertStringIncludes(out.convergeBlockReason ?? "", "spec-app/nano-app.schema.json:613");
});

test("converge-gate: an acknowledged advisory (resolved ack thread) is allowed", async () => {
  const handler = await makeUnderTest({
    readThreads: async () => [
      { isResolved: true, path: "spec-app/nano-app.schema.json", bodies: ["Applied. nano-ack: spec-app/nano-app.schema.json:613"] },
      { isResolved: true, path: "server/src/main.rs", bodies: ["Declined, false positive. nano-ack: server/src/main.rs:42"] },
    ],
    readReviewBody: async () => SAMPLE_REVIEW_BODY,
  });
  const out = await handler({ variables: { prKey: "o/r#1", repo: "o/r", prNumber: 1 } } as any, {} as any);
  assertEquals(out, { convergeBlocked: false, convergeBlockReason: "" });
});

test("converge-gate: FAILS CLOSED when the threads read returns null (no transport)", async () => {
  const handler = await makeUnderTest({
    readThreads: async () => null,
    readReviewBody: async () => "",
  });
  const out = await handler({ variables: { prKey: "o/r#1", repo: "o/r", prNumber: 1 } } as any, {} as any);
  assertEquals(out.convergeBlocked, true);
  assertStringIncludes(out.convergeBlockReason ?? "", "could not verify");
});

test("converge-gate: FAILS CLOSED when the review-body read returns null (no transport)", async () => {
  // A null review body is unverifiable, not "no advisories" — the gate must block, not fail open on
  // the suppressed-advisory dimension while the threads read happened to succeed.
  const handler = await makeUnderTest({
    readThreads: async () => [{ isResolved: true, path: "a.ts", bodies: ["ok"] }],
    readReviewBody: async () => null,
  });
  const out = await handler({ variables: { prKey: "o/r#1", repo: "o/r", prNumber: 1 } } as any, {} as any);
  assertEquals(out.convergeBlocked, true);
  assertStringIncludes(out.convergeBlockReason ?? "", "could not verify");
});

test("converge-gate: FAILS CLOSED when a reader throws", async () => {
  const handler = await makeUnderTest({
    readThreads: async () => {
      throw new Error("boom");
    },
    readReviewBody: async () => "",
  });
  const out = await handler({ variables: { prKey: "o/r#1", repo: "o/r", prNumber: 1 } } as any, {} as any);
  assertEquals(out.convergeBlocked, true);
  assertStringIncludes(out.convergeBlockReason ?? "", "could not verify");
});

test("converge-gate: FAILS CLOSED when the target cannot be resolved", async () => {
  const handler = await makeUnderTest({
    readThreads: async () => [],
    readReviewBody: async () => "",
  });
  const out = await handler({ variables: { prKey: "not-a-pr-key" } } as any, {} as any);
  assertEquals(out.convergeBlocked, true);
  assertStringIncludes(out.convergeBlockReason ?? "", "could not verify");
});

test("converge-gate: a non-string prKey does not throw — resolves from repo/prNumber vars", async () => {
  // `parsePr` calls `.trim()`, so a missing/non-string prKey must not reach it: otherwise the job
  // throws and retries instead of running the fail-closed gate. A well-formed job carrying valid
  // repo + prNumber but no prKey must still evaluate normally.
  const handler = await makeUnderTest({
    readThreads: async () => [{ isResolved: true, path: "a.ts", bodies: ["ok"] }],
    readReviewBody: async () => "",
  });
  const out = await handler({ variables: { repo: "o/r", prNumber: 1 } } as any, {} as any);
  assertEquals(out, { convergeBlocked: false, convergeBlockReason: "" });
});

test("converge-gate: FAILS CLOSED (no throw) when prKey is non-string and repo/prNumber are absent", async () => {
  const handler = await makeUnderTest({
    readThreads: async () => [],
    readReviewBody: async () => "",
  });
  const out = await handler({ variables: { prKey: 123 } } as any, {} as any);
  assertEquals(out.convergeBlocked, true);
  assertStringIncludes(out.convergeBlockReason ?? "", "could not verify");
});

test("converge-gate: resolves repo/prNumber from the prKey when the vars are absent", async () => {
  let seen: [string, number] | null = null;
  const handler = await makeUnderTest({
    readThreads: async (repo, n) => {
      seen = [repo, n];
      return [];
    },
    readReviewBody: async () => "",
  });
  await handler({ variables: { prKey: "o/r#7" } } as any, {} as any);
  assertEquals(seen, ["o/r", 7]);
});

// ── Structural guard over the committed BPMN (no engine) ─────────────────────

const bpmn = readFileSync("resources/processes/convergence-loop.bpmn", "utf8");
const flat = bpmn.replace(/\s+/g, " ");

function flowElement(id: string): string | null {
  const re = new RegExp(
    `<bpmn:sequenceFlow\\b[^>]*?\\bid="${id}"[^>]*?(?:/>|>(?:(?!<bpmn:sequenceFlow\\b).)*?</bpmn:sequenceFlow>)`,
  );
  const m = flat.match(re);
  return m ? m[0] : null;
}

test("the converged status arm routes through the check-converge gate, not straight to finalize", () => {
  const f = flowElement("f_converged");
  assert(f, "f_converged flow missing");
  assertStringIncludes(f, 'sourceRef="gw-status"');
  assertStringIncludes(f, 'targetRef="check-converge"');
  assertStringIncludes(f, 'status = "converged"');
});

test("check-converge runs the deterministic converge-gate job and feeds gw-converge-gate", () => {
  const f = flowElement("f_toConvergeGate");
  assert(f, "f_toConvergeGate flow missing");
  assertStringIncludes(f, 'sourceRef="check-converge"');
  assertStringIncludes(f, 'targetRef="gw-converge-gate"');
  assertStringIncludes(flat, 'type="pr.converge-gate"');
});

test("gw-converge-gate blocks on an explicit convergeBlocked = true condition", () => {
  const f = flowElement("f_convergeBlocked");
  assert(f, "f_convergeBlocked flow missing");
  assertStringIncludes(f, 'targetRef="persist-escalation-blockedcomments"');
  assertStringIncludes(f, "convergeBlocked = true");
});

test("gw-converge-gate default arm routes to the scope classifier (not straight to finalize)", () => {
  const gw = flat.match(/<bpmn:exclusiveGateway\b[^>]*\bid="gw-converge-gate"[^>]*>/);
  assert(gw, "gw-converge-gate gateway missing");
  assertStringIncludes(gw[0], 'default="f_convergeOk"');
  const ok = flowElement("f_convergeOk");
  assert(ok, "f_convergeOk flow missing");
  assertStringIncludes(ok, 'targetRef="classify-scope"');
  assert(!/conditionExpression/.test(ok), "the default arm must carry no conditionExpression");
});

// ── The scope classifier (agent task) replaces the deterministic scope regex ──

test("classify-scope is an agent task servicing senior:scope-classify with a linked prompt", () => {
  const task = flat.match(/<bpmn:serviceTask\b[^>]*\bid="classify-scope"[^>]*>.*?<\/bpmn:serviceTask>/);
  assert(task, "classify-scope service task missing");
  assertStringIncludes(task[0], 'type="senior:scope-classify"');
  assertStringIncludes(task[0], 'resourceId="scope-classify.md"');
  assertStringIncludes(task[0], 'linkName="prompt"');
  // It reads the human's prior answer so it can honour an override (the #395 loop-defect fix).
  assertStringIncludes(task[0], 'target="answer"');
});

test("classify-scope feeds gw-scope-gate, which blocks on scopeBlocked = true", () => {
  const toGate = flowElement("f_toScopeGate");
  assert(toGate, "f_toScopeGate flow missing");
  assertStringIncludes(toGate, 'sourceRef="classify-scope"');
  assertStringIncludes(toGate, 'targetRef="gw-scope-gate"');
  const blocked = flowElement("f_scopeBlocked");
  assert(blocked, "f_scopeBlocked flow missing");
  assertStringIncludes(blocked, 'targetRef="persist-escalation-scope"');
  assertStringIncludes(blocked, "scopeBlocked = true");
});

test("gw-scope-gate default arm finalizes (scope ok → persist-converged)", () => {
  const gw = flat.match(/<bpmn:exclusiveGateway\b[^>]*\bid="gw-scope-gate"[^>]*>/);
  assert(gw, "gw-scope-gate gateway missing");
  assertStringIncludes(gw[0], 'default="f_scopeOk"');
  const ok = flowElement("f_scopeOk");
  assert(ok, "f_scopeOk flow missing");
  assertStringIncludes(ok, 'targetRef="persist-converged"');
  assert(!/conditionExpression/.test(ok), "the default arm must carry no conditionExpression");
});

test("the scope escalation routes through gw-escalated with the classifier's specific reason", () => {
  const f = flowElement("f_scopeEscGate");
  assert(f, "f_scopeEscGate flow missing");
  assertStringIncludes(f, 'sourceRef="persist-escalation-scope"');
  assertStringIncludes(f, 'targetRef="gw-escalated"');
  const task = flat.match(/<bpmn:serviceTask\b[^>]*\bid="persist-escalation-scope"[^>]*>.*?<\/bpmn:serviceTask>/);
  assert(task, "persist-escalation-scope task missing");
  assertStringIncludes(task[0], 'type="pr.persist-escalation"');
  assertStringIncludes(task[0], 'target="question"');
  // The human sees the classifier's specific finding, not a generic boilerplate reason.
  assertStringIncludes(task[0], "scopeBlockReason");
});

test("the blocked-comments escalation routes through gw-escalated toward an answerable wait-answer", () => {
  // #333: previously this flowed UNCONDITIONALLY into wait-answer, so a blank convergeBlockReason
  // (the question is mapped from that OPTIONAL variable) opened no escalation yet still parked a
  // dead wait with a null question. It now routes through gw-escalated, which parks wait-answer
  // only on a real escalation and otherwise re-enters the loop.
  const f = flowElement("f_blockedGate");
  assert(f, "f_blockedGate flow missing");
  assertStringIncludes(f, 'sourceRef="persist-escalation-blockedcomments"');
  assertStringIncludes(f, 'targetRef="gw-escalated"');
  const task = flat.match(
    /<bpmn:serviceTask\b[^>]*\bid="persist-escalation-blockedcomments"[^>]*>.*?<\/bpmn:serviceTask>/,
  );
  assert(task, "persist-escalation-blockedcomments task missing");
  assertStringIncludes(task[0], 'type="pr.persist-escalation"');
  assertStringIncludes(task[0], 'target="status"');
  assertStringIncludes(task[0], 'target="question"');
  assertStringIncludes(task[0], 'target="recordRound"');
  // The human sees the gate's own reason (the unresolved threads / unacknowledged advisories).
  assertStringIncludes(task[0], "convergeBlockReason");
});
