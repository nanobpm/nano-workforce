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

test("decideProgress: a NO-BASELINE addressed round is a husk ONLY when the completing instance is corroborated non-terminal (agentWork=false); a terminal/unknown read still fails open", () => {
  // #786 first-round-husk gap: with no baseline (previousHead null) the head-diff can't see a
  // no-advance, but a husked completing attempt (agentWork === false) is head-independent, so it must
  // still be classified as a husk and retried — NOT waved through as progress. A terminal (true) or
  // unknown (null/undefined) read must stay fail-open, because without a baseline a terminal
  // completing attempt could equally have pushed a commit (real progress).
  const husk = decideProgress("addressed", null, "sha-1", 1, false, 0);
  assertEquals(husk.progressed, false, "a corroborated no-baseline husk is not progress");
  assertEquals(husk.huskRetry, true, "it auto-retries the same round under the cap");
  assertEquals(husk.reason, "husk");
  for (const agentWork of [true, null, undefined] as const) {
    const d = decideProgress("addressed", null, "sha-1", 1, agentWork, 0);
    assertEquals(d.progressed, true, `no baseline + agentWork=${String(agentWork)} fails open`);
    assertEquals(d.reason, undefined, "a non-corroborated no-baseline round carries no husk verdict");
  }
  // At the husk cap a no-baseline husk escalates (never loops forever), with the husk-specific question.
  const capped = decideProgress("addressed", null, "sha-1", 4, false, MAX_HUSK_RETRIES);
  assertEquals(capped.progressed, false);
  assertEquals(capped.huskRetry, false, "at the cap it escalates to a human");
  assertEquals(capped.reason, "husk");
  assertStringIncludes(String(capped.question), "no durable work");
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

function fakeApp(
  row?: ({ last_round_head: string | null } & Record<string, unknown>) | undefined,
  searchAgentInstances: (arg: unknown) => Promise<unknown[]> = async () => [],
) {
  const updates: { key: string; patch: Record<string, unknown> }[] = [];
  const store = new Map<string, Record<string, unknown>>();
  if (row) store.set("o/r#1", { pr_key: "o/r#1", ...row });
  const app = {
    // The default agent-work reader consults app.engine.searchAgentInstances; the fake returns an
    // empty list (read-as-absence → availability probe → null → no-advance) by default so a test
    // exercises the AVAILABILITY-AWARE default reader unless it injects its own readAgentWork or a
    // non-empty instance list.
    engine: { searchAgentInstances },
    data: {
      table(_name: string, _key: string) {
        return {
          async get(key: string) {
            return store.get(key);
          },
          async update(key: string, patch: Record<string, unknown>) {
            updates.push({ key, patch });
            // Apply the patch so a redelivery in the SAME test observes the committed baseline +
            // idempotency stamp — the faithful double for the at-least-once replay guard (#789).
            store.set(key, { ...(store.get(key) ?? { pr_key: key }), ...patch });
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

test("progress-check: a non-addressed round records the baseline but never escalates or reads agent-work", async () => {
  // Post-#786 the head read + baseline write happen for EVERY round (so the first `addressed` round
  // has a baseline to compare against), but a non-addressed `waiting` round still short-circuits to
  // progressed:true and never consults the agent-work channel.
  let called = false;
  let agentReads = 0;
  const handler = await makeUnderTest(
    async () => {
      called = true;
      return "sha-2";
    },
    async () => {
      agentReads++;
      return false;
    },
  );
  const { app, updates } = fakeApp({ last_round_head: "sha-1" });
  const out = await handler({ processInstanceKey: "pik", variables: { prKey: "o/r#1", status: "waiting", repo: "o/r", prNumber: 1 } } as any, app as any);
  assertEquals(out, { progressed: true, huskRetries: 0 });
  assertEquals(called, true, "a waiting round reads the head to seed the baseline");
  assertEquals(agentReads, 0, "but never consults the agent-work channel");
  // ONE atomic write now (Copilot #789): the baseline head advance and the review-wait PARK are
  // folded into a single row update so a redelivery can't observe a half-state. persist-round no
  // longer parks — pr.progress-check is the single writer of `waiting_review` (#786).
  assertEquals(updates.length, 1, "records the baseline and parks for review in one atomic write");
  assertEquals(updates[0]!.patch.last_round_head, "sha-2", "the observed head is the new baseline");
  assertEquals(updates[0]!.patch.status, "waiting_review", "the round parks for review");
  assertEquals(typeof updates[0]!.patch.waiting_since, "string", "and stamps the review-wait start");
});

test("progress-check: a blank/unknown status is treated as addressed — reads the head and can report no progress", async () => {
  let called = false;
  const handler = await makeUnderTest(async () => {
    called = true;
    return "sha-1";
  });
  const { app } = fakeApp({ last_round_head: "sha-1" });
  const out = await handler({ processInstanceKey: "pik", variables: { prKey: "o/r#1", status: "", repo: "o/r", prNumber: 1, round: 5, huskRetries: MAX_HUSK_RETRIES } } as any, app as any);
  assertEquals(out.progressed, false, "a blank-status no-progress round is caught, not waved through");
  assertEquals(called, true, "a blank status (the safe-default addressed trap) still reads the head");
});

test("progress-check: an addressed round whose head is unchanged with no agent work AUTO-RETRIES (husk) under the cap", async () => {
  // No terminal review-round agent-instance (injected false) => husk. Under the cap the worker
  // re-runs the same round instead of parking a human.
  const handler = await makeUnderTest(async () => "sha-1", async () => false);
  const { app, updates } = fakeApp({ last_round_head: "sha-1" });
  const out = await handler({ processInstanceKey: "pik", variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 5, huskRetries: 0 } } as any, app as any);
  assertEquals(out.progressed, false);
  assertEquals(out.huskRetry, true, "the husk is auto-retried");
  assertEquals(out.huskRetries, 1);
  assertEquals(out.noProgressReason, "husk");
  // Poller non-interference (#786): the retry keeps the PR on a running `converging` status (never a
  // transient `waiting_review`) so pollReviews can't solicit a spurious review while the retried
  // round re-enters review-round. persist-round no longer parks, so this is the ONLY status write.
  const parked = updates.find((u) => u.patch.status === "waiting_review");
  assertEquals(parked, undefined, "a husk-retry round NEVER transits waiting_review");
  const statusUpdate = updates.find((u) => u.patch.status !== undefined);
  assert(statusUpdate, "a husk retry must update the PR status");
  assertEquals(statusUpdate!.patch.status, "converging", "the retry flips the PR to a running status");
});

test("progress-check: an unchanged head with an UNKNOWN agent-work read (null) escalates as no-advance, never auto-retries", async () => {
  // A transient/unavailable AgentInstance read (injected null) must not be treated as a husk — it
  // fails safe to an immediate no-advance escalation so a read outage can never auto-retry (and
  // possibly duplicate) genuinely-completed agent work.
  const handler = await makeUnderTest(async () => "sha-1", async () => null);
  const { app } = fakeApp({ last_round_head: "sha-1" });
  const out = await handler({ processInstanceKey: "pik", variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 5, huskRetries: 0 } } as any, app as any);
  assertEquals(out.progressed, false);
  assertEquals(out.huskRetry, false, "an unknown read is never auto-retried");
  assertEquals(out.noProgressReason, "no-advance");
  assertStringIncludes(String(out.noProgressQuestion), "PR head did not advance");
});

test("progress-check: an unchanged head with a terminal agent-instance escalates as no-advance (never auto-retry)", async () => {
  const handler = await makeUnderTest(async () => "sha-1", async () => true);
  const { app } = fakeApp({ last_round_head: "sha-1" });
  const out = await handler({ processInstanceKey: "pik", variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 3, huskRetries: 0 } } as any, app as any);
  assertEquals(out.progressed, false);
  assertEquals(out.huskRetry, false, "a corroborated no-advance round is never auto-retried");
  assertEquals(out.noProgressReason, "no-advance");
  assertStringIncludes(String(out.noProgressQuestion), "PR head did not advance");
});

test("progress-check: an addressed round whose head advanced reports progressed:true and rebaselines", async () => {
  const handler = await makeUnderTest(async () => "sha-2");
  const { app, updates } = fakeApp({ last_round_head: "sha-1" });
  const out = await handler({ processInstanceKey: "pik", variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 2 } } as any, app as any);
  assertEquals(out.progressed, true);
  assertEquals(out.huskRetries, 0, "a progressing round resets the husk counter");
  // ONE atomic write (Copilot #789): the rebaseline and the review-wait PARK are a single row
  // update so a redelivery can't see the advanced baseline without the park. progress-check owns
  // `waiting_review` now (#786).
  assertEquals(updates.length, 1, "the observed head is rebaselined and parked in one atomic write");
  assertEquals(updates[0]!.patch.last_round_head, "sha-2");
  assertEquals(updates[0]!.patch.status, "waiting_review", "a progressed round parks for review");
  assertEquals(typeof updates[0]!.patch.waiting_since, "string", "and stamps the review-wait start");
});

test("progress-check: a lost completion-ack REDELIVERS the same job — the recorded outcome is replayed, not recomputed against the advanced baseline (idempotent)", async () => {
  // Copilot #789 (engine at-least-once delivery): a progressed round advances `last_round_head` to
  // the new head. If its completion-ack is LOST the engine redelivers the SAME job key. Without the
  // idempotency guard the redelivery reads the just-advanced baseline as `previousHead`, sees the
  // (still-unchanged) head as "no advance", and mis-ESCALATES an already-progressed round. The guard
  // must recognize its own job key and REPLAY the recorded progressed outcome, making no new write
  // and never consulting the agent-work channel.
  let agentReads = 0;
  const readAgentWork = async () => {
    agentReads++;
    return null; // would drive a no-advance ESCALATION if the guard let it recompute
  };
  // Head reader returns the SAME advanced head on both deliveries (no new push between them).
  const handler = await makeUnderTest(async () => "sha-2", readAgentWork);
  const { app, updates } = fakeApp({ last_round_head: "sha-1" });

  // First delivery: an addressed round whose head advanced → progressed:true, stamps the baseline +
  // idempotency record atomically.
  const first = await handler(
    { jobKey: "job-1", processInstanceKey: "pik", variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 2, huskRetries: 0 } } as any,
    app as any,
  );
  assertEquals(first.progressed, true, "the first delivery sees the advance and progresses");
  const writesAfterFirst = updates.length;
  assertEquals(agentReads, 1, "a progressing round reads agent-work once to maintain the attempt watermark (#789)");

  // Second delivery: the SAME job key redelivered after a lost ack. The baseline is now "sha-2" and
  // the head is unchanged, so a RECOMPUTE would read "no advance" and escalate. The guard must
  // replay the recorded progressed outcome instead.
  const replay = await handler(
    { jobKey: "job-1", processInstanceKey: "pik", variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 2, huskRetries: 0 } } as any,
    app as any,
  );
  assertEquals(replay.progressed, true, "the redelivery REPLAYS progressed:true, never mis-escalates");
  assertEquals(replay.huskRetry, undefined, "the replay is not a no-advance/husk escalation");
  assertEquals(agentReads, 1, "the replay short-circuits before recomputing, so it adds no further read");
  assertEquals(updates.length, writesAfterFirst, "the replay makes no new write (pure replay)");
});

test("progress-check: the first observed round (no baseline) continues and records the baseline", async () => {
  const handler = await makeUnderTest(async () => "sha-1");
  const { app, updates } = fakeApp(); // no row yet -> previousHead null
  const out = await handler({ processInstanceKey: "pik", variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 1 } } as any, app as any);
  assertEquals(out.progressed, true, "no baseline yet fails open");
  assertEquals(updates[0]!.patch.last_round_head, "sha-1");
});

test("progress-check: a FIRST addressed round with NO baseline whose completing instance husked (non-terminal) is retried, not waved through as progress (#786 first-round-husk gap)", async () => {
  // Copilot #789: with `last_round_head` null (a fresh submission, or after a transient waiting-round
  // baseline-read failure) the head-diff can't see a no-advance, so the worker previously failed open
  // and treated a first-addressed-round husk as PROGRESS — bypassing gw-husk. The completing
  // review-round instance husking (agentWork=false) is head-independent, so it must be corroborated
  // even with no baseline and auto-retried.
  const handler = await makeUnderTest(async () => "sha-1", async () => false);
  const { app } = fakeApp(); // no row yet -> previousHead null
  const out = await handler({ processInstanceKey: "pik", variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 1, huskRetries: 0 } } as any, app as any);
  assertEquals(out.progressed, false, "a first-round husk is NOT waved through as progress");
  assertEquals(out.huskRetry, true, "the first-round husk auto-retries the same round");
  assertEquals(out.noProgressReason, "husk");
});

