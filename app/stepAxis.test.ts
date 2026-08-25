// Unit coverage for the ONE canonical progress step axis (app/stepAxis.ts) — the single source of the
// derived stepper's vocabulary, cell→step mapping, terminal-tier normalization, and the deterministic
// parallel-frontier reduction (ADR 0006 §4b, issue #541 / S7).

import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { STAGE_KEYS } from "./stage.ts";
import {
  CELL_STEP,
  type FrontierBranch,
  INITIAL_STEP,
  reduceFrontier,
  STEP_KEYS,
  stepOrdinal,
  terminalTier,
  TERMINAL_STEP,
} from "./stepAxis.ts";

test("STEP_KEYS is SEEDED from STAGE_KEYS — the axis cannot fork across surfaces", () => {
  assertEquals([...STEP_KEYS], [...STAGE_KEYS]);
  // The two lifecycle bookends are the head/tail of the shared axis.
  assertEquals(INITIAL_STEP, STAGE_KEYS[0]);
  assertEquals(INITIAL_STEP, "Requested");
  assertEquals(TERMINAL_STEP, STAGE_KEYS[STAGE_KEYS.length - 1]);
  assertEquals(TERMINAL_STEP, "Done");
});

test("the explicit cell→step mapping collapses every process cell onto an existing STAGE_KEYS bracket (no new axis entries)", () => {
  // The three executable cells map to their lifecycle bracket; the interstitial wait/human/escalation
  // cells HOLD at the host bracket rather than owning a distinct step.
  assertEquals(CELL_STEP.implement, "Implementing");
  assertEquals(CELL_STEP.converge, "Converging");
  assertEquals(CELL_STEP.merge, "Merging");
  assertEquals(CELL_STEP.wait, "Implementing");
  assertEquals(CELL_STEP.human, "Converging");
  assertEquals(CELL_STEP.escalation, "Converging");
  // Every mapped bracket is a real axis key — v1 adds no stages, so the pipeline renderer is unchanged.
  for (const step of Object.values(CELL_STEP)) {
    assert(STEP_KEYS.includes(step), `cell step "${step}" is not a STAGE_KEYS member`);
  }
});

test("stepOrdinal gives the axis total order the frontier reduction compares advancement by", () => {
  assertEquals(stepOrdinal("Requested"), 0);
  assertEquals(stepOrdinal("Implementing"), 1);
  assertEquals(stepOrdinal("PR open"), 2);
  assertEquals(stepOrdinal("Converging"), 3);
  assertEquals(stepOrdinal("Merging"), 4);
  assertEquals(stepOrdinal("Done"), 5);
});

test("terminalTier reuses the shipped stage_state tiers (converged/merged/done→ok, blocked distinct, failed/skipped/abandoned→failed, active→null)", () => {
  assertEquals(terminalTier("merged"), "ok");
  assertEquals(terminalTier("converged"), "ok");
  assertEquals(terminalTier("done"), "ok");
  assertEquals(terminalTier("blocked"), "blocked");
  assertEquals(terminalTier("failed"), "failed");
  assertEquals(terminalTier("skipped"), "failed");
  assertEquals(terminalTier("abandoned"), "failed");
  assertEquals(terminalTier("running"), null);
  assertEquals(terminalTier("converging"), null);
});

// ── reduceFrontier — the deterministic parallel-frontier rollup (§4b §280-332) ────────────────────

const branch = (nodeId: string, step: FrontierBranch["step"], terminal: string | null = null): FrontierBranch => ({ nodeId, step, terminal });

test("a single branch reduces trivially to itself (the feature + S7 delivery-graph coarse case)", () => {
  assertEquals(reduceFrontier([branch("n0", "Implementing")]), { step: "Implementing", state: null });
  assertEquals(reduceFrontier([branch("n0", "Done", "done")]), { step: "Done", state: "ok" });
  assertEquals(reduceFrontier([branch("n0", "Done", "failed")]), { step: "Done", state: "failed" });
});

test("all-active frontier reduces to the LEAST-ADVANCED active branch (never further than the slowest in-flight branch)", () => {
  const r = reduceFrontier([branch("a", "Merging"), branch("b", "Implementing"), branch("c", "Converging")]);
  assertEquals(r, { step: "Implementing", state: null });
});

test("all-active ties on step break deterministically by stable node id", () => {
  const r = reduceFrontier([branch("z", "Converging"), branch("a", "Converging")]);
  assertEquals(r, { step: "Converging", state: null });
});

test("MIXED with only SUCCESS terminals + active branches reduces to the least-advanced ACTIVE branch (terminal branches are past, not 'still blocked on')", () => {
  const r = reduceFrontier([branch("done1", "Done", "merged"), branch("active1", "Converging"), branch("active2", "Merging")]);
  assertEquals(r, { step: "Converging", state: null });
});

test("MIXED: a NON-SUCCESS terminal (failed) takes precedence over in-flight siblings — the aggregate renders that branch's step + failed state", () => {
  const r = reduceFrontier([branch("active", "Implementing"), branch("bad", "Converging", "failed"), branch("done", "Done", "merged")]);
  assertEquals(r, { step: "Converging", state: "failed" });
});

test("MIXED: a blocked terminal surfaces as the DISTINCT blocked render state (operator-actionable), not masked by an active sibling", () => {
  const r = reduceFrontier([branch("active", "Merging"), branch("stuck", "Implementing", "blocked")]);
  assertEquals(r, { step: "Implementing", state: "blocked" });
});

test("MULTIPLE non-success terminals tie-break by earliest terminal step, then stable node id", () => {
  // Two failed branches at different steps → earliest step wins.
  assertEquals(
    reduceFrontier([branch("a", "Converging", "failed"), branch("b", "Implementing", "blocked"), branch("act", "Merging")]),
    { step: "Implementing", state: "blocked" },
  );
  // Two non-success terminals at the SAME step → stable node id wins (and its own render state).
  assertEquals(
    reduceFrontier([branch("z", "Converging", "failed"), branch("a", "Converging", "blocked")]),
    { step: "Converging", state: "blocked" },
  );
});

test("ALL-TERMINAL, all success → done (the axis tail, ok)", () => {
  const r = reduceFrontier([branch("a", "Converging", "converged"), branch("b", "Merging", "merged")]);
  assertEquals(r, { step: "Done", state: "ok" });
});

test("ALL-TERMINAL with any non-success → earliest non-success terminal step (same tie-break)", () => {
  const r = reduceFrontier([branch("a", "Merging", "merged"), branch("b", "Converging", "failed"), branch("c", "Implementing", "blocked")]);
  assertEquals(r, { step: "Implementing", state: "blocked" });
});

test("reduceFrontier throws on an empty frontier — a unit always has at least its own branch", () => {
  let threw = false;
  try {
    reduceFrontier([]);
  } catch {
    threw = true;
  }
  assert(threw, "expected reduceFrontier([]) to throw");
});
