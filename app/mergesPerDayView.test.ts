// Coverage for the merged-per-day VIEW that retires the denormalised `merges_per_day` table
// (epic #412; the read model originally shipped in issue #344 / 051_merges_per_day.sql).
//
// The whole point of #412 is that this aggregate — merged-per-day throughput + burn-up + a
// pre-formatted proportional bar — is now a derived SQL VIEW (enabled by nano-ide#424) instead of a
// worker-written flat table, so it is a single source of truth with no drift. This test therefore
// exercises the REAL SQLite view (062_merges_per_day_view.sql applied to an in-memory DB, mirroring
// migration053.test.ts / planWaveSummary.test.ts) and pins that it reproduces the previous
// projection's EXACT values: the DISTINCT-per-day count, the ascending burn-up `cumulative`, and the
// byte-for-byte pre-formatted `bar` string the Velocity `prose` renderer draws.
//
// `deriveMergesPerDay` (app/mergesPerDay.ts) is the pure function the retired `pollMergesPerDay`
// write-path used, so it is the authoritative oracle for "what the table held". We assert the view
// equals it over sample `merges` rows. Bucketing is local-calendar-day (issue #361 — the view uses
// `date(at, 'localtime')`); to keep the SQLite `localtime` bucketing and the JS oracle in lockstep
// deterministically, this file pins the process zone to UTC (node's test runner isolates each test
// FILE in its own process, so this cannot leak into the timezone-specific assertions in
// app/mergesPerDay.test.ts) and drives the oracle with the matching `"UTC"` zone.
process.env.TZ = "UTC";

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "#test-assert";
import { deriveMergesPerDay, type MergeAuditRow } from "./mergesPerDay.ts";

const MIGRATION = fileURLToPath(new URL("../db/migrations/062_merges_per_day_view.sql", import.meta.url));

