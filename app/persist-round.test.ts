// Red/green regression for pr.persist-round's round recording behaviour.
//
// The convergence loop routes both `addressed` (the agent pushed changes) and the new `waiting`
// (nothing to triage yet — round 1, awaiting the first review) statuses through gw-guard into
// persist-round. Both must be recorded in `rounds` under their own status and both must advance the
// PR's `current_round`. The PARK into `waiting_review` is owned by the downstream pr.progress-check
// step (the single writer of the post-round wait status), NOT persist-round — persist-round runs
// before the husk decision, so parking here would let the poller fire a spurious review re-request
// against a husk-retry round before progress-check resolves it (#786).
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import handler from "../workers/persist-round/worker.ts";

function fakeApp() {
  const inserts: Record<string, unknown[]> = { rounds: [] };
  const updates: Record<string, unknown[]> = { pull_requests: [] };
  const rows: Record<string, Map<string, unknown>> = {};
  let roundsId = 0;
  const app = {
    data: {
      table(name: string, _key: string) {
        const store = (rows[name] ??= new Map());
        return {
          async get(key: string) {
            return store.get(key);
          },
          async find(criteria: Record<string, unknown>) {
            return [...store.values()].filter((r) =>
              Object.entries(criteria).every(([k, v]) => (r as any)[k] === v),
            );
          },
          async insert(row: unknown) {
            const pk = name === "rounds" ? "id" : "pr_key";
            // The rounds table has an AUTOINCREMENT id; mint one so find/update can key on it.
            if (name === "rounds" && (row as any).id === undefined) {
              (row as any).id = ++roundsId;
            }
            (inserts[name] ??= []).push(row);
            store.set((row as any)[pk], row);
            return 1;
          },
          async update(key: string, patch: Record<string, unknown>) {
            (updates[name] ??= []).push({ key, patch });
            const existing = store.get(key);
            if (existing) store.set(key, { ...(existing as object), ...patch });
          },
        };
      },
    },
  };
  return { app, inserts, updates, rows };
}

for (const status of ["addressed", "waiting"]) {
  test(`persist-round records a '${status}' round and advances current_round without parking`, async () => {
    const { app, inserts, updates } = fakeApp();
    const job = { variables: { prKey: "o/r#1", round: 1, status, summary: `round was ${status}` } };
    await handler(job as any, app as any);

    assertEquals(inserts.rounds.length, 1, "the round is recorded");
    const round = inserts.rounds[0] as any;
    assertEquals(round.status, status, "the round carries the agent's status");
    assertEquals(round.round_no, 1);

    assertEquals(updates.pull_requests!.length, 1, "the PR is updated once");
    const patch = (updates.pull_requests![0] as any).patch;
    // The park into `waiting_review` is owned by pr.progress-check (the single writer of the
    // post-round wait status), NOT persist-round — persist-round runs before the husk decision, so
    // parking here would race the poller against a husk retry (#786). It only advances the round.
    assertEquals(patch.status, undefined, "persist-round does NOT park the PR in waiting_review");
    assertEquals(patch.waiting_since, undefined, "persist-round does NOT stamp the review-wait start");
    assertEquals(patch.current_round, 1);
  });
}

// The harness completes each agent job with `agent` (its profile name); persist-round records it
// on the round so a human can identify the servicing worker from the durable history.
test("persist-round records the servicing worker name from the agent variable", async () => {
  const { app, inserts } = fakeApp();
  const job = { variables: { prKey: "o/r#1", round: 1, status: "addressed", agent: "senior" } };
  await handler(job as any, app as any);
  assertEquals((inserts.rounds[0] as any).worker, "senior", "the round carries the worker name");
});

// A blank/absent agent name leaves the nullable column NULL (the write boundary omits undefined).
test("persist-round leaves worker undefined when the agent name is blank", async () => {
  const { app, inserts } = fakeApp();
  const job = { variables: { prKey: "o/r#1", round: 1, status: "addressed", agent: "  " } };
  await handler(job as any, app as any);
  assertEquals((inserts.rounds[0] as any).worker, undefined, "blank worker -> NULL column");
});

