// Read-model coverage for the Convergence (PRs) Active/History projection — the declared `list_bucket`
// (active/history) + `ack_open` (the Dismiss affordance flag) that give the PR surfaces the SAME
// acknowledge-to-dismiss behaviour Features/Epics/Delivery-Graphs already have, authored via Urban's
// ADR-0065 declare-once primitive (app/pullRequestReadModel.ts). Issue #641; the exemplars are
// app/featureReadModel.test.ts and app/deliveryGraphReadModel.test.ts.
//
// Guards:
//   1. DRIFT GUARD — migration 094 embeds each derived column VERBATIM from
//      `pullRequestReadModel.sqlSelectFor(...)` and passes EVERY base column through, so the checked-in
//      VIEW cannot drift from the declaration.
//   2. FRAMEWORK PARITY GUARD — `assertReadModelParity` proves the SQL and TS lowerings the ONE
//      declaration compiles to agree over the status × acknowledged matrix.
//   3. END-TO-END BEHAVIOUR on the REAL migration VIEW (094 applied to an in-memory DB): a live PR is
//      active with no Dismiss; a terminal-but-unacknowledged PR STAYS active and offers Dismiss; once
//      acknowledged it drops to History; an out-of-band-terminated PR classifies on engine truth.
//   4. PAGE BINDINGS — the Convergence surfaces (overview + home) bind the derived VIEW and bucket on
//      the derived `list_bucket`, not a base-`status` allowlist over the raw `pull_requests` table.

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertReadModelParity, type ParityDb, type ParitySample } from "@nanobpm/urban";
import { assert, assertEquals } from "#test-assert";
import { applyMigrationSet, readMigrationSetFromDisk } from "../test/migrations.ts";
import {
  PR_TERMINAL_STATUSES,
  PULL_REQUEST_READ_MODEL_BASE_ALIAS,
  PULL_REQUEST_READ_MODEL_DERIVED,
  pullRequestReadModel,
} from "./pullRequestReadModel.ts";

