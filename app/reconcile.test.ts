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
import { assertEquals } from "#test-assert";
import { freshData } from "../test/reconcileDb.ts";
import {
  DEFAULT_VANISHED_GRACE_MS,
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

// --- Merged seam: runEngineReconcile (both passes, one result) --------------------------------
// The operator/startup seam merges the epoch-regression and vanished-instance passes into ONE
// result. This guards the merged behavior the two per-pass suites above don't reach: run-id
// correlation (the vanished pass's provenance must be locatable from the returned `runId`) and
// `reason` selection when the epoch pass is `engine-unreachable` yet vanished instances are orphaned.

test("runEngineReconcile: engine-unreachable epoch pass still folds vanished instances, with a correlatable run id", async () => {
  const { data, raw } = freshData();
  ensureInstanceState(raw);
  // A vanished orphan (escalated, past grace, instance absent from the read model).
  seedFeatureRun(raw, "Magikcraft/nano-bpm#1051", "escalated", "71506");

  // The engine is unreachable — the epoch probe fails, so the epoch pass reports `engine-unreachable`
  // and orphans nothing; the vanished pass must still act.
  const fetchImpl = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
  const res = await runEngineReconcile(
    data,
    { restAddress: "http://engine.invalid" },
    { now: AT, fetchImpl },
  );

  // The vanished pass acted even though the epoch pass could not reach the engine.
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

  // Both passes recorded their own reconcile_runs row under correlatable ids.
  const epochRun = raw.prepare("SELECT reason FROM reconcile_runs WHERE run_id=?").get(res.runId) as
    | { reason: string }
    | undefined;
  assertEquals(epochRun?.reason, "engine-unreachable");
  const vanishedRun = raw
    .prepare("SELECT reason, orphaned_count FROM reconcile_runs WHERE run_id=?")
    .get(`${res.runId}-vanished`) as { reason: string; orphaned_count: number } | undefined;
  assertEquals(vanishedRun?.reason, "instance-vanished");
  assertEquals(vanishedRun?.orphaned_count, 1);
});