test("progress-check: a FIRST addressed round with NO baseline whose completing instance is terminal fails open (a terminal attempt may have pushed — no false no-advance)", async () => {
  // The mirror safety case: without a baseline a TERMINAL completing attempt could equally have
  // pushed a commit, so it must NOT be escalated as a no-advance — only a corroborated husk acts.
  const handler = await makeUnderTest(async () => "sha-1", async () => true);
  const { app } = fakeApp(); // no baseline
  const out = await handler({ processInstanceKey: "pik", variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 1, huskRetries: 0 } } as any, app as any);
  assertEquals(out.progressed, true, "a no-baseline terminal attempt fails open (may have pushed)");
  assertEquals(out.huskRetry, undefined);
  assertEquals(out.noProgressReason, undefined);
});

test("progress-check: an unreadable head fails open and does not clobber the baseline", async () => {
  const handler = await makeUnderTest(async () => null);
  const { app, updates } = fakeApp({ last_round_head: "sha-1" });
  const out = await handler({ processInstanceKey: "pik", variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 2 } } as any, app as any);
  assertEquals(out.progressed, true, "a null head fails open");
  // A null head is never written as a baseline (it must not clobber the good `last_round_head`), but
  // the round still fails OPEN to the review wait, so progress-check parks it (persist-round no
  // longer does). The single write is therefore the PARK, carrying no `last_round_head`.
  assertEquals(updates.length, 1, "only the review-wait park is written");
  assertEquals(updates[0]!.patch.last_round_head, undefined, "a null head never overwrites the baseline");
  assertEquals(updates[0]!.patch.status, "waiting_review", "a fail-open round still parks for review");
});

