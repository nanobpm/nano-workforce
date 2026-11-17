// Contract for the per-repo merge protocol (#43): the descriptor parser must be total (any
// malformed/partial input degrades to DEFAULT_MERGE_PROTOCOL, never throws), the AGENTS.md block
// extractor must find the fenced ```merge-protocol JSON, and the fresh-head-run decision must fire
// exactly once per landing attempt — only in the frugal-CI stuck state (no head run + waiting) —
// so a converged PR is nudged into a fresh CI run without disturbing a run already in flight.
// Run with `node --test`.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import {
  classifyMergeLanding,
  DEFAULT_MERGE_PROTOCOL,
  type DraftPromotionState,
  draftPromotionReady,
  extractProtocolBlock,
  freshHeadRunAction,
  headRunPresenceCount,
  type MergeProtocol,
  parseMergeProtocol,
  presentRequiredCheckCount,
} from "./mergeProtocol.ts";

test("parseMergeProtocol: non-object / junk → defaults (total, never throws)", () => {
  assertEquals(parseMergeProtocol(undefined), { ...DEFAULT_MERGE_PROTOCOL });
  assertEquals(parseMergeProtocol(null), { ...DEFAULT_MERGE_PROTOCOL });
  assertEquals(parseMergeProtocol("nope"), { ...DEFAULT_MERGE_PROTOCOL });
  assertEquals(parseMergeProtocol([1, 2]), { ...DEFAULT_MERGE_PROTOCOL });
});

test("parseMergeProtocol: full nano-bpm-style descriptor", () => {
  const got = parseMergeProtocol({
    autoMerge: false,
    freshHeadRun: "ready-or-reopen",
    waitForChecks: true,
    land: { method: "mergify-queue", comment: "@mergifyio queue" },
    requiredChecks: [
      { name: "rustfmt (pinned nightly)", acceptedConclusions: ["success"] },
      { name: "processos (clippy + test)", acceptedConclusions: ["success", "skipped"] },
    ],
    doc: "AGENTS.md#merging-prs",
  });
  assertEquals(got.autoMerge, false);
  assertEquals(got.freshHeadRun, "ready-or-reopen");
  assertEquals(got.waitForChecks, true);
  assertEquals(got.land, { method: "mergify-queue", comment: "@mergifyio queue" });
  assertEquals(got.requiredChecks.length, 2);
  assertEquals(got.requiredChecks[0], { name: "rustfmt (pinned nightly)", acceptedConclusions: ["success"] });
  assertEquals(got.requiredChecks[1].acceptedConclusions, ["success", "skipped"]);
  assertEquals(got.doc, "AGENTS.md#merging-prs");
});

test("parseMergeProtocol: requiredChecks tolerates bare-string entries + drops nameless/junk", () => {
  const got = parseMergeProtocol({
    requiredChecks: [
      "server (clippy + test)", // bare name → default acceptedConclusions ["success"]
      { name: "engine-core (clippy + test)" }, // object, no acceptedConclusions → default
      { name: "", acceptedConclusions: ["success"] }, // empty name → dropped
      { acceptedConclusions: ["success"] }, // no name → dropped
      42, // junk → dropped
    ],
  });
  assertEquals(got.requiredChecks, [
    { name: "server (clippy + test)", acceptedConclusions: ["success"] },
    { name: "engine-core (clippy + test)", acceptedConclusions: ["success"] },
  ]);
});

test("parseMergeProtocol: invalid enums / wrong types fall back per-field", () => {
  const got = parseMergeProtocol({
    autoMerge: "yes", // not a boolean → default
    freshHeadRun: "sometimes", // not in the enum → default (none)
    land: { method: "teleport" }, // not in the enum → default (gh-merge)
    requiredChecks: ["ok", 7, null], // keep only usable names
  });
  assertEquals(got.autoMerge, DEFAULT_MERGE_PROTOCOL.autoMerge);
  assertEquals(got.freshHeadRun, "none");
  assertEquals(got.land.method, "gh-merge");
  assertEquals(got.requiredChecks, [{ name: "ok", acceptedConclusions: ["success"] }]);
});

test("parseMergeProtocol: comment dropped when absent", () => {
  const got = parseMergeProtocol({ land: { method: "admin" } });
  assertEquals(got.land, { method: "admin" });
});

