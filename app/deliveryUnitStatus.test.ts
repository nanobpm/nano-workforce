// Coverage for ADR 0006 slice S1 — the ONE canonical delivery-unit status union and the per-shape
// derivations that map each bespoke source union into it (app/deliveryUnitStatus.ts).
//
// Guards THREE things:
//   1. TOTALITY — every member of each source union (feature / plan aggregate / plan-task node /
//      delivery-graph run) maps to a valid canonical member, and the compiled `fnFor` agrees with the
//      declared map object (so the DSL derivation and the TS map cannot drift).
//   2. TERMINALITY PRECEDENCE — a source SETTLED/terminal status always maps to a canonical
//      settled/terminal status, so a reconciler reading the union never mistakes a finished unit for a
//      live one (or vice-versa).
//   3. FRAMEWORK PARITY — for each of the four read models, `assertReadModelParity` proves the SQL VIEW
//      lowering and the TS `fnFor` lowering agree over the full source-status matrix.
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { assertReadModelParity, type ParityDb, type ParitySample } from "@nanobpm/urban";
import { assert, assertEquals } from "#test-assert";
import { DELIVERY_GRAPH_RUN_STATUSES, DELIVERY_GRAPH_TERMINAL_STATUSES } from "./deliveryGraphRun.ts";
import {
  DELIVERY_GRAPH_STATUS_TO_UNIT,
  DELIVERY_STATUS_COLUMN,
  DELIVERY_UNIT_SETTLED_STATUSES,
  DELIVERY_UNIT_STATUSES,
  DELIVERY_UNIT_TERMINAL_STATUSES,
  type DeliveryUnitStatus,
  deliveryGraphDeliveryStatus,
  FEATURE_STATUS_TO_UNIT,
  featureDeliveryStatus,
  isDeliveryUnitSettled,
  isDeliveryUnitTerminal,
  PLAN_STATUS_TO_UNIT,
  PLAN_STATUSES,
  PLAN_TASK_STATUS_TO_UNIT,
  planDeliveryStatus,
  planTaskDeliveryStatus,
  toDeliveryUnitStatus,
} from "./deliveryUnitStatus.ts";
import { FEATURE_RUN_STATUSES, FEATURE_TERMINAL_STATUSES } from "./feature.ts";
import { PLAN_TASK_STATUSES, PLAN_TERMINAL_STATUSES } from "./plan.ts";

const CANONICAL = new Set<string>(DELIVERY_UNIT_STATUSES);

// ── Type-level No-Drift guard (issue #464 review) ────────────────────────────────────────────────
// `PLAN_STATUSES` is DERIVED from `EPIC_LIVE_STATUSES` (app/delivery.ts) + `PLAN_TERMINAL_STATUSES`
// (app/plan.ts). If either source is declared as a widened `readonly string[]` instead of an `as const`
// literal tuple, `(typeof PLAN_STATUSES)[number]` collapses to `string`, `PLAN_STATUS_TO_UNIT` degrades
// to `Record<string, …>`, and the exhaustiveness guard silently evaporates — `tsc` would no longer fail
// when the plan vocabulary gains a member without a canonical mapping. This assertion fails to COMPILE
// if that widening ever returns (the `false` branch makes `true` unassignable).
type _IsLiteralUnion<T extends string> = string extends T ? false : true;
const _planStatusesAreLiteral: _IsLiteralUnion<(typeof PLAN_STATUSES)[number]> = true;
void _planStatusesAreLiteral;

// A `ParityDb` over node:sqlite's `DatabaseSync` for `assertReadModelParity` (which needs positional
// exec/all/run, whereas `DatabaseSync` exposes query methods on prepared statements).
function parityDb(db: DatabaseSync): ParityDb {
  return {
    exec: (sql) => db.exec(sql),
    all: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as T[],
    run: (sql, params: unknown[] = []) => {
      const r = db.prepare(sql).run(...(params as never[]));
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    },
  };
}

const shapes = [
  { name: "feature", model: featureDeliveryStatus, sources: FEATURE_RUN_STATUSES, map: FEATURE_STATUS_TO_UNIT },
  { name: "plan", model: planDeliveryStatus, sources: PLAN_STATUSES, map: PLAN_STATUS_TO_UNIT },
  { name: "plan-task", model: planTaskDeliveryStatus, sources: PLAN_TASK_STATUSES, map: PLAN_TASK_STATUS_TO_UNIT },
  { name: "delivery-graph", model: deliveryGraphDeliveryStatus, sources: DELIVERY_GRAPH_RUN_STATUSES, map: DELIVERY_GRAPH_STATUS_TO_UNIT },
] as const;

