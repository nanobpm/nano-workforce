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
//
//
// 075 is the same merge-skew story across two PRs that never saw each other (issue #470): #458 landed
// `075_feature_read_model_attention_from_user_tasks` and #460/#463 landed `075_delivery_graph_proposals`,
// each the branch-local "next" prefix, colliding silently only once both were on main (releases then
// stalled behind the red gate). Both are already applied forward-only and immutable (#357) — renumbering
// a merged migration would re-run it and abort boot, and the immutability check would itself flag the
// rename. They create DISJOINT objects (`075_delivery_graph_proposals` adds the `delivery_graph_proposals`
// table + its indexes; `075_feature_read_model_…` redefines the `feature_read_model` VIEW and adds one
// `user_tasks` index), so their relative apply order is irrelevant. Grandfather 075 (the next migration
// is 076, which supersedes 075's `feature_read_model` VIEW body — a NEW, unique prefix).
//
// The exemption is keyed by the EXACT set of colliding FILENAMES per prefix, not merely the prefix, so
// it only pardons the specific historical files that already merged — a THIRD file taking a
// grandfathered prefix (a fresh 075_*.sql, say) is NOT in the set and still fails the gate. This keeps
// "any NEW duplicate prefix still fails" literally true even for prefixes that already carry a pardoned
// collision (Copilot review, #472).
const GRANDFATHERED_DUPES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["004", new Set(["004_merge.sql", "004_planning.sql"])],
  ["005", new Set(["005_job_activation.sql", "005_plan_deps.sql"])],
  ["006", new Set(["006_plan_review.sql", "006_task_escalation.sql"])],
  ["007", new Set(["007_plan_review_job_key.sql", "007_wave_gate.sql"])],
  ["049", new Set(["049_drop_feature_escalation_surface.sql", "049_plan_task_needs.sql", "049_world_checkpoint.sql"])],
  ["052", new Set(["052_plan_conformance.sql", "052_worker_durable_resume.sql"])],
  ["075", new Set(["075_delivery_graph_proposals.sql", "075_feature_read_model_attention_from_user_tasks.sql"])],
]);

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
 *  merged migration is immutable (issue #357). Additions are fine. Returns whether the immutability
 *  gate actually ran (false when it was skipped because no baseline/diff was available), so the
 *  caller's success message doesn't claim a guarantee the gate never checked. */
function checkImmutability(errors: string[]): boolean {
  const baseline = resolveBaseline();
  if (baseline === null) {
    console.warn(
      "check-migrations: WARN — no origin/main baseline resolvable; skipping the immutability check " +
        "(CI runs it with full history via fetch-depth: 0).",
    );
    return false;
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
    return false;
  }

  errors.push(...immutabilityErrorsFromDiff(statusOutput));
  return true;
}

/** Classify a migration file listing into shape + prefix-collision errors. Pure over the file list
 *  so the MERGE-SKEW scenario can be pinned in a test: two individually-clean branches each pass this
 *  over their OWN tree, but the gate must fail over the UNION that lands on `main` after both merge
 *  (issue #366). This is exactly why the gate has to re-run on the post-merge state — neither branch's
 *  green CI ever saw the other's prefix. Grandfathered historical collisions stay exempt. Exported
 *  for unit coverage. */
export function collisionErrorsFromFiles(files: readonly string[]): string[] {
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
    if (group.length <= 1) continue;
    // Keyed by the EXACT historical filename set: a grandfathered prefix pardons ONLY those specific
    // already-merged files. Any file in the group NOT in that set is a NEW collision and still fails.
    const exempt = GRANDFATHERED_DUPES.get(prefix);
    const unexpected = exempt ? group.filter((f) => !exempt.has(f)) : group;
    if (unexpected.length === 0) continue;
    errors.push(
      exempt
        ? `  prefix ${prefix} is used by ${group.length} files: ${[...group].sort().join(", ")} — only the ` +
          `grandfathered historical set (${[...exempt].sort().join(", ")}) may share this prefix; ` +
          `${[...unexpected].sort().join(", ")} is NEW. Renumber it to the next free prefix ` +
          `(check origin/main, not your branch point).`
        : `  prefix ${prefix} is used by ${group.length} files: ${[...group].sort().join(", ")} — ` +
          `two migrations cannot share an apply-order slot. Renumber the newer one to the next ` +
          `free prefix (check origin/main, not your branch point).`,
    );
  }

  return errors;
}

function main(): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const errors: string[] = collisionErrorsFromFiles(files);

  const immutabilityChecked = checkImmutability(errors);

  if (errors.length > 0) {
    console.error(`check-migrations: db/migrations failed its merge-safety checks:\n${errors.join("\n")}`);
    process.exit(1);
  }

  const immutabilityClause = immutabilityChecked
    ? "none renamed/deleted/edited"
    : "immutability check skipped (no baseline)";
  console.log(
    `check-migrations: OK (${files.length} migrations, no colliding prefixes, ${immutabilityClause}).`,
  );
}

if (import.meta.main) main();

