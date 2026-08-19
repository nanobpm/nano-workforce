// Upgrade smoke test (issue #357) — CI only ever migrates a FRESH database, so it never exercises the
// one state where the forward-only contract actually breaks: a *pre-existing* install upgrading to
// the current set. This materialises the migration set at the previous release tag, applies the
// current set on top the way the runtime does (ledger keyed by filename, skip-applied / apply-new),
// and asserts the upgrade completes cleanly.
//
// It covers the whole failure class on a real release boundary — a renamed/deleted migration
// re-running, non-idempotent DDL, or an ordering assumption — rather than any single instance. When
// the tag is unavailable (a shallow clone without tags) it skips with a diagnostic; CI checks out
// full history + tags (`fetch-depth: 0`), so the real upgrade path is always exercised there.
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { assert, assertEquals } from "#test-assert";
import {
  applyMigrationSet,
  previousReleaseTag,
  readMigrationSetFromDisk,
  readMigrationSetFromGit,
} from "#test-migrations";

test("upgrading a DB from the previous release's migrations to the current set applies cleanly", (t) => {
  const tag = previousReleaseTag();
  if (tag === null) {
    t.skip("no previous release tag reachable (shallow clone without tags) — CI runs this with fetch-depth: 0");
    return;
  }
  const baseline = readMigrationSetFromGit(tag);
  if (baseline === null) {
    t.skip(`migration set at ${tag} unavailable — CI runs this with fetch-depth: 0`);
    return;
  }

  const db = new DatabaseSync(":memory:");
  // Stand up the DB exactly as the previous release left it...
  applyMigrationSet(db, baseline);
  const ledgerBefore = new Set(
    (db.prepare("SELECT name FROM _urban_migrations").all() as { name: string }[]).map((r) => r.name),
  );

  // ...then upgrade in place to the current set. A rename/delete/non-idempotent migration throws here.
  const current = readMigrationSetFromDisk();
  applyMigrationSet(db, current);

  // Every current migration is now recorded, and nothing the baseline applied went missing.
  const ledgerAfter = new Set(
    (db.prepare("SELECT name FROM _urban_migrations").all() as { name: string }[]).map((r) => r.name),
  );
  for (const file of current) {
    assert(ledgerAfter.has(file.name), `current migration ${file.name} is recorded as applied after upgrade`);
  }
  for (const name of ledgerBefore) {
    assert(ledgerAfter.has(name), `baseline migration ${name} remains in the ledger after upgrade`);
  }
  assertEquals(ledgerAfter.size, current.length, "the upgraded ledger holds exactly the current set");
});