/** A DB with the `merges` audit shape (004_merge.sql, FK-free like migration053.test.ts) + the view. */
function viewDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE merges (
       id INTEGER PRIMARY KEY AUTOINCREMENT, pr_key TEXT NOT NULL, outcome TEXT NOT NULL,
       method TEXT, detail TEXT, at TEXT NOT NULL);`,
  );
  db.exec(readFileSync(MIGRATION, "utf8"));
  return db;
}

function seed(db: DatabaseSync, rows: readonly MergeAuditRow[]): void {
  const ins = db.prepare("INSERT INTO merges (pr_key, outcome, at) VALUES (?, ?, ?)");
  for (const r of rows) ins.run(r.pr_key, r.outcome, r.at);
}

/** The view's rows as `[day, merged, cumulative, bar]`, ordered like the Velocity page (day asc). */
function view(db: DatabaseSync): Array<[string, number, number, string]> {
  return (
    db.prepare("SELECT day, merged, cumulative, bar FROM merges_per_day_view ORDER BY day").all() as Array<
      Record<string, unknown>
    >
  ).map((r) => [r.day as string, Number(r.merged), Number(r.cumulative), r.bar as string]);
}

const merged = (pr_key: string, at: string): MergeAuditRow => ({ pr_key, outcome: "merged", at });

test("merges_per_day_view reproduces the retired projection exactly (count, burn-up, bar)", () => {
  const db = viewDb();
  const rows: MergeAuditRow[] = [
    // day A: 4 distinct PRs (the busiest day → widest bar), including a duplicate merged row.
    merged("o/r#1", "2026-01-01T01:00:00Z"),
    merged("o/r#2", "2026-01-01T02:00:00Z"),
    merged("o/r#3", "2026-01-01T03:00:00Z"),
    merged("o/r#4", "2026-01-01T04:00:00Z"),
    merged("o/r#4", "2026-01-01T05:00:00Z"), // retry / already-merged short-circuit → counts once
    // day B: 1 PR → short but visible bar.
    merged("o/r#5", "2026-01-02T10:00:00Z"),
    // day C: 2 PRs.
    merged("o/r#6", "2026-01-03T10:00:00Z"),
    merged("o/r#7", "2026-01-03T11:00:00Z"),
    // non-merged attempts must be ignored entirely.
    { pr_key: "o/r#8", outcome: "queued", at: "2026-01-02T12:00:00Z" },
    { pr_key: "o/r#9", outcome: "blocked", at: "2026-01-03T12:00:00Z" },
  ];
  seed(db, rows);

  const expected = deriveMergesPerDay(rows, "UTC").map(
    (d) => [d.day, d.merged, d.cumulative, d.bar] as [string, number, number, string],
  );
  // Sanity: the oracle itself is the previous behaviour (distinct count, burn-up, scaled bar).
  assertEquals(
    expected.map((e) => [e[0], e[1], e[2]]),
    [
      ["2026-01-01", 4, 4],
      ["2026-01-02", 1, 5],
      ["2026-01-03", 2, 7],
    ],
  );
  assertEquals(view(db), expected);
});

test("merges_per_day_view bar: full glyph run for the busiest day, min one glyph for a lone merge", () => {
  const db = viewDb();
  seed(db, [
    merged("o/r#1", "2026-01-01T01:00:00Z"),
    merged("o/r#2", "2026-01-01T02:00:00Z"),
    merged("o/r#3", "2026-01-01T03:00:00Z"),
    merged("o/r#4", "2026-01-01T04:00:00Z"),
    merged("o/r#5", "2026-01-02T01:00:00Z"),
  ]);
  const rows = view(db);
  const [a, b] = rows;
  assertEquals(a[3], "█".repeat(30), "the busiest day fills the configured bar width (30)");
  assert(a[3].length > b[3].length, "the busier day draws a longer bar");
  assert([...b[3]].length >= 1, "a day with any merge draws at least one glyph");
  assertEquals(view(db), deriveMergesPerDay([
    merged("o/r#1", "2026-01-01T01:00:00Z"),
    merged("o/r#2", "2026-01-01T02:00:00Z"),
    merged("o/r#3", "2026-01-01T03:00:00Z"),
    merged("o/r#4", "2026-01-01T04:00:00Z"),
    merged("o/r#5", "2026-01-02T01:00:00Z"),
  ], "UTC").map((d) => [d.day, d.merged, d.cumulative, d.bar]));
});

test("merges_per_day_view is empty when no merges are recorded", () => {
  const db = viewDb();
  seed(db, [{ pr_key: "o/r#1", outcome: "queued", at: "2026-01-01T01:00:00Z" }]);
  assertEquals(view(db), []);
});

test("merges_per_day_view buckets on the LOCAL calendar day, matching deriveMergesPerDay (issue #361)", () => {
  // Under the pinned UTC process zone, `date(at, 'localtime')` == the UTC date, so two merges either
  // side of UTC midnight are two days — exactly what the JS oracle produces for "UTC".
  const db = viewDb();
  const rows: MergeAuditRow[] = [
    merged("o/r#1", "2026-01-01T23:30:00Z"),
    merged("o/r#2", "2026-01-02T00:30:00Z"),
  ];
  seed(db, rows);
  assertEquals(view(db), deriveMergesPerDay(rows, "UTC").map((d) => [d.day, d.merged, d.cumulative, d.bar]));
});

test("merges_per_day_view reproduces the projection across many random audits (property check)", () => {
  const db = viewDb();
  const outcomes = ["merged", "merged", "merged", "queued", "blocked"];
  for (let trial = 0; trial < 200; trial++) {
    db.exec("DELETE FROM merges");
    const rows: MergeAuditRow[] = [];
    const n = 1 + Math.floor(Math.random() * 40);
    for (let i = 0; i < n; i++) {
      const day = 1 + Math.floor(Math.random() * 9);
      const hh = String(Math.floor(Math.random() * 24)).padStart(2, "0");
      rows.push({
        pr_key: `o/r#${1 + Math.floor(Math.random() * 12)}`,
        outcome: outcomes[Math.floor(Math.random() * outcomes.length)],
        at: `2026-01-0${day}T${hh}:00:00Z`,
      });
    }
    seed(db, rows);
    assertEquals(
      view(db),
      deriveMergesPerDay(rows, "UTC").map((d) => [d.day, d.merged, d.cumulative, d.bar]),
      `random trial ${trial} diverged from the projection`,
    );
  }
});
