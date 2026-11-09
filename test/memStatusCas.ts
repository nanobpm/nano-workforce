// Test-only: apply the poller's compare-and-set status flip (`flipToMergingThenPublish`, app/service.ts)
// — `UPDATE <t> SET status = ?, updated_at = ? WHERE pr_key = ? AND status = ?` — against an
// in-memory store, so hand-rolled `DataLayer` fakes model the real conditional write (and its
// lost-race `changed: 0`) instead of no-op'ing it. Returns `null` for any other statement so the
// caller can fall through to its own handling (or throw loudly).
const CAS =
  /^\s*UPDATE\s+"?(\w+)"?\s+SET\s+"?(\w+)"?\s*=\s*\?\s*,\s*"?(\w+)"?\s*=\s*\?\s+WHERE\s+"?(\w+)"?\s*=\s*\?\s+AND\s+"?(\w+)"?\s*=\s*\?\s*$/i;

// biome-ignore lint/suspicious/noExplicitAny: test-only fake over dynamic row shapes.
export function memStatusCas(stores: Record<string, any[]>, sql: string, params: unknown[]): { changed: number } | null {
  const m = sql.match(CAS);
  if (!m) return null;
  const [, table, setA, setB, keyCol, condCol] = m;
  let changed = 0;
  for (const r of (stores[table] ??= [])) {
    if (r[keyCol] === params[2] && r[condCol] === params[3]) {
      r[setA] = params[0];
      r[setB] = params[1];
      changed++;
    }
  }
  return { changed };
}
