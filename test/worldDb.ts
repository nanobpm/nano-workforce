// A test-only DataLayer over a real in-memory `node:sqlite` db with the world-restore schema
// (`db/migrations/049_world_checkpoint.sql`) applied, for exercising `app/world/store.ts` and the
// `app/world/checkpoint.ts` orchestration against a REAL SQLite engine — so the durable fence (the
// `UNIQUE(pr_key, idempotency_key)` constraint) and the monotonic offset are proven, not mocked.
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import type { DataLayer } from "@nanobpm/urban";

const openDbs = new Set<DatabaseSync>();
afterEach(() => {
  for (const raw of openDbs) {
    if (openDbs.delete(raw)) raw.close();
  }
});

function coerce(p: unknown): SQLInputValue {
  if (p === null || p === undefined) return null;
  if (typeof p === "boolean") return p ? 1 : 0;
  return p as SQLInputValue;
}

const quote = (id: string) => `"${id.replace(/"/g, '""')}"`;

/** A minimal async `Table<T>`-shaped gateway over one real SQLite table — the insert/find/findOne/
 * update/get subset the world store uses. Mirrors the runtime `Table<T>` semantics: `insert` omits
 * `undefined` keys (schema default governs), `update` skips `undefined` keys and clears on `null`. */
function gateway(db: DatabaseSync, name: string, pk: string) {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: test-only gateway over dynamic row shapes.
    async insert(row: any): Promise<number | bigint> {
      const keys = Object.keys(row).filter((k) => row[k] !== undefined);
      const cols = keys.map(quote).join(", ");
      const placeholders = keys.map(() => "?").join(", ");
      const r = db.prepare(`INSERT INTO ${quote(name)} (${cols}) VALUES (${placeholders})`).run(...keys.map((k) => coerce(row[k])));
      return pk === "id" ? r.lastInsertRowid : (row[pk] as number);
    },
    // biome-ignore lint/suspicious/noExplicitAny: test-only gateway over dynamic row shapes.
    async find(where: any = {}): Promise<any[]> {
      const keys = Object.keys(where);
      const clause = keys.length ? `WHERE ${keys.map((k) => `${quote(k)} = ?`).join(" AND ")}` : "";
      return db.prepare(`SELECT * FROM ${quote(name)} ${clause}`).all(...keys.map((k) => coerce(where[k])));
    },
    // biome-ignore lint/suspicious/noExplicitAny: test-only gateway over dynamic row shapes.
    async findOne(where: any = {}): Promise<any> {
      return (await this.find(where))[0];
    },
    // biome-ignore lint/suspicious/noExplicitAny: test-only gateway over dynamic row shapes.
    async get(id: any): Promise<any> {
      return db.prepare(`SELECT * FROM ${quote(name)} WHERE ${quote(pk)} = ?`).get(coerce(id));
    },
    // biome-ignore lint/suspicious/noExplicitAny: test-only gateway over dynamic row shapes.
    async update(id: any, patch: any): Promise<number> {
      const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
      if (keys.length === 0) return 0;
      const set = keys.map((k) => `${quote(k)} = ?`).join(", ");
      const r = db.prepare(`UPDATE ${quote(name)} SET ${set} WHERE ${quote(pk)} = ?`).run(...keys.map((k) => coerce(patch[k])), coerce(id));
      return Number(r.changes);
    },
  };
}

/** A minimal self-referential `DataSource`-shaped gateway over the real db: the `table` surface plus
 * a real `tx()` that BEGIN/COMMIT/ROLLBACKs on the underlying SQLite connection, so the world store's
 * atomic `recordCheckpoint` (checkpoint + effects in one transaction) is exercised against genuine
 * transaction semantics rather than mocked. `tx(fn)` passes the SAME source object to `fn`, so a test
 * that decorates `table` on the returned source sees its decoration inside the transaction too. */
type MemDataSource = {
  table: (name: string, pk?: string) => ReturnType<typeof gateway>;
  tx<T>(fn: (t: MemDataSource) => Promise<T>): Promise<T>;
};

function openDataSource(db: DatabaseSync): MemDataSource {
  const ds: MemDataSource = {
    table: (name, pk = "id") => gateway(db, name, pk),
    async tx(fn) {
      db.exec("BEGIN");
      try {
        const r = await fn(ds);
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return ds;
}

/** A `DataLayer` stub over a fresh in-memory db with the world schema applied. */
export function memWorldData(): { data: DataLayer; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  openDbs.add(db);
  const sql = readFileSync(fileURLToPath(new URL("../db/migrations/049_world_checkpoint.sql", import.meta.url)), "utf8");
  db.exec(sql);
  const data = {
    table: (name: string, pk = "id") => gateway(db, name, pk),
    open: () => openDataSource(db),
  } as unknown as DataLayer;
  return { data, db };
}
