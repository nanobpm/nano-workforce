// Read-model derivation test for the FEATURE-run BLOCKED reconcile (issue #220 — a blocked feature run
// parked at `feature-blocked` had no completion affordance in nwf). When a run reaches a `blocked`
// outcome `record-feature` holds the row at the non-terminal `awaiting_operator` status and it parks on
// the native `feature-blocked` operator user task; `feature_runs` (which the pages read) had a status
// but NO completable-task pointer, so the pages could not drive an acknowledge action. The blocked twin
// of `deriveFeatureEscalationPatch` — the pure source of truth tested here — reconciles ONLY that
// completable-task pointer (never the status, which `record-feature`/`record-blocked-ack` own), which
// `pollFeatureBlocked` projects onto the row.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import { deriveFeatureBlockedPatch } from "./feature.ts";
import { pollFeatureBlocked } from "./service.ts";

// biome-ignore lint/suspicious/noExplicitAny: tiny in-memory table double, mirrors featureEscalation.test.ts
function memData(): { data: DataLayer; stores: Record<string, any[]> } {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const stores: Record<string, any[]> = {};
  function tbl(name: string, pk = "id") {
    // biome-ignore lint/suspicious/noExplicitAny: see above
    const rows = (stores[name] ??= [] as any[]);
    // biome-ignore lint/suspicious/noExplicitAny: see above
    const match = (r: any, where: any) => Object.entries(where).every(([k, v]) => r[k] === v);
    return {
      async all() {
        return rows.slice();
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async get(id: any) {
        return rows.find((r) => r[pk] === id);
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async find(where: any = {}) {
        return rows.filter((r) => match(r, where));
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async insert(row: any) {
        rows.push({ ...row });
        return row[pk];
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async update(id: any, patch: any) {
        const r = rows.find((row) => row[pk] === id);
        if (r) Object.assign(r, patch);
      },
    };
  }
  const data = { table: (n: string, pk?: string) => tbl(n, pk) } as unknown as DataLayer;
  return { data, stores };
}

/** A fake engine whose open user tasks are keyed by processInstanceKey (the only field
 *  pollFeatureBlocked queries on). */
function fakeEngine(byInstance: Record<string, { userTaskKey: string; elementId?: string }[]>): EngineClient {
  return {
    searchUserTasks: (filter?: { processInstanceKey?: string }) =>
      Promise.resolve(filter?.processInstanceKey ? (byInstance[filter.processInstanceKey] ?? []) : []),
  } as unknown as EngineClient;
}

test("deriveFeatureBlockedPatch: a run parked at feature-blocked records the completable key (status untouched)", () => {
  const patch = deriveFeatureBlockedPatch({ blocked_user_task_key: null }, { userTaskKey: "ut-9" });
  assertEquals(patch, { blocked_user_task_key: "ut-9" });
});

test("deriveFeatureBlockedPatch: an already-recorded parked run yields no patch (idempotent)", () => {
  const patch = deriveFeatureBlockedPatch({ blocked_user_task_key: "ut-9" }, { userTaskKey: "ut-9" });
  assertEquals(patch, null);
});

test("deriveFeatureBlockedPatch: an observed run whose task is gone clears the stale pointer", () => {
  const patch = deriveFeatureBlockedPatch({ blocked_user_task_key: "ut-9" }, null);
  assertEquals(patch, { blocked_user_task_key: null });
});

// The pre-observation self-healing window (record-feature has persisted `awaiting_operator` but the
// user task is not yet visible, so the pointer is still NULL): a premature "not parked" pass must NOT
// write anything — the pointer is filled in on the next pass once the task is observable.
test("deriveFeatureBlockedPatch: the pre-observation self-healing window yields no patch", () => {
  const patch = deriveFeatureBlockedPatch({ blocked_user_task_key: null }, null);
  assertEquals(patch, null);
});

test("pollFeatureBlocked: a parked awaiting_operator run is denormalised with the completable key", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#1", status: "awaiting_operator", process_key: "100", blocked_user_task_key: null },
  ];
  const engine = fakeEngine({ "100": [{ userTaskKey: "ut-1", elementId: "feature-blocked" }] });

  await pollFeatureBlocked(data, engine);

  // The poller never flips status — record-feature owns `awaiting_operator`, record-blocked-ack the terminal.
  assertEquals(stores.feature_runs[0].status, "awaiting_operator");
  assertEquals(stores.feature_runs[0].blocked_user_task_key, "ut-1");
});

test("pollFeatureBlocked: an observed run whose task is gone (out-of-band completion) clears the pointer", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#2", status: "awaiting_operator", process_key: "200", blocked_user_task_key: "ut-2" },
  ];
  const engine = fakeEngine({ "200": [] });

  await pollFeatureBlocked(data, engine);

  assertEquals(stores.feature_runs[0].blocked_user_task_key, null);
});

test("pollFeatureBlocked: only touches awaiting_operator runs, and never one without a process_key", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#3", status: "blocked", process_key: "300", blocked_user_task_key: null },
    { feature_key: "o/r#4", status: "awaiting_operator", process_key: null, blocked_user_task_key: null },
  ];
  const engine = fakeEngine({ "300": [{ userTaskKey: "ut-3", elementId: "feature-blocked" }] });

  await pollFeatureBlocked(data, engine);

  // blocked is terminal → not a candidate; awaiting_operator with no process_key → skipped.
  assertEquals(stores.feature_runs[0].blocked_user_task_key, null);
  assertEquals(stores.feature_runs[1].blocked_user_task_key, null);
});

test("pollFeatureBlocked: a parked non-blocked task (feature-escalation) does not record a pointer", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#5", status: "awaiting_operator", process_key: "500", blocked_user_task_key: null },
  ];
  const engine = fakeEngine({ "500": [{ userTaskKey: "ut-5", elementId: "feature-escalation" }] });

  await pollFeatureBlocked(data, engine);

  assertEquals(stores.feature_runs[0].blocked_user_task_key, null);
});
