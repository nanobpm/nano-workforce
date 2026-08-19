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
//
// A second, independent invariant lives here too (issue #357): once a migration has merged to
// `main` it is IMMUTABLE — never renamed, deleted, or edited. The runtime keys the migration ledger
// by FILENAME, so renaming a merged migration makes the runner re-apply it against an already-
// migrated DB and abort boot ("duplicate column"); editing one silently no-ops on every existing
// install (the ledger already has that name) while diverging fresh installs. `checkImmutability`
// diffs `db/migrations/` against the merge-base with `origin/main` and fails on any rename, delete,
// or content change to a file that existed there. It compares against the merge-base (the branch's
// fork point), NOT `origin/main`'s tip, so a branch that is merely behind main isn't wrongly flagged
// for migrations added to main after it forked.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "db", "migrations");

// Historical collisions that predate this gate. Forward-only + already applied ⇒ cannot be
// renumbered. New duplicates are NOT allowed here — fix them before merge.
//
// 049 is a grandfathered post-hoc collision: three independently-merged PRs each took the then-next
// free prefix on their own branch and landed a `049_*.sql` (#290 `049_plan_task_needs`, #337
// `049_world_checkpoint`, #339 `049_drop_feature_escalation_surface`). Because a per-branch prefix is
// computed without visibility of sibling branches, the collision was SILENT at each PR's green CI and
// only surfaced once all three were on main — exactly the merge-time failure mode this gate warns
// about, realised across three PRs that never saw each other. By the time it was caught the three
// migrations were already applied forward-only on main and production, so — like 004–007 — they
// cannot be renumbered (a rename re-runs `CREATE TABLE`/`ALTER TABLE DROP COLUMN` on migrated DBs and
// fails). They create three disjoint schema objects, so their relative apply order is irrelevant.
// Grandfather 049; any NEW duplicate prefix still fails the build.
//
// 052 is the same story across two PRs: #351 landed `052_worker_durable_resume` and #355 landed
// `052_plan_conformance`, each the branch-local "next" prefix, colliding silently only once both were
// on main. Both are already applied forward-only, and — reinforced now by the immutability check
// below — renumbering a merged migration is itself forbidden (the rename would re-run it and abort
// boot, issue #357). The two create disjoint tables (`worker_durable_resume`, `plan_conformance`), so
// apply order is irrelevant. Grandfather 052; any NEW duplicate prefix still fails the build.
const GRANDFATHERED_DUPES: ReadonlySet<string> = new Set(["004", "005", "006", "007", "049", "052"]);

const PREFIX = /^(\d{3})_[^/]*\.sql$/;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}

/** The commit to treat as "already merged" — the branch's fork point from `origin/main` (fall back to
 *  local `main`). `null` when no baseline is resolvable (e.g. a shallow clone with no `main`), in
 *  which case the immutability check is skipped with a warning; CI checks out full history. Override
 *  with `MIGRATION_BASELINE_REF` (used by the gate's own tests). */
function resolveBaseline(): string | null {
  const override = process.env.MIGRATION_BASELINE_REF;
  const upstreams = override ? [override] : ["origin/main", "main"];
  for (const ref of upstreams) {
    try {
      // An explicit override is used as-is; a branch name is resolved to its merge-base with HEAD so a
      // branch that is merely behind main isn't blamed for migrations main gained after it forked.
      if (override) {
        git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
        return ref;
      }
      return git(["merge-base", ref, "HEAD"]).trim();
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Classify a `git diff --find-renames --name-status <baseline> -- db/migrations` listing into
 *  immutability violations. Renames (`R`), deletes (`D`), and content edits (`M`) of a merged
 *  migration are violations; additions (`A`) are allowed. Exported for unit coverage. */
export function immutabilityErrorsFromDiff(statusOutput: string): string[] {
  const errors: string[] = [];
  const name = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
  for (const line of statusOutput.split("\n")) {
    if (line.trim() === "") continue;
    const [status, ...paths] = line.split("\t");
    if (status.startsWith("R")) {
      errors.push(
        `  ${name(paths[0])} -> ${name(paths[1])}: a merged migration was RENAMED. The ledger keys ` +
          `by filename, so the renamed file re-runs on every existing install and aborts boot. Keep ` +
          `the original filename; add a NEW migration for further change.`,
      );
    } else if (status.startsWith("D")) {
      errors.push(
        `  ${name(paths[0])}: a merged migration was DELETED. Forward-only migrations are immutable — ` +
          `removing one desyncs the ledger from the schema. Leave it in place.`,
      );
    } else if (status.startsWith("M")) {
      errors.push(
        `  ${name(paths[0])}: a merged migration was EDITED. The ledger already records it, so the ` +
          `edit silently no-ops on every migrated install while diverging fresh ones. Add a NEW ` +
          `migration instead of changing a merged one.`,
      );
    }
  }
  return errors;
}

/** Fail on any rename, delete, or content change to a migration already present at the baseline — a
 *  merged migration is immutable (issue #357). Additions are fine. */
function checkImmutability(errors: string[]): void {
  const baseline = resolveBaseline();
  if (baseline === null) {
    console.warn(
      "check-migrations: WARN — no origin/main baseline resolvable; skipping the immutability check " +
        "(CI runs it with full history via fetch-depth: 0).",
    );
    return;
  }

  let statusOutput: string;
  try {
    // Diff the baseline tree against the WORKING TREE (staged + unstaged), detecting renames, scoped
    // to db/migrations. `--find-renames` surfaces a rename as one `R` row instead of a delete+add.
    statusOutput = git([
      "diff",
      "--find-renames",
      "--name-status",
      baseline,
      "--",
      "db/migrations",
    ]);
  } catch {
    console.warn(
      `check-migrations: WARN — could not diff migrations against ${baseline}; skipping the immutability check.`,
    );
    return;
  }

  errors.push(...immutabilityErrorsFromDiff(statusOutput));
}

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

  checkImmutability(errors);

  if (errors.length > 0) {
    console.error(`check-migrations: db/migrations failed its merge-safety checks:\n${errors.join("\n")}`);
    process.exit(1);
  }

  console.log(
    `check-migrations: OK (${files.length} migrations, no colliding prefixes, none renamed/deleted/edited).`,
  );
}

if (import.meta.main) main();