test("progress-check: resolves repo/prNumber from the prKey when the vars are absent", async () => {
  let seen: [string, number] | null = null;
  const handler = await makeUnderTest(async (repo, n) => {
    seen = [repo, n];
    return "sha-2";
  });
  const { app } = fakeApp({ last_round_head: "sha-1" });
  await handler({ processInstanceKey: "pik", variables: { prKey: "o/r#1", status: "addressed", round: 2 } } as any, app as any);
  assertEquals(seen, ["o/r", 1], "falls back to parsing owner/repo#N from the prKey");
});

test("progress-check: reads agent-instances on EVERY addressed round (incl. a progressing one) to maintain the attempt watermark (#789)", async () => {
  // Copilot #789: the husk verdict is only consulted on the no-advance path, but the read must ALSO
  // run on a progressing round so its fresh `review-round` instance is CONSUMED into the watermark —
  // otherwise the next round's pre-registration husk would see that stale terminal instance as
  // "newer than the watermark" and mis-escalate. The advancing head still fails open to progress.
  let agentReads = 0;
  const handler = await makeUnderTest(async () => "sha-2", async () => {
    agentReads++;
    return true;
  });
  const { app } = fakeApp({ last_round_head: "sha-1" });
  const out = await handler({ processInstanceKey: "pik", variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 2 } } as any, app as any);
  assertEquals(agentReads, 1, "a progressing round still reads once to advance the attempt watermark");
  assertEquals(out.progressed, true, "an advancing head is still progress regardless of the read");
});

