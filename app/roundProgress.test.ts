// No-progress guard — unit tests for the canonical router (app/roundProgress.ts), the
// pr.progress-check worker, and a structural guard over the committed convergence-loop BPMN.
//
// The convergence loop used to trust the agent's self-reported `addressed` status to trigger the
// next Copilot review round. An agent could return `addressed` (or fall back to the safe default)
// WITHOUT pushing a commit, so Copilot re-reviewed byte-identical code and the loop burned rounds
// making no progress until the round cap escalated. The fix inserts a deterministic
// `pr.progress-check` step that compares the PR head SHA across rounds and routes an `addressed`
// round whose head did not advance to the human `wait-answer` escalation instead of another review.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "#test-assert";
import { decideProgress, MAX_HUSK_RETRIES, noProgressQuestion, routeProgress } from "./roundProgress.ts";

// ── The canonical router ────────────────────────────────────────────────────

test("routeProgress: an addressed round whose head did not advance escalates", () => {
  assertEquals(routeProgress("addressed", "sha-1", "sha-1"), "escalate");
});

test("routeProgress: an addressed round whose head advanced continues", () => {
  assertEquals(routeProgress("addressed", "sha-1", "sha-2"), "continue");
});

test("routeProgress: an explicit non-addressed round always continues (no push is expected)", () => {
  // These are the statuses gw-status routes AWAY from the addressed/default arm — a legit no-push
  // round. They always continue regardless of the head.
  for (const status of ["waiting", "converged", "needs_input", "blocked"]) {
    assertEquals(
      routeProgress(status, "sha-1", "sha-1"),
      "continue",
      `status ${JSON.stringify(status)} must continue even with an unchanged head`,
    );
  }
});

test("routeProgress: blank/unknown status behaves like addressed (the safe-default trap)", () => {
  // gw-status defaults blank/unknown/unrecognized status down the addressed arm and pr.persist-round
  // records a missing status as `addressed`, so the no-progress guard must apply to them too: an
  // unchanged head escalates, an advanced head continues.
  for (const status of [undefined, null, "", "x"]) {
    assertEquals(
      routeProgress(status, "sha-1", "sha-1"),
      "escalate",
      `blank/unknown status ${JSON.stringify(status)} with an unchanged head must escalate like addressed`,
    );
    assertEquals(
      routeProgress(status, "sha-1", "sha-2"),
      "continue",
      `blank/unknown status ${JSON.stringify(status)} with an advanced head must continue`,
    );
  }
});

test("routeProgress: fails OPEN when either head is unknown (no baseline / unreadable head)", () => {
  for (const [prev, cur] of [
    [null, "sha-1"],
    [undefined, "sha-1"],
    ["sha-1", null],
    ["sha-1", undefined],
    [null, null],
  ] as const) {
    assertEquals(
      routeProgress("addressed", prev, cur),
      "continue",
      `unknown head (${JSON.stringify(prev)} -> ${JSON.stringify(cur)}) must fail open`,
    );
  }
});

// ── Husk classification & bounded self-heal (issue #786) ─────────────────────

test("decideProgress: a progressing round continues and RESETS the husk counter", () => {
  // head advanced -> progressed, huskRetries reset to 0 regardless of the carried count.
  const d = decideProgress("addressed", "sha-1", "sha-2", 3, null, 2);
  assertEquals(d.progressed, true);
  assertEquals(d.huskRetries, 0);
  assertEquals(d.huskRetry, undefined);
  assertEquals(d.reason, undefined);
});

test("decideProgress: a husk (successful empty agent-work read) under the cap auto-retries the same round", () => {
  // no head advance + a SUCCESSFUL empty agent-instance read (false) => husk. Under the cap it
  // re-runs the same round on a healthy worker and bumps the counter.
  const d = decideProgress("addressed", "sha-1", "sha-1", 5, false, 0);
  assertEquals(d.progressed, false);
  assertEquals(d.huskRetry, true, "a corroborated-empty husk must auto-retry");
  assertEquals(d.huskRetries, 1, "the husk bumps the counter");
  assertEquals(d.reason, "husk");
  assertEquals(d.question, undefined, "an auto-retry opens no escalation question");
});

