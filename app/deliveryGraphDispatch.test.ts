// Unit coverage for `dispatchDeliveryGraphRun` (app/deliveryGraphDispatch.ts) — the retained
// delivery-graph DISPATCH core extracted out of the removed agent `start` door (ADR 0005 Decision 7,
// issue #460). It has NO approval gate: the authorization lives in the fact that only the cockpit
// dispatch seam reaches this code (never the agent surface). What it DOES keep is the durable
// at-most-once launch fence + idempotency short-circuit, so a double-dispatch never double-launches a
// graph's side effects. These tests drive it against an in-memory app/data/engine faithful to the run
// aggregate's PRIMARY KEY fence and the guarded raw UPDATE the claim issues.
import { test } from "node:test";
import { assert, assertEquals, assertRejects } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { dispatchDeliveryGraphRun } from "./deliveryGraphDispatch.ts";
import { isStaleLaunchClaim } from "./deliveryGraphRun.ts";
import { noopLog } from "../test/log.ts";

function makeApp(opts: { failIdentityWrite?: boolean; reconcileReadThrows?: { on: boolean }; liveOriginal?: { processInstanceKey: string; runKey: string | null; processDefinitionId?: string } } = {}) {
  const tables = new Map<string, Record<string, unknown>[]>();
  const started: { processDefinitionId: string; variables?: Record<string, unknown> }[] = [];
  const cancelled: string[] = [];
  const table = (name: string, key: string) => {
    if (opts.failIdentityWrite && name === "delivery_graph_run_identity") {
      // Simulate a transient side-table write error (e.g. a SQLite `disk I/O error`) — NOT a UNIQUE
      // collision, so `upsertRunIdentity` rethrows it rather than folding it into an UPDATE.
      return {
        get: () => Promise.resolve(null),
        find: () => Promise.resolve([]),
        all: () => Promise.resolve([]),
        insert: () => Promise.reject(new Error("disk I/O error")),
        update: () => Promise.reject(new Error("disk I/O error")),
        delete: () => Promise.resolve(),
      };
    }
    const rows =
      tables.get(name) ??
      (() => {
        const fresh: Record<string, unknown>[] = [];
        tables.set(name, fresh);
        return fresh;
      })();
    return {
      get: (k: unknown) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
      find: (q: Record<string, unknown>) =>
        Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
      all: () => Promise.resolve([...rows]),
      insert: (r: Record<string, unknown>) => {
        if (rows.some((existing) => existing[key] === r[key])) {
          return Promise.reject(new Error(`UNIQUE constraint failed: ${name}.${key}`));
        }
        rows.push(r);
        return Promise.resolve(r);
      },
      update: (k: unknown, patch: Record<string, unknown>) => {
        const row = rows.find((r) => r[key] === k);
        if (row) Object.assign(row, patch);
        return Promise.resolve(row);
      },
      delete: (k: unknown) => {
        const i = rows.findIndex((r) => r[key] === k);
        if (i >= 0) rows.splice(i, 1);
        return Promise.resolve();
      },
    };
  };
  const app = {
    data: {
      table,
      open: () => {
        const exec = (sql: string, params: unknown[]) =>
          Promise.resolve().then(() => {
            const cols = [...sql.matchAll(/"(\w+)"\s*=\s*\?/g)].map((m) => m[1]);
            // The claim CAS (claimRunForLaunch) ends `… WHERE "run_key" = ? AND ("status" <> 'running'
            // OR ("process_key" IS NULL AND "updated_at" < ?))` — the run_key is the 2nd-to-last param,
            // the stale-TTL threshold the last. Model BOTH branches so a stale re-claim wins.
            const isClaimCas = sql.includes('OR ("process_key" IS NULL AND "updated_at" < ?)');
            const runKey = isClaimCas ? params[params.length - 2] : params[params.length - 1];
            const staleBefore = isClaimCas ? (params[params.length - 1] as string) : null;
            const rows = tables.get("delivery_graph_runs") ?? [];
            const row = rows.find((r) => r["run_key"] === runKey);
            const staleReclaimable =
              isClaimCas && row && row["status"] === "running" && (row["process_key"] == null) && typeof staleBefore === "string" && (row["updated_at"] as string) < staleBefore;
            if (row && (row["status"] !== "running" || staleReclaimable)) {
              for (let i = 0; i < cols.length - 1; i++) row[cols[i]] = params[i];
              return { changed: 1 };
            }
            return { changed: 0 };
          });
        // The claim runs inside a transaction (`data.open().tx(...)`); model `tx` as a pass-through
        // that hands the same `exec` to the callback (the mock has no real isolation to model).
        return { exec, tx: async (fn: (t: { exec: typeof exec }) => Promise<unknown>) => fn({ exec }) };
      },
    },
    engine: {
      deployResources: () => Promise.resolve([]),
      createInstance: (req: { processDefinitionId: string; variables?: Record<string, unknown> }) => {
        started.push(req);
        return Promise.resolve({ processInstanceKey: `PI-${started.length}`, processDefinitionId: req.processDefinitionId });
      },
      // The reconcile-before-relaunch seam (issue #852 review): surface a configured LIVE original
      // instance (a dispatch that died after createInstance but before stamping the key) so the test can
      // assert the relaunch cancels it. `liveOriginal.runKey === null` models an instance whose runKey
      // variable is absent/unreadable — it must NOT be cancelled (unproven ownership).
      searchProcessInstances: (filter?: { processDefinitionId?: string; state?: string }) =>
        // A reconcile READ failure (issue #853 review — thread deliveryGraphDispatch.ts:280): the
        // reconcile pass queries by `processDefinitionId`, so gate the transient throw on that filter.
        opts.reconcileReadThrows?.on && filter?.processDefinitionId !== undefined
          ? Promise.reject(new Error("engine unavailable"))
          : Promise.resolve(
          opts.liveOriginal &&
            (filter?.processDefinitionId === undefined || filter.processDefinitionId === (opts.liveOriginal.processDefinitionId ?? filter.processDefinitionId)) &&
            (filter?.state === undefined || filter.state === "ACTIVE")
            ? [{ processInstanceKey: opts.liveOriginal.processInstanceKey, state: "ACTIVE" }]
            : [],
        ),
      searchVariables: (filter?: { processInstanceKey?: string; name?: string }) =>
        Promise.resolve(
          opts.liveOriginal && filter?.name === "runKey" && filter.processInstanceKey === opts.liveOriginal.processInstanceKey && opts.liveOriginal.runKey !== null
            ? [{ variableKey: "v1", name: "runKey", value: JSON.stringify(opts.liveOriginal.runKey), scopeKey: opts.liveOriginal.processInstanceKey, processInstanceKey: opts.liveOriginal.processInstanceKey, isTruncated: false }]
            : [],
        ),
      cancelInstance: (req: { processInstanceKey: string }) => {
        cancelled.push(req.processInstanceKey);
        return Promise.resolve();
      },
    },
    log: noopLog(),
  } as unknown as AppApi;
  return { app, started, cancelled, runs: () => tables.get("delivery_graph_runs") ?? [] };
}

