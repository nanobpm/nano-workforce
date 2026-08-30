// Coverage for `pollTasklessPlanTermination` (issue #624) — the poll pass that owns a TASKLESS plan's
// COMPLETED → `done` transition from ENGINE truth, so terminal `plans.status` follows engine instance
// liveness instead of the retired "record-plan with task_count = 0 ⇒ done" heuristic (which rendered
// the epic "Done" over a still-active, in fact looping, plan-fanout instance).
//
// Booted against the real provisioned SQLite data layer (so the `plans` table exists) with a stubbed
// `searchProcessInstances`, proving: a taskless plan whose instance is STILL ACTIVE stays non-terminal
// (the core acceptance guarantee); it flips to `done` only once the instance reads COMPLETED; a
// TASKFUL plan is never touched (its `record-results` finalizer owns `done`); a plan with no engine
// instance is skipped; and an already-`done` plan is left alone.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import { bootTestApp } from "@nanobpm/urban-testkit";
import { plans } from "./plan.ts";
import { pollTasklessPlanTermination } from "./service.ts";
import { withTrackingViews } from "../test/trackingViews.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");

async function withData(fn: (data: DataLayer) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-taskless-term-"));
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dir, "app.db")}` } });
  try {
    await fn(app.db);
  } finally {
    await app.stop?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

const now = () => new Date().toISOString();

async function seedPlan(
  data: DataLayer,
  over: { status?: string; process_key?: string | null; task_count?: number; outcome?: string | null } = {},
) {
  await plans(data).insert({
    plan_key: "owner/repo#7",
    repo: "owner/repo",
    issue_number: 7,
    issue_url: "https://github.com/owner/repo/issues/7",
    title: "Epic",
    status: over.status ?? "planning",
    task_count: over.task_count ?? 0,
    outcome: "outcome" in over ? over.outcome : "planner emitted no tasks",
    process_key: "process_key" in over ? over.process_key : "pi-1",
    created_at: now(),
    updated_at: now(),
  } as never);
}

test("pollTasklessPlanTermination leaves a taskless plan NON-terminal while its instance is ACTIVE", async () => {
  await withData(async (data) => {
    await seedPlan(data, { status: "planning", task_count: 0 });
    const engine = { searchProcessInstances: async () => [{ processInstanceKey: "pi-1", state: "ACTIVE" }] };
    await pollTasklessPlanTermination(data, engine as never);
    // The core acceptance guarantee: a task_count = 0 plan is not terminal while its instance runs.
    assertEquals((await plans(data).get("owner/repo#7"))?.status, "planning");
  });
});

test("pollTasklessPlanTermination flips a taskless plan to done once its instance reads COMPLETED", async () => {
  await withData(async (data) => {
    await seedPlan(data, { status: "planning", task_count: 0 });
    const engine = { searchProcessInstances: async () => [{ processInstanceKey: "pi-1", state: "COMPLETED" }] };
    await pollTasklessPlanTermination(data, engine as never);
    const row = await plans(data).get("owner/repo#7");
    assertEquals(row?.status, "done");
    assertEquals(row?.outcome, "planner emitted no tasks");
  });
});

test("pollTasklessPlanTermination matches a numeric engine processInstanceKey against the string process_key", async () => {
  await withData(async (data) => {
    await seedPlan(data, { status: "planning", task_count: 0, process_key: "12345" });
    const engine = { searchProcessInstances: async () => [{ processInstanceKey: 12345, state: "COMPLETED" }] };
    await pollTasklessPlanTermination(data, engine as never);
    assertEquals((await plans(data).get("owner/repo#7"))?.status, "done");
  });
});

test("pollTasklessPlanTermination never touches a TASKFUL plan (record-results owns its done)", async () => {
  await withData(async (data) => {
    await seedPlan(data, { status: "dispatched", task_count: 3, outcome: null });
    let called = false;
    const engine = {
      searchProcessInstances: async () => {
        called = true;
        return [{ processInstanceKey: "pi-1", state: "COMPLETED" }];
      },
    };
    await pollTasklessPlanTermination(data, engine as never);
    assertEquals(called, false);
    assertEquals((await plans(data).get("owner/repo#7"))?.status, "dispatched");
  });
});

test("pollTasklessPlanTermination skips a taskless plan that has no engine instance yet", async () => {
  await withData(async (data) => {
    await seedPlan(data, { status: "planning", task_count: 0, process_key: null });
    let called = false;
    const engine = {
      searchProcessInstances: async () => {
        called = true;
        return [];
      },
    };
    await pollTasklessPlanTermination(data, engine as never);
    assertEquals(called, false);
    assertEquals((await plans(data).get("owner/repo#7"))?.status, "planning");
  });
});

test("pollTasklessPlanTermination never re-touches an already-terminal plan", async () => {
  await withData(async (data) => {
    await seedPlan(data, { status: "done", task_count: 0 });
    let called = false;
    const engine = {
      searchProcessInstances: async () => {
        called = true;
        return [];
      },
    };
    await pollTasklessPlanTermination(data, engine as never);
    // `done` is not in EPIC_LIVE_STATUSES, so the pass never queries the engine for it.
    assertEquals(called, false);
  });
});

// A taskless plan whose instance TERMINATED out of band keeps its base `status = planning` (the
// worker-owned transient the reconciler no longer overwrites) while the ADR-0065 tracking VIEW folds
// its `derived_status` to `abandoned`. A base-`status` scan would keep re-querying the engine for that
// already-dead row every pass forever; the pass MUST read `derived_status` off `plansTracking` and skip
// it. Modelled with the `withTrackingViews` fake so the base `status` and derived `derived_status`
// diverge exactly as the real terminated instance produces, without a live engine.
// biome-ignore lint/suspicious/noExplicitAny: test-only fake over dynamic row shapes.
function trackedMemData(): DataLayer {
  // biome-ignore lint/suspicious/noExplicitAny: test-only dynamic row store.
  const store: any[] = [];
  const tbl = (_name: string, pk = "plan_key") => ({
    // biome-ignore lint/suspicious/noExplicitAny: test-only dynamic row.
    async insert(row: any) {
      store.push({ ...row });
      return row[pk];
    },
    async get(key: unknown) {
      return store.find((r) => r[pk] === key);
    },
    async find(where: Record<string, unknown>) {
      return store.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
    },
    // biome-ignore lint/suspicious/noExplicitAny: test-only patch.
    async update(key: unknown, patch: any) {
      const r = store.find((x) => x[pk] === key);
      if (r) Object.assign(r, patch);
    },
  });
  // biome-ignore lint/suspicious/noExplicitAny: test-only fake DataLayer.
  return { table: withTrackingViews((n: string, pk?: string) => tbl(n, pk)) } as any as DataLayer;
}

test("pollTasklessPlanTermination skips a derive-only-terminal (TERMINATED) taskless plan without querying the engine", async () => {
  const data = trackedMemData();
  // Base `status` still reads live `planning` (frozen transient), but the instance terminated out of
  // band so the tracking VIEW's `derived_status` is `abandoned`.
  await plans(data).insert({
    plan_key: "owner/repo#7",
    status: "planning",
    derived_status: "abandoned",
    task_count: 0,
    process_key: "pi-1",
  } as never);
  let called = false;
  const engine = {
    searchProcessInstances: async () => {
      called = true;
      return [{ processInstanceKey: "pi-1", state: "COMPLETED" }];
    },
  };
  await pollTasklessPlanTermination(data, engine as never);
  // The regression guard: a base-status scan would re-query the engine here forever.
  assertEquals(called, false);
  assertEquals((await plans(data).get("owner/repo#7"))?.status, "planning");
});
