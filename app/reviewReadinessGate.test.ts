// Structural guard for the review-ready wait re-expressed on the canonical ReadinessProbe
// wait-gate contract (ADR 0001 §2, issue #259).
//
// #258 landed the generic durable wait-gate: an event-based gateway racing a canonical
// `readiness-ready` signal against a bounded timer that escalates. #259 collapses nwf's bespoke
// review-ready poll path onto that ONE primitive — so there is a single "wait for the world"
// message, no drift-prone twin. The out-of-band poller-correlated shape (#258 pinned decision 3)
// keeps the canonical self-scheduling poller (`pollReviews` in app/service.ts) publishing the
// signal when a fresh review lands, while the convergence-loop parks on the canonical gate.
//
// These pure text assertions over the committed BPMN lock the migrated wait: it now catches the
// canonical `readiness-ready` message (the bespoke `review-ready` message is GONE), and it stays
// BOUNDED — the event-based gateway still races the signal against the `reviewWaitTimeout` timer,
// whose arm escalates to a human. Matches the repo's model-guard style (see roundResultDefault.test.ts).

import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assert, assertStringIncludes } from "#test-assert";
import { READINESS_READY_MESSAGE } from "./readiness.ts";

const bpmn = readFileSync("resources/processes/convergence-loop.bpmn", "utf8");
const flat = bpmn.replace(/\s+/g, " ");

test("the review wait catches the canonical readiness-ready message, not a bespoke twin", () => {
  // The one canonical wait-gate signal (#258), re-used here — no separate `review-ready` message.
  const msg = flat.match(/<bpmn:message\b[^>]*\bname="readiness-ready"[\s\S]*?<\/bpmn:message>/);
  assert(msg, "convergence-loop must declare the canonical readiness-ready message");
  assertStringIncludes(msg![0], 'correlationKey="=prKey"', "correlation shape is preserved (=prKey)");

  // The bespoke review-ready message/shape must be fully retired (one mechanism, no drift).
  assert(!/name="review-ready"/.test(flat), "the bespoke review-ready message must be gone");
  assert(!/id="Message_reviewReady"/.test(flat), "the bespoke Message_reviewReady must be gone");
  assert(!/id="ReviewReady"/.test(flat), "the bespoke ReviewReady payload shape must be gone");

  // And the constant the poller publishes under is the very same canonical name.
  assert(new RegExp(`name="${READINESS_READY_MESSAGE}"`).test(flat), "message name matches the canonical constant");
});

test("the review-ready catch subscribes to the canonical readiness-ready message", () => {
  const wait = flat.match(/<bpmn:intermediateCatchEvent\b[^>]*\bid="wait-review"[\s\S]*?<\/bpmn:intermediateCatchEvent>/);
  assert(wait, "the wait-review catch event must exist");
  assertStringIncludes(
    wait![0],
    'messageRef="Message_readinessReady"',
    "wait-review must catch the canonical readiness-ready message",
  );
  // The round increment (forward progress) is preserved on the same catch.
  assertStringIncludes(wait![0], 'target="round"', "wait-review still advances the round on a fresh signal");
});

test("the migrated wait stays bounded: an event-based gateway races the signal against a timer", () => {
  // The gate shape from #258: an event-based gateway forks to the signal catch and a timer catch.
  const gw = flat.match(/<bpmn:eventBasedGateway\b[^>]*\bid="gw-review-wait"[^>]*>/);
  assert(gw, "the review wait must be an event-based gateway race (bounded gate)");

  const timeout = flat.match(
    /<bpmn:intermediateCatchEvent\b[^>]*\bid="wait-review-timeout"[\s\S]*?<\/bpmn:intermediateCatchEvent>/,
  );
  assert(timeout, "the bounded timer arm (wait-review-timeout) must exist");
  assertStringIncludes(timeout![0], "<bpmn:timerEventDefinition", "the timer arm bounds the wait");
  assertStringIncludes(timeout![0], "=reviewWaitTimeout", "the timer is seeded with the review-wait timeout");

  // The gateway forks to BOTH the signal catch and the timer catch (the race).
  assert(
    /sourceRef="gw-review-wait"[^>]*targetRef="wait-review"|targetRef="wait-review"[^>]*sourceRef="gw-review-wait"/.test(
      flat,
    ),
    "the gateway races toward the readiness signal catch",
  );
  assert(
    /sourceRef="gw-review-wait"[^>]*targetRef="wait-review-timeout"|targetRef="wait-review-timeout"[^>]*sourceRef="gw-review-wait"/.test(
      flat,
    ),
    "the gateway races toward the bounded timer catch",
  );
});

test("the timeout arm escalates to a human (the wait cannot hang forever)", () => {
  // timer catch → persist-review-stalled (records the escalation) → wait-answer (native userTask).
  assert(
    /sourceRef="wait-review-timeout"[^>]*targetRef="persist-review-stalled"|targetRef="persist-review-stalled"[^>]*sourceRef="wait-review-timeout"/.test(
      flat,
    ),
    "a timed-out review wait routes to the stalled-review escalation",
  );
  assert(
    /sourceRef="persist-review-stalled"[^>]*targetRef="wait-answer"|targetRef="wait-answer"[^>]*sourceRef="persist-review-stalled"/.test(
      flat,
    ),
    "the stalled-review escalation parks on the human answer userTask",
  );
});
