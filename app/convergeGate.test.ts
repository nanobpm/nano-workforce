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
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "#test-assert";
import { evaluateConvergeGate } from "./convergeGate.ts";
import {
  advisoryStableKey,
  isAckThread,
  parseAckedAdvisories,
  parseReviewThreadsPage,
  parseSuppressedAdvisories,
  pickLatestCopilotReview,
  pickLatestCopilotReviewBody,
  type ReviewThread,
} from "./github.ts";

// ── The canonical router ────────────────────────────────────────────────────

test("evaluateConvergeGate: a clean PR (no unresolved threads, no advisories) converges", () => {
  const r = evaluateConvergeGate({ unresolvedThreadCount: 0, suppressedAdvisories: [], acknowledgedKeys: [] });
  assertEquals(r.convergeBlocked, false);
  assertEquals(r.convergeBlockReason, "");
  assertEquals(r.ackOnly, false);
});

test("evaluateConvergeGate: an unresolved review thread blocks convergence", () => {
  const r = evaluateConvergeGate({ unresolvedThreadCount: 2, suppressedAdvisories: [], acknowledgedKeys: [] });
  assertEquals(r.convergeBlocked, true);
  assertStringIncludes(r.convergeBlockReason, "2 unresolved review threads");
  // An unresolved inline thread needs the round agent's code/reply work — NOT ack-only (#796).
  assertEquals(r.ackOnly, false);
});

test("evaluateConvergeGate: an unacknowledged suppressed advisory blocks convergence", () => {
  const r = evaluateConvergeGate({
    unresolvedThreadCount: 0,
    suppressedAdvisories: [{ key: "spec/a.json#deadbeef", label: "spec/a.json:613" }],
    acknowledgedKeys: [],
  });
  assertEquals(r.convergeBlocked, true);
  assertStringIncludes(r.convergeBlockReason, "spec/a.json:613");
  // Singular noun for exactly one advisory (explicit, not "advisor" + "y/ies" concatenation).
  assertStringIncludes(r.convergeBlockReason, "1 unacknowledged suppressed advisory (");
  // Blocked SOLELY on an unacked advisory → the recoverable, bounded-auto-ack case (#796).
  assertEquals(r.ackOnly, true);
});

test("evaluateConvergeGate: an ACKNOWLEDGED suppressed advisory no longer blocks convergence", () => {
  const r = evaluateConvergeGate({
    unresolvedThreadCount: 0,
    suppressedAdvisories: [{ key: "spec/a.json#deadbeef", label: "spec/a.json:613" }],
    acknowledgedKeys: ["spec/a.json#deadbeef"],
  });
  assertEquals(r.convergeBlocked, false);
});

test("evaluateConvergeGate: a prose-blind legacy `path:line` ack does NOT acknowledge an advisory (no false-OPEN)", () => {
  // A resolved `nano-ack: spec/a.json:613` for a PRIOR advisory would yield only the `path:line`
  // string — never a stable `<path>#<fp>` key. A genuinely new advisory at that same line carries a
  // different stable key, so a bare-line ack can never satisfy it: the gate stays blocked. This is
  // the guard for issue #787's re-review finding — honouring `path:line` let a resolved ack for
  // advisory A silently converge a NEW advisory B re-emitted at the same line.
  const r = evaluateConvergeGate({
    unresolvedThreadCount: 0,
    suppressedAdvisories: [{ key: "spec/a.json#deadbeef", label: "spec/a.json:613" }],
    acknowledgedKeys: ["spec/a.json:613"],
  });
  assertEquals(r.convergeBlocked, true);
  assertStringIncludes(r.convergeBlockReason, "spec/a.json:613");
});