test("decideProgress: an UNKNOWN agent-work read (null/undefined) escalates as no-advance — never auto-retries", () => {
  // An engine read that was unavailable/threw (null) — or was never attempted (undefined) — is NOT a
  // corroborated husk. Auto-retrying it could duplicate agent work that actually ran, so it fails
  // safe to an immediate no-advance escalation, exactly as the pre-#786 loop did.
  for (const observed of [null, undefined] as const) {
    const d = decideProgress("addressed", "sha-1", "sha-1", 5, observed, 0);
    assertEquals(d.progressed, false, `observed=${observed}`);
    assertEquals(d.huskRetry, false, `observed=${observed} must NOT auto-retry an unknown read`);
    assertEquals(d.huskRetries, 0, `observed=${observed} does not bump the husk counter`);
    assertEquals(d.reason, "no-advance");
    assert(d.question, `observed=${observed} escalates with a question`);
    assertStringIncludes(d.question ?? "", "PR head did not advance");
  }
});

test("decideProgress: a husk at the retry cap escalates with a husk-specific question and resets", () => {
  const d = decideProgress("addressed", "sha-1", "sha-1", 5, false, MAX_HUSK_RETRIES);
  assertEquals(d.progressed, false);
  assertEquals(d.huskRetry, false, "the cap is reached — no more auto-retries");
  assertEquals(d.huskRetries, 0, "the counter resets so a human-answered resume gets fresh retries");
  assertEquals(d.reason, "husk");
  assert(d.question, "an escalating husk carries a question");
  assertStringIncludes(d.question ?? "", "no durable work");
  assertStringIncludes(d.question ?? "", "did not help");
});

test("decideProgress: a no-advance round (agent DID run) escalates immediately — never auto-retries", () => {
  // A terminal agent-instance exists (agentWorkObserved=true): the agent ran but pushed nothing.
  // Re-running would loop on identical reasoning, so escalate straight away even with 0 retries used.
  const d = decideProgress("addressed", "sha-1", "sha-1", 4, true, 0);
  assertEquals(d.progressed, false);
  assertEquals(d.huskRetry, false, "a no-advance round is never auto-retried");
  assertEquals(d.reason, "no-advance");
  assert(d.question, "a no-advance round carries a question");
  assertStringIncludes(d.question ?? "", "PR head did not advance");
});

test("decideProgress: a legitimately non-addressed / unreadable-head round continues without a husk verdict", () => {
  for (const args of [
    ["waiting", "sha-1", "sha-1", 1, null, 0],
    ["addressed", null, "sha-1", 1, null, 0],
    ["addressed", "sha-1", null, 1, null, 0],
  ] as const) {
    const d = decideProgress(...args);
    assertEquals(d.progressed, true, `${JSON.stringify(args)} must continue`);
    assertEquals(d.reason, undefined);
    assertEquals(d.huskRetries, 0);
  }
});

test("decideProgress: a garbage carried husk-retry counter is coerced to 0", () => {
  for (const bad of [Number.NaN, -3, undefined, null] as const) {
    const d = decideProgress("addressed", "sha-1", "sha-1", 5, false, bad);
    assertEquals(d.huskRetry, true, `counter ${String(bad)} coerces to 0 -> under the cap`);
    assertEquals(d.huskRetries, 1);
  }
});

test("noProgressQuestion: husk vs no-advance render distinct, human-actionable reasons", () => {
  assertStringIncludes(noProgressQuestion(5, "husk", false), "no durable work");
  assertStringIncludes(noProgressQuestion(5, "no-advance", false), "PR head did not advance");
});

// ── The worker (with an injected head reader — never touches git/network) ────

