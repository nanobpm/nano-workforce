// Red/green regression for pr.persist-escalation's round-recording (PR #32 review).
//
// The "review stalled" timer arm runs *after* `persist-round` has already inserted an
// `addressed` row for this `round`. Re-inserting a `rounds` row there would record one round as
// both `addressed` and `blocked`, making round history/UI ambiguous. The stalled arm therefore
// passes `recordRound=false`, which must suppress the round insert while still opening the
// escalation. The agent-raised / max-rounds arms omit the flag (no prior round row) and must
// still record the round.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import handler from "../workers/persist-escalation/worker.ts";

function fakeApp() {
  const inserts: Record<string, unknown[]> = { rounds: [], escalations: [] };
  const updates: Record<string, unknown[]> = { pull_requests: [] };
  const rows: Record<string, Map<string, unknown>> = {};
  const app = {
    data: {
      table(name: string, _key: string) {
        const store = (rows[name] ??= new Map());
        return {
          async get(key: string) {
            return store.get(key);
          },
          async insert(row: unknown) {
            (inserts[name] ??= []).push(row);
            const pk = name === "escalations" ? "id" : name === "rounds" ? "id" : "pr_key";
            store.set((row as any)[pk], row);
            return name === "escalations" ? 42 : 1;
          },
          async update(key: string, patch: unknown) {
            (updates[name] ??= []).push({ key, patch });
          },
        };
      },
    },
  };
  return { app, inserts, updates, rows };
}

test("stalled arm (recordRound=false) does not insert a duplicate rounds row", async () => {
  const { app, inserts } = fakeApp();
  const job = {
    variables: { prKey: "o/r#1", round: 3, status: "blocked", question: "stalled", recordRound: false },
  };
  const out = await handler(job as any, app as any);
  assertEquals(inserts.rounds.length, 0, "no round row when the round was already recorded");
  assertEquals(inserts.escalations.length, 1, "escalation is still opened");
  assertEquals((out as any).escalationId, 42);
});

test("escalation arm without the flag still records the round", async () => {
  const { app, inserts } = fakeApp();
  const job = { variables: { prKey: "o/r#1", round: 3, status: "blocked", question: "max rounds" } };
  await handler(job as any, app as any);
  assertEquals(inserts.rounds.length, 1);
  assertEquals((inserts.rounds[0] as any).round_no, 3);
});

// The servicing worker name (harness `agent` var) is stamped on both the round it recorded and
// the escalation it opened, so the durable history identifies who did the work.
test("persist-escalation records the servicing worker on the round and escalation", async () => {
  const { app, inserts } = fakeApp();
  const job = {
    variables: { prKey: "o/r#1", round: 3, status: "blocked", question: "max rounds", agent: "senior" },
  };
  await handler(job as any, app as any);
  assertEquals((inserts.rounds[0] as any).worker, "senior", "the round carries the worker name");
  assertEquals((inserts.escalations[0] as any).worker, "senior", "the escalation carries the worker name");
});

// When the convergence-loop passes repo/prNumber and the FK parent is missing (engine/app.db
// desync), persist-escalation reconstructs the `pull_requests` row before the rounds/escalations
// inserts so opening an escalation never dies with an opaque FOREIGN KEY constraint failure.
test("persist-escalation heals a missing pull_requests parent before recording", async () => {
  const { app, inserts, updates } = fakeApp();
  const job = {
    variables: {
      prKey: "o/r#8",
      round: 4,
      status: "blocked",
      question: "max rounds",
      repo: "o/r",
      prNumber: 8,
    },
  };
  await handler(job as any, app as any);
  assertEquals(inserts.pull_requests?.length, 1, "the missing parent is reconstructed");
  // Assert against the reconstruction insert payload (ensurePr) rather than the stored row: the
  // fake update() doesn't apply patches, so the row would otherwise still read the insert's
  // "converging" status and mask the worker's real final state.
  const healed = inserts.pull_requests![0] as any;
  assertEquals(healed.status, "converging", "the healed parent starts in the converging aggregate");
  assertEquals(inserts.rounds.length, 1, "the round is still recorded");
  assertEquals(inserts.escalations.length, 1, "the escalation is still opened");
  // And the worker still moves the (now-present) PR to escalated as its final state.
  assertEquals(updates.pull_requests!.length, 1, "the PR is updated once after the heal");
  assertEquals((updates.pull_requests![0] as any).patch.status, "escalated");
});


test("a padded question is persisted trimmed and returned trimmed (no whitespace drift)", async () => {
  const { app, inserts, updates } = fakeApp();
  const job = { variables: { prKey: "o/r#1", round: 4, status: "needs_input", question: "  needs a decision  " } };
  const out = await handler(job as any, app as any);
  assertEquals((inserts.escalations[0] as any).question, "needs a decision", "escalation stores the trimmed question");
  // The trimmed question is returned as a process variable so the downstream `wait-answer`
  // userTask + `pr-escalation.form` can display it (there is no denormalised PR-row pointer).
  assertEquals((out as any).question, "needs a decision", "the returned question is trimmed too");
  const patch = (updates.pull_requests![0] as any).patch;
  assertEquals(patch.open_escalation_question, undefined, "no denormalised question pointer is written");
  assertEquals(patch.open_escalation_id, undefined, "no denormalised id pointer is written");
});

