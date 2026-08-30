// Red/green coverage for the app-side engine-reset reconciliation surface (issue #622).
//
// The core scenario the incident (Magikcraft/nano-bpm#1065) demanded a supported remedy for: the
// engine is reset and its incarnation epoch REGRESSES, while `app.db` still projects engine-backed
// inflight work (an active `feature_runs`/`delivery_graph_runs`/… row keyed on a now-dead
// `process_key`). Reconcile must drive exactly those rows to the defined `orphaned` terminal WITH
// PROVENANCE, leave terminal history + non-engine-backed rows untouched, and be idempotent.
//
// These run against the REAL migration set (092 applied to an in-memory SQLite via urban's own
// `makeGateway`), so the tables/columns/indexes reconcile reads and writes are the shipping schema.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type DataLayer, makeGateway, type SqliteDb } from "@nanobpm/urban";
import { applyMigrationSet } from "#test-migrations";
import { assertEquals } from "#test-assert";
import {
  ORPHANED_STATUS,
  parseEngineEpoch,
  RECONCILE_ORPHAN_REASON,
  reconcileEngineBackedWork,
} from "./reconcile.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../db/migrations", import.meta.url));

/** Adapt a raw `node:sqlite` handle to urban's tiny `SqliteDb` seam so `makeGateway` yields the real
 *  record-oriented `DataSource` reconcile binds to (no fakes — the shipping gateway). */
function sqliteDb(raw: DatabaseSync): SqliteDb {
  return {
    exec: (sql) => raw.exec(sql),
    run: (sql, params = []) => {
      const r = raw.prepare(sql).run(...(params as never[]));
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    },
    all: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      raw.prepare(sql).all(...(params as never[])) as T[],
    close: () => raw.close(),
  };
}

function readMigrationFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith(".sql"))
    .map((name) => ({ name, sql: readFileSync(`${MIGRATIONS_DIR}/${name}`, "utf8") }));
}

/** A DataLayer over a fresh in-memory DB with the whole migration set applied. */
function freshData(): { data: DataLayer; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  applyMigrationSet(raw, readMigrationFiles());
  const gw = makeGateway(sqliteDb(raw));
  const data = { open: () => gw } as unknown as DataLayer;
  return { data, raw };
}

const AT = () => new Date("2026-02-02T00:00:00.000Z");

function seedFeatureRun(raw: DatabaseSync, key: string, status: string, processKey: string | null): void {
  raw
    .prepare(
      `INSERT INTO feature_runs (feature_key, repo, issue_number, issue_url, base_branch, status, process_key, created_at, updated_at)
       VALUES (?, 'o/r', 1, 'https://x', 'main', ?, ?, '2026-01-01', '2026-01-01')`,
    )
    .run(key, status, processKey);
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
