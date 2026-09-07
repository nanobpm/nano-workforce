// Red/green coverage for the app-side engine-reset reconciliation surface (issues #622 and #630).
//
// The core scenario the incident (Magikcraft/nano-bpm#1065) demanded a supported remedy for: the
// engine is reset and its incarnation epoch REGRESSES, while `app.db` still projects engine-backed
// inflight work (an active `feature_runs`/`delivery_graph_runs`/… row keyed on a now-dead
// `process_key`). Reconcile must drive exactly those rows to the defined `orphaned` terminal WITH
// PROVENANCE, leave terminal history + non-engine-backed rows untouched, and be idempotent.
//
// These run against the REAL migration set (092 applied to an in-memory SQLite via urban's own
// `makeGateway`), so the tables/columns/indexes reconcile reads and writes are the shipping schema.
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { DataLayer, GatewayDataSource as DataSource } from "@nanobpm/urban";
import { assertEquals, assertNotEquals } from "#test-assert";
import { freshData } from "../test/reconcileDb.ts";
import {
  DEFAULT_VANISHED_GRACE_MS,
  makeEngineActiveProbe,
  ORPHANED_STATUS,
  parseEngineEpoch,
  RECONCILE_ORPHAN_REASON,
  RECONCILE_VANISHED_REASON,
  reconcileEngineBackedWork,
  reconcileVanishedInstances,
  runEngineReconcile,
} from "./reconcile.ts";

const AT = () => new Date("2026-02-02T00:00:00.000Z");

/** The canonical `_urban_instance_state` DDL (urban's framework projection, `_urban_`-prefixed so it
 *  is provisioned by the runtime — NOT our migrations). Mirrors `InstanceStateStore`'s schema so the
 *  vanished-instance reconcile is exercised against exactly the table it reads in production. */
function ensureInstanceState(raw: DatabaseSync): void {
  raw.exec(
    `CREATE TABLE IF NOT EXISTS _urban_instance_state (
       process_instance_key TEXT NOT NULL,
       state                TEXT NOT NULL,
       waiting_on_human     INTEGER NOT NULL DEFAULT 0,
       updated_at           TEXT NOT NULL,
       PRIMARY KEY (process_instance_key)
     );`,
  );
}

function seedInstanceState(raw: DatabaseSync, processKey: string, state: string): void {
  raw
    .prepare(
      `INSERT INTO _urban_instance_state (process_instance_key, state, waiting_on_human, updated_at)
       VALUES (?, ?, 0, '2026-01-15')`,
    )
    .run(processKey, state);
}

function seedFeatureRun(
  raw: DatabaseSync,
  key: string,
  status: string,
  processKey: string | null,
  updatedAt = "2026-01-01",
): void {
  raw
    .prepare(
      `INSERT INTO feature_runs (feature_key, repo, issue_number, issue_url, base_branch, status, process_key, created_at, updated_at)
       VALUES (?, 'o/r', 1, 'https://x', 'main', ?, ?, '2026-01-01', ?)`,
    )
    .run(key, status, processKey, updatedAt);
}

function seedDeliveryGraphRun(raw: DatabaseSync, runKey: string, status: string, processKey: string | null): void {
  raw
    .prepare(
      `INSERT INTO delivery_graph_runs (run_key, process_key, digest, status, created_at, updated_at)
       VALUES (?, ?, 'deadbeef', ?, '2026-01-01', '2026-01-01')`,
    )
    .run(runKey, processKey, status);
}

test("parseEngineEpoch reads nano.incarnation (or its epoch alias), else null", () => {
  assertEquals(parseEngineEpoch({ nano: { incarnation: 7 } }), 7);
  assertEquals(parseEngineEpoch({ nano: { epoch: "9" } }), 9);
  assertEquals(parseEngineEpoch({ nano: { engine: "nano" } }), null);
  assertEquals(parseEngineEpoch({ gatewayVersion: "8.6" }), null);
  assertEquals(parseEngineEpoch(null), null);
});

test("first observation SEEDS the epoch without orphaning anything", async () => {
  const { data, raw } = freshData();
  seedFeatureRun(raw, "o/r#1", "running", "pk-1");

  const res = await reconcileEngineBackedWork(data, { reachable: true, epoch: 5 }, { now: AT, runId: "run-seed" });

  assertEquals(res.reason, "seed-epoch");
  assertEquals(res.orphanedCount, 0);
  const row = raw.prepare("SELECT status FROM feature_runs WHERE feature_key='o/r#1'").get() as { status: string };
  assertEquals(row.status, "running");
  const rec = raw.prepare("SELECT epoch FROM engine_incarnation WHERE id=1").get() as { epoch: number };
  assertEquals(rec.epoch, 5);
});

