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
// The `deriveMergesPerDay` PURE function (issue #344), formerly the derive-half of the
// `deriveMergesPerDay`/`pollMergesPerDay` split. The merges-per-day read model is now a DERIVED SQL
// VIEW (`merges_per_day_view`, 062) — the worker-maintained `merges_per_day` table and its
// `pollMergesPerDay` write-path were RETIRED (epic #412). This pure derivation stays: it is the
// single source of truth the view's SQL mirrors, and is still exercised by its unit tests +
// the view's read-model guard.
//   • `deriveMergesPerDay` — a PURE function: merge audit rows → one ordered `MergeDay` per calendar
//     day (merged count, burn-up cumulative, a proportional bar string). No I/O, fully tested. Counts
//     `COUNT(DISTINCT pr_key)` — a PR with several `merged` rows on one day (an `already-merged`
//     short-circuit or retry) counts once — and ignores `queued`/`blocked` rows entirely.

/** The subset of a `merges` audit row (004_merge.sql) the derivation reads. */
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
 *  deterministic. Any value that is not an UNAMBIGUOUS ISO instant — one carrying an explicit
 *  timezone designator (`Z` or a `±HH:MM`/`±HHMM` offset) — falls back to the whole trimmed string so
 *  it still groups deterministically. This deliberately excludes partially-formed values a bare
 *  `new Date(s)` would still parse but *ambiguously*: a date-only `"2026-01-01"` is read as UTC
 *  midnight while an offset-less `"2026-01-01T12:00:00"` is read in the host's local zone — so
 *  bucketing them would be runtime/timezone-dependent, the very drift this read model exists to avoid.
 *  Production `merges.at` values are always `new Date().toISOString()` (UTC, `Z`-suffixed), so only a
 *  malformed audit row ever takes the fallback. */
const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** An unambiguous ISO-8601 instant: a full `YYYY-MM-DDTHH:MM[:SS[.sss]]` carrying an explicit zone
 *  designator (`Z`, or a `±HH:MM`/`±HHMM` offset). Only these parse to a timezone-independent instant;
 *  anything else (date-only, offset-less datetime, free text) buckets ambiguously, so `dayOf` treats
 *  it as a non-instant and groups on the trimmed string instead. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

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
  // Only bucket unambiguous ISO instants (explicit `Z`/offset). A partially-formed value a bare
  // `new Date(s)` would still parse — a date-only or offset-less datetime — buckets differently per
  // runtime/timezone, so group it deterministically on the trimmed string instead.
  if (!ISO_INSTANT.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const parts = dayFormatter(timeZone).formatToParts(d);
  const field = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const year = field("year");
  const month = field("month");
  const day = field("day");
  // Guard against a formatter that somehow omits a field — never emit a `"--"`-shaped key; fall back
  // to the trimmed string so the row still groups deterministically.
  if (!year || !month || !day) return s;
  return `${year}-${month}-${day}`;
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