function fakeApp(row?: { last_round_head: string | null }) {
  const updates: { key: string; patch: Record<string, unknown> }[] = [];
  const store = new Map<string, unknown>();
  if (row) store.set("o/r#1", { pr_key: "o/r#1", ...row });
  const app = {
    // The default agent-work reader consults app.engine.searchAgentInstances; the fake returns an
    // empty list (read-as-absence) so a no-progress round classifies as a husk unless a test injects
    // its own readAgentWork.
    engine: { async searchAgentInstances() { return []; } },
    data: {
      table(_name: string, _key: string) {
        return {
          async get(key: string) {
            return store.get(key);
          },
          async update(key: string, patch: Record<string, unknown>) {
            updates.push({ key, patch });
          },
        };
      },
    },
  };
  return { app, updates };
}

async function makeUnderTest(
  readHead: (repo: string, n: number) => Promise<string | null>,
  readAgentWork?: (pik: string | null | undefined, round: number) => Promise<boolean | null>,
) {
  const { makeHandler } = await import("../workers/progress-check/worker.ts");
  return makeHandler(readAgentWork ? { readHead, readAgentWork } : { readHead });
}

test("progress-check: skips the head read entirely for a non-addressed round", async () => {
  let called = false;
  const handler = await makeUnderTest(async () => {
    called = true;
    return "sha-2";
  });
  const { app, updates } = fakeApp({ last_round_head: "sha-1" });
  const out = await handler({ variables: { prKey: "o/r#1", status: "waiting", repo: "o/r", prNumber: 1 } } as any, app as any);
  assertEquals(out, { progressed: true, huskRetries: 0 });
  assertEquals(called, false, "a waiting round never reads the head");
  assertEquals(updates.length, 0, "and never rewrites the baseline");
});

test("progress-check: a blank/unknown status is treated as addressed — reads the head and can report no progress", async () => {
  let called = false;
  const handler = await makeUnderTest(async () => {
    called = true;
    return "sha-1";
  });
  const { app } = fakeApp({ last_round_head: "sha-1" });
  const out = await handler({ variables: { prKey: "o/r#1", status: "", repo: "o/r", prNumber: 1, round: 5, huskRetries: MAX_HUSK_RETRIES } } as any, app as any);
  assertEquals(out.progressed, false, "a blank-status no-progress round is caught, not waved through");
  assertEquals(called, true, "a blank status (the safe-default addressed trap) still reads the head");
});

test("progress-check: an addressed round whose head is unchanged with no agent work AUTO-RETRIES (husk) under the cap", async () => {
  // No terminal review-round agent-instance (injected false) => husk. Under the cap the worker
  // re-runs the same round instead of parking a human.
  const handler = await makeUnderTest(async () => "sha-1", async () => false);
  const { app } = fakeApp({ last_round_head: "sha-1" });
  const out = await handler({ variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 5, huskRetries: 0 } } as any, app as any);
  assertEquals(out.progressed, false);
  assertEquals(out.huskRetry, true, "the husk is auto-retried");
  assertEquals(out.huskRetries, 1);
  assertEquals(out.noProgressReason, "husk");
});

test("progress-check: an unchanged head with an UNKNOWN agent-work read (null) escalates as no-advance, never auto-retries", async () => {
  // A transient/unavailable AgentInstance read (injected null) must not be treated as a husk — it
  // fails safe to an immediate no-advance escalation so a read outage can never auto-retry (and
  // possibly duplicate) genuinely-completed agent work.
  const handler = await makeUnderTest(async () => "sha-1", async () => null);
  const { app } = fakeApp({ last_round_head: "sha-1" });
  const out = await handler({ variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 5, huskRetries: 0 } } as any, app as any);
  assertEquals(out.progressed, false);
  assertEquals(out.huskRetry, false, "an unknown read is never auto-retried");
  assertEquals(out.noProgressReason, "no-advance");
  assertStringIncludes(String(out.noProgressQuestion), "PR head did not advance");
});

