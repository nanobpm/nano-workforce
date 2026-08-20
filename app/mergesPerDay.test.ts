// Read-model derivation + projection test for the merged-per-day throughput chart (issue #344).
//
// `deriveMergesPerDay` is the single source of truth behind the denormalised `merges_per_day` table
// the Velocity page reads. It must: count DISTINCT PRs per calendar day (a PR with several `merged`
// audit rows on one day — an `already-merged` short-circuit or a retry — counts once); ignore
// `queued`/`blocked` attempts entirely; order days ascending; carry a running burn-up `cumulative`;
// and scale each day's `bar` against the busiest day. `pollMergesPerDay` must project that onto the
// read table idempotently — a steady-state re-run writes nothing, and a day dropped from the audit is
// pruned.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import { deriveMergesPerDay, type MergeAuditRow, pollMergesPerDay } from "./mergesPerDay.ts";

// The bucketing is now LOCAL-calendar-day (issue #361: use the viewer's timezone, not UTC). The
// derivation buckets in an explicit IANA `timeZone` argument (via `Intl.DateTimeFormat`), so these
// tests pass the zone directly rather than mutating the process-global `process.env.TZ` — which
// `node --test` runs concurrently across files, so an in-process `TZ` flip could leak into and
// reorder unrelated date-handling tests. The UTC-based assertions pass `"UTC"`; the
// timezone-specific ones pass the zone they exercise.

// A tiny in-memory record gateway (all/find/insert/update/delete), mirroring the fake-app style used
// across the app tests (see app/delivery.test.ts), enough to exercise the `pollMergesPerDay`
// projection.
function memData(): { data: DataLayer; stores: Record<string, any[]>; writes: () => number } {
  const stores: Record<string, any[]> = {};
  let writes = 0;
  function tbl(name: string, pk = "id") {
    const rows = (stores[name] ??= [] as any[]);
    return {
      async all() {
        return rows.slice();
      },
      async get(id: any) {
        return rows.find((r) => r[pk] === id);
      },
      async find(where: any = {}) {
        return rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
      },
      async insert(row: any) {
        writes++;
        rows.push({ ...row });
        return row[pk];
      },
      async update(id: any, patch: any) {
        writes++;
        const r = rows.find((row) => row[pk] === id);
        if (r) Object.assign(r, patch);
        return 1;
      },
      async delete(id: any) {
        const i = rows.findIndex((row) => row[pk] === id);
        if (i >= 0) {
          writes++;
          rows.splice(i, 1);
        }
        return 1;
      },
    };
  }
  const data = { table: (n: string, pk?: string) => tbl(n, pk) } as any as DataLayer;
  return { data, stores, writes: () => writes };
}

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

test("pollMergesPerDay projects the aggregate onto merges_per_day", async () => {
  const { data, stores } = memData();
  stores.merges = [
    { id: 1, pr_key: "o/r#1", outcome: "merged", at: "2026-01-01T09:00:00Z" },
    { id: 2, pr_key: "o/r#1", outcome: "merged", at: "2026-01-01T09:05:00Z" }, // dup same day
    { id: 3, pr_key: "o/r#2", outcome: "merged", at: "2026-01-02T09:00:00Z" },
    { id: 4, pr_key: "o/r#3", outcome: "queued", at: "2026-01-02T09:10:00Z" }, // ignored
  ];
  await pollMergesPerDay(data, "UTC");
  const rows = (stores.merges_per_day ?? []).slice().sort((x, y) => x.day.localeCompare(y.day));
  assertEquals(rows.map((r) => [r.day, r.merged, r.cumulative]), [
    ["2026-01-01", 1, 1],
    ["2026-01-02", 1, 2],
  ]);
  for (const r of rows) assert(typeof r.updated_at === "string" && r.updated_at.length > 0);
});

test("pollMergesPerDay is idempotent — a steady-state re-run writes nothing", async () => {
  const { data, stores, writes } = memData();
  stores.merges = [{ id: 1, pr_key: "o/r#1", outcome: "merged", at: "2026-01-01T09:00:00Z" }];
  await pollMergesPerDay(data, "UTC");
  const afterFirst = writes();
  assert(afterFirst > 0, "the first pass must project at least one row");
  await pollMergesPerDay(data, "UTC");
  assertEquals(writes(), afterFirst, "a steady-state re-run must not write");
});

test("pollMergesPerDay prunes a day that no longer derives from the audit", async () => {
  const { data, stores } = memData();
  stores.merges_per_day = [
    { day: "2025-12-31", merged: 3, cumulative: 3, bar: "███", updated_at: "old" },
  ];
  stores.merges = [{ id: 1, pr_key: "o/r#1", outcome: "merged", at: "2026-01-01T09:00:00Z" }];
  await pollMergesPerDay(data, "UTC");
  const days = (stores.merges_per_day ?? []).map((r: any) => r.day);
  assert(!days.includes("2025-12-31"), "a stale day must be pruned");
  assert(days.includes("2026-01-01"), "the derived day must be present");
});
