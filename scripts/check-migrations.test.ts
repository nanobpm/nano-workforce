// Red/green coverage for the migration immutability gate (scripts/check-migrations.ts, issue #357).
//
// The runtime keys the migration ledger by FILENAME, so once a migration merges it must never be
// renamed (re-runs against a migrated DB and aborts boot), deleted (desyncs ledger from schema), or
// edited (silently no-ops on migrated installs). The gate diffs db/migrations against the merge-base
// with origin/main; here we drive its diff classifier directly with representative
// `git diff --find-renames --name-status` output so each violation shape is pinned.
import test from "node:test";
import { collisionErrorsFromFiles, immutabilityErrorsFromDiff } from "./check-migrations.ts";
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

// Merge-skew regression coverage (issue #366).
//
// The failure class this pins: two PRs each pass `check:migrations` on their OWN head, but their
// COMBINATION on `main` after both squash-merge violates the prefix-collision invariant — because
// neither branch's green CI ever saw the other's file. The 052 collision (#351 + #355, hotfixed in
// #359) was exactly this. Driving the pure collision detector with each branch's tree AND their union
// demonstrates that only the post-merge state trips the gate, which is why the gate must re-run on
// the prospective merged commit (merge_queue) / on push to `main`, not just PR heads.
test("merge skew: two individually-clean branches whose union collides IS caught", () => {
  const mainTree = ["050_capability_gates.sql", "051_merges_per_day.sql"];
  // Each branch independently picks the same "next free" prefix (060) without seeing its sibling.
  const branchA = [...mainTree, "060_plan_conformance.sql"];
  const branchB = [...mainTree, "060_worker_durable_resume.sql"];

  // On its own head, each branch is clean — this is why both PRs go green in isolation.
  assertEquals(collisionErrorsFromFiles(branchA), [], "branch A alone has no colliding prefix");
  assertEquals(collisionErrorsFromFiles(branchB), [], "branch B alone has no colliding prefix");

  // The post-merge tree on `main` (git merges both files cleanly — the names don't textually
  // conflict) now shares slot 060. The gate, re-run on that merged state, catches it.
  const mergedOnMain = [...new Set([...branchA, ...branchB])].sort();
  const errors = collisionErrorsFromFiles(mergedOnMain);
  assertEquals(errors.length, 1, "the merged tree has exactly one colliding prefix");
  assert(/prefix 060/.test(errors[0]));
  assert(/060_plan_conformance.sql/.test(errors[0]));
  assert(/060_worker_durable_resume.sql/.test(errors[0]));
});

test("collision detector flags a non-NNN shape and grandfathers historical dupes", () => {
  assert(collisionErrorsFromFiles(["nope.sql"]).some((e) => /required NNN_name.sql shape/.test(e)));
  // Grandfathered historical collisions (already applied forward-only) must stay exempt.
  assertEquals(
    collisionErrorsFromFiles(["052_plan_conformance.sql", "052_worker_durable_resume.sql"]),
    [],
    "grandfathered prefix 052 is not a new violation",
  );
});
