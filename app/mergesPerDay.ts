// Merged-per-day burn-down / throughput read model (issue #344).
//
// A simple time-series behind the console's "Velocity" page: how many PRs the fleet landed each
// calendar day. Every land is already audited in the `merges` table (004_merge.sql) — one row per
// merge attempt, `outcome ∈ {merged|queued|blocked}`, `at` = ISO timestamp — so merged-per-day is
// fully DERIVABLE from that audit trail with NO new write-path bookkeeping (AGENTS.md: "Derivation
// over duplication"). The canonical aggregate is the one in the issue:
//
//   SELECT date(at) AS day, COUNT(DISTINCT pr_key) AS merged
//   FROM merges WHERE outcome = 'merged' GROUP BY date(at);
//
// Two halves, mirroring the `deriveDelivery`/`pollDelivery` and `deriveLineage`/`pollLineage`
// convention:
//   • `deriveMergesPerDay` — a PURE function: merge audit rows → one ordered `MergeDay` per calendar
//     day (merged count, burn-up cumulative, a proportional bar string). No I/O, fully tested. Counts
//     `COUNT(DISTINCT pr_key)` — a PR with several `merged` rows on one day (an `already-merged`
//     short-circuit or retry) counts once — and ignores `queued`/`blocked` rows entirely.
//   • `pollMergesPerDay` — the gateway glue: read the `merges` rows and project them onto the
//     `merges_per_day` read table (051_merges_per_day.sql) the schema-driven Velocity page binds. A
//     denormalised flat table because Urban's datasource cannot read a SQL VIEW (gateway.ts
//     `schema()` whitelists `type='table'` only — same reason `lineage_threads`/`plans.delivery` are
//     flat tables). Writes only when a day's projection actually changes, so a steady-state pass is a
//     no-op.
import type { DataLayer } from "@nanobpm/urban";

const now = () => new Date().toISOString();

/** The subset of a `merges` audit row (004_merge.sql) the projection reads. */
export interface MergeAuditRow {
  pr_key: string;
  outcome: string;
  at: string;
}

/** One projected calendar day of merge throughput. */
export interface MergeDay {
  /** Calendar day, ISO `YYYY-MM-DD` (SQLite `date(at)`). */
  day: string;
  /** Distinct PRs merged that day (`COUNT(DISTINCT pr_key)`). */
  merged: number;
  /** Running total of merged PRs up to and including this day — the burn-up line. */
  cumulative: number;
  /** Proportional block-character bar (length scaled to the busiest day), for the prose chart. */
  bar: string;
}

/** Widest bar (in block glyphs) the busiest day draws; every other day scales against it. */
const BAR_WIDTH = 30;
const BAR_FULL = "█";

/** The calendar day of an ISO timestamp — the JS twin of SQLite `date(at)`. A well-formed `merges.at`
 *  is an ISO string, so the first 10 chars are `YYYY-MM-DD`; fall back to the whole trimmed value for
 *  any non-ISO shape so a malformed row still groups deterministically rather than throwing. */
function dayOf(at: string): string {
  const s = String(at).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

/** Render a proportional bar: `merged` glyphs scaled against the busiest day's `max`, min one glyph
 *  for any non-zero day so a lone merge is still visible. Zero renders as an empty bar. */
function barFor(merged: number, max: number): string {
  if (merged <= 0 || max <= 0) return "";
  const n = Math.max(1, Math.round((merged / max) * BAR_WIDTH));
  return BAR_FULL.repeat(n);
}

/** PURE aggregate: merge audit rows → one ordered `MergeDay` per calendar day (ascending).
 *
 * Only `outcome === "merged"` rows count; `queued`/`blocked` attempts are ignored. Within a day a
 * `pr_key` is counted once (`COUNT(DISTINCT pr_key)`), so duplicate `merged` audit rows — an
 * `already-merged` short-circuit or a retry — do not double-count. `cumulative` is the running total
 * across days (burn-up); `bar` is scaled against the busiest day so the chart is comparable. */
export function deriveMergesPerDay(rows: readonly MergeAuditRow[]): MergeDay[] {
  // day -> set of distinct merged pr_keys that day.
  const prKeysByDay = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.outcome !== "merged") continue;
    if (r.pr_key == null || r.at == null) continue;
    const day = dayOf(r.at);
    let set = prKeysByDay.get(day);
    if (!set) {
      set = new Set<string>();
      prKeysByDay.set(day, set);
    }
    set.add(r.pr_key);
  }

  const counts = [...prKeysByDay.entries()]
    .map(([day, set]) => ({ day, merged: set.size }))
    .sort((a, b) => a.day.localeCompare(b.day));
  const max = counts.reduce((m, c) => Math.max(m, c.merged), 0);

  let cumulative = 0;
  const out: MergeDay[] = [];
  for (const { day, merged } of counts) {
    cumulative += merged;
    out.push({ day, merged, cumulative, bar: barFor(merged, max) });
  }
  return out;
}

/** The denormalised read-table row `pollMergesPerDay` projects, one per calendar day. */
interface MergesPerDayRow extends MergeDay {
  updated_at: string;
}

const mergesPerDay = (data: DataLayer) => data.table<MergesPerDayRow>("merges_per_day", "day");
const mergesAudit = (data: DataLayer) => data.table<MergeAuditRow>("merges", "id");

/** Idempotent read-model pass: recompute merged-per-day from the `merges` audit table and denormalise
 * it onto the `merges_per_day` read table the Velocity page reads. Additive/derived only — never
 * touches `merges`. Upserts a day only when its projection actually changes (so a steady-state pass is
 * a no-op) and prunes any stale day row that no longer derives (defensive — days are append-only in
 * practice, but a purge/rewrite of the audit must not leave a phantom). */
export async function pollMergesPerDay(data: DataLayer): Promise<void> {
  try {
    const audit = await mergesAudit(data).all();
    const want = deriveMergesPerDay(audit);
    const wantByDay = new Map(want.map((d) => [d.day, d]));

    const existing = await mergesPerDay(data).all();
    const existingByDay = new Map(existing.map((r) => [r.day, r]));

    for (const d of want) {
      const cur = existingByDay.get(d.day);
      if (!cur) {
        await mergesPerDay(data).insert({ ...d, updated_at: now() });
      } else if (cur.merged !== d.merged || cur.cumulative !== d.cumulative || cur.bar !== d.bar) {
        await mergesPerDay(data).update(d.day, {
          merged: d.merged,
          cumulative: d.cumulative,
          bar: d.bar,
          updated_at: now(),
        });
      }
    }

    // Prune any projected day that no longer derives from the audit trail.
    for (const r of existing) {
      if (!wantByDay.has(r.day)) await mergesPerDay(data).delete(r.day);
    }
  } catch (err) {
    console.error(`[poller] merges-per-day: ${err}`);
  }
}
