// Unit coverage for `summarizeDeliverySteps` (issue #989, `d8ctl nwf graph show`): the read projection
// must never echo a secret the compiler preview conceals, and must tolerate a staged-but-invalid probe.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeliveryGraph } from "../nano-generated/api-io.d.ts";
import { summarizeDeliverySteps } from "./deliveryRunner.ts";

const one = (graph: DeliveryGraph) => summarizeDeliverySteps(graph)[0];

test("a command wait probe's target is redacted, never echoed", () => {
  const s = one({ nodes: [{ id: "w", kind: "wait", wait: { kind: "command", target: "curl -H 'Authorization: Bearer s3cret' x" } }] });
  assert.equal(s?.target, "<redacted>");
  assert.doesNotMatch(JSON.stringify(s), /s3cret/);
});

test("a URL wait target has its embedded credential redacted", () => {
  const s = one({ nodes: [{ id: "w", kind: "wait", wait: { kind: "url", target: "https://user:pa55@host/health?token=t0k" } }] });
  assert.doesNotMatch(JSON.stringify(s), /pa55|t0k/);
});

test("connector target and PR payload are redacted", () => {
  const s = one({
    nodes: [{ id: "c", kind: "connector", connector: { target: "converge", payload: { pr: "//user:pa55@host#42" } } }],
  });
  assert.doesNotMatch(JSON.stringify(s), /pa55/);
});

test("agent repository credentials are redacted", () => {
  const s = one({ nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:feature", repository: "https://user:pa55@github.com/o/r.git" } }] });
  assert.doesNotMatch(JSON.stringify(s), /pa55/);
});

test("a staged probe parseProbe rejects is reported on the step, not thrown", () => {
  const steps = summarizeDeliverySteps({
    nodes: [{ id: "w", kind: "wait", wait: { kind: "capability", target: "github-releases:owner/repo" } }],
  });
  assert.equal(steps.length, 1);
  assert.equal(typeof steps[0]?.problem, "string");
  assert.equal(steps[0]?.timeLimitDefaulted, true);
});

test("a valid step reports no problem", () => {
  assert.equal(one({ nodes: [{ id: "w", kind: "wait", wait: { kind: "epic", target: "owner/repo#1" } }] })?.problem, null);
});