const HUMAN_ONLY = {
  name: "manual gate",
  nodes: [{ id: "ack", kind: "human", human: { prompt: "click done" } }],
};
const SIDE_EFFECTING = {
  name: "release runbook",
  nodes: [
    { id: "open-b", kind: "agent", agent: { jobType: "senior:demo", prompt: "merge #B" } },
    { id: "publish", kind: "human", human: { prompt: "run the manual OTP publish" } },
  ],
  edges: [{ from: "open-b", to: "publish" }],
};

test("dispatchDeliveryGraphRun: a human-only graph launches straight away (running), one engine instance", async () => {
  const { app, started, runs } = makeApp();
  const res = await dispatchDeliveryGraphRun(app, HUMAN_ONLY, { repoless: true });
  assertEquals(res.ok, true);
  if (!res.ok) return;
  assertEquals(res.status, "running");
  assertEquals(res.alreadyRunning, false);
  assertEquals(res.sideEffecting, false);
  assertEquals(started.length, 1);
  assertEquals(runs()[0].status, "running");
});

test("#778 dispatchDeliveryGraphRun: a post-claim identity-write failure flips the claimed run to `failed`, not a stranded null-process_key `running` — so a phantom run never short-circuits a later dispatch (thread deliveryGraphDispatch.ts:229)", async () => {
  const { app, started, runs } = makeApp({ failIdentityWrite: true });
  // The identity side-table write throws AFTER the durable `running` claim; dispatch must propagate it.
  await assertRejects(() => dispatchDeliveryGraphRun(app, SIDE_EFFECTING, { repoless: true }), Error, "disk I/O error");
  // The claimed row was flipped to `failed` (never left `running` with a null process key), so a later
  // same-key dispatch does NOT short-circuit onto a phantom run — it can retry cleanly.
  assertEquals(runs().length, 1);
  assertEquals(runs()[0].status, "failed");
  assertEquals(runs()[0].process_key ?? null, null);
  // The side effect never launched.
  assertEquals(started.length, 0);
});

