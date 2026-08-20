// migrationHeal — recover installs broken by a migration that was RENAMED after it had already
// merged and applied (issue #357).
//
// The runtime (`@nanobpm/urban` applyMigrations) keys the `_urban_migrations` ledger by FILENAME, so
// a renamed migration is a *different* migration to the runner: it re-runs its DDL against a schema
// that already has the change, and a bare `ALTER TABLE ... ADD COLUMN` then aborts boot with
// "duplicate column". The direct hazard is now blocked forward by the immutability gate
// (`scripts/check-migrations.ts`), but installs that migrated under the OLD name *before* the rename
// landed are already stuck and need their ledger reconciled.
//
// The fix is a ledger-alias, NOT a schema change and NOT an edit to the renamed migration (editing a
// merged migration is itself forbidden by the immutability gate, and would silently no-op on every
// already-migrated DB anyway): if the old filename is recorded as applied, the new filename names the
// exact same forward-only change, so it is safe — and correct — to record the new filename as applied
// too. `healMigrationLedger` does that, guarded so it only ever fires on the broken state.
//
// `RENAMED_MIGRATIONS` is the single source of truth for known historical renames. It exists ONLY to
// heal the pre-gate past — the immutability gate prevents any new entry from ever being needed.
import type { DatabaseSync } from "node:sqlite";

const MIGRATIONS_TABLE = "_urban_migrations";

// new filename -> old filename, for merged migrations that were renamed before the immutability gate
// existed. Each entry names the SAME forward-only change under two prefixes, so aliasing the ledger
// from the old name to the new is lossless.
//
// - `046_user_tasks_subject_title.sql` was merged as `043_user_tasks_subject_title.sql` (#311) and
//   renumbered to 046 (#316) to break a prefix collision with `043_pr_epic_phase.sql`. Any DB that
//   booted between those two PRs applied it as 043 and now re-runs it as 046 → "duplicate column
//   name: subject_title" (issue #357).
export const RENAMED_MIGRATIONS: ReadonlyMap<string, string> = new Map([
  ["046_user_tasks_subject_title.sql", "043_user_tasks_subject_title.sql"],
]);

/** Does the `_urban_migrations` ledger table exist? A fresh/never-migrated DB has nothing to heal. */
function ledgerExists(db: DatabaseSync): boolean {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(MIGRATIONS_TABLE) !== undefined
  );
}

function isApplied(db: DatabaseSync, name: string): boolean {
  return db.prepare(`SELECT 1 AS one FROM ${MIGRATIONS_TABLE} WHERE name=?`).get(name) !== undefined;
}

/**
 * Reconcile the migration ledger for known historical renames, in place. For every rename where the
 * OLD filename is recorded as applied but the NEW one is not, record the new filename as applied
 * (aliasing the ledger) so the runtime stops re-running the renamed migration.
 *
 * Idempotent and safe on every state:
 *  - old applied, new missing  -> alias inserted (the broken install; the only case that acts)
 *  - both applied              -> no-op (overlay-drift install carrying both files)
 *  - only new applied          -> no-op (clean install that never saw the old name)
 *  - neither applied / no ledger-> no-op (fresh DB)
 *
 * @returns the new filenames that were aliased in (empty when nothing needed healing).
 */
export function healMigrationLedger(db: DatabaseSync, now: () => Date = () => new Date()): string[] {
  if (!ledgerExists(db)) return [];
  const healed: string[] = [];
  for (const [newName, oldName] of RENAMED_MIGRATIONS) {
    if (isApplied(db, oldName) && !isApplied(db, newName)) {
      db.prepare(`INSERT OR IGNORE INTO ${MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`).run(
        newName,
        now().toISOString(),
      );
      healed.push(newName);
    }
  }
  return healed;
}