test("RED→GREEN: an epoch regression orphans dangling inflight rows with provenance", async () => {
  const { data, raw } = freshData();
  await reconcileEngineBackedWork(data, { reachable: true, epoch: 10 }, { now: AT, runId: "run-0" });
  seedFeatureRun(raw, "o/r#1", "running", "41");
  seedDeliveryGraphRun(raw, "graph-1", "running", "77");

  // The engine was reset/rewound: its incarnation epoch regressed 10 → 2.
  const res = await reconcileEngineBackedWork(data, { reachable: true, epoch: 2 }, { now: AT, runId: "run-1" });

  assertEquals(res.reason, "epoch-regression");
  assertEquals(res.orphanedCount, 2);

  const fr = raw.prepare("SELECT status FROM feature_runs WHERE feature_key='o/r#1'").get() as { status: string };
  assertEquals(fr.status, ORPHANED_STATUS);
  const dg = raw.prepare("SELECT status FROM delivery_graph_runs WHERE run_key='graph-1'").get() as { status: string };
  assertEquals(dg.status, ORPHANED_STATUS);

  const prov = raw
    .prepare("SELECT * FROM reconcile_provenance WHERE source_table='feature_runs'")
    .get() as Record<string, unknown>;
  assertEquals(prov.to_status, ORPHANED_STATUS);
  assertEquals(prov.from_status, "running");
  assertEquals(prov.reason, RECONCILE_ORPHAN_REASON);
  assertEquals(prov.observed_epoch, 2);
  assertEquals(prov.run_id, "run-1");
  assertEquals(prov.key_value, "41");

  const run = raw.prepare("SELECT reason, orphaned_count FROM reconcile_runs WHERE run_id='run-1'").get() as {
    reason: string;
    orphaned_count: number;
  };
  assertEquals(run.reason, "epoch-regression");
  assertEquals(run.orphaned_count, 2);
  const rec = raw.prepare("SELECT epoch FROM engine_incarnation WHERE id=1").get() as { epoch: number };
  assertEquals(rec.epoch, 2);
});

test("terminal history and rows without a process_key are NEVER touched", async () => {
  const { data, raw } = freshData();
  await reconcileEngineBackedWork(data, { reachable: true, epoch: 10 }, { now: AT, runId: "run-0" });
  seedFeatureRun(raw, "term#1", "merged", "88"); // terminal — not in activeStatuses
  seedFeatureRun(raw, "await#1", "opened", "89"); // terminal-for-tracking
  seedFeatureRun(raw, "nokeed#1", "running", null); // active but no engine key

  const res = await reconcileEngineBackedWork(data, { reachable: true, epoch: 2 }, { now: AT, runId: "run-1" });

  assertEquals(res.orphanedCount, 0);
  const statuses = raw.prepare("SELECT feature_key, status FROM feature_runs ORDER BY feature_key").all() as {
    feature_key: string;
    status: string;
  }[];
  assertEquals(statuses.find((r) => r.feature_key === "term#1")?.status, "merged");
  assertEquals(statuses.find((r) => r.feature_key === "await#1")?.status, "opened");
  assertEquals(statuses.find((r) => r.feature_key === "nokeed#1")?.status, "running");
  assertEquals((raw.prepare("SELECT COUNT(*) c FROM reconcile_provenance").get() as { c: number }).c, 0);
});

test("idempotent: a second pass with a matching epoch is a no-op", async () => {
  const { data, raw } = freshData();
  await reconcileEngineBackedWork(data, { reachable: true, epoch: 10 }, { now: AT, runId: "run-0" });
  seedFeatureRun(raw, "o/r#1", "running", "41");

  const first = await reconcileEngineBackedWork(data, { reachable: true, epoch: 2 }, { now: AT, runId: "run-1" });
  assertEquals(first.orphanedCount, 1);

  const second = await reconcileEngineBackedWork(data, { reachable: true, epoch: 2 }, { now: AT, runId: "run-2" });
  assertEquals(second.reason, "no-op");
  assertEquals(second.orphanedCount, 0);

  const provCount = raw.prepare("SELECT COUNT(*) c FROM reconcile_provenance").get() as { c: number };
  assertEquals(provCount.c, 1);
});

test("an unreachable engine is a hard no-op — live work is never orphaned", async () => {
  const { data, raw } = freshData();
  await reconcileEngineBackedWork(data, { reachable: true, epoch: 10 }, { now: AT, runId: "run-0" });
  seedFeatureRun(raw, "o/r#1", "running", "41");

  const res = await reconcileEngineBackedWork(data, { reachable: false, epoch: null }, { now: AT, runId: "run-1" });
  assertEquals(res.reason, "engine-unreachable");
  assertEquals(res.orphanedCount, 0);

  const row = raw.prepare("SELECT status FROM feature_runs WHERE feature_key='o/r#1'").get() as { status: string };
  assertEquals(row.status, "running");
  const run = raw.prepare("SELECT reason FROM reconcile_runs WHERE run_id='run-1'").get() as { reason: string };
  assertEquals(run.reason, "engine-unreachable");
});