test("#778 dispatchDeliveryGraphRun: a still-running run whose identity row is MISSING (null, pre-migration) short-circuits with identityConfirmed:false instead of throwing (thread deliveryGraphDispatch.ts:175)", async () => {
  const { app, started } = makeApp();
  const first = await dispatchDeliveryGraphRun(app, SIDE_EFFECTING, { repoless: true });
  assert(first.ok);
  if (!first.ok) return;
  assertEquals(first.status, "running");
  // Simulate a run launched BEFORE the identity side-table existed: drop its identity row so
  // `identities.get(runKey)` resolves to null (the test table — like the real `table.get()` — returns
  // null, NOT undefined, for a missing row).
  await app.data.table("delivery_graph_run_identity", "run_key").delete(first.runKey);
  // A second same-key dispatch hits the already-running short-circuit; the null identity row must not
  // throw while building the response — it is unprovable, so identityConfirmed is false.
  const second = await dispatchDeliveryGraphRun(app, SIDE_EFFECTING, { repoless: true });
  assert(second.ok);
  if (!second.ok) return;
  assertEquals(second.alreadyRunning, true);
  assertEquals(second.identityConfirmed, false);
  assertEquals(started.length, 1); // no double launch
});

test("dispatchDeliveryGraphRun: a side-effecting graph dispatches with NO approval token — the operator seam IS the approval", async () => {
  const { app, started, runs } = makeApp();
  const res = await dispatchDeliveryGraphRun(app, SIDE_EFFECTING, { repoless: true });
  assertEquals(res.ok, true);
  if (!res.ok) return;
  assertEquals(res.status, "running");
  assertEquals(res.sideEffecting, true);
  assertEquals(started.length, 1);
  assertEquals(runs()[0].status, "running");
});

test("dispatchDeliveryGraphRun: a re-dispatch of a still-running run short-circuits (alreadyRunning) — the side effect launches at most once", async () => {
  const { app, started } = makeApp();
  const first = await dispatchDeliveryGraphRun(app, SIDE_EFFECTING, { repoless: true });
  assert(first.ok);
  const second = await dispatchDeliveryGraphRun(app, SIDE_EFFECTING, { repoless: true });
  assertEquals(second.ok, true);
  if (!second.ok) return;
  assertEquals(second.alreadyRunning, true);
  assertEquals(started.length, 1); // never a second launch
});

test("dispatchDeliveryGraphRun: an explicit idempotency key forces a distinct run row", async () => {
  const { app, started } = makeApp();
  await dispatchDeliveryGraphRun(app, HUMAN_ONLY, { repoless: true });
  await dispatchDeliveryGraphRun(app, HUMAN_ONLY, { runKey: "second-run", repoless: true });
  assertEquals(started.length, 2);
});

test("#778 dispatchDeliveryGraphRun: a recompiled digest that drifts from `expectedDigest` is REFUSED before any launch — no run, no engine instance (thread :1605)", async () => {
  // A staged proposal is keyed by its stage-time digest. If the compiler ships a digest-affecting change
  // (this PR adds labels/`<bpmn:documentation>`), the stored graph recompiles to a DIFFERENT digest. The
  // door hands the stage-time digest as `expectedDigest`; a mismatch must refuse cleanly BEFORE the
  // durable launch claim, so we never strand a live run against a proposal left `staged`.
  const { app, started, runs } = makeApp();
  const res = await dispatchDeliveryGraphRun(app, SIDE_EFFECTING, { repoless: true, expectedDigest: "sha256-stale-address" });
  assertEquals(res.ok, false);
  if (res.ok) return;
  assert(res.errors.some((e) => e.path === "digest"), "the refusal is a digest-address error");
  assertEquals(started.length, 0); // nothing launched
  assertEquals(runs().length, 0); // no run row claimed
});

