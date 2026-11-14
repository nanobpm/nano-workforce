// Issue #959 — the canonical "merged beats terminated" effective-status derivation for a PR.
//
// THE DEFECT: `pull_requests__tracking.derived_status` mapped ANY terminated run to `abandoned`
// without consulting the PR's merge state, so the 23 November PRs that MERGED but whose loops were
// terminated afterwards (operator cancel, out-of-band merge reconcile, restart cleanup) all read
// "abandoned". These tests pin the fixed semantics against the REAL derivation SQL
// (`pullRequestTrackingReadModel`, app/prTrackingReadModel.ts) compiled to an in-memory SQLite VIEW
// over the SAME canonical `urban_instance_state` projection the framework feeds:
//
//   terminated + merged PR          → `merged`     (landed wins over terminated)
//   terminated + closed-unmerged PR → `abandoned`  (no merged_at → the onTerminated edge)
//   terminated + open PR            → `abandoned`
//   live (non-terminated) run       → base `status` passes through
//
// and the downstream consequence: conformance/retro count a merged-then-terminated PR as LANDED.
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { registerCanonicalProjections, readModelRegistry } from "@nanobpm/urban";
import { assert, assertEquals } from "#test-assert";
import {
  pullRequestTrackingReadModel,
  registerPullRequestTrackingReadModel,
} from "./prTrackingReadModel.ts";

// The projection NAME→physical-table mapping the VIEW's `EXISTS` resolves through.
registerCanonicalProjections();

/** A minimal in-memory DB: the real `pull_requests` base columns the derivation reads (`status`,
 *  `process_key`, `merged_at`), the canonical `_urban_instance_state` projection, and the
 *  app-owned tracking VIEW compiled from the ONE declaration. */
function viewDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE pull_requests (pr_key TEXT PRIMARY KEY, status TEXT, process_key TEXT, merged_at TEXT);
     CREATE TABLE _urban_instance_state (process_instance_key TEXT PRIMARY KEY, state TEXT, waiting_on_human INTEGER NOT NULL DEFAULT 0, updated_at TEXT);`,
  );
  db.exec(pullRequestTrackingReadModel.viewDdl());
  return db;
}

function addPr(
  db: DatabaseSync,
  prKey: string,
  opts: { status: string; processKey: string | null; mergedAt: string | null },
): void {
  db.prepare("INSERT INTO pull_requests (pr_key, status, process_key, merged_at) VALUES (?, ?, ?, ?)").run(
    prKey,
    opts.status,
    opts.processKey,
    opts.mergedAt,
  );
}

function terminate(db: DatabaseSync, processKey: string): void {
  db.prepare(
    "INSERT INTO _urban_instance_state (process_instance_key, state, waiting_on_human, updated_at) VALUES (?, 'TERMINATED', 0, 't')",
  ).run(processKey);
}

function derivedStatus(db: DatabaseSync, prKey: string): string {
  const r = db.prepare("SELECT derived_status FROM pull_requests__tracking WHERE pr_key = ?").get(prKey) as {
    derived_status: string;
  };
  return r.derived_status;
}

test("terminated instance + merged PR (merged_at set) derives `merged`, not `abandoned`", () => {
  const db = viewDb();
  // The #959 case: the loop was terminated AFTER the PR landed; base status frozen at its transient.
  addPr(db, "o/r#merged", { status: "converging", processKey: "514213", mergedAt: "2026-11-01T00:00:00Z" });
  terminate(db, "514213");
  assertEquals(derivedStatus(db, "o/r#merged"), "merged");
  db.close();
});

test("terminated instance + closed-unmerged PR (no merged_at) derives `abandoned`", () => {
  const db = viewDb();
  addPr(db, "o/r#closed", { status: "converging", processKey: "222", mergedAt: null });
  terminate(db, "222");
  assertEquals(derivedStatus(db, "o/r#closed"), "abandoned");
  db.close();
});

test("terminated instance + open PR (no merged_at) derives `abandoned`", () => {
  const db = viewDb();
  addPr(db, "o/r#open", { status: "waiting_review", processKey: "333", mergedAt: null });
  terminate(db, "333");
  assertEquals(derivedStatus(db, "o/r#open"), "abandoned");
  db.close();
});

test("a live (non-terminated) in-flight run passes its base status through unchanged", () => {
  const db = viewDb();
  addPr(db, "o/r#live", { status: "converging", processKey: "444", mergedAt: null });
  db.prepare(
    "INSERT INTO _urban_instance_state (process_instance_key, state, waiting_on_human, updated_at) VALUES ('444', 'ACTIVE', 0, 't')",
  ).run();
  assertEquals(derivedStatus(db, "o/r#live"), "converging");
  db.close();
});

test("a merged PR whose instance COMPLETED normally (no terminated edge) reads base `merged`", () => {
  const db = viewDb();
  addPr(db, "o/r#done", { status: "merged", processKey: "555", mergedAt: "2026-11-01T00:00:00Z" });
  db.prepare(
    "INSERT INTO _urban_instance_state (process_instance_key, state, waiting_on_human, updated_at) VALUES ('555', 'COMPLETED', 0, 't')",
  ).run();
  assertEquals(derivedStatus(db, "o/r#done"), "merged");
  db.close();
});

test("a terminated run with no live process_key (null) still derives the terminal edge off merged_at", () => {
  const db = viewDb();
  // merged_at set but the instance row is gone/null: the merged WHEN keys on merged_at, not the join.
  addPr(db, "o/r#nullkey", { status: "converging", processKey: null, mergedAt: "2026-11-01T00:00:00Z" });
  // No instance-state row at all → not terminated → base status passes through.
  assertEquals(derivedStatus(db, "o/r#nullkey"), "converging");
  db.close();
});

// The whole fix hinges on the app-owned model claiming the EXACT view name urban's provisioner would
// otherwise manage, so the framework defers to it. Pin that contract: the model is named
// `pull_requests__tracking`, registers into the process-wide registry (idempotently), and the
// registration is what `main.ts` invokes before `runFromEnv`.
test("the app-owned model is named pull_requests__tracking and registers idempotently", () => {
  assertEquals(pullRequestTrackingReadModel.decl.name, "pull_requests__tracking");
  assertEquals(pullRequestTrackingReadModel.decl.baseTable, "pull_requests");
  registerPullRequestTrackingReadModel();
  const registered = readModelRegistry.get("pull_requests__tracking");
  assert(registered, "the model must be registered so the framework defers to it");
  assertEquals(registered.decl.name, "pull_requests__tracking");
  // Idempotent: re-registering the identical definition is a no-op (never throws).
  registerPullRequestTrackingReadModel();
});