test("extractProtocolBlock: finds the fenced merge-protocol JSON (with info word)", () => {
  const md = [
    "## Merging PRs",
    "Some prose about how to merge.",
    "",
    "```merge-protocol json",
    '{ "autoMerge": false, "land": { "method": "mergify-queue" } }',
    "```",
    "",
    "More prose.",
  ].join("\n");
  const block = extractProtocolBlock(md);
  assertEquals(block !== null, true);
  const p = parseMergeProtocol(JSON.parse(block ?? "{}"));
  assertEquals(p.autoMerge, false);
  assertEquals(p.land.method, "mergify-queue");
});

test("extractProtocolBlock: none present → null", () => {
  assertEquals(extractProtocolBlock("# Doc\n```json\n{}\n```\n"), null);
});

const NANO: MergeProtocol = parseMergeProtocol({
  freshHeadRun: "ready-or-reopen",
  land: { method: "mergify-queue" },
});

test("freshHeadRunAction: fires in the frugal-CI stuck state (no run + waiting)", () => {
  // ready PR, no head run at all → reopen (ready-or-reopen, not a draft)
  assertEquals(freshHeadRunAction(NANO, "waiting", 0, false), "reopen");
  // draft PR, no head run → mark ready
  assertEquals(freshHeadRunAction(NANO, "waiting", 0, true), "ready");
});

test("freshHeadRunAction: a 'draft' verdict self-heals like waiting (issue #454)", () => {
  // The merge poller now classifies a draft PR as the distinct "draft" verdict (not "waiting"),
  // so guard that the fresh-head-run self-heal accepts it directly. A draft is always isDraft=true.
  assertEquals(freshHeadRunAction(NANO, "draft", 0, true), "ready"); // no run yet → mark ready (un-drafts + runs)
  assertEquals(freshHeadRunAction(NANO, "draft", 1, true), null); // required run already present → wait
  assertEquals(freshHeadRunAction(NANO, "draft", -1, true), null); // token mode (unknown) → conservative
  // fires once per landing-attempt head, then not again until the head changes (post-rebase)
  assertEquals(
    freshHeadRunAction(NANO, "draft", 0, true, { headRefOid: "h1", lastActionHeadRefOid: null }),
    "ready",
  );
  assertEquals(
    freshHeadRunAction(NANO, "draft", 0, true, { headRefOid: "h1", lastActionHeadRefOid: "h1" }),
    null,
  );
  // reopen-only protocol: a draft yields NULL, not "reopen". Reopening (close+reopen) does NOT
  // un-draft a PR, so a "reopen" self-heal can never resolve the draft-merge failure — it only
  // emits noisy close/reopen events and delays the actionable escalation by a round (issue #454).
  // With no mark-ready capability there is no valid draft self-heal, so escalate immediately.
  const reopenOnly = parseMergeProtocol({ freshHeadRun: "reopen", land: { method: "gh-merge" } });
  assertEquals(freshHeadRunAction(reopenOnly, "draft", 0, true), null);
  // none protocol → no self-heal for a draft either
  assertEquals(freshHeadRunAction(DEFAULT_MERGE_PROTOCOL, "draft", 0, true), null);
});

test("freshHeadRunAction: fires once per landing-attempt head, then re-fires after rebase", () => {
  assertEquals(
    freshHeadRunAction(NANO, "waiting", 0, false, { headRefOid: "h1", lastActionHeadRefOid: null }),
    "reopen",
  );
  assertEquals(
    freshHeadRunAction(NANO, "waiting", 0, false, { headRefOid: "h1", lastActionHeadRefOid: "h1" }),
    null,
  );
  assertEquals(
    freshHeadRunAction(NANO, "waiting", 0, false, { headRefOid: "h2", lastActionHeadRefOid: "h1" }),
    "reopen",
  );
});