test("#778 dispatchDeliveryGraphRun: a matching `expectedDigest` dispatches normally (the same-compiler no-op path)", async () => {
  // Compute the graph's true digest first, then pass it as `expectedDigest` — the normal deterministic
  // recompile matches, so the address check is a no-op and the run launches.
  const { app, started } = makeApp();
  const probe = await dispatchDeliveryGraphRun(app, HUMAN_ONLY, { repoless: true });
  assert(probe.ok);
  if (!probe.ok) return;
  const { app: app2, started: started2 } = makeApp();
  const res = await dispatchDeliveryGraphRun(app2, HUMAN_ONLY, { repoless: true, expectedDigest: probe.digest });
  assertEquals(res.ok, true);
  if (!res.ok) return;
  assertEquals(res.status, "running");
  assertEquals(started2.length, 1);
});

test("dispatchDeliveryGraphRun: a malformed graph → ok:false with path-qualified errors, nothing launched", async () => {
  const { app, started } = makeApp();
  const res = await dispatchDeliveryGraphRun(app, { name: "empty", nodes: [] });
  assertEquals(res.ok, false);
  if (res.ok) return;
  assert(Array.isArray(res.errors) && res.errors.length > 0);
  for (const e of res.errors) {
    assert(typeof e.path === "string" && typeof e.message === "string");
  }
  assertEquals(started.length, 0);
});

// Option C (issue #778): a graph carrying redacted-away credential material has a LOSSY content digest
// (a sibling differing only in the secret would collide), so a keyless dispatch — which defaults the
// run identity to that digest — is refused; an explicit `idempotencyKey` disambiguates it.
const SECRET_BEARING = {
  name: "deploy with a secret",
  nodes: [{ id: "deploy", kind: "agent", agent: { jobType: "senior:demo", prompt: "push to https://user:s3cr3t@host.example/repo" } }],
};

test("dispatchDeliveryGraphRun: a secret-bearing graph dispatched KEYLESS is refused, points at idempotencyKey, launches nothing", async () => {
  const { app, started, runs } = makeApp();
  const res = await dispatchDeliveryGraphRun(app, SECRET_BEARING, { repoless: true });
  assertEquals(res.ok, false);
  if (res.ok) return;
  assertEquals(res.errors.length, 1);
  assertEquals(res.errors[0].path, "idempotencyKey");
  assert(res.errors[0].message.includes("idempotencyKey"));
  assertEquals(started.length, 0);
  assertEquals(runs().length, 0); // nothing claimed
});

test("dispatchDeliveryGraphRun: the SAME secret-bearing graph WITH an explicit idempotencyKey launches", async () => {
  const { app, started, runs } = makeApp();
  const res = await dispatchDeliveryGraphRun(app, SECRET_BEARING, { runKey: "deploy-2024-06-a", repoless: true });
  assertEquals(res.ok, true);
  if (!res.ok) return;
  assertEquals(res.status, "running");
  assertEquals(res.runKey, "deploy-2024-06-a");
  assertEquals(started.length, 1);
  assertEquals(runs()[0].run_key, "deploy-2024-06-a");
});

test("dispatchDeliveryGraphRun: two credential-differing secret graphs with DISTINCT keys get distinct runs (no collision)", async () => {
  const { app, started, runs } = makeApp();
  const graphA = { name: "deploy", nodes: [{ id: "d", kind: "agent", agent: { jobType: "senior:demo", prompt: "push to https://user:AAA@host.example/repo" } }] };
  const graphB = { name: "deploy", nodes: [{ id: "d", kind: "agent", agent: { jobType: "senior:demo", prompt: "push to https://user:BBB@host.example/repo" } }] };
  const a = await dispatchDeliveryGraphRun(app, graphA, { runKey: "run-a", repoless: true });
  const b = await dispatchDeliveryGraphRun(app, graphB, { runKey: "run-b", repoless: true });
  assert(a.ok && b.ok);
  assertEquals(started.length, 2);
  assertEquals(new Set(runs().map((r) => r.run_key)).size, 2);
});