test("progress-check: an unreadable head skips the agent-work read (nothing to correlate)", async () => {
  let agentReads = 0;
  const handler = await makeUnderTest(async () => null, async () => {
    agentReads++;
    return true;
  });
  const { app } = fakeApp({ last_round_head: "sha-1" });
  const out = await handler({ processInstanceKey: "pik", variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 2 } } as any, app as any);
  assertEquals(agentReads, 0, "an unreadable head has nothing to correlate, so no read");
  assertEquals(out.progressed, true, "an unreadable head fails open to progress");
});

// ── The DEFAULT (availability-aware) agent-work reader over app.engine.searchAgentInstances ──────
// These exercise agentWorkFromEngine directly (no injected readAgentWork), via fakeApp's injectable
// engine, to lock the Option 1 (#786) semantics: BOTH-empty→unknown→no-advance; scoped-empty-but-
// channel-present→husk; non-terminal→husk; all-terminal→no-advance; correlation is by the COMPLETING
// element-instance, not a round count.

test("progress-check default reader: a WHOLLY-empty process instance (absent channel) fails safe to no-advance, never a husk", async () => {
  // Two-tier availability probe: on a channel-absent engine (the testkit double returns [] for EVERY
  // search — both the scoped review-round query AND the process-wide probe) the channel is UNKNOWN,
  // so empty ⇒ no-advance — NOT a husk auto-retry that could loop forever on a non-agentic engine.
  const handler = await makeUnderTest(async () => "sha-1"); // no injected readAgentWork -> default
  const { app } = fakeApp({ last_round_head: "sha-1" }, async () => []);
  const out = await handler({ processInstanceKey: "pik", variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 5, huskRetries: 0 } } as any, app as any);
  assertEquals(out.progressed, false);
  assertEquals(out.huskRetry, false, "an absent channel must never auto-retry");
  assertEquals(out.noProgressReason, "no-advance");
});

