// Issue #1032 — testkit reproduction of the gw-husk converged-head route and the per-round reset of
// its routing variables.
//
// Live evidence (merlin, convergence-loop 105254 round 10): `check-progress` left
// `convergedHead = true` in scope, yet `gw-husk` took its default escalation arm. These tests boot
// the committed model on the WASM engine and pin two things:
//
//  1. A `check-progress` completion of `{progressed:false, convergedHead:true, huskRetry:false}`
//     routes `gw-husk` → `check-converge` (the #1018 route) — never the no-progress escalation.
//  2. The per-round outcome variables (`convergedHead`, `ciRed`, `huskRetry`, `noProgressQuestion`)
//     are cleared on round entry (`capture-head`), so a value left by an EARLIER round can never
//     route a later round — e.g. a stale `convergedHead = true` must not send a later no-advance
//     round to merge when that round's check-progress omits the flag.

import { after, test } from "node:test";
import { assert } from "#test-assert";
import { readFileSync } from "node:fs";
import { assertThatInstance, byProcessId, createWasmEngineClient, type WasmEngineClient } from "@nanobpm/urban-testkit";

const MODEL = readFileSync("resources/processes/convergence-loop.bpmn", "utf8");

type Output = Record<string, unknown>;
type Job = { variables: Record<string, unknown> };

const RESPONSES: Record<string, Output> = {
  "senior:pr-review": { status: "addressed", summary: "replied to every thread" },
  "senior:adversarial-review": { adversarialFindings: "", adversarialSummary: "no findings" },
  "pr.capture-head": { roundEntryHead: "sha-entry" },
  "pr.liveness-check": { prGone: "" },
  "pr.persist-round": {},
  "pr.converge-gate": { convergeBlocked: false, convergeBlockReason: "", convergeAckOnly: false },
  "senior:scope-classify": { scopeBlocked: false, scopeBlockReason: "" },
  "pr.finalize": {},
  "pr.persist-escalation": { escalated: true },
  "pr.answer-escalation": {},
};

const VARS: Record<string, unknown> = {
  prKey: "o/r#1",
  repo: "o/r",
  prNumber: 1,
  prUrl: "https://example.test/pr/1",
  round: 10,
  maxRounds: 20,
  reviewWaitTimeout: "PT30M",
  ackRetryRound: 0,
  ackRetryMax: 2,
  advPass: 0,
  advMax: 0,
  abandonBrief: null,
  status: null,
  question: null,
  summary: null,
  answer: null,
  scopePending: false,
  scopeAnswer: null,
  convergeBlocked: null,
  convergeBlockReason: null,
  convergeAckOnly: null,
  reviewStale: null,
  roundEntryHead: null,
  huskRetries: 0,
  progressed: true,
  escalated: null,
};

const engines: WasmEngineClient[] = [];
after(async () => {
  await Promise.all(engines.map((e) => e.close()));
});

async function boot(progress: Output, vars: Record<string, unknown> = {}) {
  const engine = await createWasmEngineClient();
  engines.push(engine);
  await engine.deployResources([{ name: "convergence-loop.bpmn", content: MODEL, contentType: "text/xml" }]);
  const seen: Record<string, Record<string, unknown>[]> = {};
  const all: Record<string, Output> = { ...RESPONSES, "pr.progress-check": progress };
  for (const [jobType, out] of Object.entries(all)) {
    seen[jobType] = [];
    await engine.registerWorker(jobType, (job) => {
      seen[jobType].push({ ...(job as Job).variables });
      return out;
    });
  }
  await engine.createInstance({
    processDefinitionId: "convergence-loop",
    awaitCompletion: false,
    variables: { ...VARS, ...vars },
  });
  return { engine, seen };
}

function completions(engine: WasmEngineClient, elementId: string): number {
  const snap = engine.snapshot() as { elementStats?: { elementId: string; completed: number }[] };
  return (snap.elementStats ?? []).find((s) => s.elementId === elementId)?.completed ?? 0;
}

const NO_ADVANCE = { progressed: false, huskRetries: 0, huskRetry: false, ciRed: false, prGone: "" };

test("#1032: check-progress {progressed:false, convergedHead:true, huskRetry:false} routes gw-husk → check-converge", async () => {
  const { engine } = await boot({ ...NO_ADVANCE, convergedHead: true });
  assertThatInstance(engine, byProcessId("convergence-loop")).hasNoIncident();
  assert(completions(engine, "check-converge") >= 1, "gw-husk must take f_convergedHead into check-converge");
  assert(completions(engine, "persist-escalation-noprogress") === 0, "a converged head must not escalate as no-progress");
});

test("#1032: a stale convergedHead from an earlier round cannot route a later no-advance round to merge", async () => {
  // Round entry carries convergedHead=true from an earlier round; this round's check-progress omits it.
  const { engine } = await boot({ ...NO_ADVANCE }, { convergedHead: true });
  assertThatInstance(engine, byProcessId("convergence-loop")).hasNoIncident();
  assert(completions(engine, "check-converge") === 0, "a stale convergedHead must not reach the converge gate");
  assert(completions(engine, "persist-escalation-noprogress") === 1, "the no-advance round must escalate");
});

test("#1032: capture-head clears every per-round outcome variable before the round runs", async () => {
  const { seen } = await boot(
    { ...NO_ADVANCE, convergedHead: true },
    { convergedHead: true, ciRed: true, huskRetry: true, noProgressQuestion: "stale question" },
  );
  const review = seen["senior:pr-review"][0];
  assert(review, "review-round must run");
  for (const k of ["convergedHead", "ciRed", "huskRetry"]) {
    assert(review[k] === false, `${k} must be reset to false on round entry, got ${JSON.stringify(review[k])}`);
  }
  assert(review.noProgressQuestion == null, `noProgressQuestion must be cleared, got ${JSON.stringify(review.noProgressQuestion)}`);
});
