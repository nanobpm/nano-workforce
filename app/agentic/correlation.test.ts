// Unit tests for the jobKey ⇄ process/plan correlation registry (ADR 0056, H6 / #149).
//
// The registry is the single canonical join the cockpit uses to line a worker's terminal up with the
// process instance / plan it belongs to. These tests pin: the `job:<jobKey>` stream convention; the
// two derived-from-one-write projections (instance→jobKeys and jobKey→context) staying consistent
// across link / re-link (move) / releaseJob / releaseInstance; the presence `jobKeysFor` seam; the
// drill `primaryStreamFor`; and the sorted snapshot.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CorrelationRegistry,
  currentCorrelation,
  JOB_STREAM_PREFIX,
  jobKeyOfStream,
  jobStream,
  setCurrentCorrelation,
} from "./correlation.ts";

test("jobStream / jobKeyOfStream are inverse over the job: convention", () => {
  assert.equal(jobStream("6494"), `${JOB_STREAM_PREFIX}6494`);
  assert.equal(jobKeyOfStream(jobStream("6494")), "6494");
  assert.equal(jobKeyOfStream("wk-a"), undefined);
  // A bare `job:` prefix carries no jobKey, so it maps to undefined (not "") — an empty jobKey is
  // invalid (link() ignores it), so callers never mistake it for a valid key.
  assert.equal(jobKeyOfStream("job:"), undefined);
});

test("link records context and both projections; resolve carries the job: stream", () => {
  const reg = new CorrelationRegistry();
  reg.link("wk-a", "6494", { processInstanceKey: "4612", bpmnProcessId: "plan-fanout", elementId: "implement-task", planKey: "o/r#142" });

  assert.deepEqual(reg.jobKeysFor("wk-a"), ["6494"]);
  const c = reg.resolve("6494");
  assert.ok(c);
  assert.equal(c.jobKey, "6494");
  assert.equal(c.stream, "job:6494");
  assert.equal(c.processInstanceKey, "4612");
  assert.equal(c.bpmnProcessId, "plan-fanout");
  assert.equal(c.elementId, "implement-task");
  assert.equal(c.planKey, "o/r#142");
  assert.equal(reg.count(), 1);
});

test("attachElementInstance enriches a linked job's context, preserving every other field (#544)", () => {
  const reg = new CorrelationRegistry();
  reg.link("wk-a", "6494", { processInstanceKey: "4612", elementId: "agent", planKey: "o/r#142" });
  reg.attachElementInstance("6494", "ei-77");
  const c = reg.resolve("6494");
  assert.ok(c);
  assert.equal(c.elementInstanceKey, "ei-77");
  // Enrichment is additive — it must not clobber the fields the link established.
  assert.equal(c.processInstanceKey, "4612");
  assert.equal(c.elementId, "agent");
  assert.equal(c.planKey, "o/r#142");
  assert.equal(c.jobKey, "6494");
  assert.equal(c.stream, "job:6494");
});

test("attachElementInstance is a no-op for a released (or never-linked) job or an empty key (#544)", () => {
  const reg = new CorrelationRegistry();
  // Never linked.
  reg.attachElementInstance("nope", "ei-1");
  assert.equal(reg.resolve("nope"), undefined);
  // Released before the resolution landed (the completion-race path).
  reg.link("wk-a", "6494");
  reg.releaseJob("6494");
  reg.attachElementInstance("6494", "ei-1");
  assert.equal(reg.resolve("6494"), undefined);
  // Empty inputs are ignored, and never materialise a context.
  reg.link("wk-b", "7000");
  reg.attachElementInstance("7000", "");
  assert.equal(reg.resolve("7000")?.elementInstanceKey, undefined);
  reg.attachElementInstance("", "ei-1");
});

test("link ignores empty instance or jobKey", () => {
  const reg = new CorrelationRegistry();
  reg.link("", "6494");
  reg.link("wk-a", "");
  assert.equal(reg.count(), 0);
  assert.deepEqual(reg.jobKeysFor("wk-a"), []);
});