// When the convergence-loop passes repo/prNumber and the FK parent is missing (engine/app.db
// desync), persist-round reconstructs the `pull_requests` row before recording the round so the
// insert never dies with an opaque FOREIGN KEY constraint failure.
test("persist-round heals a missing pull_requests parent before recording the round", async () => {
  const { app, inserts, updates } = fakeApp();
  const job = {
    variables: {
      prKey: "o/r#7",
      round: 3,
      status: "addressed",
      repo: "o/r",
      prNumber: 7,
    },
  };
  await handler(job as any, app as any);

  assertEquals(inserts.pull_requests?.length, 1, "the missing parent is reconstructed");
  // Assert against the reconstruction insert payload (ensurePr) rather than the stored row: the
  // fake update() doesn't apply patches, so the row would otherwise still read the insert's
  // "converging" status and mask the worker's real final state.
  const healed = inserts.pull_requests![0] as any;
  assertEquals(healed.status, "converging", "the healed parent starts in the converging aggregate");
  assertEquals(healed.url, "https://github.com/o/r/pull/7", "URL is derived canonically");
  assertEquals(inserts.rounds.length, 1, "the round is still recorded after the heal");
  // And the worker advances current_round on the (now-present) PR — but does NOT park it in
  // waiting_review (that is pr.progress-check's job now, #786).
  assertEquals(updates.pull_requests!.length, 1, "the PR is updated once after the heal");
  assertEquals((updates.pull_requests![0] as any).patch.status, undefined, "no park in persist-round");
  assertEquals((updates.pull_requests![0] as any).patch.current_round, 3);
});

// rather than writing a NULL status — the round history stays readable.
test("persist-round defaults a missing status to 'addressed'", async () => {
  const { app, inserts } = fakeApp();
  const job = { variables: { prKey: "o/r#1", round: 2 } };
  await handler(job as any, app as any);
  assertEquals((inserts.rounds[0] as any).status, "addressed");
});