// ── #852 review: reconcile-before-relaunch (thread deliveryGraphRun.ts:180) ──────────────────────
// A STALE launch claim can hide a LIVE original instance (the dispatch died after createInstance but
// before stamping the process key). The relaunch must cancel that original — matched by its seeded
// `runKey` variable — before starting a second instance of the same side-effecting graph.

/** Seed a STALE launch-claim row (running, NULL process_key, updated_at older than the TTL) straight
 * into the mock store, as a crashed dispatch left it. */
async function seedStaleClaim(app: AppApi, runKey: string, digest: string) {
  const staleAt = new Date(Date.now() - 20 * 60_000).toISOString(); // 20 min ago > 15 min TTL
  await app.data.table("delivery_graph_runs", "run_key").insert({
    run_key: runKey,
    process_key: null,
    process_definition_id: `delivery-graph-${digest}`,
    digest,
    status: "running",
    side_effecting: 1,
    node_count: 2,
    human_node_count: 1,
    side_effect_count: 1,
    title: "t",
    phase: "Running",
    phase_node_id: null,
    human_labels: null,
    created_at: staleAt,
    updated_at: staleAt,
    acknowledged_at: null,
  });
}

test("#852 dispatchDeliveryGraphRun: re-claiming a STALE claim with a LIVE original instance cancels it before relaunch (at-most-once)", async () => {
  // The original dispatch died after createInstance but before stamping the key: the row is a stale
  // claim AND a live instance of this run (runKey "run-x") is still ACTIVE on the engine.
  const { app, started, cancelled } = makeApp({ liveOriginal: { processInstanceKey: "PI-orig", runKey: "run-x" } });
  // First dispatch to learn the digest, on a SEPARATE app so it doesn't disturb the test store.
  const probe = await dispatchDeliveryGraphRun(makeApp().app, SIDE_EFFECTING, { runKey: "run-x", repoless: true });
  assert(probe.ok);
  if (!probe.ok) return;
  await seedStaleClaim(app, "run-x", probe.digest);

  const res = await dispatchDeliveryGraphRun(app, SIDE_EFFECTING, { runKey: "run-x", repoless: true });
  assertEquals(res.ok, true);
  if (!res.ok) return;
  assertEquals(res.alreadyRunning, false, "the stale claim is re-claimed, not short-circuited");
  assertEquals(cancelled, ["PI-orig"], "the live original instance is cancelled before the relaunch");
  assertEquals(started.length, 1, "exactly one replacement instance launches");
});

test("#852 dispatchDeliveryGraphRun: re-claiming a STALE claim whose only ACTIVE instance is a DIFFERENT run relaunches WITHOUT cancelling it", async () => {
  // A different run of the SAME graph (same content-addressed processDefinitionId) is still ACTIVE.
  // The relaunch must NOT cancel it — the runKey variable proves it is not ours.
  const { app, started, cancelled } = makeApp({ liveOriginal: { processInstanceKey: "PI-other", runKey: "other-run" } });
  const probe = await dispatchDeliveryGraphRun(makeApp().app, SIDE_EFFECTING, { runKey: "run-y", repoless: true });
  assert(probe.ok);
  if (!probe.ok) return;
  await seedStaleClaim(app, "run-y", probe.digest);

  const res = await dispatchDeliveryGraphRun(app, SIDE_EFFECTING, { runKey: "run-y", repoless: true });
  assertEquals(res.ok, true);
  if (!res.ok) return;
  assertEquals(cancelled, [], "a different run's live instance is never cancelled");
  assertEquals(started.length, 1, "the relaunch still proceeds");
});