test("RED→GREEN: a concurrent terminal transition wins — the guarded UPDATE never clobbers it", async () => {
  const { data, raw } = freshData();
  await reconcileEngineBackedWork(data, { reachable: true, epoch: 10 }, { now: AT, runId: "run-0" });
  seedFeatureRun(raw, "o/r#1", "running", "41");

  // Interpose a writer that flips the row to a newer terminal status AFTER reconcile has SELECTed it
  // as "running" but BEFORE its UPDATE lands — the exact TOCTOU window. With a blind UPDATE-by-pk the
  // reset would clobber `merged` back to `orphaned` (and write provenance); the guarded UPDATE (status
  // re-asserted) sees `res.changed === 0` and leaves the terminal history untouched.
  const gw = data.open();
  let raced = false;
  const wrapTx = (t: { query: (...a: unknown[]) => unknown; exec: (sql: string, params?: unknown[]) => unknown }) => ({
    query: (...a: unknown[]) => t.query(...a),
    exec: (sql: string, params?: unknown[]) => {
      if (!raced && /^UPDATE/.test(sql.trim())) {
        raced = true;
        raw.prepare("UPDATE feature_runs SET status='merged' WHERE feature_key='o/r#1'").run();
      }
      return t.exec(sql, params);
    },
  });
  const wrappedSrc = {
    query: (...a: unknown[]) => (gw as { query: (...a: unknown[]) => unknown }).query(...a),
    exec: (sql: string, params?: unknown[]) => (gw as { exec: (sql: string, params?: unknown[]) => unknown }).exec(sql, params),
    tx: (fn: (t: unknown) => unknown) => (gw as { tx: (f: (t: unknown) => unknown) => unknown }).tx((t) => fn(wrapTx(t as never))),
  };
  const wrapped = { open: () => wrappedSrc } as unknown as DataLayer;

  const res = await reconcileEngineBackedWork(wrapped, { reachable: true, epoch: 2 }, { now: AT, runId: "run-1" });

  assertEquals(raced, true);
  assertEquals(res.orphanedCount, 0);
  const row = raw.prepare("SELECT status FROM feature_runs WHERE feature_key='o/r#1'").get() as { status: string };
  assertEquals(row.status, "merged");
  assertEquals((raw.prepare("SELECT COUNT(*) c FROM reconcile_provenance").get() as { c: number }).c, 0);
});

test("RED→GREEN: orphaning stamps updated_at so the transition timestamp isn't left stale", async () => {
  const { data, raw } = freshData();
  await reconcileEngineBackedWork(data, { reachable: true, epoch: 10 }, { now: AT, runId: "run-0" });
  seedFeatureRun(raw, "o/r#1", "running", "41");
  seedDeliveryGraphRun(raw, "graph-1", "running", "77");

  // The seeded rows carry updated_at='2026-01-01'; AT() (the reconcile clock) is 2026-02-02. A blind
  // `SET status='orphaned'` would leave updated_at at the stale seed value, misrepresenting when the
  // row was orphaned to the UI/audits. The transition must refresh updated_at like every other one.
  const res = await reconcileEngineBackedWork(data, { reachable: true, epoch: 2 }, { now: AT, runId: "run-1" });

  assertEquals(res.orphanedCount, 2);
  const at = AT().toISOString();
  const fr = raw
    .prepare("SELECT status, updated_at FROM feature_runs WHERE feature_key='o/r#1'")
    .get() as { status: string; updated_at: string };
  assertEquals(fr.status, ORPHANED_STATUS);
  assertEquals(fr.updated_at, at);
  const dg = raw
    .prepare("SELECT status, updated_at FROM delivery_graph_runs WHERE run_key='graph-1'")
    .get() as { status: string; updated_at: string };
  assertEquals(dg.status, ORPHANED_STATUS);
  assertEquals(dg.updated_at, at);
});

// --- Vanished-instance reconciliation (issue #630) --------------------------------------------
// The "instance absent/unknown" gap, DISTINCT from the epoch-regression reset above: when an engine
// instance VANISHES from the read model (`_urban_instance_state` row pruned/never re-created after a
// clean reset), the derived terminal edge has no `TERMINATED` row to match, so the run freezes at its
// last worker-owned status (`escalated`) and wedges Active forever. `reconcileVanishedInstances`
// drives those orphaned-in-truth rows to `orphaned` WITH PROVENANCE — gated on a grace window so a
// still-starting run (not yet projected) is spared.

