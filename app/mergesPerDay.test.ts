// Read-model derivation test for the merged-per-day throughput chart (issue #344).
//
// `deriveMergesPerDay` is the pure aggregate that specifies the derived `merges_per_day` VIEW
// (db/migrations/059_merges_per_day_view.sql) the Velocity page reads. It must: count DISTINCT PRs
// per calendar day (a PR with several `merged` audit rows on one day — an `already-merged`
// short-circuit or a retry — counts once); ignore `queued`/`blocked` attempts entirely; order days
// ascending; carry a running burn-up `cumulative`; and scale each day's `bar` against the busiest
// day. The VIEW's parity with this pure fn is asserted in app/mergesPerDayView.test.ts.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { deriveMergesPerDay, type MergeAuditRow } from "./mergesPerDay.ts";

// The bucketing is now LOCAL-calendar-day (issue #361: use the viewer's timezone, not UTC). The
// derivation buckets in an explicit IANA `timeZone` argument (via `Intl.DateTimeFormat`), so these
// tests pass the zone directly rather than mutating the process-global `process.env.TZ` — which
// `node --test` runs concurrently across files, so an in-process `TZ` flip could leak into and
// reorder unrelated date-handling tests. The UTC-based assertions pass `"UTC"`; the
// timezone-specific ones pass the zone they exercise.

const merged = (pr_key: string, at: string): MergeAuditRow => ({ pr_key, outcome: "merged", at });

test("counts DISTINCT merged PRs per calendar day", () => {
  const days = deriveMergesPerDay([
    merged("o/r#1", "2026-01-01T09:00:00Z"),
    merged("o/r#2", "2026-01-01T18:30:00Z"),
    merged("o/r#3", "2026-01-02T10:00:00Z"),
  ], "UTC");
  assertEquals(days.map((d) => [d.day, d.merged]), [
    ["2026-01-01", 2],
    ["2026-01-02", 1],
  ]);
});

test("dedupes duplicate merged rows for the same PR on the same day (COUNT DISTINCT pr_key)", () => {
  const days = deriveMergesPerDay([
    merged("o/r#1", "2026-01-01T09:00:00Z"),
    merged("o/r#1", "2026-01-01T09:00:05Z"), // retry / already-merged short-circuit
    merged("o/r#1", "2026-01-01T23:59:00Z"),
  ], "UTC");
  assertEquals(days.length, 1);
  assertEquals(days[0].merged, 1);
});

test("the same PR merged on two different days counts once per day", () => {
  // A defensive case: distinctness is per-day, not global.
  const days = deriveMergesPerDay([
    merged("o/r#1", "2026-01-01T09:00:00Z"),
    merged("o/r#1", "2026-01-02T09:00:00Z"),
  ], "UTC");
  assertEquals(days.map((d) => [d.day, d.merged]), [
    ["2026-01-01", 1],
    ["2026-01-02", 1],
  ]);
});

test("ignores queued and blocked attempts", () => {
  const days = deriveMergesPerDay([
    merged("o/r#1", "2026-01-01T09:00:00Z"),
    { pr_key: "o/r#2", outcome: "queued", at: "2026-01-01T09:10:00Z" },
    { pr_key: "o/r#3", outcome: "blocked", at: "2026-01-01T09:20:00Z" },
  ], "UTC");
  assertEquals(days.length, 1);
  assertEquals(days[0].merged, 1);
});

test("orders days ascending and carries a running burn-up cumulative", () => {
  const days = deriveMergesPerDay([
    merged("o/r#5", "2026-01-03T10:00:00Z"),
    merged("o/r#1", "2026-01-01T10:00:00Z"),
    merged("o/r#2", "2026-01-01T11:00:00Z"),
    merged("o/r#4", "2026-01-02T10:00:00Z"),
  ], "UTC");
  assertEquals(days.map((d) => d.day), ["2026-01-01", "2026-01-02", "2026-01-03"]);
  assertEquals(days.map((d) => d.merged), [2, 1, 1]);
  assertEquals(days.map((d) => d.cumulative), [2, 3, 4]);
});

