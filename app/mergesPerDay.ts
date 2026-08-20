// Merged-per-day throughput / burn-up read model (issue #344).
//
// A simple time-series behind the console's "Velocity" page: how many PRs the fleet landed each
// calendar day (throughput), plus a running `cumulative` burn-up total. Every land is already
// audited in the `merges` table (004_merge.sql) — one row per merge attempt, whose `outcome`
// includes `merged`, `queued`, `blocked` and `retry` (see the merge classifier in github.ts; the
// set is not exhaustive), `at` = ISO timestamp. Only `outcome = 'merged'` rows feed this aggregate,
// so merged-per-day is
// fully DERIVABLE from that audit trail with NO new write-path bookkeeping (AGENTS.md: "Derivation
// over duplication"). The `at` audit value is UTC, but the day is bucketed in the viewer's LOCAL
// timezone (issue #361) so an operator sees merges on the calendar day they happened locally, not
// shifted across a UTC midnight. The canonical aggregate is the one in the issue, in local time:
//
//   SELECT date(at, 'localtime') AS day, COUNT(DISTINCT pr_key) AS merged
//   FROM merges WHERE outcome = 'merged' GROUP BY date(at, 'localtime');
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
  /** Local calendar day, ISO `YYYY-MM-DD` (SQLite `date(at, 'localtime')` — issue #361). */
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

/** The **local** calendar day of an ISO timestamp — the viewer's-timezone twin of SQLite
 *  `date(at, 'localtime')` (issue #361). The `merges.at` audit value is a UTC ISO string, but the
 *  Velocity page is read by an operator in their own timezone, so bucketing on the UTC date split a
 *  single local day across two rows (a late-evening merge west of UTC, or an early-morning one east
 *  of it, landed on the wrong day). We derive the day in the target `timeZone` via
 *  `Intl.DateTimeFormat` — an explicit, side-effect-free zone rather than one mutated through the
 *  process-global `process.env.TZ`. When `timeZone` is omitted the formatter uses the host's
 *  resolved zone (so a remote deployment can still pin the operator's zone via `TZ`, and a
 *  co-located console — the default `npm start` on `localhost` — is already the browser's zone). An
 *  invalid/unknown IANA `timeZone` falls back to the host-resolved zone (rather than throwing a
 *  `RangeError` that would wedge `deriveMergesPerDay`/`pollMergesPerDay`), so bucketing stays
 *  deterministic. Any value that does not parse to a real instant (a malformed / non-ISO row) falls
 *  back to the whole trimmed string so it still groups deterministically rather than throwing. */
const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** A cached `en-CA` day formatter for `timeZone`, falling back to the host-resolved zone when the
 *  zone is invalid/unknown (an invalid IANA string makes `Intl.DateTimeFormat` throw a `RangeError`).
 *  Keyed so an invalid zone is only probed once. */
function dayFormatter(timeZone?: string): Intl.DateTimeFormat {
  const key = timeZone ?? "";
  const cached = dayFormatters.get(key);
  if (cached) return cached;
  const opts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-CA", { ...opts, timeZone });
  } catch {
    fmt = new Intl.DateTimeFormat("en-CA", opts);
  }
  dayFormatters.set(key, fmt);
  return fmt;
}

function dayOf(at: string, timeZone?: string): string {
  const s = String(at).trim();
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const parts = dayFormatter(timeZone).formatToParts(d);
  const field = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${field("year")}-${field("month")}-${field("day")}`;
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
 * Days are bucketed in `timeZone` (an IANA zone, e.g. `America/New_York`); omit it to use the host's
 * resolved zone — the production default, matching SQLite `date(at, 'localtime')` for the operator's
 * console (issue #361). Only `outcome === "merged"` rows count; `queued`/`blocked` attempts are
 * ignored. Within a day a `pr_key` is counted once (`COUNT(DISTINCT pr_key)`), so duplicate `merged`
 * audit rows — an `already-merged` short-circuit or a retry — do not double-count. `cumulative` is
 * the running total across days (burn-up); `bar` is scaled against the busiest day so the chart is
 * comparable. */
export function deriveMergesPerDay(rows: readonly MergeAuditRow[], timeZone?: string): MergeDay[] {
  // day -> set of distinct merged pr_keys that day.
  const prKeysByDay = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.outcome !== "merged") continue;
    if (r.pr_key == null || r.at == null) continue;
    const day = dayOf(r.at, timeZone);
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
 * practice, but a purge/rewrite of the audit must not leave a phantom). Buckets in `timeZone` (an
 * IANA zone) when given; the production caller omits it to use the host's resolved zone. */
export async function pollMergesPerDay(data: DataLayer, timeZone?: string): Promise<void> {
  try {
    // Only `outcome === "merged"` rows contribute to the aggregate, so filter at the read rather than
    // scanning queued/blocked rows as the audit grows (deriveMergesPerDay ignores non-merged rows too).
    const audit = await mergesAudit(data).find({ outcome: "merged" });
    const want = deriveMergesPerDay(audit, timeZone);
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