test("RED→GREEN: a vanished instance (no _urban_instance_state row, past grace) is orphaned", async () => {
  const { data, raw } = freshData();
  ensureInstanceState(raw);
  // The pre-reset orphan from the incident: escalated, keyed on a HIGH pre-reset process_key whose
  // instance is absent from the current read model. Its updated_at is ~32 days before AT() (past grace).
  seedFeatureRun(raw, "Magikcraft/nano-bpm#1051", "escalated", "71506");
  // A live sibling: still ACTIVE in the projection — must be left untouched.
  seedFeatureRun(raw, "o/r#live", "running", "200");
  seedInstanceState(raw, "200", "ACTIVE");

  // RED (pre-fix): the orphan reads `escalated` (Active) indefinitely — no terminal edge fires.
  const before = raw.prepare("SELECT status FROM feature_runs WHERE feature_key='Magikcraft/nano-bpm#1051'").get() as {
    status: string;
  };
  assertEquals(before.status, "escalated");

  const res = await reconcileVanishedInstances(data, { now: AT, runId: "van-1" });

  assertEquals(res.reason, "instance-vanished");
  assertEquals(res.orphanedCount, 1);

  const orphan = raw
    .prepare("SELECT status, updated_at FROM feature_runs WHERE feature_key='Magikcraft/nano-bpm#1051'")
    .get() as { status: string; updated_at: string };
  assertEquals(orphan.status, ORPHANED_STATUS);
  // The transition refreshes updated_at like every other status transition (not left stale).
  assertEquals(orphan.updated_at, AT().toISOString());

  // The live instance (ACTIVE row present) is never touched.
  const live = raw.prepare("SELECT status FROM feature_runs WHERE feature_key='o/r#live'").get() as { status: string };
  assertEquals(live.status, "running");

  const prov = raw
    .prepare("SELECT * FROM reconcile_provenance WHERE source_table='feature_runs'")
    .get() as Record<string, unknown>;
  assertEquals(prov.to_status, ORPHANED_STATUS);
  assertEquals(prov.from_status, "escalated");
  assertEquals(prov.reason, RECONCILE_VANISHED_REASON);
  assertEquals(prov.key_value, "71506");
  assertEquals(prov.run_id, "van-1");
  assertEquals(prov.observed_epoch, null);

  const run = raw.prepare("SELECT reason, orphaned_count FROM reconcile_runs WHERE run_id='van-1'").get() as {
    reason: string;
    orphaned_count: number;
  };
  assertEquals(run.reason, "instance-vanished");
  assertEquals(run.orphaned_count, 1);
});

test("a still-starting run within the grace window is NOT prematurely folded", async () => {
  const { data, raw } = freshData();
  ensureInstanceState(raw);
  // Dispatched moments ago — its process_key is set but the reconciler has not yet projected the
  // instance into _urban_instance_state. updated_at is 30s before AT(), inside the grace window.
  const justNow = new Date(AT().getTime() - 30_000).toISOString();
  seedFeatureRun(raw, "o/r#starting", "running", "999", justNow);

  const res = await reconcileVanishedInstances(data, { now: AT, runId: "van-1" });

  assertEquals(res.orphanedCount, 0);
  const row = raw.prepare("SELECT status FROM feature_runs WHERE feature_key='o/r#starting'").get() as {
    status: string;
  };
  assertEquals(row.status, "running");
  assertEquals((raw.prepare("SELECT COUNT(*) c FROM reconcile_provenance").get() as { c: number }).c, 0);
  // A generous grace window is the point — the default comfortably exceeds a poll cycle.
  assertEquals(DEFAULT_VANISHED_GRACE_MS >= 60_000, true);
});

test("RED→GREEN: a row whose updated_at is null/unparseable is spared, never orphaned", async () => {
  const { data, raw } = freshData();
  ensureInstanceState(raw);
  // A tracked table's `updated_at` can be nullable (e.g. delivery_units.updated_at,
  // db/migrations/088_delivery_units.sql) or carry an unparseable value. Its instance is absent from
  // the read model, so without a usable age we cannot tell a genuinely-vanished row from a live one.
  // RED (pre-fix): withinGrace treated an unestablishable age as "old enough" and folded the row.
  // GREEN: we err toward sparing — an ageless row is treated as within grace and left untouched.
  seedFeatureRun(raw, "o/r#ageless", "running", "888", "not-a-timestamp");

  const res = await reconcileVanishedInstances(data, { now: AT, runId: "van-1" });

  assertEquals(res.orphanedCount, 0);
  const row = raw.prepare("SELECT status FROM feature_runs WHERE feature_key='o/r#ageless'").get() as {
    status: string;
  };
  assertEquals(row.status, "running");
  assertEquals((raw.prepare("SELECT COUNT(*) c FROM reconcile_provenance").get() as { c: number }).c, 0);
});