const MIG = (name: string) => readFileSync(fileURLToPath(new URL(`../db/migrations/${name}`, import.meta.url)), "utf8");
const PAGE = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../pages/${name}`, import.meta.url)), "utf8"));

const READ_MODEL_MIGRATION = "094_pull_requests_read_model.sql";

// The real base `pull_requests` columns, in schema order — DERIVED from the migration chain (not a
// hand-kept list that could silently omit one), used by both the drift guard and the e2e stand-in.
function baseColumns(): string[] {
  const db = new DatabaseSync(":memory:");
  applyMigrationSet(db, readMigrationSetFromDisk());
  const cols = (db.prepare("PRAGMA table_info(pull_requests)").all() as { name: string }[]).map((r) => r.name);
  db.close();
  return cols;
}

// A minimal in-memory DB carrying the base `pull_requests` shape the VIEW reads, plus a stand-in for
// the managed `pull_requests__tracking` derived VIEW urban provisions at mount (re-exporting `pr.*`
// plus the terminal-folded `derived_status`). `derived_status_override` models the reconciler's
// `onTerminated` edge (a terminated instance ⇒ `abandoned` while base `status` stays frozen). Then
// migration 094 (the read model VIEW) is applied on top.
function viewDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const cols = baseColumns().filter((c) => c !== "pr_key");
  db.exec(
    `CREATE TABLE pull_requests (
       pr_key TEXT PRIMARY KEY,
       ${cols.map((c) => `${c} TEXT`).join(",\n       ")},
       derived_status_override TEXT);
     CREATE VIEW pull_requests__tracking AS
       SELECT p.*, COALESCE(p.derived_status_override, p.status) AS derived_status FROM pull_requests p;`,
  );
  db.exec(MIG(READ_MODEL_MIGRATION));
  return db;
}

function addPr(
  db: DatabaseSync,
  pr_key: string,
  opts: { status: string; acknowledged_at?: string | null; derived_status_override?: string | null },
): void {
  db.prepare(
    "INSERT INTO pull_requests (pr_key, status, acknowledged_at, derived_status_override) VALUES (?, ?, ?, ?)",
  ).run(pr_key, opts.status, opts.acknowledged_at ?? null, opts.derived_status_override ?? null);
}

function bucket(db: DatabaseSync, pr_key: string): { list_bucket: string; ack_open: number; status: string } {
  const r = db
    .prepare("SELECT list_bucket, ack_open, status FROM pull_requests_read_model WHERE pr_key = ?")
    .get(pr_key) as { list_bucket: string; ack_open: number; status: string };
  return { list_bucket: r.list_bucket, ack_open: r.ack_open, status: r.status };
}

function parityDb(db: DatabaseSync): ParityDb {
  return {
    exec: (sql) => db.exec(sql),
    all: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])) as T[],
    run: (sql, params: unknown[] = []) => {
      const r = db.prepare(sql).run(...(params as never[]));
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    },
  };
}

// ── 1. DRIFT GUARD ────────────────────────────────────────────────────────────────────────────────

test("DRIFT GUARD: migration 094 embeds each derived column VERBATIM from pullRequestReadModel.sqlSelectFor (the VIEW cannot drift from the declaration)", () => {
  const sql = MIG(READ_MODEL_MIGRATION);
  const alias = PULL_REQUEST_READ_MODEL_BASE_ALIAS;
  for (const c of PULL_REQUEST_READ_MODEL_DERIVED) {
    const emitted = pullRequestReadModel.sqlSelectFor(c, { baseAlias: alias });
    assert(
      sql.includes(`${emitted} AS ${c}`),
      `migration ${READ_MODEL_MIGRATION} no longer embeds the declaration's SQL for "${c}" — regenerate it from ` +
        `app/pullRequestReadModel.ts. Expected to contain:\n  ${emitted} AS ${c}`,
    );
  }
  assert(/DROP VIEW IF EXISTS pull_requests_read_model;/.test(sql), "094 must DROP the VIEW first");
  assert(/CREATE VIEW pull_requests_read_model AS/.test(sql), "094 must (re)create pull_requests_read_model");
  // Base identity pass-throughs — DERIVED from the REAL `pull_requests` schema, NOT a hand-kept list:
  // the VIEW must re-export EVERY base column so the static pages↔schema contract guard sees them (and a
  // future regeneration can't drop one without failing here). `status` is the one exception — exposed as
  // the effective COALESCE below, not a bare pass-through — so it is asserted separately.
  const cols = baseColumns();
  assert(cols.length > 0, "the migration chain must create the pull_requests base table");
  for (const base of cols) {
    if (base === "status") continue;
    assert(sql.includes(`pr.${base} AS ${base}`), `094 must pass base column "${base}" through the VIEW (derived from the real pull_requests schema)`);
  }
  assert(sql.includes("COALESCE(pr.derived_status, pr.status) AS status"), "094 must expose the effective status so the pages' Status cell + any status reader track a terminated PR");
  assert(sql.includes(`FROM ${pullRequestReadModel.decl.baseTable} ${alias}`), `094's FROM must be the declaration's baseTable "${pullRequestReadModel.decl.baseTable}"`);
});

// ── 2. FRAMEWORK PARITY GUARD ──────────────────────────────────────────────────────────────────────

test("FRAMEWORK PARITY GUARD: pullRequestReadModel's SQL and TS lowerings agree over the status × acknowledged matrix (assertReadModelParity)", () => {
  const samples: ParitySample[] = [];
  for (const status of ["waiting_review", "converging", "merged", "converged", "abandoned", "closed", "failed"]) {
    for (const derived_status of [status, "abandoned"]) {
      for (const acknowledged_at of [null, "2026-02-02T00:00:00Z"]) {
        samples.push({ baseRow: { pr_key: "self", status, derived_status, acknowledged_at }, lookups: {} });
      }
    }
  }
  const db = new DatabaseSync(":memory:");
  assertReadModelParity(pullRequestReadModel, parityDb(db), samples, { sql: { baseAlias: PULL_REQUEST_READ_MODEL_BASE_ALIAS } });
  db.close();
});