test("freshHeadRunAction: never fires once a run exists, or when not waiting", () => {
  assertEquals(freshHeadRunAction(NANO, "waiting", 1, false), null); // run already in flight
  assertEquals(freshHeadRunAction(NANO, "waiting", -1, false), null); // token mode (unknown) → conservative
  assertEquals(freshHeadRunAction(NANO, "ready", 0, false), null); // already landable
  assertEquals(freshHeadRunAction(NANO, "blocked", 0, false), null); // failed check → fix-ci arm
  assertEquals(freshHeadRunAction(NANO, "blocked", 0, false, { headRefOid: "h2", lastActionHeadRefOid: "h1" }), null);
  assertEquals(freshHeadRunAction(NANO, "conflict", 0, false), null); // conflict → rebase arm (#42)
});

test("freshHeadRunAction: protocol.freshHeadRun=none is a no-op (default repos unchanged)", () => {
  assertEquals(freshHeadRunAction(DEFAULT_MERGE_PROTOCOL, "waiting", 0, false), null);
});

test("freshHeadRunAction: mode=ready only acts on drafts", () => {
  const readyOnly = parseMergeProtocol({ freshHeadRun: "ready", land: { method: "gh-merge" } });
  assertEquals(freshHeadRunAction(readyOnly, "waiting", 0, true), "ready");
  assertEquals(freshHeadRunAction(readyOnly, "waiting", 0, false), null); // not a draft → nothing to ready
});

// The nano-bpm merge protocol: 3 required checks, one skip-tolerant.
const NANO_REQ: MergeProtocol = parseMergeProtocol({
  freshHeadRun: "ready-or-reopen",
  land: { method: "mergify-queue" },
  requiredChecks: [
    { name: "rustfmt (pinned nightly)", acceptedConclusions: ["success"] },
    { name: "server (clippy + test)", acceptedConclusions: ["success"] },
    { name: "processos (clippy + test)", acceptedConclusions: ["success", "skipped"] },
  ],
});

test("presentRequiredCheckCount: counts only declared required checks present on the head", () => {
  // Only an unrelated always-on check (Mergify) is present → zero required checks present.
  assertEquals(presentRequiredCheckCount(NANO_REQ, ["Mergify Merge Queue"]), 0);
  // Two of the three required checks present (plus the incidental Mergify one).
  assertEquals(
    presentRequiredCheckCount(NANO_REQ, ["Mergify Merge Queue", "server (clippy + test)", "rustfmt (pinned nightly)"]),
    2,
  );
  // A repo that declares no required checks → nothing to count.
  assertEquals(presentRequiredCheckCount(DEFAULT_MERGE_PROTOCOL, ["anything"]), 0);
});

test("headRunPresenceCount: required-aware — Mergify's incidental check doesn't mask a missing run", () => {
  // The #727 stuck state: BLOCKED head carries only Mergify's neutral check, none of the 3
  // required checks ran. Raw rollup length is 1, but the required-check presence is 0 → the
  // remedy must see 0 and fire the reopen.
  const st = { totalChecks: 1, presentCheckNames: ["Mergify Merge Queue"] };
  assertEquals(headRunPresenceCount(NANO_REQ, st), 0);
  assertEquals(freshHeadRunAction(NANO_REQ, "waiting", headRunPresenceCount(NANO_REQ, st), false), "reopen");
});

test("headRunPresenceCount: a present required check reads as run-exists (no reopen)", () => {
  const st = { totalChecks: 2, presentCheckNames: ["Mergify Merge Queue", "server (clippy + test)"] };
  assertEquals(headRunPresenceCount(NANO_REQ, st), 1);
  assertEquals(freshHeadRunAction(NANO_REQ, "waiting", headRunPresenceCount(NANO_REQ, st), false), null);
});

test("headRunPresenceCount: no declared required checks → falls back to total rollup length", () => {
  const proto = parseMergeProtocol({ freshHeadRun: "ready-or-reopen", land: { method: "gh-merge" } });
  assertEquals(headRunPresenceCount(proto, { totalChecks: 0, presentCheckNames: [] }), 0);
  assertEquals(headRunPresenceCount(proto, { totalChecks: 3, presentCheckNames: ["a", "b", "c"] }), 3);
});

test("headRunPresenceCount: token mode (totalChecks < 0) stays conservative (-1)", () => {
  assertEquals(headRunPresenceCount(NANO_REQ, { totalChecks: -1, presentCheckNames: [] }), -1);
  assertEquals(freshHeadRunAction(NANO_REQ, "waiting", -1, false), null);
});

