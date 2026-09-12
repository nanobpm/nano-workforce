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
  advisoryStableKey,
  parseAckedAdvisories,
  parseReviewThreadsPage,
  parseSuppressedAdvisories,
  pickLatestCopilotReviewBody,
  type ReviewThread,
} from "./github.ts";

// ── The canonical router ────────────────────────────────────────────────────

test("evaluateConvergeGate: a clean PR (no unresolved threads, no advisories) converges", () => {
  const r = evaluateConvergeGate({ unresolvedThreadCount: 0, suppressedAdvisories: [], acknowledgedKeys: [] });
  assertEquals(r.convergeBlocked, false);
  assertEquals(r.convergeBlockReason, "");
});

test("evaluateConvergeGate: an unresolved review thread blocks convergence", () => {
  const r = evaluateConvergeGate({ unresolvedThreadCount: 2, suppressedAdvisories: [], acknowledgedKeys: [] });
  assertEquals(r.convergeBlocked, true);
  assertStringIncludes(r.convergeBlockReason, "2 unresolved review threads");
});

test("evaluateConvergeGate: an unacknowledged suppressed advisory blocks convergence", () => {
  const r = evaluateConvergeGate({
    unresolvedThreadCount: 0,
    suppressedAdvisories: [{ key: "spec/a.json#deadbeef", legacyKey: "spec/a.json:613", label: "spec/a.json:613" }],
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
    suppressedAdvisories: [{ key: "spec/a.json#deadbeef", legacyKey: "spec/a.json:613", label: "spec/a.json:613" }],
    acknowledgedKeys: ["spec/a.json#deadbeef"],
  });
  assertEquals(r.convergeBlocked, false);
});

test("evaluateConvergeGate: a LEGACY path:line ack still acknowledges its advisory (back-compat)", () => {
  const r = evaluateConvergeGate({
    unresolvedThreadCount: 0,
    suppressedAdvisories: [{ key: "spec/a.json#deadbeef", legacyKey: "spec/a.json:613", label: "spec/a.json:613" }],
    acknowledgedKeys: ["spec/a.json:613"],
  });
  assertEquals(r.convergeBlocked, false);
});

test("evaluateConvergeGate: multiple unacknowledged advisories use the plural noun", () => {
  const r = evaluateConvergeGate({
    unresolvedThreadCount: 0,
    suppressedAdvisories: [
      { key: "x.ts#a", legacyKey: "x.ts:10", label: "x.ts:10" },
      { key: "y.ts#b", legacyKey: "y.ts:20", label: "y.ts:20" },
    ],
    acknowledgedKeys: [],
  });
  assertEquals(r.convergeBlocked, true);
  assertStringIncludes(r.convergeBlockReason, "2 unacknowledged suppressed advisories (");
});

