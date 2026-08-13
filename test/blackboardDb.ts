// A test-only DataLayer stub backed by a real in-memory `node:sqlite` database, for exercising the
// blackboard adapter (`app/blackboard.ts`) and the agentic `blackboard` family against a real SQLite
// engine rather than a mock. It mirrors the two surfaces the adapter uses:
//   - `data.source().db`  — the raw synchronous `SqliteDb` the shared `BlackboardStore` writes to,
//   - `data.table(name)`  — the async record gateway (only the `plans` table is needed here, for
//     token→plan resolution), backed by the SAME db so the sync (`planKeyForTokenSync`) and async
//     (`planKeyForToken`) paths see identical rows.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach } from "node:test";
import type { DataLayer } from "@nanobpm/urban";

/** The tiny synchronous SQLite handle shape the runtime + the agentic store share. */
interface SqliteDb {
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  close(): void;
}

function coerce(p: unknown): SQLInputValue {
  if (p === null) return null;
  if (typeof p === "boolean") return p ? 1 : 0;
  return p as SQLInputValue;
}

function wrap(db: DatabaseSync): SqliteDb {
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => {
      const r = db.prepare(sql).run(...params.map(coerce));
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    },
    all: <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params.map(coerce)) as T[],
    close: () => db.close(),
  };
}

// Every raw handle these helpers open is tracked here and released after each test, so call sites
// that drop the returned `close()` (most of them) don't leak native SQLite handles across the run.
const openDbs = new Set<DatabaseSync>();

afterEach(() => {
  for (const raw of openDbs) closeTracked(raw);
});

/** Open a tracked in-memory db and return it with an idempotent `close()` safe to call twice. */
function openTracked(): { raw: DatabaseSync; close(): void } {
  const raw = new DatabaseSync(":memory:");
  openDbs.add(raw);
  return { raw, close: () => closeTracked(raw) };
}

function closeTracked(raw: DatabaseSync): void {
  if (openDbs.delete(raw)) raw.close();
}

/** A minimal async record gateway over the real db — just the insert/find/findOne subset the
 * blackboard tests exercise on the `plans` table. */
function gateway(db: SqliteDb, name: string, pk: string) {
  const quote = (id: string) => `"${id.replace(/"/g, '""')}"`;
  return {
    // biome-ignore lint/suspicious/noExplicitAny: test-only gateway over dynamic row shapes.
    async insert(row: any): Promise<number | bigint | unknown> {
      const keys = Object.keys(row).filter((k) => row[k] !== undefined);
      const cols = keys.map(quote).join(", ");
      const placeholders = keys.map(() => "?").join(", ");
      const r = db.run(
        `INSERT INTO ${quote(name)} (${cols}) VALUES (${placeholders})`,
        keys.map((k) => row[k]),
      );
      return pk === "id" ? r.lastInsertRowid : row[pk];
    },
    // biome-ignore lint/suspicious/noExplicitAny: test-only gateway over dynamic row shapes.
    async find(where: any = {}): Promise<any[]> {
      const keys = Object.keys(where);
      const clause = keys.length ? `WHERE ${keys.map((k) => `${quote(k)} = ?`).join(" AND ")}` : "";
      return db.all(`SELECT * FROM ${quote(name)} ${clause}`, keys.map((k) => where[k]));
    },
    // biome-ignore lint/suspicious/noExplicitAny: test-only gateway over dynamic row shapes.
    async findOne(where: any = {}): Promise<any> {
      return (await this.find(where))[0];
    },
  };
}

/** A DataLayer stub over a fresh in-memory SQLite db, plus a `plans` table for token resolution. */
export function memBlackboardData(): { data: DataLayer; db: SqliteDb; close(): void } {
  const { raw, close } = openTracked();
  const db = wrap(raw);
  db.exec("CREATE TABLE IF NOT EXISTS plans (plan_key TEXT PRIMARY KEY, blackboard_token TEXT);");
  const data = {
    source: () => ({ db }),
    table: (name: string, pk = "id") => gateway(db, name, pk),
  } as unknown as DataLayer;
  return { data, db, close };
}

/**
 * A bare real-sqlite handle (no tables) for tests whose fake DataLayer keeps its OTHER tables as
 * in-memory arrays but still needs the blackboard's `data.source().db` seam to resolve to a real
 * SQLite engine (the store applies its own schema via `ensureSchema()`). Spread its `.source` into
 * the fake `data`: `{ ...fake, source: bb.source }`.
 */
export function memBlackboardSource(): { source: () => { db: SqliteDb }; db: SqliteDb; close(): void } {
  const { raw, close } = openTracked();
  const db = wrap(raw);
  return { source: () => ({ db }), db, close };
}