// The land method is classified against the canonical escalation taxonomy: only a `ui` method is a
// decision-required escalation (a human must click Merge); every machine-landable method is
// transient (the merge stage lands it in-process).
test("classifyMergeLanding: only `ui` is decision-required", () => {
  const withMethod = (method: MergeProtocol["land"]["method"]): MergeProtocol => ({
    ...DEFAULT_MERGE_PROTOCOL,
    land: { method },
  });
  assertEquals(classifyMergeLanding(withMethod("ui")), "decision-required");
  assertEquals(classifyMergeLanding(withMethod("gh-merge")), "transient");
  assertEquals(classifyMergeLanding(withMethod("admin")), "transient");
  assertEquals(classifyMergeLanding(withMethod("mergify-queue")), "transient");
});

// ── draftPromotionReady: promote a *validated* draft, never an unvalidated one (issue #967) ──────
//
// A recovered PR is opened as a DRAFT because the agent never vouched for it — but by the time it
// reaches the merge stage it HAS been vouched for (converged review, green checks). The merge poller
// must mark such a draft ready itself rather than wedging on a human "mark it ready" escalation.
// The predicate is the guard: it returns true ONLY when validation is KNOWN to pass, so an
// unvalidated / unreadable / failing draft still escalates. These are pure unit tests over the
// structural `DraftPromotionState`.

function draftState(over: Partial<DraftPromotionState> = {}): DraftPromotionState {
  return {
    mergeStateStatus: "CLEAN",
    failingChecks: 0,
    presentCheckNames: [],
    pendingCheckNames: [],
    checkGateConclusions: {},
    unresolvedThreads: 0,
    ...over,
  };
}

test("draftPromotionReady: a converged, green, conflict-free draft IS promoted (the #967 recovery case)", () => {
  // No declared required checks, no failing/pending checks, no open threads, no conflict → validated.
  assertEquals(draftPromotionReady(draftState(), DEFAULT_MERGE_PROTOCOL), true);
  assertEquals(draftPromotionReady(draftState(), undefined), true); // no protocol → same validation
});

test("draftPromotionReady: a draft with a failing check is NOT promoted (routes to fix-ci)", () => {
  assertEquals(
    draftPromotionReady(draftState({ failingChecks: 1, presentCheckNames: ["build"], checkGateConclusions: { build: ["FAILURE"] } }), DEFAULT_MERGE_PROTOCOL),
    false,
  );
});

test("draftPromotionReady: a conflicting draft is NOT promoted (routes to the rebase arm)", () => {
  assertEquals(draftPromotionReady(draftState({ mergeStateStatus: "DIRTY" }), DEFAULT_MERGE_PROTOCOL), false);
});

// PR #968 review (finding 1): mergeability must be KNOWN non-conflicting before the draft safeguard
// is stripped. `UNKNOWN` / `null` / `""` mean GitHub is still computing whether the PR conflicts
// (`classifyMergeability` maps them to `"waiting"`, never a validated verdict) — an otherwise green,
// thread-free draft must NOT be promoted on an unread merge state.
test("draftPromotionReady: UNKNOWN / null / empty mergeability is NOT promoted (conflict not yet ruled out)", () => {
  assertEquals(draftPromotionReady(draftState({ mergeStateStatus: "UNKNOWN" }), DEFAULT_MERGE_PROTOCOL), false);
  assertEquals(draftPromotionReady(draftState({ mergeStateStatus: null }), DEFAULT_MERGE_PROTOCOL), false);
  assertEquals(draftPromotionReady(draftState({ mergeStateStatus: "" }), DEFAULT_MERGE_PROTOCOL), false);
});

test("draftPromotionReady: a BLOCKED merge state is NOT promoted when it is NOT the mergify-queue case", () => {
  // A BLOCKED with green checks + zero threads but no Mergify-queue land method is a required gate /
  // human review — NOT validated (PR #968 review round 3's safeguard retained).
  assertEquals(draftPromotionReady(draftState({ mergeStateStatus: "BLOCKED" }), DEFAULT_MERGE_PROTOCOL), false);
});

