// Adversarial unit coverage for the inter-epic gate projection (issue #292, slice S4) — the pure
// `deriveWaitGate` that turns a dependent's inbound `plan_deps` edges + its own lifecycle into the
// operator-visible `wait_gate` / `wait_gate_label` columns. No data/engine/network: pure derivation,
// exactly like app/delivery.test.ts.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { PlanDep } from "./plan.ts";
import {
  deriveWaitGate,
  humanizeMs,
  parseBoundArtifacts,
  type WaitGateLifecycle,
} from "./waitGate.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const T0_MS = Date.parse(T0);

const edge = (
  consumer: string,
  producer: string,
  pkg = "@scope/pkg",
  capRef = producer,
): PlanDep => ({
  plan_key: consumer,
  depends_on_plan_key: producer,
  package: pkg,
  capability_ref: capRef,
  created_at: T0,
});

const plan = (over: Partial<WaitGateLifecycle> = {}): WaitGateLifecycle => ({
  status: "planning",
  current_wave: null,
  bound_artifacts: null,
  created_at: T0,
  ...over,
});

// ── root ───────────────────────────────────────────────────────────────────────────────────────
test("a root epic (no inbound edge) has NO wait-gate", () => {
  const got = deriveWaitGate([], plan(), { nowMs: T0_MS });
  assertEquals(got, { wait_gate: null, wait_gate_label: null });
});

// ── waiting (parked at the preflight) ────────────────────────────────────────────────────────────
test("a parked dependent is 'waiting' and names exactly which producer/package it is blocked on", () => {
  const got = deriveWaitGate([edge("o/r#2", "o/r#1", "@scope/api")], plan(), {
    nowMs: T0_MS + 1000,
  });
  assertEquals(got.wait_gate, "waiting");
  assert(got.wait_gate_label!.includes("o/r#1 @ @scope/api"), "names the producer#N @ package");
  assert(got.wait_gate_label!.includes("re-checks every"), "shows the poll cadence");
  assert(got.wait_gate_label!.includes("escalates by"), "shows the escalation deadline");
});

test("a fan-in dependent waits on ALL its producers, capping the visible list", () => {
  const edges = [
    edge("o/r#9", "o/r#1", "@p/one"),
    edge("o/r#9", "o/r#2", "@p/two"),
    edge("o/r#9", "o/r#3", "@p/three"),
    edge("o/r#9", "o/r#4", "@p/four"),
  ];
  const got = deriveWaitGate(edges, plan(), { nowMs: T0_MS + 1000 });
  assertEquals(got.wait_gate, "waiting");
  assert(got.wait_gate_label!.includes("o/r#1 @ @p/one"), "shows the first producer");
  assert(got.wait_gate_label!.includes("+1 more"), "caps the fan-in list");
});

// ── ready (preflight went green) ─────────────────────────────────────────────────────────────────
test("a dependent that has fanned out (current_wave set) is 'ready'", () => {
  const got = deriveWaitGate([edge("o/r#2", "o/r#1")], plan({ current_wave: 0 }), {
    nowMs: T0_MS + 1000,
  });
  assertEquals(got.wait_gate, "ready");
});

test("a satisfied dependent shows its BOUND version, not merely 'ready'", () => {
  const got = deriveWaitGate(
    [edge("o/r#2", "o/r#1")],
    plan({ current_wave: 1, bound_artifacts: JSON.stringify(["@scope/api@1.4.0"]) }),
    { nowMs: T0_MS + 1000 },
  );
  assertEquals(got.wait_gate, "ready");
  assert(got.wait_gate_label!.includes("@scope/api@1.4.0"), "surfaces the exact bound pkg@version");
});

test("a dispatched/done dependent with no captured version still reads 'ready' (green, gate passed)", () => {
  for (const status of ["dispatched", "done"]) {
    const got = deriveWaitGate([edge("o/r#2", "o/r#1")], plan({ status }), { nowMs: T0_MS + 1000 });
    assertEquals(got.wait_gate, "ready", `status=${status}`);
  }
});

test("a bound version wins even before a wave is stamped (green the instant the preflight resolves)", () => {
  const got = deriveWaitGate(
    [edge("o/r#2", "o/r#1")],
    plan({ bound_artifacts: JSON.stringify(["@scope/api@2.0.0"]) }),
    { nowMs: T0_MS + 1000 },
  );
  assertEquals(got.wait_gate, "ready");
});

