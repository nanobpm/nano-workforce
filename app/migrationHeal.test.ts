// Regression guard for issue #357 — a migration renamed after it merged (`043_user_tasks_subject_
// title.sql` -> `046_…` in #316) re-runs against an already-migrated DB and aborts boot with
// "duplicate column name: subject_title", because the ledger is keyed by filename.
//
// This reproduces that exact break on the CURRENT migration set (RED), then proves
// `healMigrationLedger` reconciles the ledger so the upgrade completes cleanly (GREEN) — the recovery
// path for installs that migrated under the old name before the rename landed.
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { healMigrationLedger, RENAMED_MIGRATIONS } from "../app/migrationHeal.ts";
import { assert, assertEquals, assertThrows } from "#test-assert";
import { applyMigrationSet, readMigrationSetFromDisk } from "#test-migrations";

const NEW_NAME = "046_user_tasks_subject_title.sql";
const OLD_NAME = "043_user_tasks_subject_title.sql";

// A DB migrated fully with the CURRENT set, then rewound to model an install that applied the
// renamed migration under its OLD filename: the schema change is present, but the ledger records the
// old name — exactly the state a boot between #311 and #316 left behind.
function dbAppliedUnderOldName(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  applyMigrationSet(db, readMigrationSetFromDisk());
  db.prepare("UPDATE _urban_migrations SET name=? WHERE name=?").run(OLD_NAME, NEW_NAME);
  return db;
}

const applied = (db: DatabaseSync, name: string): boolean =>
  (db.prepare("SELECT 1 AS one FROM _urban_migrations WHERE name=?").get(name) as
    | { one: number }
    | undefined) !== undefined;

test("RENAMED_MIGRATIONS pins the 043->046 user_tasks_subject_title rename", () => {
  assertEquals(RENAMED_MIGRATIONS.get(NEW_NAME), OLD_NAME);
});

test("#357 repro: re-applying the current set to a DB migrated under the old name aborts on duplicate column", () => {
  const db = dbAppliedUnderOldName();
  // The renamed migration is unapplied under its NEW name, so the runtime re-runs its
  // `ALTER TABLE user_tasks ADD COLUMN subject_title` against a table that already has the column.
  const err = assertThrows(() => applyMigrationSet(db, readMigrationSetFromDisk()));
  assert(
    /duplicate column name: subject_title/.test(err.message),
    `expected a duplicate-column abort, got: ${err.message}`,
  );
});

test("heal reconciles the ledger so the upgrade completes cleanly", () => {
  const db = dbAppliedUnderOldName();

  const healed = healMigrationLedger(db);
  assertEquals(healed, [NEW_NAME], "the new filename was aliased into the ledger");
  assert(applied(db, NEW_NAME), "046 is now recorded as applied");
  assert(applied(db, OLD_NAME), "the historical 043 ledger row is left intact");

  // With the ledger reconciled, the renamed migration is skipped and the boot-time upgrade is clean.
  const newly = applyMigrationSet(db, readMigrationSetFromDisk());
  assertEquals(newly, [], "no migration re-runs after the heal");
});

test("heal is idempotent and a no-op on a healthy DB", () => {
  // A DB that applied the migration under its CURRENT name needs no healing.
  const clean = new DatabaseSync(":memory:");
  applyMigrationSet(clean, readMigrationSetFromDisk());
  assertEquals(healMigrationLedger(clean), [], "clean install: nothing to heal");

  // Healing twice changes nothing the second time.
  const broken = dbAppliedUnderOldName();
  assertEquals(healMigrationLedger(broken), [NEW_NAME]);
  assertEquals(healMigrationLedger(broken), [], "second heal is a no-op");
});

test("heal is a no-op on a fresh DB with no migration ledger", () => {
  const fresh = new DatabaseSync(":memory:");
  assertEquals(healMigrationLedger(fresh), [], "no ledger table => nothing to heal");
});