test("draftPromotionReady: every known-non-conflicting merge state IS promotable when otherwise validated", () => {
  // Mirror `classifyMergeability`'s `ready` arms: CLEAN / HAS_HOOKS / UNSTABLE / BEHIND.
  for (const mergeStateStatus of ["CLEAN", "HAS_HOOKS", "UNSTABLE", "BEHIND"]) {
    assertEquals(draftPromotionReady(draftState({ mergeStateStatus }), DEFAULT_MERGE_PROTOCOL), true);
  }
});

// PR #968 review round 4 (finding 2): `fetchPrState` preserves GitHub's `DRAFT` merge state for a
// draft PR. A `DRAFT` merge state carries no conflict signal of its own — the conflict question is
// answered by the DIRTY/UNKNOWN rejections — so a green, thread-free `DRAFT` draft is the validated
// recovery case (issue #967) and MUST promote; rejecting it wedges the PR on a human (the existing
// fixture in `maybeEnsureFreshHeadRun.test.ts` builds exactly this `DRAFT` state).
test("draftPromotionReady: a DRAFT merge state with green checks and zero threads IS promoted (#968 round 4)", () => {
  assertEquals(draftPromotionReady(draftState({ mergeStateStatus: "DRAFT" }), DEFAULT_MERGE_PROTOCOL), true);
  // … and with declared required checks all satisfied.
  const req: MergeProtocol = { ...DEFAULT_MERGE_PROTOCOL, requiredChecks: [{ name: "build", acceptedConclusions: ["success"] }] };
  assertEquals(
    draftPromotionReady(draftState({ mergeStateStatus: "DRAFT", presentCheckNames: ["build"], checkGateConclusions: { build: ["SUCCESS"] } }), req),
    true,
  );
});

test("draftPromotionReady: a DRAFT merge state still rejects red/pending checks and open threads", () => {
  // DRAFT is promotable only when otherwise validated — the check/thread gates still apply.
  assertEquals(
    draftPromotionReady(draftState({ mergeStateStatus: "DRAFT", failingChecks: 1, presentCheckNames: ["build"], checkGateConclusions: { build: ["FAILURE"] } }), DEFAULT_MERGE_PROTOCOL),
    false,
  );
  assertEquals(
    draftPromotionReady(draftState({ mergeStateStatus: "DRAFT", pendingCheckNames: ["build"], presentCheckNames: ["build"], checkGateConclusions: { build: [""] } }), DEFAULT_MERGE_PROTOCOL),
    false,
  );
  assertEquals(draftPromotionReady(draftState({ mergeStateStatus: "DRAFT", unresolvedThreads: 1 }), DEFAULT_MERGE_PROTOCOL), false);
});

// PR #968 review round 4 (finding 1): a `mergify-queue` repo reports a converged, green draft with
// Mergify's own queue check at NEUTRAL ("not queued yet") and GitHub still reports the merge BLOCKED
// on it. That is the PR awaiting the declared land step (`@mergifyio queue`), not a human review —
// `classifyMergeability` already maps it to `ready` via `awaitingMergifyEnqueue` (issue #951), so the
// draft promotion must too (mirroring the github.test.ts BLOCKED/CLEAN mergify-queue fixtures).
const MERGIFY_LAND: MergeProtocol = {
  ...DEFAULT_MERGE_PROTOCOL,
  land: { method: "mergify-queue", comment: "@mergifyio queue" },
  requiredChecks: [{ name: "build", acceptedConclusions: ["success"] }],
};
const MERGIFY_GATES = { build: ["SUCCESS"], "Mergify Merge Queue": ["NEUTRAL"] };

test("draftPromotionReady: a BLOCKED mergify-queue draft awaiting enqueue IS promoted (#951 / #968 round 4)", () => {
  assertEquals(
    draftPromotionReady(
      draftState({ mergeStateStatus: "BLOCKED", presentCheckNames: ["build", "Mergify Merge Queue"], checkGateConclusions: MERGIFY_GATES }),
      MERGIFY_LAND,
    ),
    true,
  );
});

test("draftPromotionReady: BLOCKED mergify-queue is NOT promoted without the NEUTRAL Mergify queue check", () => {
  // Only the build check — no Mergify NEUTRAL — so the BLOCKED cause is not "awaiting enqueue".
  assertEquals(
    draftPromotionReady(
      draftState({ mergeStateStatus: "BLOCKED", presentCheckNames: ["build"], checkGateConclusions: { build: ["SUCCESS"] } }),
      MERGIFY_LAND,
    ),
    false,
  );
});

