// Contract for the per-repo merge protocol (#43): the descriptor parser must be total (any
// malformed/partial input degrades to DEFAULT_MERGE_PROTOCOL, never throws), the AGENTS.md block
// extractor must find the fenced ```merge-protocol JSON, and the fresh-head-run decision must fire
// exactly once per landing attempt — only in the frugal-CI stuck state (no head run + waiting) —
// so a converged PR is nudged into a fresh CI run without disturbing a run already in flight.
// Run with `node --test`.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import {
  DEFAULT_MERGE_PROTOCOL,
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
