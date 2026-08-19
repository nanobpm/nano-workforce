// Red/green coverage for the migration immutability gate (scripts/check-migrations.ts, issue #357).
//
// The runtime keys the migration ledger by FILENAME, so once a migration merges it must never be
// renamed (re-runs against a migrated DB and aborts boot), deleted (desyncs ledger from schema), or
// edited (silently no-ops on migrated installs). The gate diffs db/migrations against the merge-base
// with origin/main; here we drive its diff classifier directly with representative
// `git diff --find-renames --name-status` output so each violation shape is pinned.
import test from "node:test";
import { immutabilityErrorsFromDiff } from "./check-migrations.ts";
import { assert, assertEquals } from "#test-assert";

test("a rename of a merged migration is a violation", () => {
  const errors = immutabilityErrorsFromDiff(
    "R100\tdb/migrations/043_user_tasks_subject_title.sql\tdb/migrations/046_user_tasks_subject_title.sql",
  );
  assertEquals(errors.length, 1);
  assert(/RENAMED/.test(errors[0]));
  assert(/043_user_tasks_subject_title.sql -> 046_user_tasks_subject_title.sql/.test(errors[0]));
});

test("a delete of a merged migration is a violation", () => {
  const errors = immutabilityErrorsFromDiff("D\tdb/migrations/046_user_tasks_subject_title.sql");
  assertEquals(errors.length, 1);
  assert(/DELETED/.test(errors[0]));
});

test("an edit of a merged migration is a violation", () => {
  const errors = immutabilityErrorsFromDiff("M\tdb/migrations/046_user_tasks_subject_title.sql");
  assertEquals(errors.length, 1);
  assert(/EDITED/.test(errors[0]));
});

test("adding a new migration is allowed", () => {
  assertEquals(
    immutabilityErrorsFromDiff("A\tdb/migrations/061_brand_new.sql"),
    [],
    "an addition is not a violation",
  );
});

test("a clean diff (no migration changes) yields no violations", () => {
  assertEquals(immutabilityErrorsFromDiff(""), []);
});

test("mixed changes report every violation but ignore the addition", () => {
  const errors = immutabilityErrorsFromDiff(
    [
      "A\tdb/migrations/061_new.sql",
      "M\tdb/migrations/010_old.sql",
      "D\tdb/migrations/011_gone.sql",
      "R096\tdb/migrations/012_a.sql\tdb/migrations/013_a.sql",
    ].join("\n"),
  );
  assertEquals(errors.length, 3, "the three mutations are flagged, the addition is not");
  assert(errors.some((e) => /EDITED/.test(e)));
  assert(errors.some((e) => /DELETED/.test(e)));
  assert(errors.some((e) => /RENAMED/.test(e)));
});
