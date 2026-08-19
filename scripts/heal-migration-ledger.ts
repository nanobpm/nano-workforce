// heal-migration-ledger — one-shot recovery for an install wedged by issue #357 (a migration that
// was renamed after it merged, so the runtime re-runs it and boot aborts on "duplicate column").
//
// Usage:
//   node --experimental-strip-types scripts/heal-migration-ledger.ts <path-to-sqlite.db>
//
// It reconciles the `_urban_migrations` ledger for every known historical rename
// (`RENAMED_MIGRATIONS`): where the OLD filename is recorded as applied but the NEW one is not, it
// records the new filename as applied. This is a pure ledger-alias — it makes NO schema change — and
// is safe to run repeatedly and on a healthy DB (it only acts on the broken state). After running it,
// restart the node; the renamed migration is skipped and boot completes.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { healMigrationLedger } from "../app/migrationHeal.ts";

function main(): void {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error(
      "usage: node --experimental-strip-types scripts/heal-migration-ledger.ts <path-to-sqlite.db>",
    );
    process.exit(2);
  }

  // `DatabaseSync` silently CREATES an empty DB when the path doesn't exist, so a typo'd path would
  // "heal" a brand-new empty file and misleadingly report "nothing to heal". Fail loudly instead.
  if (!existsSync(dbPath)) {
    console.error(
      `heal-migration-ledger: ${dbPath} — no such file. Pass the path to the existing install's SQLite DB.`,
    );
    process.exit(2);
  }

  const db = new DatabaseSync(dbPath);
  try {
    const healed = healMigrationLedger(db);
    if (healed.length === 0) {
      console.log(`heal-migration-ledger: ${dbPath} — nothing to heal (ledger already consistent).`);
    } else {
      console.log(
        `heal-migration-ledger: ${dbPath} — aliased ${healed.length} migration(s) as applied: ${healed.join(", ")}. Restart the node to complete boot.`,
      );
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) main();