// When repo/prNumber process variables are absent (an older in-flight instance, or a regression)
// the heal still runs by parsing the canonical `owner/repo#N` prKey, so the FK-child insert is
// never left unguarded.
test("persist-round heals from the prKey when repo/prNumber are absent", async () => {
  const { app, inserts } = fakeApp();
  const job = {
    variables: {
      prKey: "o/r#12",
      round: 2,
      status: "addressed",
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

// Idempotent round recording (issue #786): a husk auto-retry re-enters `review-round` WITHOUT
// advancing the round counter, so pr.persist-round is reached again for the SAME (pr_key, round_no).
// The `rounds` table has no UNIQUE(pr_key, round_no), so the worker must UPSERT — update the existing
// row in place, never manufacture a duplicate history row that would corrupt the durable round
// history the cockpit and the no-progress guard both read.
test("persist-round is idempotent on (pr_key, round_no) — a retry updates, never duplicates", async () => {
  const { app, inserts, updates } = fakeApp();
  const first = { variables: { prKey: "o/r#1", round: 4, status: "addressed", summary: "first attempt" } };
  await handler(first as any, app as any);
  assertEquals(inserts.rounds.length, 1, "the first attempt inserts a round row");

  // A husk retry: same round_no, a fresh summary/transcript.
  const retry = { variables: { prKey: "o/r#1", round: 4, status: "addressed", summary: "retry attempt" } };
  await handler(retry as any, app as any);
  assertEquals(inserts.rounds.length, 1, "the retry does NOT insert a second round row");

  const roundUpdate = (updates.rounds ?? []).at(-1) as any;
  assertEquals(roundUpdate?.patch.summary, "retry attempt", "the retry updates the existing round in place");
  assertEquals((inserts.rounds[0] as any).round_no, 4);
});

// Regression (issue #786): the idempotent upsert must reuse only a row THIS worker wrote — never an
// escalation row. On a needs_input/blocked escalation, pr.persist-escalation records a `rounds` row
// (status needs_input/blocked) for the SAME (pr_key, round_no); the human-answered resume re-enters
// that same numeric round and lands here. Blindly updating the newest matching row would overwrite
// the escalation row to `addressed`, ERASING the escalation attempt from the durable history. The
// resume must INSERT a fresh row so both the escalation and its resolution survive.
test("persist-round does NOT overwrite a same-round escalation row — it inserts the resumed attempt", async () => {
  const { app, inserts, updates, rows } = fakeApp();
  // Simulate pr.persist-escalation having recorded a needs_input round row for round 5.
  const roundsStore = (rows.rounds ??= new Map());
  roundsStore.set(101, {
    id: 101,
    pr_key: "o/r#1",
    round_no: 5,
    status: "needs_input",
    summary: "escalated: which API shape?",
    transcript: "escalation transcript",
    started_at: "t0",
    ended_at: "t0",
  });

  // The human answers; the same numeric round resumes and reaches persist-round as `addressed`.
  const resume = { variables: { prKey: "o/r#1", round: 5, status: "addressed", summary: "resumed and pushed" } };
  await handler(resume as any, app as any);

  assertEquals(inserts.rounds.length, 1, "the resumed attempt inserts a NEW round row");
  assertEquals((inserts.rounds[0] as any).status, "addressed", "the new row is the addressed resume");
  // The escalation row is untouched — never updated to `addressed`.
  const escalationTouched = (updates.rounds ?? []).some((u: any) => u.key === 101);
  assertEquals(escalationTouched, false, "the needs_input escalation row is preserved, not overwritten");
  assertEquals((roundsStore.get(101) as any).status, "needs_input", "the escalation row keeps its status");
});

// But a genuine husk retry (a prior pr.persist-round row, status addressed/waiting) is still reused
// in place — only escalation rows are excluded, so idempotency for the retry path is preserved even
// when an escalation row for the same round also exists.
test("persist-round reuses a prior addressed round-record row while skipping an escalation row", async () => {
  const { app, inserts, updates, rows } = fakeApp();
  const roundsStore = (rows.rounds ??= new Map());
  // An escalation row AND a prior persist-round row for the same round.
  roundsStore.set(200, { id: 200, pr_key: "o/r#1", round_no: 6, status: "blocked", summary: "blocked earlier" });
  roundsStore.set(201, { id: 201, pr_key: "o/r#1", round_no: 6, status: "addressed", summary: "first addressed" });

  const retry = { variables: { prKey: "o/r#1", round: 6, status: "addressed", summary: "husk retry" } };
  await handler(retry as any, app as any);

  assertEquals(inserts.rounds.length, 0, "no new row — the prior addressed row is reused");
  const roundUpdate = (updates.rounds ?? []).at(-1) as any;
  assertEquals(roundUpdate?.key, 201, "the addressed round-record row is updated, not the blocked escalation row");
  assertEquals(roundUpdate?.patch.summary, "husk retry");
  assertEquals((roundsStore.get(200) as any).status, "blocked", "the escalation row is left intact");
});

// Regression (issue #786): the idempotent upsert must be scoped to the writing RUN, not inferred
// from status. `submitPr` re-opens a previously converged/abandoned PR at round 1 WITHOUT deleting
// `rounds` history, so a fresh convergence run (a NEW process instance) at round 1 finds the prior
// run's `addressed`/`waiting`/`converged` round-1 row. Reusing it (its status is not human-hold)
// would clobber another run's canonical summary/transcript/worker/timestamps. Scoping reuse by the
// writing `process_instance_key` means the new run INSERTS a fresh row and the prior run's history
// survives verbatim.
test("persist-round scopes idempotency to the process instance — a resubmission inserts a fresh row", async () => {
  const { app, inserts, updates, rows } = fakeApp();
  const roundsStore = (rows.rounds ??= new Map());
  // A prior run's round-1 row (its own process instance) with real history.
  roundsStore.set(300, {
    id: 300,
    pr_key: "o/r#1",
    round_no: 1,
    status: "converged",
    summary: "prior run summary",
    transcript: "prior run transcript",
    worker: "senior",
    process_instance_key: "proc-OLD",
    started_at: "t0",
    ended_at: "t0",
  });

  // A resubmission: submitPr restarts convergence at round 1 in a NEW process instance.
  const resubmit = {
    processInstanceKey: "proc-NEW",
    variables: { prKey: "o/r#1", round: 1, status: "addressed", summary: "fresh run" },
  };
  await handler(resubmit as any, app as any);

  assertEquals(inserts.rounds.length, 1, "the resubmission inserts its OWN round row");
  assertEquals((inserts.rounds[0] as any).process_instance_key, "proc-NEW", "the new row carries the new run's key");
  const priorTouched = (updates.rounds ?? []).some((u: any) => u.key === 300);
  assertEquals(priorTouched, false, "the prior run's round-1 row is never updated");
  assertEquals((roundsStore.get(300) as any).summary, "prior run summary", "the prior run's history is intact");
});

// But a husk retry WITHIN the same run (same process instance key, same round_no) is still reused in
// place — process-instance scoping preserves husk-retry idempotency, it does not disable it.
test("persist-round reuses the same-process-instance row on a husk retry", async () => {
  const { app, inserts, updates, rows } = fakeApp();
  const roundsStore = (rows.rounds ??= new Map());
  // This run's own round-4 row, plus an UNRELATED prior run's round-4 row.
  roundsStore.set(400, {
    id: 400,
    pr_key: "o/r#1",
    round_no: 4,
    status: "addressed",
    summary: "other run",
    process_instance_key: "proc-OTHER",
  });
  roundsStore.set(401, {
    id: 401,
    pr_key: "o/r#1",
    round_no: 4,
    status: "addressed",
    summary: "this run first attempt",
    process_instance_key: "proc-THIS",
  });

  const retry = {
    processInstanceKey: "proc-THIS",
    variables: { prKey: "o/r#1", round: 4, status: "addressed", summary: "this run husk retry" },
  };
  await handler(retry as any, app as any);

  assertEquals(inserts.rounds.length, 0, "no new row — this run's own row is reused");
  const roundUpdate = (updates.rounds ?? []).at(-1) as any;
  assertEquals(roundUpdate?.key, 401, "the reused row is THIS run's row, not the other run's");
  assertEquals(roundUpdate?.patch.summary, "this run husk retry");
  assertEquals((roundsStore.get(400) as any).summary, "other run", "the unrelated run's row is untouched");
});
