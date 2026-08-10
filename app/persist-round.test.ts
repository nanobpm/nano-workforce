// Red/green regression for pr.persist-round's round recording + parking behaviour.
//
// The convergence loop routes both `addressed` (the agent pushed changes) and the new `waiting`
// (nothing to triage yet — round 1, awaiting the first review) statuses through gw-guard into
// persist-round. Both must be recorded in `rounds` under their own status and both must park the
// PR in `waiting_review` so the deterministic poller (app/service.ts) starts soliciting a review.
// A `waiting` round is what replaced the old failure mode where an agent with nothing to do
// re-requested the review destructively and escalated `blocked`.
import { assertEquals } from "jsr:@std/assert@1";
import handler from "../workers/persist-round/worker.ts";

function fakeApp() {
  const inserts: Record<string, unknown[]> = { rounds: [] };
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
            const pk = name === "rounds" ? "id" : "pr_key";
            // deno-lint-ignore no-explicit-any
            store.set((row as any)[pk], row);
            return 1;
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

for (const status of ["addressed", "waiting"]) {
  Deno.test(`persist-round records a '${status}' round and parks the PR in waiting_review`, async () => {
    const { app, inserts, updates } = fakeApp();
    const job = { variables: { prKey: "o/r#1", round: 1, status, summary: `round was ${status}` } };
    // deno-lint-ignore no-explicit-any
    await handler(job as any, app as any);

    assertEquals(inserts.rounds.length, 1, "the round is recorded");
    // deno-lint-ignore no-explicit-any
    const round = inserts.rounds[0] as any;
    assertEquals(round.status, status, "the round carries the agent's status");
    assertEquals(round.round_no, 1);

    assertEquals(updates.pull_requests!.length, 1, "the PR is updated once");
    // deno-lint-ignore no-explicit-any
    const patch = (updates.pull_requests![0] as any).patch;
    assertEquals(patch.status, "waiting_review", "the PR parks in waiting_review for the poller");
    assertEquals(patch.current_round, 1);
  });
}

// When the convergence-loop passes repo/prNumber and the FK parent is missing (engine/app.db
// desync), persist-round reconstructs the `pull_requests` row before recording the round so the
// insert never dies with an opaque FOREIGN KEY constraint failure.
Deno.test("persist-round heals a missing pull_requests parent before recording the round", async () => {
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
  // deno-lint-ignore no-explicit-any
  await handler(job as any, app as any);

  assertEquals(inserts.pull_requests?.length, 1, "the missing parent is reconstructed");
  // Assert against the reconstruction insert payload (ensurePr) rather than the stored row: the
  // fake update() doesn't apply patches, so the row would otherwise still read the insert's
  // "converging" status and mask the worker's real final state.
  // deno-lint-ignore no-explicit-any
  const healed = inserts.pull_requests![0] as any;
  assertEquals(healed.status, "converging", "the healed parent starts in the converging aggregate");
  assertEquals(healed.url, "https://github.com/o/r/pull/7", "URL is derived canonically");
  assertEquals(inserts.rounds.length, 1, "the round is still recorded after the heal");
  // And the worker still parks the (now-present) PR in waiting_review as its final state.
  assertEquals(updates.pull_requests!.length, 1, "the PR is updated once after the heal");
  // deno-lint-ignore no-explicit-any
  assertEquals((updates.pull_requests![0] as any).patch.status, "waiting_review");
});

// rather than writing a NULL status — the round history stays readable.
Deno.test("persist-round defaults a missing status to 'addressed'", async () => {
  const { app, inserts } = fakeApp();
  const job = { variables: { prKey: "o/r#1", round: 2 } };
  // deno-lint-ignore no-explicit-any
  await handler(job as any, app as any);
  // deno-lint-ignore no-explicit-any
  assertEquals((inserts.rounds[0] as any).status, "addressed");
});

// When repo/prNumber process variables are absent (an older in-flight instance, or a regression)
// the heal still runs by parsing the canonical `owner/repo#N` prKey, so the FK-child insert is
// never left unguarded.
Deno.test("persist-round heals from the prKey when repo/prNumber are absent", async () => {
  const { app, inserts } = fakeApp();
  const job = {
    variables: {
      prKey: "o/r#12",
      round: 2,
      status: "addressed",
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
