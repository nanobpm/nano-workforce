// Red/green regression for pr.persist-escalation's round-recording (PR #32 review).
//
// The "review stalled" timer arm runs *after* `persist-round` has already inserted an
// `addressed` row for this `round`. Re-inserting a `rounds` row there would record one round as
// both `addressed` and `blocked`, making round history/UI ambiguous. The stalled arm therefore
// passes `recordRound=false`, which must suppress the round insert while still opening the
// escalation. The agent-raised / max-rounds arms omit the flag (no prior round row) and must
// still record the round.
import { assert, assertEquals } from "jsr:@std/assert@1";
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
          // deno-lint-ignore require-await
          async get(key: string) {
            return store.get(key);
          },
          // deno-lint-ignore require-await
          async insert(row: unknown) {
            (inserts[name] ??= []).push(row);
            const pk = name === "escalations" ? "id" : name === "rounds" ? "id" : "pr_key";
            // deno-lint-ignore no-explicit-any
            store.set((row as any)[pk], row);
            return name === "escalations" ? 42 : 1;
          },
          // deno-lint-ignore require-await
          async update(key: string, patch: unknown) {
            (updates[name] ??= []).push({ key, patch });
          },
        };
      },
    },
  };
  return { app, inserts, updates, rows };
}

Deno.test("stalled arm (recordRound=false) does not insert a duplicate rounds row", async () => {
  const { app, inserts } = fakeApp();
  const job = {
    variables: { prKey: "o/r#1", round: 3, status: "blocked", question: "stalled", recordRound: false },
  };
  // deno-lint-ignore no-explicit-any
  const out = await handler(job as any, app as any);
  assertEquals(inserts.rounds.length, 0, "no round row when the round was already recorded");
  assertEquals(inserts.escalations.length, 1, "escalation is still opened");
  // deno-lint-ignore no-explicit-any
  assertEquals((out as any).escalationId, 42);
});

Deno.test("escalation arm without the flag still records the round", async () => {
  const { app, inserts } = fakeApp();
  const job = { variables: { prKey: "o/r#1", round: 3, status: "blocked", question: "max rounds" } };
  // deno-lint-ignore no-explicit-any
  await handler(job as any, app as any);
  assertEquals(inserts.rounds.length, 1);
  // deno-lint-ignore no-explicit-any
  assertEquals((inserts.rounds[0] as any).round_no, 3);
});

// When the convergence-loop passes repo/prNumber and the FK parent is missing (engine/app.db
// desync), persist-escalation reconstructs the `pull_requests` row before the rounds/escalations
// inserts so opening an escalation never dies with an opaque FOREIGN KEY constraint failure.
Deno.test("persist-escalation heals a missing pull_requests parent before recording", async () => {
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
  // deno-lint-ignore no-explicit-any
  await handler(job as any, app as any);
  assertEquals(inserts.pull_requests?.length, 1, "the missing parent is reconstructed");
  // Assert against the reconstruction insert payload (ensurePr) rather than the stored row: the
  // fake update() doesn't apply patches, so the row would otherwise still read the insert's
  // "converging" status and mask the worker's real final state.
  // deno-lint-ignore no-explicit-any
  const healed = inserts.pull_requests![0] as any;
  assertEquals(healed.status, "converging", "the healed parent starts in the converging aggregate");
  assertEquals(inserts.rounds.length, 1, "the round is still recorded");
  assertEquals(inserts.escalations.length, 1, "the escalation is still opened");
  // And the worker still moves the (now-present) PR to escalated as its final state.
  assertEquals(updates.pull_requests!.length, 1, "the PR is updated once after the heal");
  // deno-lint-ignore no-explicit-any
  assertEquals((updates.pull_requests![0] as any).patch.status, "escalated");
});


Deno.test("a padded question is persisted trimmed (no whitespace drift)", async () => {
  const { app, inserts, updates } = fakeApp();
  const job = { variables: { prKey: "o/r#1", round: 4, status: "needs_input", question: "  needs a decision  " } };
  // deno-lint-ignore no-explicit-any
  await handler(job as any, app as any);
  // deno-lint-ignore no-explicit-any
  assertEquals((inserts.escalations[0] as any).question, "needs a decision", "escalation stores the trimmed question");
  // deno-lint-ignore no-explicit-any
  assertEquals((updates.pull_requests![0] as any).patch.open_escalation_question, "needs a decision", "denormalised question is trimmed too");
});

// A round that fell through the `gw-status` default (no `converged`/`addressed` status and no
// question — the prompt-less-agent failure behind the empty "(no question provided)" escalations
// on Magikcraft/nano-bpm #597/#599) must NOT throw (which parked an un-remediable JobNoRetries
// incident). It now opens an *answerable* escalation with a fabricated, concrete question and the
// agent's transcript attached, so a human can unblock the loop entirely from the UI.
Deno.test("blank question fabricates an answerable escalation (no throw, no incident)", async () => {
  for (const question of [undefined, "", "   "]) {
    const { app, inserts, updates } = fakeApp();
    const job = {
      variables: {
        prKey: "o/r#1",
        round: 2,
        ...(question === undefined ? {} : { question }),
        "io.nanobpm.agentResult": { output: "the agent's prose review, no result file" },
      },
    };
    // deno-lint-ignore no-explicit-any
    const out = await handler(job as any, app as any);
    // deno-lint-ignore no-explicit-any
    assertEquals((out as any).escalationId, 42, "an escalation is opened, not refused");
    assertEquals(inserts.escalations.length, 1, "escalation row written");
    // deno-lint-ignore no-explicit-any
    const esc = inserts.escalations[0] as any;
    assert(esc.question.trim().length > 0, "fabricated question is concrete/non-blank");
    assert(
      esc.question.includes("machine-readable result"),
      "no-result rounds explain the missing status",
    );
    assertEquals(esc.transcript, "the agent's prose review, no result file", "transcript attached");
    // Default status for an unclassified escalation is a question needing input.
    assertEquals(esc.kind, "question");
    // deno-lint-ignore no-explicit-any
    const pr = updates.pull_requests![0] as any;
    assertEquals(pr.patch.open_escalation_question, esc.question, "denormalised question set");
  }
});

// When a non-empty-but-unclassified status arrives with no question, the fabricated question
// names the status so the human sees what the agent reported.
Deno.test("unclassified status without a question names the status in the fabricated question", async () => {
  const { app, inserts } = fakeApp();
  const job = { variables: { prKey: "o/r#1", round: 3, status: "in_progress" } };
  // deno-lint-ignore no-explicit-any
  await handler(job as any, app as any);
  // deno-lint-ignore no-explicit-any
  const esc = inserts.escalations[0] as any;
  assert(esc.question.includes("in_progress"), "fabricated question references the raw status");
  assertEquals(esc.kind, "blocker", "a non needs_input status is a blocker escalation");
});

// When repo/prNumber process variables are absent the heal still runs by parsing the canonical
// `owner/repo#N` prKey, so the escalation's FK parent is never left unguarded.
Deno.test("persist-escalation heals from the prKey when repo/prNumber are absent", async () => {
  const { app, inserts } = fakeApp();
  const job = {
    variables: {
      prKey: "o/r#12",
      round: 2,
      status: "needs_input",
      question: "decide",
      abandonUrl: "https://host/hooks/abandon?token=TOK-en_123",
    },
  };
  // deno-lint-ignore no-explicit-any
  await handler(job as any, app as any);
  assertEquals(inserts.pull_requests?.length, 1, "the parent is reconstructed from the prKey");
  // deno-lint-ignore no-explicit-any
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
