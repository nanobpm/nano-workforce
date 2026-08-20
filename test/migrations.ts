// Test helpers for exercising the forward-only SQLite migration set the way the runtime does.
//
// `applyMigrationSet` mirrors `@nanobpm/urban`'s `applyMigrations` (ledger keyed by FILENAME, each
// migration wrapped in its own transaction, skip-applied / apply-new) against a `node:sqlite`
// `DatabaseSync`, so upgrade tests reproduce the exact boot-time behaviour — including the
// "duplicate column" abort a renamed migration causes — without booting the whole app.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "db", "migrations");
const MIGRATIONS_TABLE = "_urban_migrations";

export interface MigrationFile {
  name: string;
  sql: string;
}

function byName(files: MigrationFile[]): MigrationFile[] {
  // Match the runtime's plain lexical `.sort()` on filename (apply order).
  return [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Apply `files` to `db` exactly as the runtime does: create the ledger, skip any filename already
 * recorded, and for each remaining file run its SQL + record the filename atomically in one
 * transaction. Throws the same rolled-back error the runtime raises when a migration's SQL fails.
 * @returns the filenames newly applied.
 */
export function applyMigrationSet(
  db: DatabaseSync,
  files: MigrationFile[],
  now: () => Date = () => new Date(),
): string[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
  );
  const applied = new Set(
    (db.prepare(`SELECT name FROM ${MIGRATIONS_TABLE}`).all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  const newlyApplied: string[] = [];
  for (const file of byName(files)) {
    if (applied.has(file.name)) continue;
    db.exec("BEGIN");
    try {
      db.exec(file.sql);
      db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`).run(
        file.name,
        now().toISOString(),
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(
        `migration "${file.name}" failed and was rolled back (no partial schema change, not recorded as applied): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    newlyApplied.push(file.name);
  }
  return newlyApplied;
}

/** The current worktree's migration set, read from `db/migrations/`. */
export function readMigrationSetFromDisk(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), "utf8") }));
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}

/**
 * The migration set as it existed at a git ref (tag/branch/sha), read straight from the object
 * store so it works from any worktree. Returns `null` if the ref (or git) is unavailable — e.g. a
 * shallow clone without tags — so callers can skip rather than fail spuriously (CI fetches full
 * history + tags, so it exercises the real path).
 */
export function readMigrationSetFromGit(ref: string): MigrationFile[] | null {
  let listing: string;
  try {
    listing = git(["ls-tree", "-r", "--name-only", ref, "--", "db/migrations"]);
  } catch {
    return null;
  }
  const paths = listing
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".sql"));
  if (paths.length === 0) return null;
  const files: MigrationFile[] = [];
  for (const path of paths) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    files.push({ name, sql: git(["show", `${ref}:${path}`]) });
  }
  return files;
}

/**
 * The most recent release tag (`vN.N.N`) reachable from HEAD's parent — i.e. the release we would be
 * upgrading a live install FROM. Falls back to the tag on HEAD itself, then `null` if none is
 * reachable (shallow clone without tags).
 */
export function previousReleaseTag(): string | null {
  for (const from of ["HEAD^", "HEAD"]) {
    try {
      const ref = git(["describe", "--tags", "--abbrev=0", "--match", "v*", from]).trim();
      if (ref) return ref;
    } catch {
      // try the next base
    }
  }
  return null;
}
