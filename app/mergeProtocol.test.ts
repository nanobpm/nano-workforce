// Contract for the per-repo merge protocol (#43): the descriptor parser must be total (any
// malformed/partial input degrades to DEFAULT_MERGE_PROTOCOL, never throws), the AGENTS.md block
// extractor must find the fenced ```merge-protocol JSON, and the fresh-head-run decision must fire
// exactly once per landing attempt — only in the frugal-CI stuck state (no head run + waiting) —
// so a converged PR is nudged into a fresh CI run without disturbing a run already in flight.
// Run with `deno test -A`.
import { assertEquals } from "jsr:@std/assert@1";
import {
  DEFAULT_MERGE_PROTOCOL,
  extractProtocolBlock,
  freshHeadRunAction,
  type MergeProtocol,
  parseMergeProtocol,
} from "./mergeProtocol.ts";

Deno.test("parseMergeProtocol: non-object / junk → defaults (total, never throws)", () => {
  assertEquals(parseMergeProtocol(undefined), { ...DEFAULT_MERGE_PROTOCOL });
  assertEquals(parseMergeProtocol(null), { ...DEFAULT_MERGE_PROTOCOL });
  assertEquals(parseMergeProtocol("nope"), { ...DEFAULT_MERGE_PROTOCOL });
  assertEquals(parseMergeProtocol([1, 2]), { ...DEFAULT_MERGE_PROTOCOL });
});

Deno.test("parseMergeProtocol: full nano-bpm-style descriptor", () => {
  const got = parseMergeProtocol({
    autoMerge: false,
    freshHeadRun: "ready-or-reopen",
    waitForChecks: true,
    land: { method: "mergify-queue", comment: "@mergifyio queue" },
    requiredChecks: ["rustfmt (pinned nightly)", "server (clippy + test)"],
    doc: "AGENTS.md#merging-prs",
  });
  assertEquals(got.autoMerge, false);
  assertEquals(got.freshHeadRun, "ready-or-reopen");
  assertEquals(got.waitForChecks, true);
  assertEquals(got.land, { method: "mergify-queue", comment: "@mergifyio queue" });
  assertEquals(got.requiredChecks.length, 2);
  assertEquals(got.doc, "AGENTS.md#merging-prs");
});

Deno.test("parseMergeProtocol: invalid enums / wrong types fall back per-field", () => {
  const got = parseMergeProtocol({
    autoMerge: "yes", // not a boolean → default
    freshHeadRun: "sometimes", // not in the enum → default (none)
    land: { method: "teleport" }, // not in the enum → default (gh-merge)
    requiredChecks: ["ok", 7, null], // keep only strings
  });
  assertEquals(got.autoMerge, DEFAULT_MERGE_PROTOCOL.autoMerge);
  assertEquals(got.freshHeadRun, "none");
  assertEquals(got.land.method, "gh-merge");
  assertEquals(got.requiredChecks, ["ok"]);
});

Deno.test("parseMergeProtocol: comment dropped when absent", () => {
  const got = parseMergeProtocol({ land: { method: "admin" } });
  assertEquals(got.land, { method: "admin" });
});

Deno.test("extractProtocolBlock: finds the fenced merge-protocol JSON (with info word)", () => {
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

Deno.test("extractProtocolBlock: none present → null", () => {
  assertEquals(extractProtocolBlock("# Doc\n```json\n{}\n```\n"), null);
});

const NANO: MergeProtocol = parseMergeProtocol({
  freshHeadRun: "ready-or-reopen",
  land: { method: "mergify-queue" },
});

Deno.test("freshHeadRunAction: fires in the frugal-CI stuck state (no run + waiting)", () => {
  // ready PR, no head run at all → reopen (ready-or-reopen, not a draft)
  assertEquals(freshHeadRunAction(NANO, "waiting", 0, false), "reopen");
  // draft PR, no head run → mark ready
  assertEquals(freshHeadRunAction(NANO, "waiting", 0, true), "ready");
});

Deno.test("freshHeadRunAction: fires once per landing-attempt head, then re-fires after rebase", () => {
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

Deno.test("freshHeadRunAction: never fires once a run exists, or when not waiting", () => {
  assertEquals(freshHeadRunAction(NANO, "waiting", 1, false), null); // run already in flight
  assertEquals(freshHeadRunAction(NANO, "waiting", -1, false), null); // token mode (unknown) → conservative
  assertEquals(freshHeadRunAction(NANO, "ready", 0, false), null); // already landable
  assertEquals(freshHeadRunAction(NANO, "blocked", 0, false), null); // failed check → fix-ci arm
  assertEquals(freshHeadRunAction(NANO, "blocked", 0, false, { headRefOid: "h2", lastActionHeadRefOid: "h1" }), null);
  assertEquals(freshHeadRunAction(NANO, "conflict", 0, false), null); // conflict → rebase arm (#42)
});

Deno.test("freshHeadRunAction: protocol.freshHeadRun=none is a no-op (default repos unchanged)", () => {
  assertEquals(freshHeadRunAction(DEFAULT_MERGE_PROTOCOL, "waiting", 0, false), null);
});

Deno.test("freshHeadRunAction: mode=ready only acts on drafts", () => {
  const readyOnly = parseMergeProtocol({ freshHeadRun: "ready", land: { method: "gh-merge" } });
  assertEquals(freshHeadRunAction(readyOnly, "waiting", 0, true), "ready");
  assertEquals(freshHeadRunAction(readyOnly, "waiting", 0, false), null); // not a draft → nothing to ready
});