test("terminal history, keyless rows, and rows with a live instance are never folded as vanished", async () => {
  const { data, raw } = freshData();
  ensureInstanceState(raw);
  seedFeatureRun(raw, "term#1", "merged", "88"); // terminal — not in activeStatuses
  seedFeatureRun(raw, "nokeed#1", "running", null); // active but never dispatched (no engine key)
  seedFeatureRun(raw, "live#1", "escalated", "89"); // active, but its instance is still present
  seedInstanceState(raw, "89", "ACTIVE");

  const res = await reconcileVanishedInstances(data, { now: AT, runId: "van-1" });

  assertEquals(res.orphanedCount, 0);
  const statuses = raw.prepare("SELECT feature_key, status FROM feature_runs ORDER BY feature_key").all() as {
    feature_key: string;
    status: string;
  }[];
  assertEquals(statuses.find((r) => r.feature_key === "term#1")?.status, "merged");
  assertEquals(statuses.find((r) => r.feature_key === "nokeed#1")?.status, "running");
  assertEquals(statuses.find((r) => r.feature_key === "live#1")?.status, "escalated");
  assertEquals((raw.prepare("SELECT COUNT(*) c FROM reconcile_provenance").get() as { c: number }).c, 0);
});

test("no-op when the _urban_instance_state projection is absent (never orphan on its absence)", async () => {
  const { data, raw } = freshData();
  // NOTE: no ensureInstanceState — the framework projection has not been provisioned.
  seedFeatureRun(raw, "o/r#1", "escalated", "71506");

  const res = await reconcileVanishedInstances(data, { now: AT, runId: "van-1" });

  assertEquals(res.reason, "no-op");
  assertEquals(res.orphanedCount, 0);
  const row = raw.prepare("SELECT status FROM feature_runs WHERE feature_key='o/r#1'").get() as { status: string };
  assertEquals(row.status, "escalated");
  const run = raw.prepare("SELECT reason FROM reconcile_runs WHERE run_id='van-1'").get() as { reason: string };
  assertEquals(run.reason, "no-op");
});

test("idempotent: a second vanished pass is a no-op (the orphaned row left activeStatuses)", async () => {
  const { data, raw } = freshData();
  ensureInstanceState(raw);
  seedFeatureRun(raw, "o/r#1", "escalated", "71506");

  const first = await reconcileVanishedInstances(data, { now: AT, runId: "van-1" });
  assertEquals(first.orphanedCount, 1);

  const second = await reconcileVanishedInstances(data, { now: AT, runId: "van-2" });
  assertEquals(second.reason, "no-op");
  assertEquals(second.orphanedCount, 0);
  assertEquals((raw.prepare("SELECT COUNT(*) c FROM reconcile_provenance").get() as { c: number }).c, 1);
});

// --- Engine-truth cross-check before orphaning a "vanished" row (issue #736) -------------------
// The `_urban_instance_state` projection is an app-side read model that can lag / be pruned / be
// rebuilt while the instance is still ACTIVE on the engine. "No projection row" is therefore NOT
// "instance vanished": on merlin (whose engine exposes no incarnation epoch, so the robust epoch
// detector is disabled) this false-orphaned 3 concurrently-LIVE instances in one pass. The vanished
// pass now cross-checks ENGINE TRUTH via `engineActive` before folding — an ACTIVE instance is spared.

test("RED→GREEN #736: an engine-ACTIVE instance with no _urban_instance_state row (past grace) is NOT orphaned", async () => {
  const { data, raw } = freshData();
  ensureInstanceState(raw);
  // The merlin repro: an inflight run past grace whose projection row is absent (lagging/pruned) but
  // whose instance the engine still reports ACTIVE. RED (pre-fix): folded to `orphaned`. GREEN: spared.
  seedFeatureRun(raw, "nanobpm/nano-workforce#336", "running", "11625");
  // Engine truth says ACTIVE for this key.
  const engineActive = async (key: string) => (key === "11625" ? true : false);

  const res = await reconcileVanishedInstances(data, { now: AT, runId: "van-1", engineActive });

  assertEquals(res.reason, "no-op");
  assertEquals(res.orphanedCount, 0);
  const row = raw.prepare("SELECT status FROM feature_runs WHERE feature_key='nanobpm/nano-workforce#336'").get() as {
    status: string;
  };
  assertEquals(row.status, "running");
  assertEquals((raw.prepare("SELECT COUNT(*) c FROM reconcile_provenance").get() as { c: number }).c, 0);
});

test("#736: an engine-CONFIRMED-gone instance (engineActive=false) IS still orphaned", async () => {
  const { data, raw } = freshData();
  ensureInstanceState(raw);
  seedFeatureRun(raw, "Magikcraft/nano-bpm#1051", "escalated", "71506");
  // Engine answered and the instance is absent/terminated — genuinely gone in engine truth.
  const engineActive = async () => false;

  const res = await reconcileVanishedInstances(data, { now: AT, runId: "van-1", engineActive });

  assertEquals(res.reason, "instance-vanished");
  assertEquals(res.orphanedCount, 1);
  const row = raw.prepare("SELECT status FROM feature_runs WHERE feature_key='Magikcraft/nano-bpm#1051'").get() as {
    status: string;
  };
  assertEquals(row.status, ORPHANED_STATUS);
});