test("evaluateConvergeGate: multiple unacknowledged advisories use the plural noun", () => {
  const r = evaluateConvergeGate({
    unresolvedThreadCount: 0,
    suppressedAdvisories: [
      { key: "x.ts#a", label: "x.ts:10" },
      { key: "y.ts#b", label: "y.ts:20" },
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
      { key: "x.ts#a", label: "x.ts:10" },
      { key: "y.ts#b", label: "y.ts:20" },
    ],
    acknowledgedKeys: ["x.ts#a"],
  });
  assertEquals(r.convergeBlocked, true);
  assertStringIncludes(r.convergeBlockReason, "1 unresolved review thread");
  assertStringIncludes(r.convergeBlockReason, "y.ts:20");
  assert(!r.convergeBlockReason.includes("x.ts:10"), "an acknowledged advisory must not be listed");
  // A mix of an unresolved thread AND an unacked advisory is NOT ack-only — the thread still needs
  // the round agent's code/reply work, so it escalates to a human as before (#796).
  assertEquals(r.ackOnly, false);
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
  // The line-stable key is `<path>#<fingerprint>` of the prose; `label` remains the human `path:line`.
  assertEquals(advisories[0].label, "spec-app/nano-app.schema.json:613");
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

// An UNRESOLVED ack thread (one the round agent posted but has not resolved yet) must NOT count as
// an unresolved *review* thread: it is a partially-completed acknowledgement the bounded #796
// auto-ack retry can finish, so counting it would flip an otherwise ack-only block off the
// recoverable path and escalate to a human despite there being no substantive open code-review
// thread. `isAckThread` is the single source of truth the converge-gate worker filters on.
test("isAckThread: a thread carrying a nano-ack marker is an ack thread (resolved or not)", () => {
  assert(
    isAckThread({
      isResolved: false,
      path: "a.ts",
      bodies: ["Applied. nano-ack: app/x.ts :: Guard the empty input."],
    }),
  );
  assert(
    isAckThread({ isResolved: true, path: "a.ts", bodies: ["Declined. nano-ack: app/x.ts :: Narrow this type."] }),
  );
});

test("isAckThread: a substantive review thread (no nano-ack marker) is NOT an ack thread", () => {
  assertEquals(isAckThread({ isResolved: false, path: "a.ts", bodies: ["This can NPE on empty input."] }), false);
  assertEquals(isAckThread({ isResolved: false, path: "a.ts", bodies: [] }), false);
});

// FAIL-CLOSED guard #1 — the retired bare `nano-ack: <path>:<line>` form is prose-blind and NOT
// honoured by `parseAckedAdvisories`; classifying it as an ack thread would drop a genuine unresolved
// thread from the count and let the gate finalize with it still open. It must stay counted.
test("isAckThread: a bare `<path>:<line>` marker is NOT a dedicated ack thread (stays counted)", () => {
  assertEquals(
    isAckThread({ isResolved: false, path: "a.ts", bodies: ["Applied. nano-ack: app/x.ts:12"] }),
    false,
  );
});

// FAIL-CLOSED guard #2 — a substantive reviewer thread whose ROOT is the finding, with a later reply
// merely QUOTING a canonical marker, must NOT be classified as an ack thread. Only the thread root is
// inspected, and the root here carries no marker, so the substantive thread stays counted.
test("isAckThread: a substantive thread that only quotes nano-ack in a reply is NOT an ack thread", () => {
  assertEquals(
    isAckThread({
      isResolved: false,
      path: "a.ts",
      bodies: [
        "This can NPE on empty input.",
        "Re: your `nano-ack: app/x.ts :: Guard the empty input.` — that is unrelated to this finding.",
      ],
    }),
    false,
  );
});

// Mirrors the converge-gate worker's split: an unresolved ack thread is classified separately (it
// still BLOCKS but stays ack-only/recoverable), while a substantive unresolved thread escalates.
test("converge gate: an unresolved ack thread does not count as a SUBSTANTIVE thread (stays ack-only)", () => {
  const threads: ReviewThread[] = [
    { isResolved: false, path: "a.ts", bodies: ["Applied. nano-ack: app/x.ts :: Guard the empty input."] },
    { isResolved: true, path: "b.ts", bodies: ["already fixed"] },
  ];
  const unresolved = threads.filter((t) => !t.isResolved);
  const unresolvedAckThreadCount = unresolved.filter((t) => isAckThread(t)).length;
  const unresolvedThreadCount = unresolved.length - unresolvedAckThreadCount;
  assertEquals(unresolvedThreadCount, 0);
  assertEquals(unresolvedAckThreadCount, 1);
  const r = evaluateConvergeGate({
    unresolvedThreadCount,
    unresolvedAckThreadCount,
    suppressedAdvisories: [{ key: "app/x.ts#deadbeef", label: "app/x.ts:12" }],
    acknowledgedKeys: [],
  });
  assertEquals(r.convergeBlocked, true);
  assertEquals(r.ackOnly, true);
});

// FAIL-CLOSED regression (thread 2): an unresolved ack thread with NO outstanding advisory must NOT
// finalize the gate — dropping it entirely (the old `!isAckThread` filter) let the process converge
// with a genuinely-open GitHub thread. It now BLOCKS, classified ack-only (recoverable).
test("converge gate: a lone unresolved ack thread (no advisory) BLOCKS, ack-only (no fail-open finalize)", () => {
  const threads: ReviewThread[] = [
    { isResolved: false, path: "a.ts", bodies: ["Applied. nano-ack: app/x.ts :: Guard the empty input."] },
  ];
  const unresolved = threads.filter((t) => !t.isResolved);
  const unresolvedAckThreadCount = unresolved.filter((t) => isAckThread(t)).length;
  const unresolvedThreadCount = unresolved.length - unresolvedAckThreadCount;
  assertEquals(unresolvedThreadCount, 0);
  assertEquals(unresolvedAckThreadCount, 1);
  const r = evaluateConvergeGate({
    unresolvedThreadCount,
    unresolvedAckThreadCount,
    suppressedAdvisories: [],
    acknowledgedKeys: [],
  });
  assertEquals(r.convergeBlocked, true);
  assertEquals(r.ackOnly, true);
  assertStringIncludes(r.convergeBlockReason, "unresolved acknowledgement thread");
});

// A genuine reviewer thread left open still blocks off the ack-only path (fail-closed intact).
test("converge gate: a substantive unresolved thread still counts (not ack-only)", () => {
  const threads: ReviewThread[] = [
    { isResolved: false, path: "a.ts", bodies: ["This can NPE on empty input."] },
    { isResolved: false, path: "b.ts", bodies: ["Applied. nano-ack: app/x.ts :: Guard the empty input."] },
  ];
  const unresolved = threads.filter((t) => !t.isResolved);
  const unresolvedAckThreadCount = unresolved.filter((t) => isAckThread(t)).length;
  const unresolvedThreadCount = unresolved.length - unresolvedAckThreadCount;
  assertEquals(unresolvedThreadCount, 1);
  assertEquals(unresolvedAckThreadCount, 1);
  const r = evaluateConvergeGate({
    unresolvedThreadCount,
    unresolvedAckThreadCount,
    suppressedAdvisories: [{ key: "app/x.ts#deadbeef", label: "app/x.ts:12" }],
    acknowledgedKeys: [],
  });
  assertEquals(r.convergeBlocked, true);
  assertEquals(r.ackOnly, false);
});

test("parseAckedAdvisories: only RESOLVED threads carrying a nano-ack marker count", () => {
  const threads: ReviewThread[] = [
    {
      isResolved: true,
      path: "a.ts",
      bodies: ["Fixed. nano-ack: spec-app/nano-app.schema.json :: Clarify the loopback default."],
    },
    { isResolved: false, path: "b.ts", bodies: ["nano-ack: server/src/main.rs :: Narrow this type."] }, // open -> ignored
    { isResolved: true, path: "c.ts", bodies: ["unrelated resolved comment"] },
  ];
  const acked = parseAckedAdvisories(threads);
  assertEquals(acked, [advisoryStableKey("spec-app/nano-app.schema.json", "Clarify the loopback default.")]);
});

// A resolved bare `<path>:<line>` ack (the retired legacy form) must NOT count: it carries no
// advisory prose, so it cannot identify WHICH advisory it acknowledged. Honouring it would false-OPEN
// a genuinely new advisory re-emitted at that same line (issue #787's re-review finding).
test("parseAckedAdvisories: a bare legacy `<path>:<line>` marker is NOT honoured (no prose-blind ack)", () => {
  const threads: ReviewThread[] = [
    { isResolved: true, path: "a.ts", bodies: ["Fixed. nano-ack: spec-app/nano-app.schema.json:613"] },
  ];
  assertEquals(parseAckedAdvisories(threads), []);
});

test("parseAckedAdvisories: the new `<path> :: <text>` form yields the line-stable key", () => {
  const threads: ReviewThread[] = [
    { isResolved: true, path: "a.ts", bodies: ["Declined. nano-ack: server/src/main.rs :: Consider narrowing this type."] },
  ];
  const acked = parseAckedAdvisories(threads);
  assertEquals(acked, [advisoryStableKey("server/src/main.rs", "Consider narrowing this type.")]);
});

// A valid GitHub path can contain spaces; the ack form must not reject it (regression for the
// critical review finding — `\S+`/`[^\s]` path groups silently dropped a spaced-path ack, so the
// gate could never observe the acknowledgement and escalated forever).
test("parseAckedAdvisories: a path containing spaces is honoured in the new `<path> :: <text>` form", () => {
  const newForm: ReviewThread[] = [
    { isResolved: true, path: "d.md", bodies: ["Applied. nano-ack: docs/my file.md :: Clarify the loopback default."] },
  ];
  assertEquals(parseAckedAdvisories(newForm), [advisoryStableKey("docs/my file.md", "Clarify the loopback default.")]);
});

// A valid GitHub path can itself contain `::` (e.g. `src/a::b.ts`); the ` :: ` separator must be
// whitespace-delimited so a bare `::` inside the path is not mistaken for the delimiter (regression
// for the suppressed finding: `\s*::\s*` split `src/a::b.ts :: text` at the wrong `::`, mangling the
// path and producing a key that could never match the advisory).
// The `<path> :: <text>` separator is whitespace-delimited, so a path containing a bare `::` is not
// split at the interior `::` (a legacy `<path>:<line>` interior-colon test was retired with the
// prose-blind legacy form).
test("parseAckedAdvisories: a path containing `::` is not split at the interior `::`", () => {
  const threads: ReviewThread[] = [
    { isResolved: true, path: "a.ts", bodies: ["Applied. nano-ack: src/a::b.ts :: Narrow the return type here."] },
  ];
  assertEquals(parseAckedAdvisories(threads), [advisoryStableKey("src/a::b.ts", "Narrow the return type here.")]);
});

// Normalization must preserve word boundaries, punctuation, and Unicode so distinct advisories on
// one path do not alias to the same key (regression for the suppressed findings: deleting every
// separator made `foo-bar`/`foobar` collide and non-ASCII-only prose normalized to an empty key;
// collapsing punctuation-into-space aliased `Use foo() here` with `Use foo here` — a false-OPEN).
test("advisoryStableKey: word boundaries, punctuation and Unicode are preserved (distinct prose -> distinct keys)", () => {
  const p = "app/x.ts";
  assertNotEquals(advisoryStableKey(p, "foo-bar"), advisoryStableKey(p, "foobar"));
  // Two different non-ASCII-only advisories must not both collapse to the empty-string key.
  assertNotEquals(advisoryStableKey(p, "café"), advisoryStableKey(p, "naïve"));
  // Punctuation must NOT collapse into whitespace: prose differing only by punctuation-vs-space
  // stays distinct, so a resolved ack for one cannot silently acknowledge the other (false-OPEN).
  assertNotEquals(advisoryStableKey(p, "Use foo() here"), advisoryStableKey(p, "Use foo here"));
  assertNotEquals(advisoryStableKey(p, "foo/bar"), advisoryStableKey(p, "foo bar"));
  // Only case and whitespace runs are normalized (verbatim copy modulo reflow -> same key).
  assertEquals(advisoryStableKey(p, "Foo  bar,   baz."), advisoryStableKey(p, "foo bar, baz."));
  // NFC (not NFKC): compatibility variants must stay DISTINCT, or acking one false-OPENs the other.
  // Full-width `！` vs ASCII `!` (NFKC would fold them together); ligature `ﬁ` vs `fi`.
  assertNotEquals(advisoryStableKey(p, "Use foo\uFF01"), advisoryStableKey(p, "Use foo!"));
  assertNotEquals(advisoryStableKey(p, "The \uFB01le"), advisoryStableKey(p, "The file"));
  // A precomposed vs decomposed accent IS canonically equivalent (NFC unifies) -> same key.
  assertEquals(advisoryStableKey(p, "caf\u00E9"), advisoryStableKey(p, "cafe\u0301"));
});

// The advisory side strips a leading markdown bullet (Copilot renders suppressed prose as `* …`),
// and the prompt tells the agent to copy that first line VERBATIM — so an ack marker legitimately
// carries the `* ` bullet. Keying must therefore be bullet-insensitive on BOTH sides, else the ack
// key never matches the advisory key and the gate livelocks (fail-CLOSED). Regression for the
// suppressed finding that `parseSuppressedAdvisories` stripped the bullet but the ack path did not.
test("advisoryStableKey: a leading markdown bullet is stripped so bulleted ack text matches", () => {
  const p = "app/x.ts";
  assertEquals(advisoryStableKey(p, "* Consider narrowing this type."), advisoryStableKey(p, "Consider narrowing this type."));
  assertEquals(advisoryStableKey(p, "- Consider narrowing this type."), advisoryStableKey(p, "Consider narrowing this type."));
  // But a leading `-`/`*` with NO trailing whitespace is NOT a bullet: it is preserved, so distinct
  // first-line prose keeps a distinct key (else `-foo` false-acks `foo`). Regression for the finding
  // that the greedy `[-*]\s*` stripped a non-bullet leading punctuation char.
  assertNotEquals(advisoryStableKey(p, "-foo"), advisoryStableKey(p, "foo"));
  assertNotEquals(advisoryStableKey(p, "*foo"), advisoryStableKey(p, "foo"));
});

// End-to-end: an ack whose marker copies Copilot's bulleted first line verbatim acknowledges the
// advisory parsed from that same rendered bullet (the ack key == the parsed advisory key).
test("parseAckedAdvisories: an ack copying the rendered `* ` bullet verbatim matches the advisory key", () => {
  const advisories = parseSuppressedAdvisories(SAMPLE_REVIEW_BODY);
  const bulleted = advisories.map((a) => a.label); // ["…schema.json:613", "…main.rs:42"]
  assert(bulleted.length === 2);
  const threads: ReviewThread[] = [
    {
      isResolved: true,
      path: "a.ts",
      // Verbatim copy of Copilot's rendered first line, bullet included.
      bodies: ["Declined. nano-ack: server/src/main.rs :: - Consider narrowing this type."],
    },
  ];
  const acked = parseAckedAdvisories(threads);
  const mainRs = advisories.find((a) => a.path === "server/src/main.rs");
  assert(mainRs !== undefined);
  assert(acked.includes(mainRs.key), "bulleted verbatim ack resolves to the advisory's stable key");
});

// A collision in the advisory fingerprint would let a NEWER, unacknowledged advisory on the same
// path pass the gate on a resolved ack for a DIFFERENT advisory — a false-OPEN. The former 32-bit
// FNV-1a digest was cheaply collidable; the key now carries a 128-bit (32-hex) SHA-256 slice.
test("advisoryStableKey: digest is a collision-resistant 128-bit (32-hex) SHA-256 slice", () => {
  const p = "app/x.ts";
  const hash = advisoryStableKey(p, "Some advisory prose.").split("#")[1];
  assertEquals(hash.length, 32, "digest is 32 hex chars (128 bits)");
  assert(/^[0-9a-f]{32}$/.test(hash), "digest is lowercase hex");
  // Distinct prose on the same path yields distinct keys (no cheap collision surface).
  assertNotEquals(
    advisoryStableKey(p, "Narrow this return type."),
    advisoryStableKey(p, "Guard against a null argument here."),
  );
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

// The COMMIT-ID-carrying picker (`pickLatestCopilotReview`) is the ONLY production path that carries
// GitHub's `commit_id` into the stale-review guard (#799); the worker tests inject `{ commitId }`
// directly, so without these the picker's commit_id selection could regress (disabling stale
// detection) while every other test stays green. These lock: the NEWEST Copilot review's commit_id
// (and body) is returned; a no-Copilot-review read is verified `{ body: "", commitId: null }`; a
// truncated read fails closed to `null`.
test("pickLatestCopilotReview: returns the NEWEST Copilot review's body AND commit_id (oldest\u2192newest)", () => {
  const picked = pickLatestCopilotReview(
    [
      { user: { login: "human" }, body: "human review", commit_id: "humansha" },
      { user: { login: "Copilot" }, body: "old copilot review", commit_id: "oldsha" },
      { user: { login: "Copilot" }, body: "newest copilot review", commit_id: "newsha" },
    ],
    false,
  );
  assertEquals(picked, { body: "newest copilot review", commitId: "newsha" });
});

test('pickLatestCopilotReview: a complete read with NO Copilot review is verified { body: "", commitId: null }', () => {
  assertEquals(pickLatestCopilotReview([{ user: { login: "human" }, body: "hi", commit_id: "x" }], false), {
    body: "",
    commitId: null,
  });
  assertEquals(pickLatestCopilotReview([], false), { body: "", commitId: null });
});

test("pickLatestCopilotReview: a Copilot review missing commit_id yields commitId null (not stale)", () => {
  // A review with no commit_id must not fabricate a stale verdict: `isReviewStale` fails safe on a
  // null review commit_id, and this picker must surface that null rather than an empty string.
  assertEquals(pickLatestCopilotReview([{ user: { login: "Copilot" }, body: "b" }], false), {
    body: "b",
    commitId: null,
  });
});

test("pickLatestCopilotReview: FAILS CLOSED (null) when the reviews read was TRUNCATED", () => {
  assertEquals(pickLatestCopilotReview([{ user: { login: "Copilot" }, body: "possibly stale", commit_id: "s" }], true), null);
});

async function makeUnderTest(deps: {
  readThreads: (repo: string, n: number) => Promise<ReviewThread[] | null>;
  readReviewBody: (repo: string, n: number) => Promise<string | null>;
  // The commit SHA the latest Copilot review was submitted against, and the PR's current HEAD SHA
  // (issue #799). Absent ⇒ both null ⇒ never stale (the pre-#799 behaviour every existing test
  // relies on). A stale-review test supplies a `reviewCommitId` that differs from `headSha`.
  reviewCommitId?: string | null;
  headSha?: string | null;
}) {
  const { makeHandler } = await import("../workers/converge-gate/worker.ts");
  return makeHandler({
    readThreads: deps.readThreads,
    readReview: async (repo, n) => {
      const body = await deps.readReviewBody(repo, n);
      return body === null ? null : { body, commitId: deps.reviewCommitId ?? null };
    },
    readHeadSha: async () => deps.headSha ?? null,
  });
}

test("converge-gate: a clean PR is allowed to converge", async () => {
  const handler = await makeUnderTest({
    readThreads: async () => [{ isResolved: true, path: "a.ts", bodies: ["ok"] }],
    readReviewBody: async () => "## Overview\nNo suppressed block.",
  });
  const out = await handler({ variables: { prKey: "o/r#1", repo: "o/r", prNumber: 1 } } as any, {} as any);
  assertEquals(out, { convergeBlocked: false, convergeBlockReason: "", convergeAckOnly: false, reviewStale: false });
});

test("converge-gate: an unresolved thread blocks convergence", async () => {
  const handler = await makeUnderTest({
    readThreads: async () => [{ isResolved: false, path: "a.ts", bodies: ["please fix"] }],
    readReviewBody: async () => "",
  });
  const out = await handler({ variables: { prKey: "o/r#1", repo: "o/r", prNumber: 1 } } as any, {} as any);
  assertEquals(out.convergeBlocked, true);
  assertStringIncludes(out.convergeBlockReason ?? "", "unresolved review thread");
  assertEquals(out.convergeAckOnly, false);
});

test("converge-gate: an unacknowledged suppressed advisory blocks convergence", async () => {
  const handler = await makeUnderTest({
    readThreads: async () => [],
    readReviewBody: async () => SAMPLE_REVIEW_BODY,
  });
  const out = await handler({ variables: { prKey: "o/r#1", repo: "o/r", prNumber: 1 } } as any, {} as any);
  assertEquals(out.convergeBlocked, true);
  assertStringIncludes(out.convergeBlockReason ?? "", "spec-app/nano-app.schema.json:613");
  // Blocked SOLELY on unacked advisories → ack-only, so the loop auto-acks before a human (#796).
  assertEquals(out.convergeAckOnly, true);
});

test("converge-gate: an acknowledged advisory (resolved ack thread) is allowed", async () => {
  const handler = await makeUnderTest({
    readThreads: async () => [
      {
        isResolved: true,
        path: "spec-app/nano-app.schema.json",
        bodies: [
          "Applied. nano-ack: spec-app/nano-app.schema.json :: The description could be clearer about the loopback default.",
        ],
      },
      {
        isResolved: true,
        path: "server/src/main.rs",
        bodies: ["Declined, false positive. nano-ack: server/src/main.rs :: Consider narrowing this type."],
      },
    ],
    readReviewBody: async () => SAMPLE_REVIEW_BODY,
  });
  const out = await handler({ variables: { prKey: "o/r#1", repo: "o/r", prNumber: 1 } } as any, {} as any);
  assertEquals(out, { convergeBlocked: false, convergeBlockReason: "", convergeAckOnly: false, reviewStale: false });
});

// WIRING regression guard (through makeHandler, not a local re-implementation of the filter): an
// UNRESOLVED ack thread is classified separately (ack-only), so a block whose only substantive cause
// is unacked advisories stays ack-only. If the worker regressed to counting an unresolved ack thread
// as a SUBSTANTIVE thread, convergeAckOnly would flip to false and this handler-level test would fail.
test("converge-gate: an unresolved ack thread is classified ack-only, not substantive (through the handler)", async () => {
  const handler = await makeUnderTest({
    readThreads: async () => [
      // A partially-completed acknowledgement (posted, not yet resolved) — its root carries the
      // canonical marker, so isAckThread classifies it as an (unresolved) ack thread, not substantive.
      {
        isResolved: false,
        path: "spec-app/nano-app.schema.json",
        bodies: [
          "Applied. nano-ack: spec-app/nano-app.schema.json :: The description could be clearer about the loopback default.",
        ],
      },
    ],
    readReviewBody: async () => SAMPLE_REVIEW_BODY,
  });
  const out = await handler({ variables: { prKey: "o/r#1", repo: "o/r", prNumber: 1 } } as any, {} as any);
  assertEquals(out.convergeBlocked, true);
  // No SUBSTANTIVE unresolved thread was counted → the block is ack-only (recoverable).
  assertEquals(out.convergeAckOnly, true);
  assertStringIncludes(out.convergeBlockReason ?? "", "unacknowledged suppressed");
});

// FAIL-CLOSED wiring guard (thread 2, through the handler): a lone UNRESOLVED ack thread with NO
// outstanding advisory must NOT let the gate finalize. The old `!isAckThread` filter dropped it
// entirely (unresolvedThreadCount = 0, no advisory) → convergeBlocked = false → the process could
// converge with a genuinely-open GitHub thread. It must now BLOCK (ack-only, recoverable).
test("converge-gate: a lone unresolved ack thread (no advisory) BLOCKS, ack-only — no fail-open finalize (through the handler)", async () => {
  const handler = await makeUnderTest({
    readThreads: async () => [
      {
        isResolved: false,
        path: "spec-app/nano-app.schema.json",
        bodies: [
          "Applied. nano-ack: spec-app/nano-app.schema.json :: The description could be clearer about the loopback default.",
        ],
      },
    ],
    readReviewBody: async () => "## Overview\nNo suppressed block.",
  });
  const out = await handler({ variables: { prKey: "o/r#1", repo: "o/r", prNumber: 1 } } as any, {} as any);
  assertEquals(out.convergeBlocked, true);
  assertEquals(out.convergeAckOnly, true);
  assertStringIncludes(out.convergeBlockReason ?? "", "unresolved acknowledgement thread");
});

test("converge-gate: FAILS CLOSED when the threads read returns null (no transport)", async () => {
  const handler = await makeUnderTest({
    readThreads: async () => null,
    readReviewBody: async () => "",
  });
  const out = await handler({ variables: { prKey: "o/r#1", repo: "o/r", prNumber: 1 } } as any, {} as any);
  assertEquals(out.convergeBlocked, true);
  assertStringIncludes(out.convergeBlockReason ?? "", "could not verify");
  // An unverifiable block is NOT ack-only — it must go to a human, never the auto-ack path (#796).
  assertEquals(out.convergeAckOnly, false);
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
  assertEquals(out, { convergeBlocked: false, convergeBlockReason: "", convergeAckOnly: false, reviewStale: false });
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

// ── Stale-review guard (issue #799) ──────────────────────────────────────────
// FM2: when the PR HEAD has advanced past the commit the latest Copilot review was submitted
// against, that review is stale — its suppressed advisories may already be fixed in code. The gate
// must NOT block/escalate on it; it must signal `reviewStale` so the loop re-solicits a fresh
// review of the current HEAD. FM1 (an applied-but-unacked advisory re-escalating forever) is
// structurally cured by this: once the fixing commit lands, the review that still lists the
// advisory is stale, so the gate re-solicits instead of re-blocking.

test("converge-gate #799: a STALE review (commit_id predates HEAD) does not block — signals reviewStale", async () => {
  // The review still lists an unacked suppressed advisory (would block if evaluated), but it was
  // submitted against an OLD commit — the agent has since pushed a fix. The gate must re-solicit,
  // not escalate.
  const handler = await makeUnderTest({
    readThreads: async () => [],
    readReviewBody: async () => SAMPLE_REVIEW_BODY,
    reviewCommitId: "oldsha1111111111111111111111111111111111",
    headSha: "newsha2222222222222222222222222222222222",
  });
  const out = await handler({ variables: { prKey: "o/r#1", repo: "o/r", prNumber: 1 } } as any, {} as any);
  assertEquals(out, { convergeBlocked: false, convergeBlockReason: "", convergeAckOnly: false, reviewStale: true });
});

test("converge-gate #799: a HEAD-CURRENT review still blocks on an unacked advisory (control)", async () => {
  // Same unacked advisory, but the review's commit_id MATCHES HEAD — it is fresh, so the ordinary
  // gate runs and blocks. Proves the stale guard does not swallow a genuine block.
  const handler = await makeUnderTest({
    readThreads: async () => [],
    readReviewBody: async () => SAMPLE_REVIEW_BODY,
    reviewCommitId: "samesha33333333333333333333333333333333",
    headSha: "samesha33333333333333333333333333333333",
  });
  const out = await handler({ variables: { prKey: "o/r#1", repo: "o/r", prNumber: 1 } } as any, {} as any);
  assertEquals(out.convergeBlocked, true);
  assertEquals(out.reviewStale, false);
  assertStringIncludes(out.convergeBlockReason ?? "", "spec-app/nano-app.schema.json:613");
});

test("converge-gate #799: an unknown review commit_id or unreadable HEAD is NOT stale (evaluates normally)", async () => {
  // Fail-safe: without both SHAs we cannot prove staleness, so the gate must fall through to the
  // ordinary evaluation (here: block on the unacked advisory), never fabricate a re-solicit loop.
  const handler = await makeUnderTest({
    readThreads: async () => [],
    readReviewBody: async () => SAMPLE_REVIEW_BODY,
    reviewCommitId: null,
    headSha: "newsha2222222222222222222222222222222222",
  });
  const out = await handler({ variables: { prKey: "o/r#1", repo: "o/r", prNumber: 1 } } as any, {} as any);
  assertEquals(out.convergeBlocked, true);
  assertEquals(out.reviewStale, false);
});

// ── NON-GATING shadow persistence wiring (issue #811, through the handler) ────
// The pure `recordConvergeShadow` path is unit-tested in convergeShadow.test.ts; these guard the
// WORKER wiring the existing handler tests skip (they pass `{}` as the app, so `app?.data` is
// falsy and the shadow branch never runs). They assert the handler (a) passes the real gate
// input/result to a persisting datasource, and (b) leaves the returned verdict unchanged when the
// datasource THROWS — the "a shadow failure never perturbs the gate" guarantee.

function makeShadowApp(onInsert: (row: Record<string, unknown>) => void) {
  return {
    data: {
      table() {
        return {
          async insert(row: Record<string, unknown>) {
            onInsert(row);
          },
        };
      },
    },
  };
}

test("converge-gate #811: the handler persists a shadow row carrying the real gate verdict", async () => {
  const handler = await makeUnderTest({
    readThreads: async () => [{ isResolved: true, path: "a.ts", bodies: ["ok"] }],
    readReviewBody: async () => "## Overview\nNo suppressed block.",
  });
  const rows: Record<string, unknown>[] = [];
  const out = await handler(
    { variables: { prKey: "o/r#1", repo: "o/r", prNumber: 1 } } as any,
    makeShadowApp((r) => rows.push(r)) as any,
  );
  // Verdict unchanged (clean PR converges) …
  assertEquals(out, { convergeBlocked: false, convergeBlockReason: "", convergeAckOnly: false, reviewStale: false });
  // … and exactly one shadow row was written, carrying the gate's own verdict as ground truth.
  assertEquals(rows.length, 1);
  assertEquals(rows[0].pr_key, "o/r#1");
  assertEquals(rows[0].ground_truth, "converged");
});

test("converge-gate #811: a THROWING shadow datasource leaves the gate verdict unchanged", async () => {
  // An unresolved thread blocks; the shadow insert throws. The block verdict must survive intact —
  // the shadow pass is best-effort and can never turn a block into an error or a converge.
  const handler = await makeUnderTest({
    readThreads: async () => [{ isResolved: false, path: "a.ts", bodies: ["please fix"] }],
    readReviewBody: async () => "",
  });
  const throwingApp = {
    data: {
      table() {
        return {
          async insert() {
            throw new Error("datasource unavailable");
          },
        };
      },
    },
  };
  const out = await handler({ variables: { prKey: "o/r#1", repo: "o/r", prNumber: 1 } } as any, throwingApp as any);
  assertEquals(out.convergeBlocked, true);
  assertStringIncludes(out.convergeBlockReason ?? "", "unresolved review thread");
  assertEquals(out.convergeAckOnly, false);
  assertEquals(out.reviewStale, false);
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
  // A block now routes to the bounded auto-ack gateway first (#796), not straight to the human.
  assertStringIncludes(f, 'targetRef="gw-ack-retry"');
  assertStringIncludes(f, "convergeBlocked = true");
});

// ── Bounded agent auto-ack before human escalation (#796) ────────────────────
// A converge-gate block whose SOLE cause is unacked suppressed advisories is recoverable by
// re-dispatching the review-round agent to post the missing acks. gw-ack-retry sends such an
// ack-only block back into review-round (bounded by ackRetryMax), and only a non-ack-only block
// (an unresolved inline thread) or an exhausted budget escalates to the human wait-answer.

test("gw-ack-retry routes an ack-only block (within budget) back into the review-round agent", () => {
  const gw = flat.match(/<bpmn:exclusiveGateway\b[^>]*\bid="gw-ack-retry"[^>]*>/);
  assert(gw, "gw-ack-retry gateway missing");
  assertStringIncludes(gw[0], 'default="f_ackEscalate"');
  const retry = flowElement("f_ackRetry");
  assert(retry, "f_ackRetry flow missing");
  assertStringIncludes(retry, 'sourceRef="gw-ack-retry"');
  // The re-entry rejoins the loop at `capture-head` (the loop head that captures the round-entry
  // head, #786) which then flows straight into `review-round` — so the ack-only block re-dispatches
  // the review-round agent, freshly baselined.
  assertStringIncludes(retry, 'targetRef="capture-head"');
  assertStringIncludes(retry, "convergeAckOnly = true");
  // Bounded: re-dispatch only while the ack-retry budget is not exhausted.
  assert(/ackRetryRound &lt;= ackRetryMax|ackRetryRound <= ackRetryMax/.test(retry), "f_ackRetry must be budget-bounded");
});

test("gw-ack-retry default arm escalates to the human (threads or exhausted budget)", () => {
  const esc = flowElement("f_ackEscalate");
  assert(esc, "f_ackEscalate flow missing");
  assertStringIncludes(esc, 'sourceRef="gw-ack-retry"');
  assertStringIncludes(esc, 'targetRef="persist-escalation-blockedcomments"');
  assert(!/conditionExpression/.test(esc), "the escalate arm is the default — no conditionExpression");
});

test("capture-head accepts the ack-retry re-entry flow", () => {
  const task = flat.match(/<bpmn:serviceTask\b[^>]*\bid="capture-head"[^>]*>.*?<\/bpmn:serviceTask>/);
  assert(task, "capture-head task missing");
  assertStringIncludes(task[0], "<bpmn:incoming>f_ackRetry</bpmn:incoming>");
});

test("check-converge advances the ack-retry counter only on an ack-only block (bounded)", () => {
  const task = flat.match(/<bpmn:serviceTask\b[^>]*\bid="check-converge"[^>]*>.*?<\/bpmn:serviceTask>/);
  assert(task, "check-converge task missing");
  assertStringIncludes(
    task[0],
    "if convergeBlocked = true and convergeAckOnly = true then ackRetryRound + 1 else ackRetryRound",
  );
});

test("PrConvergeGateOut carries the convergeAckOnly signal for the auto-ack router", () => {
  const shape = flat.match(/<nano:shape\b[^>]*\bid="PrConvergeGateOut"[^>]*>.*?<\/nano:shape>/);
  assert(shape, "PrConvergeGateOut envelope missing");
  assertStringIncludes(shape[0], 'name="convergeAckOnly"');
});

test("gw-converge-gate routes a STALE review back to persist-round (re-solicit), not to escalation (#799)", () => {
  const f = flowElement("f_convergeStale");
  assert(f, "f_convergeStale flow missing");
  assertStringIncludes(f, 'sourceRef="gw-converge-gate"');
  // A stale review re-enters the round loop via persist-round → check-progress, which parks
  // waiting_review (the single writer) and the poller re-solicits a fresh review.
  assertStringIncludes(f, 'targetRef="persist-round"');
  assertStringIncludes(f, "reviewStale = true");
  // persist-round must accept the stale re-entry as an incoming.
  const pr = flat.match(/<bpmn:serviceTask\b[^>]*\bid="persist-round"[^>]*>.*?<\/bpmn:serviceTask>/);
  assert(pr, "persist-round task missing");
  assertStringIncludes(pr[0], "<bpmn:incoming>f_convergeStale</bpmn:incoming>");
  // The gate's output envelope must declare reviewStale for the FEEL condition to read it.
  assertStringIncludes(flat, 'id="PrConvergeGateOut"');
  assert(
    /<nano:shape\b[^>]*\bid="PrConvergeGateOut"[^>]*>.*?name="reviewStale".*?<\/nano:shape>/.test(flat),
    "PrConvergeGateOut must declare reviewStale",
  );
});

test("the round cap does NOT escalate a stale-retry round — f_guardMax is gated on reviewStale != true (#799)", () => {
  // A stale review re-enters persist-round → check-progress → gw-guard. On the FINAL configured round
  // the cap would escalate a human instead of soliciting a fresh review — but a stale review is not a
  // failure to converge, it is a review of obsolete code. The round cap must therefore bypass the
  // stale-retry path (the review-wait timeout remains the backstop against an indefinitely stalled
  // re-solicitation).
  const f = flowElement("f_guardMax");
  assert(f, "f_guardMax flow missing");
  assertStringIncludes(f, "maxRounds and reviewStale != true");
});

test("wait-review clears reviewStale when a fresh review lands, so the marker can't leak into a later round (#799)", () => {
  // reviewStale is written ONLY by the converge-gate; once a fresh review arrives it is no longer
  // known-stale, so wait-review resets it to false alongside the round increment. Without this reset
  // a stale marker would persist and disable the round cap for a subsequent addressed round.
  const wr = flat.match(/<bpmn:intermediateCatchEvent\b[^>]*\bid="wait-review"[^>]*>.*?<\/bpmn:intermediateCatchEvent>/);
  assert(wr, "wait-review catch event missing");
  assertStringIncludes(wr[0], '<zeebe:output source="=round + 1" target="round" />');
  assertStringIncludes(wr[0], '<zeebe:output source="=false" target="reviewStale" />');
});

test("record-answer clears reviewStale so a human-resumed round after a review-stall timeout is re-capped (#799)", () => {
  // reviewStale is cleared on the wait-review MESSAGE arm, but the review-wait TIMER arm bypasses it:
  // wait-review-timeout → persist-review-stalled → wait-answer → record-answer → capture-head. A
  // stale-retry round that times out and is resumed by a human therefore re-enters the loop still
  // carrying reviewStale = true, which — via `f_guardMax`'s `reviewStale != true` guard — would keep
  // the round cap disabled for that (and every subsequent) human-directed addressed round. Once a
  // human is answering escalations the automated stale-retry is over, so record-answer must reset the
  // marker; a genuinely-still-stale next review re-sets it at the converge-gate.
  const task = flat.match(/<bpmn:serviceTask\b[^>]*\bid="record-answer"[^>]*>.*?<\/bpmn:serviceTask>/);
  assert(task, "record-answer task missing");
  assertStringIncludes(task[0], '<zeebe:output source="=false" target="reviewStale" />');
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
