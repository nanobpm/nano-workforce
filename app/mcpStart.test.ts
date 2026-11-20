// Issue #976 review: the MCP feature admission must fail closed on a `noop-terminal` start.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertFeatureDispatched, requireOptionalPositiveInt } from "./mcpStart.ts";

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

test("requireOptionalPositiveInt: rejects zero, negative, fractional, non-finite, non-number", () => {
  for (const v of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3", true]) {
    assert.throws(() => requireOptionalPositiveInt({ maxRounds: v }, "maxRounds", "t"), /positive integer/);
  }
});

test("requireOptionalPositiveInt: absent is undefined, positive integer passes", () => {
  assert.equal(requireOptionalPositiveInt({}, "maxRounds", "t"), undefined);
  assert.equal(requireOptionalPositiveInt({ maxRounds: null }, "maxRounds", "t"), undefined);
  assert.equal(requireOptionalPositiveInt({ maxRounds: 7 }, "maxRounds", "t"), 7);
});