test("progress-check: an unchanged head with a terminal agent-instance escalates as no-advance (never auto-retry)", async () => {
  const handler = await makeUnderTest(async () => "sha-1", async () => true);
  const { app } = fakeApp({ last_round_head: "sha-1" });
  const out = await handler({ variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 3, huskRetries: 0 } } as any, app as any);
  assertEquals(out.progressed, false);
  assertEquals(out.huskRetry, false, "a corroborated no-advance round is never auto-retried");
  assertEquals(out.noProgressReason, "no-advance");
  assertStringIncludes(String(out.noProgressQuestion), "PR head did not advance");
});

test("progress-check: an addressed round whose head advanced reports progressed:true and rebaselines", async () => {
  const handler = await makeUnderTest(async () => "sha-2");
  const { app, updates } = fakeApp({ last_round_head: "sha-1" });
  const out = await handler({ variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 2 } } as any, app as any);
  assertEquals(out.progressed, true);
  assertEquals(out.huskRetries, 0, "a progressing round resets the husk counter");
  assertEquals(updates.length, 1, "the observed head is recorded as the new baseline");
  assertEquals(updates[0]!.patch.last_round_head, "sha-2");
});

test("progress-check: the first observed round (no baseline) continues and records the baseline", async () => {
  const handler = await makeUnderTest(async () => "sha-1");
  const { app, updates } = fakeApp(); // no row yet -> previousHead null
  const out = await handler({ variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 1 } } as any, app as any);
  assertEquals(out.progressed, true, "no baseline yet fails open");
  assertEquals(updates[0]!.patch.last_round_head, "sha-1");
});

test("progress-check: an unreadable head fails open and does not clobber the baseline", async () => {
  const handler = await makeUnderTest(async () => null);
  const { app, updates } = fakeApp({ last_round_head: "sha-1" });
  const out = await handler({ variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 2 } } as any, app as any);
  assertEquals(out.progressed, true, "a null head fails open");
  assertEquals(updates.length, 0, "a null head never overwrites the good baseline");
});

test("progress-check: resolves repo/prNumber from the prKey when the vars are absent", async () => {
  let seen: [string, number] | null = null;
  const handler = await makeUnderTest(async (repo, n) => {
    seen = [repo, n];
    return "sha-2";
  });
  const { app } = fakeApp({ last_round_head: "sha-1" });
  await handler({ variables: { prKey: "o/r#1", status: "addressed", round: 2 } } as any, app as any);
  assertEquals(seen, ["o/r", 1], "falls back to parsing owner/repo#N from the prKey");
});

test("progress-check: only reads agent-instances on the no-advance path, not on a progressing round", async () => {
  let agentReads = 0;
  const handler = await makeUnderTest(async () => "sha-2", async () => {
    agentReads++;
    return true;
  });
  const { app } = fakeApp({ last_round_head: "sha-1" });
  await handler({ variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 2 } } as any, app as any);
  assertEquals(agentReads, 0, "an advancing head never wastes an engine read");
});

// ── Structural guard over the committed BPMN (no engine) ─────────────────────

const bpmn = readFileSync("resources/processes/convergence-loop.bpmn", "utf8");
const flat = bpmn.replace(/\s+/g, " ");

function flowElement(id: string): string | null {
  const re = new RegExp(
    `<bpmn:sequenceFlow\\b[^>]*?\\bid="${id}"[^>]*?(?:/>|>(?:(?!<bpmn:sequenceFlow\\b).)*?</bpmn:sequenceFlow>)`,
  );
  const m = flat.match(re);
  return m ? m[0] : null;
}

test("persist-round routes through check-progress before the review wait", () => {
  const f = flowElement("f_roundWait");
  assert(f, "f_roundWait flow missing");
  assertStringIncludes(f, 'sourceRef="persist-round"');
  assertStringIncludes(f, 'targetRef="check-progress"');
});

test("check-progress feeds the gw-progress gateway", () => {
  const f = flowElement("f_checkGate");
  assert(f, "f_checkGate flow missing");
  assertStringIncludes(f, 'sourceRef="check-progress"');
  assertStringIncludes(f, 'targetRef="gw-progress"');
  // The task runs the deterministic no-progress guard job.
  assertStringIncludes(flat, 'type="pr.progress-check"');
});

