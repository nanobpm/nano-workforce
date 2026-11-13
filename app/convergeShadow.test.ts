// Unit tests for the converge-gate shadow observer (app/convergeShadow.ts, issue #811): the
// ground-truth label derivation, the deterministic feature text, the graceful no-model path, the
// scored path, and the best-effort persist that must NEVER throw into the gate.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { ConvergeGateInput, ConvergeGateResult } from "./convergeGate.ts";
import {
  buildShadowText,
  deriveGateLabel,
  isDecisionModel,
  observeConvergeShadow,
  recordConvergeShadow,
} from "./convergeShadow.ts";
import { trainDecisionModel } from "./decisionTrain.ts";

const cleanInput: ConvergeGateInput = {
  unresolvedThreadCount: 0,
  unresolvedAckThreadCount: 0,
  suppressedAdvisories: [],
  acknowledgedKeys: [],
};
const converged: ConvergeGateResult = { convergeBlocked: false, convergeBlockReason: "", ackOnly: false };
const escalate: ConvergeGateResult = { convergeBlocked: true, convergeBlockReason: "x", ackOnly: false };
const ackRetry: ConvergeGateResult = { convergeBlocked: true, convergeBlockReason: "x", ackOnly: true };

test("deriveGateLabel maps the gate result to a canonical route", () => {
  assertEquals(deriveGateLabel(converged), "converged");
  assertEquals(deriveGateLabel(escalate), "escalate");
  assertEquals(deriveGateLabel(ackRetry), "ack-retry");
});

test("buildShadowText is deterministic and reflects the inputs", () => {
  const input: ConvergeGateInput = {
    unresolvedThreadCount: 2,
    unresolvedAckThreadCount: 1,
    suppressedAdvisories: [
      { key: "a#1", label: "nullcheck" },
      { key: "b#2", label: "typo" },
    ],
    acknowledgedKeys: ["a#1"],
  };
  const a = buildShadowText(input);
  const b = buildShadowText(input);
  assertEquals(a, b);
  assert(a.includes("unresolved-threads 2"), a);
  assert(a.includes("unacked-advisories 1"), a);
  assert(a.includes("typo"), a);
});

test("observeConvergeShadow with no model records only the labelled row (graceful path)", () => {
  const obs = observeConvergeShadow(cleanInput, converged, null);
  assertEquals(obs.groundTruth, "converged");
  assertEquals(obs.shadowAction, undefined);
  assertEquals(obs.agree, undefined);
  assert(obs.features.length > 0);
});

test("observeConvergeShadow with a model scores over the fixed converge routes", () => {
  const model = trainDecisionModel(
    [
      { text: buildShadowText(cleanInput), label: "converged" },
      { text: buildShadowText(cleanInput), label: "converged" },
      {
        text: buildShadowText({ ...cleanInput, unresolvedThreadCount: 3 }),
        label: "escalate",
      },
      {
        text: buildShadowText({ ...cleanInput, unresolvedThreadCount: 3 }),
        label: "escalate",
      },
      {
        text: buildShadowText({ ...cleanInput, suppressedAdvisories: [{ key: "a#1", label: "x" }] }),
        label: "ack-retry",
      },
      {
        text: buildShadowText({ ...cleanInput, suppressedAdvisories: [{ key: "a#1", label: "x" }] }),
        label: "ack-retry",
      },
    ],
    { name: "converge-shadow", epochs: 400 },
  );
  const obs = observeConvergeShadow(cleanInput, converged, model);
  assertEquals(obs.modelName, "converge-shadow");
  assertEquals(obs.shadowAction, "converged");
  assertEquals(obs.agree, true);
  assert(typeof obs.shadowTopP === "number");
});

