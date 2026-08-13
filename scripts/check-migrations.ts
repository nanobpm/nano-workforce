// check-migrations — merge-safety gate for the forward-only SQLite migrations under db/migrations/.
//
// Migrations are numbered by a leading 3-digit prefix and applied in prefix order (nano.app.json
// data.sources.app.migrations). AGENTS.md tells every author to "number a new migration after the
// current highest prefix" — but that number is computed independently in each worktree. When an
// epic fans a fleet out across parallel branches, two siblings both take "the next" free prefix
// and emit e.g. 023_agentic_presence.sql and 023_agentic_transcript.sql. Those filenames don't
// textually conflict, so git merges both cleanly and the collision is SILENT: two migrations now
// share an apply-order slot. This exact failure mode already scarred the repo (the historical
// 004/005/006/007 duplicate pairs) and recurred on epic #142 despite the doc note added by the
// #160 retro (PR #178) — so we escalate the lesson from a doc line to a mechanical gate.
//
// The rule: no two migration files may share a numeric prefix. The pre-existing historical
// duplicates are forward-only and already applied, so they cannot be renamed — they are
// grandfathered in GRANDFATHERED_DUPES. Any NEW duplicate prefix fails the build.
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

// Historical collisions that predate this gate. Forward-only + already applied ⇒ cannot be
// renumbered. New duplicates are NOT allowed here — fix them before merge.
const GRANDFATHERED_DUPES: ReadonlySet<string> = new Set(["004", "005", "006", "007"]);

const PREFIX = /^(\d{3})_[^/]*\.sql$/;

function main(): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const errors: string[] = [];
  const byPrefix = new Map<string, string[]>();

  for (const file of files) {
    const m = PREFIX.exec(file);
    if (!m) {
      errors.push(
        `  ${file}: does not match the required NNN_name.sql shape (3-digit prefix, underscore, name).`,
      );
      continue;
    }
    const prefix = m[1];
    const group = byPrefix.get(prefix) ?? [];
    group.push(file);
    byPrefix.set(prefix, group);
  }

  for (const [prefix, group] of byPrefix) {
    if (group.length > 1 && !GRANDFATHERED_DUPES.has(prefix)) {
      errors.push(
        `  prefix ${prefix} is used by ${group.length} files: ${group.join(", ")} — ` +
          `two migrations cannot share an apply-order slot. Renumber the newer one to the next ` +
          `free prefix (check origin/main, not your branch point).`,
      );
    }
  }

  if (errors.length > 0) {
    console.error(`check-migrations: db/migrations has colliding prefixes:\n${errors.join("\n")}`);
    process.exit(1);
  }

  console.log(`check-migrations: OK (${files.length} migrations, no colliding prefixes).`);
}

main();