test("progress-check default reader: an empty review-round search but a CHANNEL-PRESENT process (another agent instance exists) ⇒ husk — the round husked before registering (#789)", async () => {
  // Copilot #789: review-round is an external-agent serviceTask, so a job that husks BEFORE the
  // worker registers its AgentInstance mints NOTHING — the scoped search is empty even on a
  // channel-present engine. The process-wide probe disambiguates: another agent instance (e.g.
  // classify-scope, or an earlier round) proves the channel is PRESENT, so the empty review-round is
  // a genuine husk (auto-retry), not an absent channel.
  const handler = await makeUnderTest(async () => "sha-1");
  const { app } = fakeApp({ last_round_head: "sha-1" }, async (arg) => {
    // Filter-aware double: the scoped review-round query is EMPTY (the round husked pre-registration),
    // but the process-wide probe returns a classify-scope instance (channel present).
    const f = (arg ?? {}) as { elementId?: string };
    if (f.elementId === "review-round") return [];
    return [{ status: "completed", completionDate: "2024-01-01T00:00:00Z", elementInstanceKeys: ["50"] }];
  });
  const out = await handler({ processInstanceKey: "pik", variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 5, huskRetries: 0 } } as any, app as any);
  assertEquals(out.progressed, false);
  assertEquals(out.huskRetry, true, "a channel-present empty review-round is a husk, so it auto-retries");
  assertEquals(out.noProgressReason, "husk");
});