test("observeConvergeShadow declines to score a model missing a canonical converge label (labelled-only)", () => {
  // A model trained from `rounds.status` carries non-converge labels (addressed/blocked) and lacks
  // some canonical routes. Scoring over its full label set could persist a non-converge label as
  // `shadow_action` and corrupt the calibration, so the observer must fall back to the labelled-only
  // row (no scored fields) exactly as when no model is present (reviewer #811).
  const model = trainDecisionModel(
    [
      { text: buildShadowText(cleanInput), label: "converged" },
      { text: buildShadowText(cleanInput), label: "converged" },
      { text: buildShadowText({ ...cleanInput, unresolvedThreadCount: 3 }), label: "addressed" },
      { text: buildShadowText({ ...cleanInput, unresolvedThreadCount: 3 }), label: "addressed" },
      { text: buildShadowText({ ...cleanInput, suppressedAdvisories: [{ key: "a#1", label: "x" }] }), label: "blocked" },
      { text: buildShadowText({ ...cleanInput, suppressedAdvisories: [{ key: "a#1", label: "x" }] }), label: "blocked" },
    ],
    { name: "round-status", epochs: 50 },
  );
  const obs = observeConvergeShadow(cleanInput, converged, model);
  assertEquals(obs.groundTruth, "converged");
  assertEquals(obs.modelName, undefined);
  assertEquals(obs.shadowAction, undefined);
  assertEquals(obs.agree, undefined);
});

test("recordConvergeShadow inserts a row and never throws (best-effort)", async () => {
  const inserted: unknown[] = [];
  const data = {
    table() {
      return {
        async insert(row: unknown) {
          inserted.push(row);
          return 1;
        },
      };
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: structural DataLayer stub for the insert seam
  const obs = await recordConvergeShadow(data as any, { prKey: "o/r#1" }, cleanInput, escalate);
  assertEquals(inserted.length, 1);
  assert(obs !== null);
  const row = inserted[0];
  assert(row && typeof row === "object");
  assertEquals(Reflect.get(row, "pr_key"), "o/r#1");
  assertEquals(Reflect.get(row, "ground_truth"), "escalate");
});

test("recordConvergeShadow swallows a throwing datasource (gate must be unaffected)", async () => {
  const data = {
    table() {
      return {
        async insert() {
          throw new Error("db down");
        },
      };
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: structural DataLayer stub for the insert seam
  const obs = await recordConvergeShadow(data as any, { prKey: "o/r#1" }, cleanInput, converged);
  assertEquals(obs, null);
});

test("isDecisionModel accepts a well-formed model and rejects malformed artifacts", () => {
  const good = trainDecisionModel(
    [
      { text: buildShadowText(cleanInput), label: "converged" },
      { text: buildShadowText(cleanInput), label: "converged" },
      { text: buildShadowText({ ...cleanInput, unresolvedThreadCount: 3 }), label: "escalate" },
      { text: buildShadowText({ ...cleanInput, unresolvedThreadCount: 3 }), label: "escalate" },
    ],
    { name: "converge-shadow", epochs: 30 },
  );
  assert(isDecisionModel(good), "a freshly trained model is valid");

  // A shallow guard that only checks "arrays + numeric dim" would wrongly accept every case below;
  // `recordConvergeShadow` would then throw mid-scoring (ragged/short rows) or persist NaN/always-
  // escalate scores instead of taking the graceful labelled-only path (#812).
  assertEquals(isDecisionModel(null), false);
  assertEquals(isDecisionModel({ ...good, version: 2 }), false, "wrong version");
  assertEquals(isDecisionModel({ ...good, dim: 0 }), false, "non-positive dim");
  assertEquals(isDecisionModel({ ...good, dim: 4.5 }), false, "non-integer dim");
  assertEquals(isDecisionModel({ ...good, ngram: 3 }), false, "invalid ngram");
  assertEquals(isDecisionModel({ ...good, threshold: Number.NaN }), false, "NaN threshold");
  const { margin, ...noMargin } = good;
  void margin;
  assertEquals(isDecisionModel(noMargin), false, "missing margin");
  assertEquals(isDecisionModel({ ...good, labels: [] }), false, "empty labels");
  assertEquals(
    isDecisionModel({ ...good, weights: good.weights.slice(0, good.weights.length - 1) }),
    false,
    "weight rows fewer than labels",
  );
  assertEquals(
    isDecisionModel({ ...good, weights: good.weights.map((r) => r.slice(0, -1)) }),
    false,
    "a short (ragged) weight row",
  );
  assertEquals(isDecisionModel({ ...good, bias: [0] }), false, "bias length != labels");
  assertEquals(
    isDecisionModel({ ...good, weights: good.weights.map((r) => r.map(() => Number.NaN)) }),
    false,
    "NaN weights",
  );
});