test("#852 dispatchDeliveryGraphRun: an explicit-key stale re-claim whose graph DRIFTED still cancels the original (matched by the STALE ROW's digest, not the new one)", async () => {
  // Under an explicit idempotencyKey the re-dispatched graph can differ from the original, so the
  // freshly-compiled digest (d2) diverges from the stale row's digest (d1). The original live instance
  // was deployed under `delivery-graph-d1`; matching it under the NEW digest d2 would miss it and strand
  // it live — a double-launch of side-effecting nodes. Reconcile MUST search under the stale row's own
  // digest. Learn both digests on throwaway apps.
  const probeOrig = await dispatchDeliveryGraphRun(makeApp().app, SIDE_EFFECTING, { runKey: "run-z", repoless: true });
  const probeDrift = await dispatchDeliveryGraphRun(makeApp().app, HUMAN_ONLY, { runKey: "run-z", repoless: true });
  assert(probeOrig.ok && probeDrift.ok);
  if (!probeOrig.ok || !probeDrift.ok) return;
  assert(probeOrig.digest !== probeDrift.digest, "the two graphs must have different digests for this test to bite");

  // The live original is deployed under the ORIGINAL digest's definition id — NOT the re-dispatched one.
  const { app, started, cancelled } = makeApp({
    liveOriginal: { processInstanceKey: "PI-orig", runKey: "run-z", processDefinitionId: `delivery-graph-${probeOrig.digest}` },
  });
  await seedStaleClaim(app, "run-z", probeOrig.digest);

  // Re-dispatch the DRIFTED graph under the same explicit key.
  const res = await dispatchDeliveryGraphRun(app, HUMAN_ONLY, { runKey: "run-z", repoless: true });
  assertEquals(res.ok, true);
  if (!res.ok) return;
  assertEquals(res.alreadyRunning, false, "the stale claim is re-claimed, not short-circuited");
  assertEquals(cancelled, ["PI-orig"], "the original (under the stale row's digest) is cancelled despite the graph drift");
  assertEquals(started.length, 1, "exactly one replacement instance launches");
});

// ── #853 review: a reconcile-read failure must leave the row RECLAIMABLE-with-reconcile, never `failed`
// (thread deliveryGraphDispatch.ts:280) ──────────────────────────────────────────────────────────────
// If the reconcile read/cancel throws TRANSIENTLY while the original instance is still live, retiring
// the stale claim to `failed` would let the NEXT dispatch relaunch WITHOUT reconciling (a `failed` row
// is a plain terminal re-run, not a stale claim), double-launching the side-effecting nodes. The claim
// must instead revert to a stale launch-claim so the reconcile is retried before any relaunch.

test("#853 dispatchDeliveryGraphRun: a reconcile-read failure reverts the row to a STALE claim (not `failed`), launching nothing — so the next dispatch retries reconcile instead of relaunching blind", async () => {
  const reconcileReadThrows = { on: true };
  const { app, started, cancelled, runs } = makeApp({ liveOriginal: { processInstanceKey: "PI-orig", runKey: "run-r" }, reconcileReadThrows });
  const probe = await dispatchDeliveryGraphRun(makeApp().app, SIDE_EFFECTING, { runKey: "run-r", repoless: true });
  assert(probe.ok);
  if (!probe.ok) return;
  await seedStaleClaim(app, "run-r", probe.digest);

  // Phase 1: the reconcile read throws. The dispatch must propagate the error, launch NOTHING, and
  // leave the row a reclaimable stale claim — NOT retire it to `failed`.
  await assertRejects(() => dispatchDeliveryGraphRun(app, SIDE_EFFECTING, { runKey: "run-r", repoless: true }), Error, "engine unavailable");
  const row = runs().find((r) => r["run_key"] === "run-r");
  assert(row, "the run row still exists");
  assertEquals(row?.["status"], "running", "the row stays a `running` claim, not `failed`");
  assertEquals(row?.["process_key"], null, "the row stays a NULL-key launch claim (still reclaimable as stale)");
  assert(isStaleLaunchClaim(row as Parameters<typeof isStaleLaunchClaim>[0]), "the row is still a STALE launch claim, so the reconcile is retried before any relaunch");
  assertEquals(started.length, 0, "nothing launched while the original may still be live");
  assertEquals(cancelled, [], "nothing cancelled — the read failed before any cancel");

  // Phase 2: the engine recovers. The NEXT dispatch re-enters reconcile (because the row is still a
  // stale claim), cancels the live original, and relaunches exactly once — proving the row was never
  // stranded in a `failed` state that would have relaunched blind.
  reconcileReadThrows.on = false;
  const res = await dispatchDeliveryGraphRun(app, SIDE_EFFECTING, { runKey: "run-r", repoless: true });
  assertEquals(res.ok, true);
  if (!res.ok) return;
  assertEquals(res.alreadyRunning, false, "the stale claim is re-claimed, not short-circuited");
  assertEquals(cancelled, ["PI-orig"], "the recovered reconcile cancels the live original before relaunch");
  assertEquals(started.length, 1, "exactly one replacement instance launches across the two dispatches");
});