test("progress-check default reader: a non-terminal review-round instance ⇒ husk (auto-retry under cap)", async () => {
  // Channel present, the completing attempt (newest element-instance) is stuck non-terminal
  // (husked) => false => husk. The stale terminal instance is an EARLIER attempt (lower key).
  const handler = await makeUnderTest(async () => "sha-1");
  const { app } = fakeApp({ last_round_head: "sha-1" }, async () => [
    { status: "completed", completionDate: "2024-01-01T00:00:00Z", elementInstanceKeys: ["100"] },
    { status: "THINKING", completionDate: null, elementInstanceKeys: ["200"] },
  ]);
  const out = await handler({ processInstanceKey: "pik", variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 5, huskRetries: 0 } } as any, app as any);
  assertEquals(out.progressed, false);
  assertEquals(out.huskRetry, true, "a non-terminal completing attempt is a husk");
  assertEquals(out.noProgressReason, "husk");
});

test("progress-check default reader: ALL-terminal review-round instances ⇒ no-advance (never auto-retry)", async () => {
  // Channel present, every instance (including the completing attempt) is terminal => true =>
  // genuine no-advance — the agent ran to completion but produced no head change, a human question.
  const handler = await makeUnderTest(async () => "sha-1");
  const { app } = fakeApp({ last_round_head: "sha-1" }, async () => [
    { status: "completed", completionDate: "2024-01-01T00:00:00Z", elementInstanceKeys: ["100"] },
    { status: "failed", completionDate: "2024-01-02T00:00:00Z", elementInstanceKeys: ["200"] },
  ]);
  const out = await handler({ processInstanceKey: "pik", variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 5, huskRetries: 0 } } as any, app as any);
  assertEquals(out.progressed, false);
  assertEquals(out.huskRetry, false, "an all-terminal round is a genuine no-advance, not a husk");
  assertEquals(out.noProgressReason, "no-advance");
});

test("progress-check default reader: a STALE non-terminal prior attempt does NOT mask a terminal completing attempt (no false husk)", async () => {
  // #786 correlation defect: `.every(isTerminalInstance)` over ALL historical instances mis-flags a
  // genuine no-advance as a husk whenever an EARLIER attempt is still stuck non-terminal. The newest
  // element-instance (greatest engine key) is the COMPLETING attempt and it is terminal => no-advance,
  // regardless of the stale husked prior instance.
  const handler = await makeUnderTest(async () => "sha-1");
  const { app } = fakeApp({ last_round_head: "sha-1" }, async () => [
    { status: "THINKING", completionDate: null, elementInstanceKeys: ["100"] }, // stale prior husk
    { status: "completed", completionDate: "2024-01-02T00:00:00Z", elementInstanceKeys: ["200"] }, // newest, terminal
  ]);
  const out = await handler({ processInstanceKey: "pik", variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 5, huskRetries: 0 } } as any, app as any);
  assertEquals(out.progressed, false);
  assertEquals(out.huskRetry, false, "a stale non-terminal prior attempt must not fabricate a husk");
  assertEquals(out.noProgressReason, "no-advance");
});

test("progress-check default reader: a same-round husk AFTER an earlier terminal attempt is a husk (newest instance wins)", async () => {
  // The mirror case: an earlier attempt in this round ran to a terminal instance, then a resume
  // husked. The newest element-instance (greatest engine key) is the non-terminal resume => husk,
  // not masked by the earlier terminal instance.
  const handler = await makeUnderTest(async () => "sha-1");
  const { app } = fakeApp({ last_round_head: "sha-1" }, async () => [
    { status: "completed", completionDate: "2024-01-01T00:00:00Z", elementInstanceKeys: ["300"] }, // earlier terminal
    { status: "THINKING", completionDate: null, elementInstanceKeys: ["400"] }, // newest, husked
  ]);
  const out = await handler({ processInstanceKey: "pik", variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 5, huskRetries: 0 } } as any, app as any);
  assertEquals(out.progressed, false);
  assertEquals(out.huskRetry, true, "the newest attempt husked, so the round is a husk");
  assertEquals(out.noProgressReason, "husk");
});

test("progress-check default reader: an engine read that THROWS degrades to no-advance (unknown), never a husk", async () => {
  const handler = await makeUnderTest(async () => "sha-1");
  const { app } = fakeApp({ last_round_head: "sha-1" }, async () => {
    throw new Error("engine unreachable");
  });
  const out = await handler({ processInstanceKey: "pik", variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 5, huskRetries: 0 } } as any, app as any);
  assertEquals(out.progressed, false);
  assertEquals(out.huskRetry, false, "a read outage must never auto-retry");
  assertEquals(out.noProgressReason, "no-advance");
});