test("TOTALITY: every source status maps to a valid canonical member, and fnFor agrees with the declared map", () => {
  for (const { name, model, sources, map } of shapes) {
    for (const source of sources) {
      const declared = (map as Record<string, DeliveryUnitStatus>)[source];
      assert(declared !== undefined, `${name}: source status "${source}" has no canonical mapping`);
      assert(CANONICAL.has(declared), `${name}: "${source}" maps to non-canonical "${declared}"`);
      // The DSL-compiled TS lowering must produce the SAME canonical value as the declared map object.
      assertEquals(toDeliveryUnitStatus(model, source), declared, `${name}: fnFor drift for "${source}"`);
    }
    // An out-of-band status is NULL (never an invented member), matching the VIEW's ELSE NULL.
    assertEquals(toDeliveryUnitStatus(model, "not-a-real-status"), null, `${name}: unmapped status must be null`);
    assertEquals(toDeliveryUnitStatus(model, null), null, `${name}: null status must be null`);
  }
});

test("TERMINALITY PRECEDENCE: a source SETTLED/terminal status maps to a canonical settled/terminal status", () => {
  // Feature counts opened/converging as SETTLED-for-redispatch (live PR stages), so check against the
  // settled set; the plan aggregate and delivery-graph terminals are truly DONE, so check the done tier.
  for (const s of FEATURE_TERMINAL_STATUSES) {
    assert(isDeliveryUnitSettled(FEATURE_STATUS_TO_UNIT[s]), `feature terminal "${s}" must map to a settled canonical status`);
  }
  for (const s of PLAN_TERMINAL_STATUSES as readonly (keyof typeof PLAN_STATUS_TO_UNIT)[]) {
    assert(isDeliveryUnitTerminal(PLAN_STATUS_TO_UNIT[s]), `plan terminal "${s}" must map to a done-tier canonical status`);
  }
  for (const s of DELIVERY_GRAPH_TERMINAL_STATUSES) {
    assert(isDeliveryUnitTerminal(DELIVERY_GRAPH_STATUS_TO_UNIT[s]), `graph terminal "${s}" must map to a done-tier canonical status`);
  }
  // The non-terminal parked waits must NOT be classified terminal (a reconciler must keep polling them).
  for (const nonTerminal of ["escalated", "awaiting_operator", "waiting", "running", "requested"] as DeliveryUnitStatus[]) {
    assert(!isDeliveryUnitTerminal(nonTerminal), `"${nonTerminal}" must be non-terminal`);
  }
});

test("NODE-VS-AGGREGATE decision (ADR 0006 §4): a plan-task node maps into the SAME union; its lane wait becomes the canonical `waiting`", () => {
  assertEquals(PLAN_TASK_STATUS_TO_UNIT["waiting-for-lane"], "waiting", "the node lane/dependency wait is the canonical `waiting`");
  assertEquals(PLAN_TASK_STATUS_TO_UNIT.pending, "requested", "a queued (not-yet-run) node is pre-dispatch `requested`");
  // Every node status resolves to a member of the one canonical union — no separate node vocabulary.
  for (const s of PLAN_TASK_STATUSES) {
    assert(CANONICAL.has(PLAN_TASK_STATUS_TO_UNIT[s]), `node status "${s}" must be a canonical member`);
  }
});

test("the settled set is exactly the terminal (done-tier) set plus the two live PR resting stages", () => {
  assertEquals(
    [...DELIVERY_UNIT_SETTLED_STATUSES].sort(),
    [...DELIVERY_UNIT_TERMINAL_STATUSES, "opened", "converging"].sort(),
    "settled = terminal ∪ {opened, converging}",
  );
  for (const t of DELIVERY_UNIT_TERMINAL_STATUSES) assert(isDeliveryUnitSettled(t), `terminal "${t}" is settled`);
});

test("no dead canonical members: every DELIVERY_UNIT_STATUSES value is reachable from at least one source mapping", () => {
  const reached = new Set<string>();
  for (const { map } of shapes) for (const v of Object.values(map)) reached.add(v as string);
  for (const canonical of DELIVERY_UNIT_STATUSES) {
    assert(reached.has(canonical), `canonical "${canonical}" is unreachable — a dead member or a missing mapping`);
  }
});

test("FRAMEWORK PARITY: each per-shape delivery_status model's SQL and TS lowerings agree over the full source-status matrix", () => {
  for (const { name, model, sources } of shapes) {
    const samples: ParitySample[] = sources.map((status) => ({ baseRow: { status } }));
    // Also exercise the ELSE NULL arm with an out-of-band value.
    samples.push({ baseRow: { status: "out-of-band" } });
    const db = new DatabaseSync(":memory:");
    assertReadModelParity(model, parityDb(db), samples, { columns: [DELIVERY_STATUS_COLUMN] });
    db.close();
    assert(true, `${name} parity holds`);
  }
});