test("#736: an instance whose engine truth is UNKNOWN (engineActive=null) is spared — never orphan unconfirmed", async () => {
  const { data, raw } = freshData();
  ensureInstanceState(raw);
  seedFeatureRun(raw, "o/r#unknown", "escalated", "71506");
  // The engine truth could not be established (unreachable / non-2xx / malformed) — we must NOT orphan.
  const engineActive = async () => null;

  const res = await reconcileVanishedInstances(data, { now: AT, runId: "van-1", engineActive });

  assertEquals(res.reason, "no-op");
  assertEquals(res.orphanedCount, 0);
  const row = raw.prepare("SELECT status FROM feature_runs WHERE feature_key='o/r#unknown'").get() as {
    status: string;
  };
  assertEquals(row.status, "escalated");
});

// --- Merged seam: runEngineReconcile (both passes, one result) --------------------------------
// The operator/startup seam merges the epoch-regression and vanished-instance passes into ONE
// result. This guards the merged behavior the two per-pass suites above don't reach: run-id
// correlation (the vanished pass's provenance must be locatable from the returned `runId`), the
// engine-truth cross-check the seam wires from the live engine (#736), and `reason` selection.

/** A `/v2` fetch stub: `/topology` answers `topologyBody` (200), and `/process-instances/search`
 *  answers with `searchItems` (200) — the engine-truth cross-check the vanished pass runs (#736). */
