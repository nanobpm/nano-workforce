// Derivation-parity guard for the `merges_per_day` VIEW (issue #412).
//
// Issue #412 retires the worker-maintained `merges_per_day` flat table + its `pollMergesPerDay`
// projection in favour of the derived VIEW (db/migrations/059_merges_per_day_view.sql), now that
// urban can read a SQL VIEW (nanobpm/nano-ide#424). The acceptance criteria require "a test per VIEW
// asserting it reproduces the previous projection's values over sample rows" — this is that test.
//
// It applies the migration against a REAL `node:sqlite` database (the same engine that runs in
// production, so window functions and `date(at,'localtime')` are exercised for real, not mocked),
// inserts sample `merges` audit rows, and asserts the VIEW's rows are IDENTICAL — day / merged /
// cumulative / bar, in order — to `deriveMergesPerDay` (app/mergesPerDay.ts), the pure aggregate that
// WAS the projection's source of truth. If the two ever drift, this fails.
//
// Timezone determinism: the VIEW buckets with `date(at,'localtime')` (the host's zone — the SQL twin
// of the poller's host-zone bucketing, issue #361) while `deriveMergesPerDay` buckets in the host's
// resolved zone when no explicit IANA zone is passed. Pinning `process.env.TZ = "UTC"` before opening
// the database makes both resolve to UTC calendar days, so the parity assertion is stable on any CI
// host. All sample `at` values are `Z`-suffixed ISO instants (the production shape — `merges.at` is
// always `new Date().toISOString()`), so bucketing is unambiguous.
process.env.TZ = "UTC";

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "#test-assert";
import { deriveMergesPerDay, type MergeAuditRow } from "./mergesPerDay.ts";

/** A DB with the `merges` audit table (004_merge.sql, minus the `pull_requests` FK parent so the
 *  VIEW is proven in isolation — mirroring migration053.test.ts's host-in-isolation style) and the
 *  059 VIEW applied on top. */
function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE merges (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_key   TEXT NOT NULL,
    outcome  TEXT NOT NULL,
    method   TEXT,
    detail   TEXT,
    at       TEXT NOT NULL
  );`);
  const sql = readFileSync(
    fileURLToPath(new URL("../db/migrations/059_merges_per_day_view.sql", import.meta.url)),
    "utf8",
  );
  db.exec(sql);
  return db;
}

function insert(db: DatabaseSync, rows: readonly Partial<MergeAuditRow>[]): void {
  const stmt = db.prepare("INSERT INTO merges (pr_key, outcome, at) VALUES (?, ?, ?)");
  for (const r of rows) stmt.run(r.pr_key ?? "o/r#0", r.outcome ?? "merged", r.at ?? "t");
}

function viewRows(db: DatabaseSync): { day: string; merged: number; cumulative: number; bar: string }[] {
  const raw = db
    .prepare("SELECT day, merged, cumulative, bar FROM merges_per_day ORDER BY day")
    .all() as { day: string; merged: number; cumulative: number; bar: string }[];
  // node:sqlite returns null-prototype rows; re-wrap as plain objects so deep-equal matches the
  // pure fn's plain-object output (prototype-sensitive `deepStrictEqual`).
  return raw.map((r) => ({ day: r.day, merged: r.merged, cumulative: r.cumulative, bar: r.bar }));
}

const merged = (pr_key: string, at: string): MergeAuditRow => ({ pr_key, outcome: "merged", at });

// The sample audit trail: multiple days, DISTINCT-per-day dedupe (o/r#1 logs twice on Jan 1 and again
// on Jan 3), non-merged outcomes that must be ignored, and a spread of counts so `bar` scales.
const SAMPLE: MergeAuditRow[] = [
  merged("o/r#1", "2026-01-01T09:00:00Z"),
  merged("o/r#1", "2026-01-01T18:30:00Z"), // retry / already-merged — same PR, same day → counts once
  merged("o/r#2", "2026-01-01T20:00:00Z"),
  merged("o/r#3", "2026-01-01T21:00:00Z"),
  { pr_key: "o/r#9", outcome: "queued", at: "2026-01-01T22:00:00Z" }, // ignored
  merged("o/r#4", "2026-01-02T10:00:00Z"),
  { pr_key: "o/r#8", outcome: "blocked", at: "2026-01-02T11:00:00Z" }, // ignored
  merged("o/r#1", "2026-01-03T10:00:00Z"), // same PR again, a later day → counts on Jan 3
  merged("o/r#5", "2026-01-03T11:00:00Z"),
];

test("merges_per_day VIEW reproduces deriveMergesPerDay row-for-row over the sample audit", () => {
  const db = migratedDb();
  insert(db, SAMPLE);
  const want = deriveMergesPerDay(SAMPLE).map((d) => ({
    day: d.day,
    merged: d.merged,
    cumulative: d.cumulative,
    bar: d.bar,
  }));
  assertEquals(viewRows(db), want);
  // Sanity: the sample really did exercise dedupe, a burn-up, and scaled bars.
  assert(want.length === 3, "sample should span three calendar days");
  assertEquals(want.map((d) => d.merged), [3, 1, 2]);
  assertEquals(want.map((d) => d.cumulative), [3, 4, 6]);
  assert(
    want[0].bar.length > want[1].bar.length && want[1].bar.length >= 1,
    "the busiest day draws the longest bar; a lone-merge day still draws one glyph",
  );
});

test("merges_per_day VIEW is empty when no merged rows exist", () => {
  const db = migratedDb();
  insert(db, [{ pr_key: "o/r#1", outcome: "queued", at: "2026-01-01T09:00:00Z" }]);
  assertEquals(viewRows(db), []);
  assertEquals(deriveMergesPerDay([{ pr_key: "o/r#1", outcome: "queued", at: "2026-01-01T09:00:00Z" }]), []);
});

test("merges_per_day VIEW recomputes live — a new merge is reflected with no write-path", () => {
  const db = migratedDb();
  insert(db, [merged("o/r#1", "2026-01-01T09:00:00Z")]);
  assertEquals(viewRows(db).map((r) => [r.day, r.merged, r.cumulative]), [["2026-01-01", 1, 1]]);
  // A VIEW has no poller: the next read simply re-derives, so appending an audit row is reflected
  // immediately — the drift window a hand-maintained projection carried is gone.
  insert(db, [merged("o/r#2", "2026-01-02T09:00:00Z")]);
  assertEquals(viewRows(db).map((r) => [r.day, r.merged, r.cumulative]), [
    ["2026-01-01", 1, 1],
    ["2026-01-02", 1, 2],
  ]);
});

test("merges_per_day VIEW rejects writes — urban treats it read-only (no INSTEAD OF triggers)", () => {
  const db = migratedDb();
  let threw = false;
  try {
    db.exec("INSERT INTO merges_per_day (day, merged, cumulative, bar) VALUES ('2026-01-01', 1, 1, '')");
  } catch {
    threw = true;
  }
  assert(threw, "a plain SQLite view must reject a direct INSERT");
});
