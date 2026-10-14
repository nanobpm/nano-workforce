// Unit tests for the tier-3a trainer (app/decisionTrain.ts): it learns a separable decision, is
// byte-for-byte deterministic (the "no flaky tests" invariant for a shipped model artifact), and its
// evaluate() reports the coverage / covered-accuracy calibration numbers that decide tier promotion.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { evaluate, type Sample, trainDecisionModel } from "./decisionTrain.ts";
import { scoreChoices } from "./scoreChoices.ts";

// A small but linearly-separable "round status" toy set: distinct vocabulary per class.
const samples: Sample[] = [
  { text: "reviewer approved, all comments resolved, clean lgtm", label: "converged" },
  { text: "approved with no further changes, everything looks good", label: "converged" },
  { text: "lgtm approved ship it, nothing actionable remains", label: "converged" },
  { text: "all threads resolved and approved by the reviewer", label: "converged" },
  { text: "pushed a fix addressing the review comments", label: "addressed" },
  { text: "updated the code and pushed changes for the feedback", label: "addressed" },
  { text: "addressed the comment, committed and pushed the fix", label: "addressed" },
  { text: "made the requested changes and pushed a new commit", label: "addressed" },
  { text: "merge conflict and failing checks block progress", label: "blocked" },
  { text: "cannot proceed, tests failing and conflict on main", label: "blocked" },
  { text: "blocked by a failing pipeline and unresolved conflict", label: "blocked" },
  { text: "checks are red, blocked until the conflict is resolved", label: "blocked" },
];

test("trainDecisionModel learns a separable decision", () => {
  const model = trainDecisionModel(samples, { name: "round-status", epochs: 400 });
  assertEquals(model.labels, ["addressed", "blocked", "converged"]);
  const report = evaluate(model, samples);
  assert(report.accuracy >= 0.9, `training accuracy ${report.accuracy}`);
  // A held-out-style phrase using class vocabulary should land on the right class.
  const d = scoreChoices("reviewer approved and all threads resolved", model);
  assertEquals(d.top.label, "converged");
});

test("training is deterministic (identical weights across runs)", () => {
  const a = trainDecisionModel(samples, { name: "x", epochs: 120 });
  const b = trainDecisionModel(samples, { name: "x", epochs: 120 });
  assertEquals(JSON.stringify(a), JSON.stringify(b));
});

test("evaluate reports coverage and covered accuracy", () => {
  const model = trainDecisionModel(samples, { name: "x", epochs: 400 });
  const report = evaluate(model, samples);
  assert(report.coverage > 0, "some samples cleared the confidence bar");
  assert(report.coveredAccuracy >= report.accuracy - 1e-9, "covered accuracy ≥ overall (confidence helps)");
  // Confusion rows sum to the per-label sample counts.
  const converged = report.confusion.converged;
  const rowSum = Object.values(converged).reduce((s, v) => s + v, 0);
  assertEquals(rowSum, 4);
});

test("a restricted (allow) score can force a two-way choice on the trained model", () => {
  const model = trainDecisionModel(samples, { name: "x", epochs: 400 });
  const d = scoreChoices("pushed a commit that resolves the failing checks", model, {
    allow: ["addressed", "blocked"],
  });
  assertEquals(
    d.scores.map((s) => s.label).sort(),
    ["addressed", "blocked"],
  );
  assert(Math.abs(d.scores.reduce((a, s) => a + s.p, 0) - 1) < 1e-9);
});
