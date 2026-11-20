// Issue #976 review: the MCP feature admission must fail closed on a `noop-terminal` start.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertFeatureDispatched } from "./mcpStart.ts";

test("assertFeatureDispatched: noop-terminal (no instance dispatched) throws", () => {
  assert.throws(
    () => assertFeatureDispatched({ outcome: "noop-terminal", featureKey: "o/r#1" }),
    /started no engine instance/,
  );
});

test("assertFeatureDispatched: started and already-active are admitted", () => {
  assertFeatureDispatched({ outcome: "started", featureKey: "o/r#1" });
  assertFeatureDispatched({ outcome: "already-active", featureKey: "o/r#1" });
});
