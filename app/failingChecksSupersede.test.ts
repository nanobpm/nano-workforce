// Derivation-layer guard for the CI-concurrency-cancellation drift class (issue #348).
//
// GitHub's CI concurrency cancels a superseded workflow run while a newer run on the *identical
// head SHA* takes over. Both land in the head's `statusCheckRollup` under the same check name — the
// stale one stamped `CANCELLED`, the live one green. The merge poller's check derivation used to
// count that stale `CANCELLED` as a failing required check, so a PR whose head is actually green
// read as `blocked`, armed `senior:fix-ci`, which honestly pushed nothing and (pre-#348) returned
// `blocked` → a human merge-escalation for a self-healing PR.
//
// The fix collapses the rollup to the NEWEST run per check before classifying, so a superseded
// `CANCELLED` never counts. These are pure unit tests over the exported derivation helpers.

import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { allCheckNames, failingCheckNames, latestRunPerCheck } from "./github.ts";

test("a CANCELLED run superseded by a newer green run on the same head does not count as failing", () => {
  const rollup = [
    // The superseded run: GitHub CI concurrency cancelled it when a newer run started.
    { name: "engine-core", conclusion: "CANCELLED", startedAt: "2024-01-01T00:00:00Z", completedAt: "2024-01-01T00:01:00Z" },
    // The live run on the identical head SHA: green.
    { name: "engine-core", conclusion: "SUCCESS", startedAt: "2024-01-01T00:02:00Z", completedAt: "2024-01-01T00:05:00Z" },
  ];
  assertEquals(failingCheckNames(rollup), [], "the stale CANCELLED must not read as a failing gate");
});

test("every CANCELLED-superseded required check on one head SHA is dropped (the #348 instance)", () => {
  // The exact PR #887 evidence: four required checks each with a superseded CANCELLED + a newer
  // green run on the same head. None must count as failing.
  const names = ["engine-core", "engine-wasm read-model wasm32 type-check", "processos", "server"];
  const rollup = names.flatMap((name) => [
    { name, conclusion: "CANCELLED", startedAt: "2024-01-01T00:00:00Z" },
    { name, conclusion: "SUCCESS", startedAt: "2024-01-01T00:02:00Z" },
  ]);
  assertEquals(failingCheckNames(rollup), [], "no superseded CANCELLED may count as a failing check");
});

test("a genuine failure on the newest run still counts (no false-negative)", () => {
  const rollup = [
    { name: "engine-core", conclusion: "SUCCESS", startedAt: "2024-01-01T00:00:00Z" },
    // Newest run genuinely failed — this must still be reported.
    { name: "engine-core", conclusion: "FAILURE", startedAt: "2024-01-01T00:02:00Z" },
  ];
  assertEquals(failingCheckNames(rollup), ["engine-core"], "a real failure on the newest run must count");
});

test("a lone CANCELLED with no superseding run still counts (nothing green replaced it)", () => {
  const rollup = [{ name: "engine-core", conclusion: "CANCELLED", startedAt: "2024-01-01T00:00:00Z" }];
  assertEquals(failingCheckNames(rollup), ["engine-core"], "an unsuperseded CANCELLED remains a failing gate");
});

test("ties (missing timestamps) prefer the non-CANCELLED run so the real result wins", () => {
  // GitHub sometimes omits run times; a superseded CANCELLED alongside a completed run must not
  // shadow the real conclusion even when neither carries a timestamp.
  const cancelledFirst = [
    { name: "server", conclusion: "CANCELLED" },
    { name: "server", conclusion: "SUCCESS" },
  ];
  const successFirst = [
    { name: "server", conclusion: "SUCCESS" },
    { name: "server", conclusion: "CANCELLED" },
  ];
  assertEquals(failingCheckNames(cancelledFirst), [], "CANCELLED-first tie resolves to the real (green) result");
  assertEquals(failingCheckNames(successFirst), [], "success-first tie keeps the real (green) result");
});

test("latestRunPerCheck keeps exactly one run per check name (newest)", () => {
  const rollup = [
    { name: "a", conclusion: "CANCELLED", startedAt: "2024-01-01T00:00:00Z" },
    { name: "a", conclusion: "SUCCESS", startedAt: "2024-01-01T00:02:00Z" },
    { name: "b", conclusion: "FAILURE", startedAt: "2024-01-01T00:00:00Z" },
  ];
  const latest = latestRunPerCheck(rollup);
  assertEquals(latest.length, 2, "one run per distinct check name");
  const a = latest.find((c) => c.name === "a");
  assert(a && a.conclusion === "SUCCESS", "check `a` resolves to its newest (green) run");
});

test("allCheckNames dedupes superseded reruns to a single name", () => {
  const rollup = [
    { name: "engine-core", conclusion: "CANCELLED", startedAt: "2024-01-01T00:00:00Z" },
    { name: "engine-core", conclusion: "SUCCESS", startedAt: "2024-01-01T00:02:00Z" },
  ];
  assertEquals(allCheckNames(rollup), ["engine-core"], "a superseded rerun must not double-list the check name");
});

test("legacy StatusContext (state + context) supersession is handled by createdAt", () => {
  const rollup = [
    { context: "ci/legacy", state: "ERROR", createdAt: "2024-01-01T00:00:00Z" },
    { context: "ci/legacy", state: "SUCCESS", createdAt: "2024-01-01T00:02:00Z" },
  ];
  assertEquals(failingCheckNames(rollup), [], "a superseded legacy status context is not a failing gate");
});