test("draftPromotionReady: BLOCKED mergify-queue is NOT promoted when another check is also non-success", () => {
  // A second NEUTRAL (non-Mergify) check means the BLOCKED is not solely the queue wait.
  assertEquals(
    draftPromotionReady(
      draftState({
        mergeStateStatus: "BLOCKED",
        presentCheckNames: ["build", "Mergify Merge Queue", "lint"],
        checkGateConclusions: { ...MERGIFY_GATES, lint: ["NEUTRAL"] },
      }),
      MERGIFY_LAND,
    ),
    false,
  );
});

test("draftPromotionReady: BLOCKED mergify-queue is NOT promoted on a non-mergify-queue land method", () => {
  // Same rollup, but the repo lands via gh-merge — the NEUTRAL Mergify check is then just an
  // unmet gate, not the declared queue land step.
  const ghMerge: MergeProtocol = { ...MERGIFY_LAND, land: { method: "gh-merge" } };
  assertEquals(
    draftPromotionReady(
      draftState({ mergeStateStatus: "BLOCKED", presentCheckNames: ["build", "Mergify Merge Queue"], checkGateConclusions: MERGIFY_GATES }),
      ghMerge,
    ),
    false,
  );
});

test("draftPromotionReady: a draft with a pending check is NOT promoted (still settling)", () => {
  assertEquals(
    draftPromotionReady(draftState({ presentCheckNames: ["build"], pendingCheckNames: ["build"], checkGateConclusions: { build: [""] } }), DEFAULT_MERGE_PROTOCOL),
    false,
  );
});

test("draftPromotionReady: open review threads are NOT promoted (route back into convergence)", () => {
  assertEquals(draftPromotionReady(draftState({ unresolvedThreads: 2 }), DEFAULT_MERGE_PROTOCOL), false);
});

test("draftPromotionReady: an UNKNOWN thread count is NOT promoted (the merge contract is zero threads)", () => {
  // -1 = not probed, -2 = probe failed. Neither may auto-promote a draft over unverified threads.
  assertEquals(draftPromotionReady(draftState({ unresolvedThreads: -1 }), DEFAULT_MERGE_PROTOCOL), false);
  assertEquals(draftPromotionReady(draftState({ unresolvedThreads: -2 }), DEFAULT_MERGE_PROTOCOL), false);
});

test("draftPromotionReady: token mode (checks unenumerable) is NOT promoted (never promote blind)", () => {
  assertEquals(draftPromotionReady(draftState({ failingChecks: -1 }), DEFAULT_MERGE_PROTOCOL), false);
});

test("draftPromotionReady: a declared-required check gates promotion (absent / pending / red all block)", () => {
  const req: MergeProtocol = { ...DEFAULT_MERGE_PROTOCOL, requiredChecks: [{ name: "build", acceptedConclusions: ["success"] }] };
  // Required check green → promote.
  assertEquals(
    draftPromotionReady(draftState({ presentCheckNames: ["build"], checkGateConclusions: { build: ["SUCCESS"] } }), req),
    true,
  );
  // Required check absent from the head → not validated.
  assertEquals(draftPromotionReady(draftState(), req), false);
  // Required check still pending → not validated.
  assertEquals(
    draftPromotionReady(draftState({ presentCheckNames: ["build"], pendingCheckNames: ["build"], checkGateConclusions: { build: [""] } }), req),
    false,
  );
  // Required check settled red → not validated.
  assertEquals(
    draftPromotionReady(draftState({ presentCheckNames: ["build"], failingChecks: 1, checkGateConclusions: { build: ["FAILURE"] } }), req),
    false,
  );
  // Required check whose accepted conclusion is `skipped` (change-gated) accepts a SKIPPED gate.
  const skipOk: MergeProtocol = { ...DEFAULT_MERGE_PROTOCOL, requiredChecks: [{ name: "build", acceptedConclusions: ["success", "skipped"] }] };
  assertEquals(
    draftPromotionReady(draftState({ presentCheckNames: ["build"], checkGateConclusions: { build: ["SKIPPED"] } }), skipOk),
    true,
  );
});
