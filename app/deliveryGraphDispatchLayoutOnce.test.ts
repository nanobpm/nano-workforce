// #852 — a dispatch must run the CPU-bound, superlinear `layoutBpmn` pass ONCE. `dispatchDeliveryGraphRun`
// needs only the digest / resolved model / side effects / human stops (all on the semantic compile); the
// laid-out BPMN is produced by `runDeliveryGraph` → `prepareDeliveryGraph`. Calling the layout-bearing
// `compileDeliveryGraph` here too doubled a 54-node dispatch on merlin to ~105 s (52 s per layout).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("#852: dispatchDeliveryGraphRun uses the semantic compile, never the layout-bearing compileDeliveryGraph", () => {
  const src = readFileSync(new URL("./deliveryGraphDispatch.ts", import.meta.url), "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
  assert.doesNotMatch(src, /\bcompileDeliveryGraph\s*\(/, "dispatch must not lay the diagram out (runDeliveryGraph already does)");
  assert.match(src, /\bcompileDeliveryGraphSemantic\s*\(/);
});