test("progress-check default reader: a prior round's TERMINAL instance does NOT mask a current pre-registration husk (#789)", async () => {
  // Copilot #789 suppressed comment (worker.ts:184): if an earlier round's `review-round` instance
  // is terminal and the CURRENT attempt husks BEFORE registering any AgentInstance, the scoped
  // search still returns that earlier terminal row as `newest` — which, read naively, returns `true`
  // and routes to a no-advance escalation, BYPASSING the bounded husk retry. The attempt watermark
  // fixes it: the persisted watermark (100) already ACCOUNTED FOR that terminal instance, so a scoped
  // search whose greatest key is still 100 (no NEWER instance) means the current attempt registered
  // nothing new — a genuine husk (auto-retry), not a no-advance.
  const handler = await makeUnderTest(async () => "sha-1");
  const { app, updates } = fakeApp(
    { last_round_head: "sha-1", last_progress_agent_watermark: "100" },
    async () => [
      { status: "completed", completionDate: "2024-01-01T00:00:00Z", elementInstanceKeys: ["100"] }, // prior terminal, already consumed
    ],
  );
  const out = await handler({ processInstanceKey: "pik", variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 6, huskRetries: 0 } } as any, app as any);
  assertEquals(out.progressed, false);
  assertEquals(out.huskRetry, true, "no instance newer than the watermark ⇒ the current attempt husked pre-registration");
  assertEquals(out.noProgressReason, "husk");
  // The watermark stays where it was — nothing new was consumed.
  const wm = updates.at(-1)?.patch.last_progress_agent_watermark;
  assertEquals(wm, "100", "a pre-registration husk leaves the watermark unchanged");
});

