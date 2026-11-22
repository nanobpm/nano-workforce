// Shared in-memory `open()` double for `DataLayer` fakes whose code under test runs
// `registerDependencies` (submitPr and its callers). Since the round-3 atomicity fix (issue #1007
// review), dependency replacement runs its DELETE+INSERTs through `data.open().tx(...)` so a
// concurrent `pollMerges` read can never observe the transient empty set. A fake whose `open()`
// lacks `tx` fails with `data.open is not a function` / `db.tx is not a function` — this helper
// gives every such fake the same minimal in-memory semantics: DELETE removes the PR's rows,
// INSERT appends, `tx` runs the callback in order (no real isolation needed in a single-threaded
// test double).
export interface MemStore {
  rows: Record<string, unknown>[];
  key: string;
}

type ExecFn = (sql: string, params?: unknown[]) => Promise<{ changed: number }>;
type TxFn = (fn: (q: { exec: ExecFn }) => Promise<unknown>) => Promise<unknown>;

/** Build the `open()` half of a DataLayer fake. `stores` maps table name → in-memory store (only
 * `pr_dependencies` is interpreted; any other SQL throws so an unexpected write is loud).
 * `exec` (optional) is the fake's own raw-exec behaviour, exposed verbatim on the returned
 * gateway. */
export function memOpenWithDepsTx(
  stores: Record<string, MemStore | undefined>,
  exec?: ExecFn,
): () => { exec: ExecFn; tx: TxFn } {
  const txExec: ExecFn = async (sql, params = []) => {
    if (/^DELETE FROM "pr_dependencies" WHERE "pr_key" = \?$/.test(sql)) {
      const store = stores.pr_dependencies;
      let changed = 0;
      if (store) {
        for (let i = store.rows.length - 1; i >= 0; i--) {
          if (store.rows[i].pr_key === params[0]) {
            store.rows.splice(i, 1);
            changed++;
          }
        }
      }
      return { changed };
    }
    if (/^INSERT INTO "pr_dependencies"/.test(sql)) {
      stores.pr_dependencies?.rows.push({ pr_key: params[0], depends_on_key: params[1], created_at: params[2] });
      return { changed: 1 };
    }
    if (exec) return exec(sql, params);
    throw new Error(`unexpected tx exec sql: ${sql}`);
  };
  return () => ({
    exec: exec ?? (() => Promise.reject(new Error("unexpected exec"))),
    tx: (fn) => fn({ exec: txExec }),
  });
}
