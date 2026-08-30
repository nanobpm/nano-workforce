// A test-only DataLayer over a real in-memory `node:sqlite` db with the WHOLE migration set applied,
// for exercising the engine-reset reconciliation surface (`app/reconcile.ts`, issue #622) and its
// operator-command delegate (`operations/reconcileEngineState.ts`) against the REAL shipping schema —
// so the tables/columns/indexes reconcile reads and writes are exactly what deploys, not a fake.
//
// Canonical harness shared by `app/reconcile.test.ts` and `operations/reconcileEngineState.test.ts`
// (derivation over duplication: one in-memory DataLayer builder, not two divergent copies).
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { type DataLayer, makeGateway, type SqliteDb } from "@nanobpm/urban";
import { applyMigrationSet } from "#test-migrations";

const MIGRATIONS_DIR = fileURLToPath(new URL("../db/migrations", import.meta.url));

// Every raw handle `freshData()` opens is tracked here and released after each test, so call sites
// (all of them) don't leak native SQLite handles across the run. Mirrors `test/worldDb.ts` and
// `test/blackboardDb.ts` (derivation over duplication: the same auto-close idiom, not a new one).
const openDbs = new Set<DatabaseSync>();
afterEach(() => {
  for (const raw of openDbs) {
    if (openDbs.delete(raw)) raw.close();
  }
});

/** Adapt a raw `node:sqlite` handle to urban's tiny `SqliteDb` seam so `makeGateway` yields the real
 *  record-oriented `DataSource` reconcile binds to (no fakes — the shipping gateway). */
export function sqliteDb(raw: DatabaseSync): SqliteDb {
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

export function readMigrationFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith(".sql"))
    .map((name) => ({ name, sql: readFileSync(`${MIGRATIONS_DIR}/${name}`, "utf8") }));
}

/** A DataLayer over a fresh in-memory DB with the whole migration set applied. The raw handle is
 *  tracked and auto-closed after each test (see `openDbs`), and FK enforcement is enabled so the
 *  migrations are exercised under the real constraints they ship with. */
export function freshData(): { data: DataLayer; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  openDbs.add(raw);
  // SQLite disables FK enforcement by default; enable it so migrations with foreign keys are
  // exercised (and any FK violations surface) exactly as they would on the shipping schema.
  raw.exec("PRAGMA foreign_keys = ON;");
  applyMigrationSet(raw, readMigrationFiles());
  const gw = makeGateway(sqliteDb(raw));
  const data = { open: () => gw } as unknown as DataLayer;
  return { data, raw };
}