test("bar scales against the busiest day: full for the max, non-empty for a lone merge, empty for zero", () => {
  const days = deriveMergesPerDay([
    // day A: 4 merges (the max) → widest bar
    merged("o/r#1", "2026-01-01T01:00:00Z"),
    merged("o/r#2", "2026-01-01T02:00:00Z"),
    merged("o/r#3", "2026-01-01T03:00:00Z"),
    merged("o/r#4", "2026-01-01T04:00:00Z"),
    // day B: 1 merge → short but visible bar
    merged("o/r#5", "2026-01-02T01:00:00Z"),
  ], "UTC");
  const [a, b] = days;
  assert(a.bar.length > b.bar.length, "the busier day must draw a longer bar");
  assert(b.bar.length >= 1, "a day with any merge must draw at least one glyph");
  assert(a.bar.length <= 30, "the busiest bar must not exceed the configured width");
});

test("empty audit yields no days", () => {
  assertEquals(deriveMergesPerDay([]), []);
});

test("buckets by the viewer's LOCAL calendar day, not UTC (issue #361)", () => {
  // 02:00Z on Jan 1 is still Dec 31 in a west-of-UTC zone (America/New_York, UTC-5).
  {
    const days = deriveMergesPerDay([merged("o/r#1", "2026-01-01T02:00:00Z")], "America/New_York");
    assertEquals(
      days.map((d) => d.day),
      ["2025-12-31"],
    );
  }
  // 23:00Z on Jan 1 is already Jan 2 in an east-of-UTC zone (Pacific/Kiritimati, UTC+14).
  {
    const days = deriveMergesPerDay([merged("o/r#1", "2026-01-01T23:00:00Z")], "Pacific/Kiritimati");
    assertEquals(
      days.map((d) => d.day),
      ["2026-01-02"],
    );
  }
});

test("two merges either side of local midnight land on the same local day (issue #361)", () => {
  // In UTC these are two different UTC days; in America/New_York (UTC-5) both are Jan 1 evening,
  // so a local-time bucketing counts them together on 2026-01-01.
  {
    const days = deriveMergesPerDay(
      [
        merged("o/r#1", "2026-01-01T18:00:00Z"), // 13:00 local, Jan 1
        merged("o/r#2", "2026-01-02T04:00:00Z"), // 23:00 local, Jan 1
      ],
      "America/New_York",
    );
    assertEquals(
      days.map((d) => [d.day, d.merged]),
      [["2026-01-01", 2]],
    );
  }
});

test("non-ISO / malformed `at` still groups deterministically without throwing", () => {
  const days = deriveMergesPerDay([
    { pr_key: "o/r#1", outcome: "merged", at: "not-a-timestamp" },
    { pr_key: "o/r#2", outcome: "merged", at: "not-a-timestamp" },
  ], "UTC");
  assertEquals(days.length, 1);
  assertEquals(days[0].day, "not-a-timestamp");
  assertEquals(days[0].merged, 2);
});

test("ambiguous partially-formed `at` (date-only / offset-less) buckets on the trimmed string, not a runtime-dependent day", () => {
  // `new Date("2026-01-01")` parses as UTC midnight while `new Date("2026-01-01T12:00:00")` parses in
  // the host's local zone — bucketing either would be runtime/timezone-dependent, the exact drift this
  // read model exists to avoid. Neither carries an explicit `Z`/offset, so both must fall back to the
  // trimmed string and group deterministically regardless of the viewer's `timeZone`.
  const rows: MergeAuditRow[] = [
    { pr_key: "o/r#1", outcome: "merged", at: "2026-01-01" },
    { pr_key: "o/r#2", outcome: "merged", at: "2026-01-01T12:00:00" },
  ];
  for (const zone of ["UTC", "America/New_York", "Pacific/Kiritimati"]) {
    const days = deriveMergesPerDay(rows, zone);
    assertEquals(days.map((d) => [d.day, d.merged]), [
      ["2026-01-01", 1],
      ["2026-01-01T12:00:00", 1],
    ]);
  }
});

test("an invalid IANA timeZone falls back to the host zone instead of throwing (issue #361)", () => {
  // A bogus zone would make `Intl.DateTimeFormat` throw a `RangeError`; bucketing must stay
  // deterministic and not wedge `deriveMergesPerDay`/`pollMergesPerDay`.
  const days = deriveMergesPerDay(
    [merged("o/r#1", "2026-01-01T12:00:00Z")],
    "Not/AZone",
  );
  assertEquals(days.length, 1);
  assertEquals(days[0].merged, 1);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(days[0].day));
});
