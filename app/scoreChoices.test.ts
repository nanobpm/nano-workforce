// Unit tests for the fixed-answer scoring seam (app/scoreChoices.ts): the restricted softmax, the
// ESCALATE escape hatch + thresholds, the deterministic featuriser, and the swappable backend seam.
import { test } from "node:test";
import { assert, assertEquals, assertThrows } from "#test-assert";
import {
  type DecisionBackend,
  type DecisionModel,
  ESCALATE,
  featurize,
  scoreChoices,
  tokenize,
} from "./scoreChoices.ts";

function nearly(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

// A tiny hand-built model: 2 features, 3 labels, so we can reason about the exact logits.
const model: DecisionModel = {
  version: 1,
  name: "test",
  labels: ["billing", "technical", "account"],
  dim: 8,
  ngram: 1,
  weights: [new Array(8).fill(0), new Array(8).fill(0), new Array(8).fill(0)],
  bias: [0, 0, 0],
  threshold: 0.7,
  margin: 0.2,
};

test("featurize is deterministic and L2-normalised", () => {
  const a = featurize("charged twice for subscription", 64, 2);
  const b = featurize("charged twice for subscription", 64, 2);
  assertEquals([...a], [...b]);
  let norm = 0;
  for (const v of a) norm += v * v;
  assert(nearly(Math.sqrt(norm), 1), "unit-normed");
});

test("tokenize lowercases and drops punctuation", () => {
  assertEquals(tokenize("Charged TWICE! (again)"), ["charged", "twice", "again"]);
});

test("scoreChoices returns a restricted-softmax distribution that sums to 1", () => {
  const backend: DecisionBackend = { scoreLogits: (_t, labels) => labels.map((_l, i) => [8.2, 5.5, 4.8][i]) };
  const d = scoreChoices("ticket", backend, { allow: ["billing", "technical", "account"] });
  const sum = d.scores.reduce((a, s) => a + s.p, 0);
  assert(nearly(sum, 1), "sums to 1");
  assertEquals(d.top.label, "billing");
  // 8.2 / 5.5 / 4.8 → ≈ 0.91 / 0.06 / 0.03 (the article's numbers).
  assert(Math.abs(d.top.p - 0.91) < 0.01, `top≈0.91 got ${d.top.p}`);
  assertEquals(d.confident, true);
  assertEquals(d.action, "billing");
});

test("allow restricts the candidate set (softmax normalises over the subset only)", () => {
  const backend: DecisionBackend = {
    scoreLogits: (_t, labels) => labels.map((l) => ({ billing: 8.2, technical: 5.5, account: 4.8 })[l] ?? 0),
  };
  const d = scoreChoices("t", backend, { allow: ["technical", "account"] });
  assertEquals(
    d.scores.map((s) => s.label).sort(),
    ["account", "technical"],
  );
  assert(nearly(d.scores.reduce((a, s) => a + s.p, 0), 1), "subset sums to 1");
});

test("a near-tie escalates instead of forcing a wrong auto-act", () => {
  const backend: DecisionBackend = { scoreLogits: (_t, labels) => labels.map((_l, i) => [0.46, 0.44, 0.1][i]) };
  const d = scoreChoices("t", backend, { allow: ["billing", "technical", "account"], threshold: 0.5, margin: 0.2 });
  assertEquals(d.top.label, "billing");
  assertEquals(d.confident, false);
  assertEquals(d.action, ESCALATE);
});

test("per-call threshold/margin overrides the model defaults", () => {
  const backend: DecisionBackend = { scoreLogits: (_t, labels) => labels.map((_l, i) => [2, 1, 0][i]) };
  const confident = scoreChoices("t", backend, { allow: ["a", "b", "c"], threshold: 0.5, margin: 0.1 });
  assertEquals(confident.confident, true);
  const strict = scoreChoices("t", backend, { allow: ["a", "b", "c"], threshold: 0.95, margin: 0.1 });
  assertEquals(strict.confident, false);
  assertEquals(strict.action, ESCALATE);
});

test("the built-in logistic backend scores every model label when allow is omitted", () => {
  const d = scoreChoices("anything", model);
  assertEquals(d.scores.length, 3);
  assert(nearly(d.scores.reduce((a, s) => a + s.p, 0), 1));
});

test("an unknown allow label is rejected loudly", () => {
  assertThrows(() => scoreChoices("t", model, { allow: ["nope"] }), Error, "not in model");
});

test("a raw backend with no allow set throws (no candidate labels)", () => {
  const backend: DecisionBackend = { scoreLogits: () => [] };
  assertThrows(() => scoreChoices("t", backend), Error, "no candidate labels");
});
