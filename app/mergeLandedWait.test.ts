// Unit coverage for the merge-queue landing liveness timeout policy. The value is baked into every
// merge-loop instance's `landedWaitTimeout` process variable and evaluated by the `wait-landed-timeout`
// timer catch (the timer arm of the `eg-landed` event-based gateway), so a malformed operator env
// must never deploy an uninterpretable `<bpmn:timeDuration>` — it falls back to the default instead.
// Run with `node --test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MERGE_LANDED_WAIT_TIMEOUT, mergeLandedWaitTimeout } from "./mergeLandedWait.ts";

test("mergeLandedWaitTimeout: blank / absent / malformed → default", () => {
  assert.equal(mergeLandedWaitTimeout(undefined), DEFAULT_MERGE_LANDED_WAIT_TIMEOUT);
  assert.equal(mergeLandedWaitTimeout(""), DEFAULT_MERGE_LANDED_WAIT_TIMEOUT);
  assert.equal(mergeLandedWaitTimeout("   "), DEFAULT_MERGE_LANDED_WAIT_TIMEOUT);
  assert.equal(mergeLandedWaitTimeout("1h"), DEFAULT_MERGE_LANDED_WAIT_TIMEOUT); // missing leading P/T
  assert.equal(mergeLandedWaitTimeout("P"), DEFAULT_MERGE_LANDED_WAIT_TIMEOUT); // no component
  assert.equal(mergeLandedWaitTimeout("PT"), DEFAULT_MERGE_LANDED_WAIT_TIMEOUT); // T with no time part
  assert.equal(mergeLandedWaitTimeout("garbage"), DEFAULT_MERGE_LANDED_WAIT_TIMEOUT);
});

test("mergeLandedWaitTimeout: a valid ISO-8601 duration is honoured and upper-cased", () => {
  assert.equal(mergeLandedWaitTimeout("PT30M"), "PT30M");
  assert.equal(mergeLandedWaitTimeout("pt2h"), "PT2H");
  assert.equal(mergeLandedWaitTimeout("P1D"), "P1D");
  assert.equal(mergeLandedWaitTimeout("  pt90m  "), "PT90M");
});

test("mergeLandedWaitTimeout: an explicit fallback is honoured for a bad value", () => {
  assert.equal(mergeLandedWaitTimeout("nope", "PT10M"), "PT10M");
  assert.equal(mergeLandedWaitTimeout("PT45M", "PT10M"), "PT45M");
});

test("the default is itself a well-formed ISO-8601 duration (never an uninterpretable timer)", () => {
  // Validate the default against the grammar with a *distinct* fallback: if the default were
  // malformed it would fall through to the sentinel, so equality to itself proves it parses.
  const sentinel = "PT1S";
  assert.notEqual(DEFAULT_MERGE_LANDED_WAIT_TIMEOUT, sentinel);
  assert.equal(mergeLandedWaitTimeout(DEFAULT_MERGE_LANDED_WAIT_TIMEOUT, sentinel), DEFAULT_MERGE_LANDED_WAIT_TIMEOUT);
});