// ── 3. END-TO-END BEHAVIOUR on the real migration VIEW ────────────────────────────────────────────

test("ACKNOWLEDGE-TO-DISMISS: a live PR is active with no Dismiss; a terminal-but-unacknowledged PR STAYS active + offers Dismiss; once acknowledged it drops to history", () => {
  const db = viewDb();
  // Live (in-flight convergence states) — active, no dismiss.
  addPr(db, "live-review", { status: "waiting_review" });
  addPr(db, "live-conv", { status: "converging" });
  // Terminal, not yet dismissed — the uniform rule keeps each ACTIVE (not History) with the Dismiss flag.
  for (const s of PR_TERMINAL_STATUSES) addPr(db, `term-${s}`, { status: s });
  // Terminal AND acknowledged — dropped to History, Dismiss retracted.
  addPr(db, "merged-ack", { status: "merged", acknowledged_at: "2026-03-03T00:00:00Z" });
  // Derive-only terminated (base frozen at an in-flight status, engine truth 'abandoned'), unacknowledged.
  addPr(db, "derive-term", { status: "converging", derived_status_override: "abandoned" });
  // A stray ack on a still-live PR must NOT drag it to History (ack only bites once terminal).
  addPr(db, "live-stray-ack", { status: "converging", acknowledged_at: "2026-03-03T00:00:00Z" });

  assertEquals(bucket(db, "live-review"), { list_bucket: "active", ack_open: 0, status: "waiting_review" });
  assertEquals(bucket(db, "live-conv"), { list_bucket: "active", ack_open: 0, status: "converging" });
  for (const s of PR_TERMINAL_STATUSES) {
    assertEquals(bucket(db, `term-${s}`), { list_bucket: "active", ack_open: 1, status: s });
  }
  assertEquals(bucket(db, "merged-ack"), { list_bucket: "history", ack_open: 0, status: "merged" });
  assertEquals(bucket(db, "derive-term"), { list_bucket: "active", ack_open: 1, status: "abandoned" });
  assertEquals(bucket(db, "live-stray-ack"), { list_bucket: "active", ack_open: 0, status: "converging" });
  db.close();
});

// ── 4. PAGE BINDINGS ──────────────────────────────────────────────────────────────────────────────

function grids(page: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (o.type === "dataGrid") out.push(o);
      for (const v of Object.values(o)) walk(v);
    }
  };
  walk(page);
  return out;
}

for (const { pageName, title } of [
  { pageName: "overview.page.json", title: "Active PR convergences" },
  { pageName: "home.page.json", title: "Pull requests" },
]) {
  test(`${pageName} '${title}' grid binds the derived pull_requests_read_model VIEW and buckets on list_bucket (not a base-status allowlist over the raw table)`, () => {
    const page = PAGE(pageName);
    const grid = grids(page).find((g) => (g.props as Record<string, unknown>)?.title === title);
    assert(grid, `${pageName} must carry the "${title}" grid`);
    const props = grid.props as Record<string, unknown>;
    const data = props.data as Record<string, unknown>;
    assertEquals(data.table, "pull_requests_read_model");

    // Every activeness filter (main + tabs) buckets on `list_bucket`; none re-encodes a base-status allowlist.
    const tabs = (Array.isArray(props.tabs) ? props.tabs : []) as Array<Record<string, unknown>>;
    const filters = [data.filter, ...tabs.map((t) => t.filter)].filter(Array.isArray) as Array<Array<Record<string, unknown>>>;
    let sawListBucket = false;
    for (const f of filters) {
      for (const pred of f) {
        assert(pred.field !== "status", `${pageName} "${title}" must not filter a base-status allowlist — bucket on list_bucket`);
        if (pred.field === "list_bucket") sawListBucket = true;
      }
    }
    assert(sawListBucket, `${pageName} "${title}" must filter the derived list_bucket`);
  });
}