test("evaluateConvergeGate: reports both a thread and an advisory when both are outstanding", () => {
  const r = evaluateConvergeGate({
    unresolvedThreadCount: 1,
    suppressedAdvisories: [
      { key: "x.ts#a", legacyKey: "x.ts:10", label: "x.ts:10" },
      { key: "y.ts#b", legacyKey: "y.ts:20", label: "y.ts:20" },
    ],
    acknowledgedKeys: ["x.ts#a"],
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

test("parseSuppressedAdvisories: extracts advisories inside the Suppressed comments block", () => {
  const advisories = parseSuppressedAdvisories(SAMPLE_REVIEW_BODY);
  assertEquals(
    advisories.map((a) => a.label),
    ["spec-app/nano-app.schema.json:613", "server/src/main.rs:42"],
  );
  // The line-stable key is `<path>#<fingerprint>` of the prose, distinct from the legacy path:line.
  assertEquals(advisories[0].legacyKey, "spec-app/nano-app.schema.json:613");
  assertEquals(
    advisories[0].key,
    advisoryStableKey("spec-app/nano-app.schema.json", "The description could be clearer about the loopback default."),
  );
  assert(advisories[0].key.startsWith("spec-app/nano-app.schema.json#"), "stable key is path#fingerprint");
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

test("parseAckedAdvisories: the new `<path> :: <text>` form yields the line-stable key", () => {
  const threads: ReviewThread[] = [
    { isResolved: true, path: "a.ts", bodies: ["Declined. nano-ack: server/src/main.rs :: Consider narrowing this type."] },
  ];
  const acked = parseAckedAdvisories(threads);
  assertEquals(acked, [advisoryStableKey("server/src/main.rs", "Consider narrowing this type.")]);
});

// ── Issue #787: a DECLINED advisory must not livelock the gate when its line drifts ──────────
//
// A declined advisory is re-emitted by Copilot every round; any unrelated edit shifts its line, so
// Copilot re-anchors it to a new line. Keying the ack on the line-stable prose fingerprint (not
// path:line) keeps a prior-round ack matching the re-emitted advisory across the drift.
test("converge gate #787: a stable-key ack survives a line drift and keeps the advisory acknowledged", () => {
  const proseText = "Consider narrowing this type.";
  // Round 1: Copilot suppressed the advisory at line 360; the agent acked it with the new form.
  const round1Body = [
    "<details>",
    "<summary>Suppressed comments (1)</summary>",
    "",
    "**app/deliveryRunner.ts:360**",
    `- ${proseText}`,
    "</details>",
  ].join("\n");
  // Round 2: an unrelated edit shifted the SAME advisory to line 369; Copilot re-emitted it there.
  const round2Body = round1Body.replace("app/deliveryRunner.ts:360", "app/deliveryRunner.ts:369");
  // The resolved ack thread from round 1 persists (its marker text is line-independent).
  const ackThreads: ReviewThread[] = [
    { isResolved: true, path: "app/deliveryRunner.ts", bodies: [`Declined, false positive. nano-ack: app/deliveryRunner.ts :: ${proseText}`] },
  ];
  const acknowledgedKeys = parseAckedAdvisories(ackThreads);

  const round1 = evaluateConvergeGate({
    unresolvedThreadCount: 0,
    suppressedAdvisories: parseSuppressedAdvisories(round1Body),
    acknowledgedKeys,
  });
  assertEquals(round1.convergeBlocked, false);

  // The drift MUST NOT re-block: the round-1 ack still acknowledges the round-2 re-emission.
  const round2 = evaluateConvergeGate({
    unresolvedThreadCount: 0,
    suppressedAdvisories: parseSuppressedAdvisories(round2Body),
    acknowledgedKeys,
  });
  assertEquals(round2.convergeBlocked, false);
});

test("converge gate #787: a genuinely new, never-acked advisory still blocks (no false-open)", () => {
  const body = [
    "<details>",
    "<summary>Suppressed comments (2)</summary>",
    "",
    "**app/x.ts:10**",
    "- The declined advisory that was acknowledged.",
    "",
    "**app/x.ts:20**", // SAME path, DIFFERENT advisory — never acknowledged.
    "- A brand-new concern that was never triaged.",
    "</details>",
  ].join("\n");
  const ackThreads: ReviewThread[] = [
    { isResolved: true, path: "app/x.ts", bodies: ["Declined. nano-ack: app/x.ts :: The declined advisory that was acknowledged."] },
  ];
  const r = evaluateConvergeGate({
    unresolvedThreadCount: 0,
    suppressedAdvisories: parseSuppressedAdvisories(body),
    acknowledgedKeys: parseAckedAdvisories(ackThreads),
  });
  assertEquals(r.convergeBlocked, true);
  // Only the un-acked advisory on the same path is reported; the acked one is not.
  assertStringIncludes(r.convergeBlockReason, "app/x.ts:20");
  assert(!r.convergeBlockReason.includes("app/x.ts:10"), "the acknowledged advisory must not be listed");
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
  assertStringIncludes(task[0], 'resourceId="prompts/scope-classify.md"');
  assertStringIncludes(task[0], 'linkName="prompt"');
  // After honouring (or ignoring) the human's scope answer, it clears the one-shot
  // scopeAnswer so a later round does not re-honour a stale decision.
  assertStringIncludes(task[0], 'source="=null" target="scopeAnswer"');
});

// ── The scope-answer plumbing (#395 loop-defect fix) ─────────────────────────
// review-round clears `answer` on every round, so a human's scope answer cannot reach
// the downstream classify-scope via `answer`. A dedicated `scopeAnswer` variable, gated
// by a `scopePending` marker, carries the decision across the review round without being
// confused with answers to other escalation kinds.

test("PrScopeClassifyIn feeds the classifier the surviving scopeAnswer, not the cleared answer", () => {
  const shape = flat.match(/<nano:shape\b[^>]*\bid="PrScopeClassifyIn"[^>]*>.*?<\/nano:shape>/);
  assert(shape, "PrScopeClassifyIn envelope missing");
  assertStringIncludes(shape[0], 'name="scopeAnswer"');
  assert(!/name="answer"/.test(shape[0]), "classifier must read scopeAnswer, not the shared answer");
});

test("PrScopeClassifyOut.scopeBlockReason is required (always emitted, empty when not blocked)", () => {
  const shape = flat.match(/<nano:shape\b[^>]*\bid="PrScopeClassifyOut"[^>]*>.*?<\/nano:shape>/);
  assert(shape, "PrScopeClassifyOut envelope missing");
  assert(
    /name="scopeBlockReason"(?![^>]*optional)/.test(shape[0]),
    "scopeBlockReason must not be optional — the wire contract requires it always present",
  );
});

test("persist-escalation-scope marks the open escalation as scope-kind (scopePending = true)", () => {
  const task = flat.match(/<bpmn:serviceTask\b[^>]*\bid="persist-escalation-scope"[^>]*>.*?<\/bpmn:serviceTask>/);
  assert(task, "persist-escalation-scope task missing");
  assertStringIncludes(task[0], 'source="=true" target="scopePending"');
});

test("record-answer captures a scope answer into scopeAnswer only while scopePending", () => {
  const task = flat.match(/<bpmn:serviceTask\b[^>]*\bid="record-answer"[^>]*>.*?<\/bpmn:serviceTask>/);
  assert(task, "record-answer task missing");
  // Capture is gated on scopePending so an answer to a *different* escalation is not
  // mis-read as a scope override; otherwise scopeAnswer is preserved.
  assertStringIncludes(
    task[0],
    'source="=(if scopePending = true then answer else scopeAnswer)" target="scopeAnswer"',
  );
});

test("review-round resets the scopePending marker after record-answer has consumed it", () => {
  const task = flat.match(/<bpmn:serviceTask\b[^>]*\bid="review-round"[^>]*>.*?<\/bpmn:serviceTask>/);
  assert(task, "review-round task missing");
  assertStringIncludes(task[0], 'source="=false" target="scopePending"');
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