test("gw-progress routes a no-progress round into the husk gate on an explicit progressed = false condition", () => {
  const f = flowElement("f_noProgress");
  assert(f, "f_noProgress flow missing");
  assertStringIncludes(f, 'targetRef="gw-husk"');
  assertStringIncludes(f, "progressed = false");
});

test("gw-husk auto-retries a husk back into review-round, and defaults to the human escalation", () => {
  // #786: a husked round (no commit AND no terminal review-round agent-instance) is re-run onto a
  // healthy worker — bounded by the worker's huskRetries cap — before parking a human. The bound
  // lives in the pr.progress-check worker (app/roundProgress.ts decideProgress), so the gateway only
  // routes on the worker's `huskRetry` output.
  const gw = flat.match(/<bpmn:exclusiveGateway\b[^>]*\bid="gw-husk"[^>]*>/);
  assert(gw, "gw-husk gateway missing");
  assertStringIncludes(gw[0], 'default="f_huskEscalate"');
  const retry = flowElement("f_huskRetry");
  assert(retry, "f_huskRetry flow missing");
  assertStringIncludes(retry, 'sourceRef="gw-husk"');
  assertStringIncludes(retry, 'targetRef="review-round"');
  assertStringIncludes(retry, "huskRetry = true");
  const esc = flowElement("f_huskEscalate");
  assert(esc, "f_huskEscalate flow missing");
  assertStringIncludes(esc, 'sourceRef="gw-husk"');
  assertStringIncludes(esc, 'targetRef="persist-escalation-noprogress"');
  assert(!/conditionExpression/.test(esc), "the escalate arm is the unconditioned default");
  // The husk-retry re-enters review-round WITHOUT going through the round-incrementing review wait,
  // so it re-runs the SAME round rather than advancing the counter.
  const reviewRound = flat.match(/<bpmn:serviceTask\b[^>]*\bid="review-round"[^>]*>.*?<\/bpmn:serviceTask>/);
  assert(reviewRound, "review-round task missing");
  assertStringIncludes(reviewRound[0], "<bpmn:incoming>f_huskRetry</bpmn:incoming>");
});

test("gw-progress default arm re-enters the review wait with no condition", () => {
  const gw = flat.match(/<bpmn:exclusiveGateway\b[^>]*\bid="gw-progress"[^>]*>/);
  assert(gw, "gw-progress gateway missing");
  assertStringIncludes(gw[0], 'default="f_progressOk"');
  const ok = flowElement("f_progressOk");
  assert(ok, "f_progressOk flow missing");
  assertStringIncludes(ok, 'targetRef="gw-review-wait"');
  assert(!/conditionExpression/.test(ok), "the default arm must carry no conditionExpression");
});

test("the no-progress escalation routes through gw-escalated toward the human wait-answer task", () => {
  // #333: the arm no longer flows UNCONDITIONALLY into wait-answer — it routes through the
  // gw-escalated guard, which parks wait-answer only when the worker opened a real escalation
  // (escalated=true) and otherwise re-enters the loop (never a dead wait with a null question).
  const f = flowElement("f_noprogressGate");
  assert(f, "f_noprogressGate flow missing");
  assertStringIncludes(f, 'sourceRef="persist-escalation-noprogress"');
  assertStringIncludes(f, 'targetRef="gw-escalated"');
  // It opens a real, answerable escalation (blocked status + a concrete question) so it is never a
  // blank-question non-escalation that would wedge the token on the wait.
  const task = flat.match(
    /<bpmn:serviceTask\b[^>]*\bid="persist-escalation-noprogress"[^>]*>.*?<\/bpmn:serviceTask>/,
  );
  assert(task, "persist-escalation-noprogress task missing");
  assertStringIncludes(task[0], 'type="pr.persist-escalation"');
  assertStringIncludes(task[0], 'target="status"');
  assertStringIncludes(task[0], 'target="question"');
  // It must NOT double-record the round persist-round already recorded.
  assertStringIncludes(task[0], 'target="recordRound"');
});