// REGRESSION (nano-workforce ADR 0002 §1 — retire the blank-question fabrication failure mode).
//
// A blank/absent question must be treated as a NON-escalation: no escalation row, no PR status
// flip to `escalated`, no wait. The worker previously FABRICATED a concrete question from the
// transcript and opened an answerable escalation — that is exactly the failure mode this slice
// retires. This test reproduces that defect (it fails against the old fabricating worker, which
// opened an escalation with `escalationId:42`) and pins the new non-escalation behaviour.
//
// The `gw-status` gateway is the primary guard (its `f_escalate` arm now requires a non-blank
// question — see roundResultDefault.test.ts), so a blank-question round never reaches this worker
// in practice; this asserts the worker's defence-in-depth via the canonical taxonomy.
test("blank question is a non-escalation (no row fabricated, no status flip)", async () => {
  for (const question of [undefined, "", "   "]) {
    const { app, inserts, updates } = fakeApp();
    const job = {
      variables: {
        prKey: "o/r#1",
        round: 2,
        status: "needs_input",
        ...(question === undefined ? {} : { question }),
        "io.nanobpm.agentResult": { output: "the agent's prose review, no result file" },
      },
    };
    const out = await handler(job as any, app as any);
    assertEquals((out as any).escalated, false, "the job reports no escalation");
    assertEquals((out as any).escalationId, null, "no escalation id is minted");
    assertEquals(inserts.escalations.length, 0, "no escalation row is fabricated");
    assertEquals(inserts.rounds.length, 0, "no round row is written for a non-escalation");
    assertEquals(updates.pull_requests?.length ?? 0, 0, "the PR is never flipped to escalated");
  }
});

// A non-human-blocking status (never routed here by `gw-status`, but defensively handled) is a
// transient signal, not a decision-required escalation: it opens nothing.
test("a non-decision status is a non-escalation even with no question", async () => {
  const { app, inserts, updates } = fakeApp();
  const job = { variables: { prKey: "o/r#1", round: 3, status: "in_progress" } };
  const out = await handler(job as any, app as any);
  assertEquals((out as any).escalated, false);
  assertEquals(inserts.escalations.length, 0, "no escalation is opened for a transient status");
  assertEquals(updates.pull_requests?.length ?? 0, 0, "the PR is not flipped to escalated");
});

// When repo/prNumber process variables are absent the heal still runs by parsing the canonical
// `owner/repo#N` prKey, so the escalation's FK parent is never left unguarded.
test("persist-escalation heals from the prKey when repo/prNumber are absent", async () => {
  const { app, inserts } = fakeApp();
  const job = {
    variables: {
      prKey: "o/r#12",
      round: 2,
      status: "needs_input",
      question: "decide",
      abandonUrl: "https://host/app/api/hooks/abandon?token=TOK-en_123",
    },
  };
  await handler(job as any, app as any);
  assertEquals(inserts.pull_requests?.length, 1, "the parent is reconstructed from the prKey");
  const healed = inserts.pull_requests![0] as any;
  assertEquals(healed.repo, "o/r");
  assertEquals(healed.number, 12);
  assertEquals(healed.url, "https://github.com/o/r/pull/12", "URL is derived from the parsed prKey");
  assertEquals(
    healed.abandon_token,
    "TOK-en_123",
    "the running agent's abandon token is preserved from abandonUrl, not re-minted",
  );
});

// #333 — the control-flow escalation arms (no-progress / review-stalled / unaddressed-comments /
// max-rounds) each set an explicit `status="blocked"` + a concrete `question` via `zeebe:input`
// (recordRound=false for the three that run after `persist-round`). They now route through
// `gw-escalated`, which branches on the worker's `escalated` output. This pins the contract that
// gateway depends on: a control-flow arm with a real question OPENS an escalation and returns
// `escalated:true` + the (trimmed) question, so gw-escalated parks a wait carrying that question —
// never a dead wait with a null question (the #333 defect).
test("a control-flow arm with a concrete question opens an escalation gw-escalated can park", async () => {
  const { app, inserts } = fakeApp();
  const question = "No review arrived within the review-wait timeout (PT20M). A human must decide how to proceed.";
  const job = { variables: { prKey: "o/r#5", round: 2, status: "blocked", question, recordRound: false } };
  const out = await handler(job as any, app as any);
  assertEquals((out as any).escalated, true, "a real control-flow escalation reports escalated:true");
  assertEquals((out as any).question, question, "the question is returned for the wait-answer form");
  assertEquals(inserts.escalations.length, 1, "an escalation row is opened");
  assertEquals(inserts.rounds.length, 0, "recordRound=false suppresses a duplicate round row");
});

// #333 — conversely, the `persist-escalation-blockedcomments` arm maps its question from the
// OPTIONAL `convergeBlockReason`. A blank reason is a NON-escalation: the worker opens nothing and
// returns `escalated:false`, so gw-escalated's default RE-ENTERS the loop instead of parking a dead
// `wait-answer` with a null question. This is the exact wedge the guard eliminates.
test("a control-flow arm with a blank question opens nothing so gw-escalated re-enters", async () => {
  const { app, inserts, updates } = fakeApp();
  const job = { variables: { prKey: "o/r#5", round: 2, status: "blocked", question: "  ", recordRound: false } };
  const out = await handler(job as any, app as any);
  assertEquals((out as any).escalated, false, "a blank-reason arm reports escalated:false");
  assertEquals((out as any).escalationId, null, "no escalation id is minted");
  assertEquals(inserts.escalations.length, 0, "no dead escalation is fabricated");
  assertEquals(updates.pull_requests?.length ?? 0, 0, "the PR is never flipped to escalated");
});