test("jobKeysFor returns the worker's jobs sorted; unknown instance is empty", () => {
  const reg = new CorrelationRegistry();
  reg.link("wk-a", "20");
  reg.link("wk-a", "3");
  reg.link("wk-a", "100");
  assert.deepEqual(reg.jobKeysFor("wk-a"), ["100", "20", "3"]);
  assert.deepEqual(reg.jobKeysFor("nobody"), []);
});

test("re-linking a jobKey to a new instance MOVES it (drops the stale reverse edge)", () => {
  const reg = new CorrelationRegistry();
  reg.link("wk-a", "6494");
  reg.link("wk-b", "6494", { planKey: "o/r#142" });

  assert.deepEqual(reg.jobKeysFor("wk-a"), []);
  assert.deepEqual(reg.jobKeysFor("wk-b"), ["6494"]);
  assert.equal(reg.resolve("6494")?.planKey, "o/r#142");
  assert.equal(reg.count(), 1);
});

test("re-linking a jobKey preserves an already-attached elementInstanceKey (no clobber)", () => {
  const reg = new CorrelationRegistry();
  reg.link("wk-a", "6494");
  reg.attachElementInstance("6494", "ei-42");
  // A subsequent bare re-link (worker reconnect mid-job) must not wipe the async-resolved key.
  reg.link("wk-a", "6494");
  assert.equal(reg.resolve("6494")?.elementInstanceKey, "ei-42");
  // A move to a new worker connection likewise keeps the element-instance the job occupies.
  reg.link("wk-b", "6494", { planKey: "o/r#7" });
  assert.equal(reg.resolve("6494")?.elementInstanceKey, "ei-42");
  assert.equal(reg.resolve("6494")?.planKey, "o/r#7");
});


test("releaseJob removes one job from both projections", () => {
  const reg = new CorrelationRegistry();
  reg.link("wk-a", "6494");
  reg.link("wk-a", "6495");
  reg.releaseJob("6494");
  assert.equal(reg.resolve("6494"), undefined);
  assert.deepEqual(reg.jobKeysFor("wk-a"), ["6495"]);
  reg.releaseJob("nope"); // no-op
  assert.equal(reg.count(), 1);
});

test("releaseInstance drops every job the worker held", () => {
  const reg = new CorrelationRegistry();
  reg.link("wk-a", "1");
  reg.link("wk-a", "2");
  reg.link("wk-b", "3");
  reg.releaseInstance("wk-a");
  assert.deepEqual(reg.jobKeysFor("wk-a"), []);
  assert.equal(reg.resolve("1"), undefined);
  assert.equal(reg.resolve("2"), undefined);
  assert.equal(reg.resolve("3")?.jobKey, "3");
  assert.equal(reg.count(), 1);
});

test("primaryStreamFor picks the lowest-sorted job's stream; undefined when none", () => {
  const reg = new CorrelationRegistry();
  assert.equal(reg.primaryStreamFor("wk-a"), undefined);
  reg.link("wk-a", "50");
  reg.link("wk-a", "10");
  assert.equal(reg.primaryStreamFor("wk-a"), "job:10");
});

test("snapshot returns every job sorted by jobKey", () => {
  const reg = new CorrelationRegistry();
  reg.link("wk-a", "30");
  reg.link("wk-b", "10");
  reg.link("wk-c", "20");
  const snap = reg.snapshot();
  assert.equal(snap.count, 3);
  assert.deepEqual(snap.correlations.map((c) => c.jobKey), ["10", "20", "30"]);
  assert.deepEqual(snap.correlations.map((c) => c.stream), ["job:10", "job:20", "job:30"]);
});

test("link with no context leaves optional fields unset (no undefined holes)", () => {
  const reg = new CorrelationRegistry();
  reg.link("wk-a", "6494");
  const c = reg.resolve("6494");
  assert.ok(c);
  assert.equal("processInstanceKey" in c, false);
  assert.equal("planKey" in c, false);
});

test("currentCorrelation singleton is settable and clearable", () => {
  assert.equal(currentCorrelation(), undefined);
  const reg = new CorrelationRegistry();
  setCurrentCorrelation(reg);
  assert.equal(currentCorrelation(), reg);
  setCurrentCorrelation(undefined);
  assert.equal(currentCorrelation(), undefined);
});