test("progress-check default reader: a NEW terminal attempt past the watermark ⇒ no-advance and ADVANCES the watermark (#789)", async () => {
  // The complement: the current attempt DID register (a `review-round` instance keyed 200, newer than
  // the watermark 100), and it is terminal — a genuine no-advance. The watermark advances to 200 so
  // the NEXT round can tell the attempt after it from this one.
  const handler = await makeUnderTest(async () => "sha-1");
  const { app, updates } = fakeApp(
    { last_round_head: "sha-1", last_progress_agent_watermark: "100" },
    async () => [
      { status: "completed", completionDate: "2024-01-01T00:00:00Z", elementInstanceKeys: ["100"] }, // prior, consumed
      { status: "completed", completionDate: "2024-01-02T00:00:00Z", elementInstanceKeys: ["200"] }, // fresh terminal attempt
    ],
  );
  const out = await handler({ processInstanceKey: "pik", variables: { prKey: "o/r#1", status: "addressed", repo: "o/r", prNumber: 1, round: 6, huskRetries: 0 } } as any, app as any);
  assertEquals(out.progressed, false);
  assertEquals(out.huskRetry, false, "a fresh terminal attempt is a genuine no-advance");
  assertEquals(out.noProgressReason, "no-advance");
  const wm = updates.at(-1)?.patch.last_progress_agent_watermark;
  assertEquals(wm, "200", "consuming a fresh attempt advances the watermark");
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

// ── makeDefaultReadHead: the real head reader's branch-ref-over-stale-head.sha preference ─────────
// #786 regression guard: the handler tests inject `readHead`, and app/github.test.ts exercises
// fetchBranchHead in isolation, so nothing pinned the DEFAULT reader's wiring — a change that stopped
// reading the branch ref, or fell back to the PR object's denormalized head.sha, would leave the
// suite green. These drive makeDefaultReadHead with injected fetchers to lock that contract.
async function makeReader(deps: {
  fetchPrHead: (repo: string, n: number | string, token: string) => Promise<{ headRef: string | null; headSha: string | null; baseRef: string | null; headRepo: string | null } | null>;
  fetchBranchHead: (repo: string, branch: string, token: string) => Promise<string | null>;
}) {
  const { makeDefaultReadHead } = await import("../workers/progress-check/worker.ts");
  return makeDefaultReadHead(deps as any);
}

test("makeDefaultReadHead: prefers the atomic branch ref over a stale PR head.sha", async () => {
  let branchReads = 0;
  const read = await makeReader({
    fetchPrHead: async () => ({ headRef: "feat/x", headSha: "stale-denormalized-sha", baseRef: "main", headRepo: "o/r" }),
    fetchBranchHead: async (_r, branch) => {
      branchReads++;
      assertEquals(branch, "feat/x", "the branch ref read targets the PR's head ref");
      return "fresh-atomic-sha";
    },
  });
  assertEquals(await read("o/r", 1), "fresh-atomic-sha", "the branch ref SHA wins over the stale head.sha");
  assertEquals(branchReads, 1, "the branch ref was actually consulted");
});

test("makeDefaultReadHead: a failed branch-ref read fails OPEN to null, never falling back to head.sha", async () => {
  const read = await makeReader({
    fetchPrHead: async () => ({ headRef: "feat/x", headSha: "stale-sha", baseRef: "main", headRepo: "o/r" }),
    fetchBranchHead: async () => {
      throw new Error("ref 404 / transport hiccup");
    },
  });
  assertEquals(await read("o/r", 1), null, "a ref-read failure must not fall back to the denormalized head.sha");
});

test("makeDefaultReadHead: with NO head ref (e.g. detached) falls back to the PR head.sha", async () => {
  let branchReads = 0;
  const read = await makeReader({
    fetchPrHead: async () => ({ headRef: null, headSha: "only-head-sha", baseRef: "main", headRepo: "o/r" }),
    fetchBranchHead: async () => {
      branchReads++;
      return "unused";
    },
  });
  assertEquals(await read("o/r", 1), "only-head-sha", "with no head ref the PR head.sha is the only signal");
  assertEquals(branchReads, 0, "the branch ref is not read when there is no head ref");
});

test("makeDefaultReadHead: an unreadable PR (null) fails OPEN to null", async () => {
  const read = await makeReader({
    fetchPrHead: async () => null,
    fetchBranchHead: async () => "never",
  });
  assertEquals(await read("o/r", 1), null, "a null PR read fails open (the guard treats null as continue)");
});

test("makeDefaultReadHead: a fork PR reads the FORK repo's ref, not the (colliding) base-repo ref (#786)", async () => {
  // A cross-repo PR whose head branch shares a name with a base-repo branch: querying the base repo
  // would read the unrelated base-branch SHA. The reader must target the head branch's OWNING repo.
  const queried: Array<{ repo: string; branch: string }> = [];
  const read = await makeReader({
    fetchPrHead: async () => ({ headRef: "feat/x", headSha: "sha", baseRef: "main", headRepo: "fork-owner/r" }),
    fetchBranchHead: async (repo, branch) => {
      queried.push({ repo, branch });
      return repo === "fork-owner/r" ? "fork-head-sha" : "unrelated-base-sha";
    },
  });
  assertEquals(await read("base-owner/r", 1), "fork-head-sha", "the head ref is resolved in the fork, not the base repo");
  assertEquals(queried, [{ repo: "fork-owner/r", branch: "feat/x" }], "the branch ref read targets the fork repository");
});

test("makeDefaultReadHead: an unresolvable head repository (deleted fork) fails OPEN to null (#786)", async () => {
  let branchReads = 0;
  const read = await makeReader({
    fetchPrHead: async () => ({ headRef: "feat/x", headSha: "sha", baseRef: "main", headRepo: null }),
    fetchBranchHead: async () => {
      branchReads++;
      return "never";
    },
  });
  assertEquals(await read("o/r", 1), null, "a null head repo fails open rather than falling back to the base repo");
  assertEquals(branchReads, 0, "no base-repo branch read is attempted when the head repo is unresolvable");
});