function engineFetch(
  topologyBody: unknown,
  searchItems: { processInstanceKey?: string | number; state?: string }[],
): typeof fetch {
  return (async (url: string, init?: { method?: string }) => {
    const u = String(url);
    if (u.endsWith("/topology")) return new Response(JSON.stringify(topologyBody), { status: 200 });
    if (u.endsWith("/process-instances/search") && init?.method === "POST") {
      return new Response(JSON.stringify({ items: searchItems }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

test("runEngineReconcile #736: a reachable engine reporting the instance ACTIVE spares it (no false-orphan)", async () => {
  const { data, raw } = freshData();
  ensureInstanceState(raw);
  // No projection row, past grace — but the engine (reachable, no epoch, like merlin) reports ACTIVE.
  seedFeatureRun(raw, "nanobpm/nano-workforce#731", "escalated", "11644");
  const fetchImpl = engineFetch({ nano: { engine: "merlin" } }, [{ processInstanceKey: "11644", state: "ACTIVE" }]);

  const res = await runEngineReconcile(data, { restAddress: "http://engine.local/v2" }, { now: AT, fetchImpl });

  assertEquals(res.orphanedCount, 0);
  const row = raw.prepare("SELECT status FROM feature_runs WHERE feature_key='nanobpm/nano-workforce#731'").get() as {
    status: string;
  };
  assertEquals(row.status, "escalated");
  assertEquals((raw.prepare("SELECT COUNT(*) c FROM reconcile_provenance").get() as { c: number }).c, 0);
});

test("runEngineReconcile #736: a reachable engine that no longer knows the instance folds it, with a correlatable run id", async () => {
  const { data, raw } = freshData();
  ensureInstanceState(raw);
  // A genuinely-vanished orphan (escalated, past grace); the engine answers but the instance is absent.
  seedFeatureRun(raw, "Magikcraft/nano-bpm#1051", "escalated", "71506");
  const fetchImpl = engineFetch({ nano: { engine: "merlin" } }, []);

  const res = await runEngineReconcile(data, { restAddress: "http://engine.local/v2" }, { now: AT, fetchImpl });

  assertEquals(res.reason, "instance-vanished");
  assertEquals(res.orphanedCount, 1);
  const orphan = raw
    .prepare("SELECT status FROM feature_runs WHERE feature_key='Magikcraft/nano-bpm#1051'")
    .get() as { status: string };
  assertEquals(orphan.status, ORPHANED_STATUS);

  // The vanished pass's provenance is stamped with the DERIVED, correlatable id `<runId>-vanished`
  // (the boot path omits opts.runId, so a bare random UUID would be non-locatable from the result).
  const prov = raw
    .prepare("SELECT run_id FROM reconcile_provenance WHERE source_table='feature_runs'")
    .get() as { run_id: string };
  assertEquals(prov.run_id, `${res.runId}-vanished`);

  const vanishedRun = raw
    .prepare("SELECT reason, orphaned_count FROM reconcile_runs WHERE run_id=?")
    .get(`${res.runId}-vanished`) as { reason: string; orphaned_count: number } | undefined;
  assertEquals(vanishedRun?.reason, "instance-vanished");
  assertEquals(vanishedRun?.orphaned_count, 1);
});

test("runEngineReconcile #736: an UNREACHABLE engine spares vanished candidates (truth unconfirmed → never orphan)", async () => {
  const { data, raw } = freshData();
  ensureInstanceState(raw);
  // A candidate that looks vanished (escalated, past grace, no projection row) — but with the engine
  // unreachable we cannot confirm it is gone, so it MUST be spared (issue #736): the old projection-only
  // behavior would have orphaned it, potentially false-orphaning a live instance mid-outage.
  seedFeatureRun(raw, "Magikcraft/nano-bpm#1051", "escalated", "71506");

  const fetchImpl = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
  const res = await runEngineReconcile(data, { restAddress: "http://engine.invalid" }, { now: AT, fetchImpl });

  // The epoch pass could not reach the engine, and the vanished pass could not confirm death → no-op.
  assertEquals(res.reason, "engine-unreachable");
  assertEquals(res.orphanedCount, 0);
  const row = raw.prepare("SELECT status FROM feature_runs WHERE feature_key='Magikcraft/nano-bpm#1051'").get() as {
    status: string;
  };
  assertEquals(row.status, "escalated");
  assertEquals((raw.prepare("SELECT COUNT(*) c FROM reconcile_provenance").get() as { c: number }).c, 0);
});

// --- Hardening the cross-check itself (#736 review) ---------------------------------------------
// Two defects of the SAME class the first cut still carried — "never orphan a row we could not
// positively confirm is gone" — plus the lock-hold the cross-check introduced:
//   1. a MATCHING search item whose `state` was missing or outside the engine's lifecycle enum read as
//      `false` ("gone"), so a malformed/partial engine answer folded live work;
//   2. the probe (network I/O) was awaited INSIDE `src.tx(...)`, so a slow or unreachable engine held
//      the SQLite write transaction open for the probe's full timeout PER CANDIDATE ROW — stalling
//      every other writer, including boot — and an injected probe that threw aborted the whole pass.

/** Answer `/v2/process-instances/search` with exactly `items` (200), so a probe's classification can
 *  be read off one wire shape varying only in the item's `state`. */
function searchItemsFetch(items: { processInstanceKey?: string | number; state?: string }[]): typeof fetch {
  return (async () => new Response(JSON.stringify({ items }), { status: 200 })) as unknown as typeof fetch;
}

/** Probe the key `11644` against a stubbed engine search answer of `items`. */
function probeAgainst(items: { processInstanceKey?: string | number; state?: string }[]): Promise<boolean | null> {
  const probe = makeEngineActiveProbe({ restAddress: "http://engine.local/v2" }, { fetchImpl: searchItemsFetch(items) });
  return probe("11644");
}

test("#736: the probe answers `true` for ACTIVE and `false` ONLY for a known-terminal engine state", async () => {
  assertEquals(await probeAgainst([{ processInstanceKey: "11644", state: "ACTIVE" }]), true);
  // The wire may carry the key as a JSON number and the state in any casing.
  assertEquals(await probeAgainst([{ processInstanceKey: 11644, state: "active" }]), true);
  for (const state of ["COMPLETED", "TERMINATED", "CANCELED", "FAILED"]) {
    assertEquals(await probeAgainst([{ processInstanceKey: "11644", state }]), false, `${state} is a positive "gone"`);
  }
  // Absent from the read model is STILL a positive "gone": the engine answered and does not know it.
  assertEquals(await probeAgainst([]), false);
});

test("RED→GREEN #736: a MISSING or UNRECOGNIZED engine state is UNKNOWN truth (`null` → spare), never `false`", async () => {
  // RED (pre-fix): the probe answered `String(match.state ?? "").toUpperCase() === "ACTIVE"`, so a
  // partial item (no `state`) or a state outside the enum this app knows read as "gone" and folded the
  // row — contradicting the probe's own contract that malformed engine truth degrades to `null`.
  assertEquals(await probeAgainst([{ processInstanceKey: "11644" }]), null, "a missing state is not a confirmed death");
  assertEquals(await probeAgainst([{ processInstanceKey: "11644", state: "" }]), null);
  assertEquals(await probeAgainst([{ processInstanceKey: "11644", state: "SUSPENDED" }]), null);
  // An item for a DIFFERENT key is no match for this one, so that stays "absent" (gone), not unknown.
  assertEquals(await probeAgainst([{ processInstanceKey: "99999" }]), false);
});

test("RED→GREEN #736: a malformed search item (no `state`) spares the candidate end-to-end", async () => {
  const { data, raw } = freshData();
  ensureInstanceState(raw);
  // Past grace, no projection row, and the engine ANSWERS — but its item carries no lifecycle state, so
  // engine truth is unestablished and the row must survive (RED pre-fix: folded to `orphaned`).
  seedFeatureRun(raw, "nanobpm/nano-workforce#731", "escalated", "11644");
  const fetchImpl = engineFetch({ nano: { engine: "merlin" } }, [{ processInstanceKey: "11644" }]);

  const res = await runEngineReconcile(data, { restAddress: "http://engine.local/v2" }, { now: AT, fetchImpl });

  assertEquals(res.orphanedCount, 0);
  const row = raw.prepare("SELECT status FROM feature_runs WHERE feature_key='nanobpm/nano-workforce#731'").get() as {
    status: string;
  };
  assertEquals(row.status, "escalated");
  assertEquals((raw.prepare("SELECT COUNT(*) c FROM reconcile_provenance").get() as { c: number }).c, 0);
});

test("RED→GREEN #736: a probe that THROWS is unknown truth — it spares the row instead of aborting the pass", async () => {
  const { data, raw } = freshData();
  ensureInstanceState(raw);
  seedFeatureRun(raw, "o/r#boom", "escalated", "71506");
  // `engineActive` is injectable: an implementation that rejects means truth could NOT be established
  // (spare), and must not bubble out of the pass.
  const engineActive = async (): Promise<boolean | null> => {
    throw new Error("engine exploded");
  };

  const res = await reconcileVanishedInstances(data, { now: AT, runId: "van-1", engineActive });

  assertEquals(res.reason, "no-op");
  assertEquals(res.orphanedCount, 0);
  const row = raw.prepare("SELECT status FROM feature_runs WHERE feature_key='o/r#boom'").get() as { status: string };
  assertEquals(row.status, "escalated");
  // The pass COMPLETED and recorded its run — pre-fix the throw escaped the transaction and rejected the
  // whole reconcile, so no `reconcile_runs` row was written at all.
  const run = raw.prepare("SELECT reason, orphaned_count FROM reconcile_runs WHERE run_id='van-1'").get() as
    | { reason: string; orphaned_count: number }
    | undefined;
  assertEquals(run?.reason, "no-op");
  assertEquals(run?.orphaned_count, 0);
});

test("RED→GREEN #736: the probe (network I/O) is never awaited INSIDE the write transaction", async () => {
  const { data, raw } = freshData();
  ensureInstanceState(raw);
  seedFeatureRun(raw, "o/r#tx", "escalated", "71506");

  // Wrap the gateway so the probe can report how deep in `src.tx(...)` it was awaited. RED (pre-fix):
  // depth 1 — every candidate row held the SQLite write transaction open across a network round trip
  // (up to the probe's full timeout on a slow/unreachable engine), delaying every other writer and
  // slowing/locking boot. GREEN: depth 0 — the probes finish first, and only the guarded UPDATE +
  // provenance writes run in a short transaction.
  let depth = 0;
  const observed: number[] = [];
  const inner = data.open();
  const tracked = {
    open: () => ({
      query: (sql: string, params?: unknown[]) => inner.query(sql, params),
      exec: (sql: string, params?: unknown[]) => inner.exec(sql, params),
      schema: () => inner.schema(),
      table: (name: string, pk?: string) => inner.table(name, pk),
      tx: async <T>(fn: (t: DataSource) => Promise<T>): Promise<T> => {
        depth += 1;
        try {
          return await inner.tx(fn);
        } finally {
          depth -= 1;
        }
      },
    }),
  } as unknown as DataLayer;

  const engineActive = async (): Promise<boolean | null> => {
    observed.push(depth);
    return false;
  };

  const res = await reconcileVanishedInstances(tracked, { now: AT, runId: "van-tx", engineActive });

  // Exactly one entry: the seeded row also mirrors into `delivery_units` (same `process_key`), and one
  // instance is probed once (see the next test) — at depth 0, outside any open write transaction.
  assertEquals(observed, [0], "the engine-truth probe must be awaited outside any open write transaction");
  // Hoisting the probe out of the transaction must not weaken the pass: a confirmed-gone row still folds.
  assertEquals(res.orphanedCount, 1);
  const row = raw.prepare("SELECT status FROM feature_runs WHERE feature_key='o/r#tx'").get() as { status: string };
  assertEquals(row.status, ORPHANED_STATUS);
});

test("#736: one instance backing several tracked rows is probed ONCE (engine truth is per instance)", async () => {
  const { data, raw } = freshData();
  ensureInstanceState(raw);
  // A `feature_runs` row is ALSO mirrored into the `delivery_units` aggregate by DB trigger
  // (db/migrations/089), carrying the same `process_key` — so one vanished instance yields TWO
  // candidates. Engine truth is per instance, so it must be asked once, not once per row (each probe
  // can block for its full timeout on a slow engine).
  seedFeatureRun(raw, "o/r#mirror", "escalated", "71506");
  const probed: string[] = [];
  const engineActive = async (key: string): Promise<boolean | null> => {
    probed.push(key);
    return false;
  };

  const res = await reconcileVanishedInstances(data, { now: AT, runId: "van-mirror", engineActive });

  assertEquals(probed, ["71506"], "one probe per distinct instance key");
  // Folding the base row re-projects its mirror (the sync trigger clears `dispatch_status`), so the
  // mirror is not folded a second time for the same instance — no duplicate provenance.
  assertEquals(res.orphaned.map((o) => o.table), ["feature_runs"]);
  assertEquals(res.orphanedCount, 1);
  const mirror = raw.prepare("SELECT dispatch_status FROM delivery_units WHERE legacy_key='o/r#mirror'").get() as {
    dispatch_status: string | null;
  };
  assertNotEquals(mirror.dispatch_status, "dispatched");
});
