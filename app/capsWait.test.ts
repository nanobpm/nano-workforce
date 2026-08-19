// Unit coverage for the capability-barrier bounded-wait duration policy (#289). The value is baked
// into every plan-fanout instance's `capsWaitTimeout` process variable and evaluated by the
// `wait-caps-timeout` timer arm on the `wait-caps-resolved` event-based gateway, so a malformed
// operator env must never deploy an uninterpretable `<bpmn:timeDuration>` — it falls back to the
// default instead. Run with `node --test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { capsWaitTimeout, DEFAULT_CAPS_WAIT_TIMEOUT } from "./capsWait.ts";

test("capsWaitTimeout: blank / absent / malformed → default", () => {
  assert.equal(capsWaitTimeout(undefined), DEFAULT_CAPS_WAIT_TIMEOUT);
  assert.equal(capsWaitTimeout(""), DEFAULT_CAPS_WAIT_TIMEOUT);
  assert.equal(capsWaitTimeout("   "), DEFAULT_CAPS_WAIT_TIMEOUT);
  assert.equal(capsWaitTimeout("2h"), DEFAULT_CAPS_WAIT_TIMEOUT); // missing leading P/T
  assert.equal(capsWaitTimeout("P"), DEFAULT_CAPS_WAIT_TIMEOUT); // no component
  assert.equal(capsWaitTimeout("PT"), DEFAULT_CAPS_WAIT_TIMEOUT); // T with no time part
  assert.equal(capsWaitTimeout("garbage"), DEFAULT_CAPS_WAIT_TIMEOUT);
});

test("capsWaitTimeout: a valid ISO-8601 duration is honoured and upper-cased", () => {
  assert.equal(capsWaitTimeout("PT30M"), "PT30M");
  assert.equal(capsWaitTimeout("pt2h"), "PT2H");
  assert.equal(capsWaitTimeout("P2D"), "P2D");
  assert.equal(capsWaitTimeout("  pt15m  "), "PT15M");
});

test("capsWaitTimeout: an explicit fallback is honoured for a bad value", () => {
  assert.equal(capsWaitTimeout("nope", "PT10M"), "PT10M");
  assert.equal(capsWaitTimeout("PT45M", "PT10M"), "PT45M");
});

test("the default is itself a well-formed ISO-8601 duration (never an uninterpretable timer)", () => {
  // Validate the default against the grammar with a *distinct* fallback: if the default were
  // malformed it would fall through to the sentinel, so equality to itself proves it parses.
  const sentinel = "PT1S";
  assert.notEqual(DEFAULT_CAPS_WAIT_TIMEOUT, sentinel);
  assert.equal(capsWaitTimeout(DEFAULT_CAPS_WAIT_TIMEOUT, sentinel), DEFAULT_CAPS_WAIT_TIMEOUT);
});