// ── escalated (bounded timeout / terminal failure) ───────────────────────────────────────────────
test("a still-gated dependent past its bounded timeout is 'escalated', never a silent stall", () => {
  const got = deriveWaitGate([edge("o/r#2", "o/r#1")], plan(), {
    // Well past the default readiness timeout (30m) with no publish.
    nowMs: T0_MS + 48 * 60 * 60 * 1000,
  });
  assertEquals(got.wait_gate, "escalated");
  assert(got.wait_gate_label!.includes("escalated"), "labels the escalation");
  assert(got.wait_gate_label!.includes("o/r#1 @ @scope/pkg"), "still names the blocking producer");
});

test("a terminal FAILED dependent that never went green surfaces as 'escalated'", () => {
  for (const status of ["failed", "abandoned"]) {
    const got = deriveWaitGate([edge("o/r#2", "o/r#1")], plan({ status }), { nowMs: T0_MS + 1000 });
    assertEquals(got.wait_gate, "escalated", `status=${status}`);
  }
});

test("a FAILED dependent that DID go green (bound) stays 'ready' — the gate resolved before the failure", () => {
  const got = deriveWaitGate(
    [edge("o/r#2", "o/r#1")],
    plan({ status: "failed", bound_artifacts: JSON.stringify(["@scope/pkg@1.0.0"]) }),
    { nowMs: T0_MS + 1000 },
  );
  assertEquals(got.wait_gate, "ready");
});

// ── defensive parsing / formatting ───────────────────────────────────────────────────────────────
test("parseBoundArtifacts tolerates null/garbage/non-array/non-string, never throwing", () => {
  assertEquals(parseBoundArtifacts(null), []);
  assertEquals(parseBoundArtifacts(""), []);
  assertEquals(parseBoundArtifacts("not json"), []);
  assertEquals(parseBoundArtifacts('{"a":1}'), []);
  assertEquals(parseBoundArtifacts('["@a/b@1.0.0", 3, "", null]'), ["@a/b@1.0.0"]);
});

test("a green dependent whose bound_artifacts is garbage still reads 'ready' (via the wave signal)", () => {
  const got = deriveWaitGate(
    [edge("o/r#2", "o/r#1")],
    plan({ current_wave: 0, bound_artifacts: "garbage" }),
    { nowMs: T0_MS + 1000 },
  );
  assertEquals(got.wait_gate, "ready");
  assertEquals(got.wait_gate_label, "ready", "no phantom version from an unparseable value");
});

test("humanizeMs renders compact human spans", () => {
  assertEquals(humanizeMs(30_000), "30s");
  assertEquals(humanizeMs(90_000), "1m 30s");
  assertEquals(humanizeMs(30 * 60 * 1000), "30m");
  assertEquals(humanizeMs(0), "0s");
});

test("the waiting label reflects the exponential backoff cadence, not a flat interval", () => {
  const got = deriveWaitGate([edge("o/r#2", "o/r#1", "@scope/api")], plan(), { nowMs: T0_MS + 1000 });
  assertEquals(got.wait_gate, "waiting");
  assert(
    got.wait_gate_label!.includes("(exponential backoff)"),
    "names the default exponential backoff so 'every N' can't imply a fixed cadence",
  );
});

test("the waiting label is stable regardless of inbound edge order (no idempotent-poll churn)", () => {
  const a = edge("o/r#9", "o/r#1", "@p/one");
  const b = edge("o/r#9", "o/r#2", "@p/two");
  const c = edge("o/r#9", "o/r#3", "@p/three");
  const forward = deriveWaitGate([a, b, c], plan(), { nowMs: T0_MS + 1000 });
  const shuffled = deriveWaitGate([c, a, b], plan(), { nowMs: T0_MS + 1000 });
  assertEquals(shuffled.wait_gate_label, forward.wait_gate_label, "order-independent label");
});

test("parseBoundArtifacts drops whitespace-only entries, not just empty strings", () => {
  assertEquals(parseBoundArtifacts('["@a/b@1.0.0", "   ", "\\t"]'), ["@a/b@1.0.0"]);
});
