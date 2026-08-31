// Unit coverage for the mergeable-wait liveness timeout policy. The value is baked into every
// merge-loop instance's `mergeableWaitTimeout` process variable and evaluated by the
// `wait-mergeable-timeout` timer catch (the timer arm of the `gw-merge-wait` event-based gateway),
// so a malformed operator env must never deploy an uninterpretable `<bpmn:timeDuration>` — it falls
// back to the default instead. Run with `node --test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MERGEABLE_WAIT_TIMEOUT, mergeableWaitTimeout } from "./mergeableWait.ts";

test("mergeableWaitTimeout: blank / absent / malformed → default", () => {
  assert.equal(mergeableWaitTimeout(undefined), DEFAULT_MERGEABLE_WAIT_TIMEOUT);
  assert.equal(mergeableWaitTimeout(""), DEFAULT_MERGEABLE_WAIT_TIMEOUT);
  assert.equal(mergeableWaitTimeout("   "), DEFAULT_MERGEABLE_WAIT_TIMEOUT);
  assert.equal(mergeableWaitTimeout("30m"), DEFAULT_MERGEABLE_WAIT_TIMEOUT); // missing leading P/T
  assert.equal(mergeableWaitTimeout("P"), DEFAULT_MERGEABLE_WAIT_TIMEOUT); // no component
  assert.equal(mergeableWaitTimeout("PT"), DEFAULT_MERGEABLE_WAIT_TIMEOUT); // T with no time part
  assert.equal(mergeableWaitTimeout("garbage"), DEFAULT_MERGEABLE_WAIT_TIMEOUT);
});

test("mergeableWaitTimeout: a valid ISO-8601 duration is honoured and upper-cased", () => {
  assert.equal(mergeableWaitTimeout("PT30M"), "PT30M");
  assert.equal(mergeableWaitTimeout("pt2h"), "PT2H");
  assert.equal(mergeableWaitTimeout("P1D"), "P1D");
  assert.equal(mergeableWaitTimeout("  pt45m  "), "PT45M");
});

test("mergeableWaitTimeout: an explicit fallback is honoured for a bad value", () => {
  assert.equal(mergeableWaitTimeout("nope", "PT10M"), "PT10M");
  assert.equal(mergeableWaitTimeout("PT15M", "PT10M"), "PT15M");
});

test("the default is itself a well-formed ISO-8601 duration (never an uninterpretable timer)", () => {
  // Validate the default against the grammar with a *distinct* fallback: if the default were
  // malformed it would fall through to the sentinel, so equality to itself proves it parses.
  const sentinel = "PT1S";
  assert.notEqual(DEFAULT_MERGEABLE_WAIT_TIMEOUT, sentinel);
  assert.equal(mergeableWaitTimeout(DEFAULT_MERGEABLE_WAIT_TIMEOUT, sentinel), DEFAULT_MERGEABLE_WAIT_TIMEOUT);
});
