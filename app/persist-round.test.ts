// Red/green regression for pr.persist-round's round recording + parking behaviour.
//
// The convergence loop routes both `addressed` (the agent pushed changes) and the new `waiting`
// (nothing to triage yet — round 1, awaiting the first review) statuses through gw-guard into
// persist-round. Both must be recorded in `rounds` under their own status and both must park the
// PR in `waiting_review` so the deterministic poller (app/service.ts) starts soliciting a review.
// A `waiting` round is what replaced the old failure mode where an agent with nothing to do
// re-requested the review destructively and escalated `blocked`.
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
  test(`persist-round records a '${status}' round and parks the PR in waiting_review`, async () => {
    const { app, inserts, updates } = fakeApp();
    const job = { variables: { prKey: "o/r#1", round: 1, status, summary: `round was ${status}` } };
    await handler(job as any, app as any);

    assertEquals(inserts.rounds.length, 1, "the round is recorded");
    const round = inserts.rounds[0] as any;
    assertEquals(round.status, status, "the round carries the agent's status");
    assertEquals(round.round_no, 1);

    assertEquals(updates.pull_requests!.length, 1, "the PR is updated once");
    const patch = (updates.pull_requests![0] as any).patch;
    assertEquals(patch.status, "waiting_review", "the PR parks in waiting_review for the poller");
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
  // And the worker still parks the (now-present) PR in waiting_review as its final state.
  assertEquals(updates.pull_requests!.length, 1, "the PR is updated once after the heal");
  assertEquals((updates.pull_requests![0] as any).patch.status, "waiting_review");
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
