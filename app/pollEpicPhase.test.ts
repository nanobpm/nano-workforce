// Coverage for `pollEpicPhase` (S8, #542 / ADR 0006 §4b) — the poll pass that reconciles the epic's
// `plans.epic_phase` from the LIVE engine element-instance model, the pure read-model derivation that
// RETIRED the write-time stamp the spine workers used to write. Booted against the real provisioned
// SQLite data layer (so the `plans` table and the `plan_wave_progress` wave-frontier VIEW exist) with
// a stubbed `searchElementInstances`, proving: a live plan's phase advances to the furthest active
// spine element; the wave label rides the wave-progress rollup; a steady-state pass is a no-op; and a
// terminal (non-live) plan is never touched.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import { bootTestApp } from "@nanobpm/urban-testkit";
import { EPIC_PHASE } from "./epicPhase.ts";
import { plans, planTasks } from "./plan.ts";
import { pollEpicPhase } from "./service.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");

async function withData(fn: (data: DataLayer) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-epicphase-"));
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
  over: {
    status?: string;
    process_key?: string | null;
    epic_phase?: string | null;
    task_count?: number;
  } = {},
) {
  await plans(data).insert({
    plan_key: "owner/repo#7",
    repo: "owner/repo",
    issue_number: 7,
    issue_url: "https://github.com/owner/repo/issues/7",
    title: "Epic",
    status: over.status ?? "dispatched",
    task_count: over.task_count ?? 0,
    epic_phase: over.epic_phase ?? EPIC_PHASE.PLANNING,
    process_key: "process_key" in over ? over.process_key : "pi-1",
    created_at: now(),
    updated_at: now(),
  } as never);
}

test("pollEpicPhase advances a live epic's phase to the furthest ACTIVE spine element", async () => {
  await withData(async (data) => {
    await seedPlan(data, { epic_phase: EPIC_PHASE.PLANNING });
    // The plan is recorded (COMPLETED) and the review-plan agent is running → Reviewing.
    const engine = {
      searchElementInstances: async () => [
        { elementInstanceKey: "e1", processInstanceKey: "pi-1", elementId: "record-plan", state: "COMPLETED" },
        { elementInstanceKey: "e2", processInstanceKey: "pi-1", elementId: "review-plan", state: "ACTIVE" },
      ],
    };
    await pollEpicPhase(data, engine as never);
    assertEquals((await plans(data).get("owner/repo#7"))?.epic_phase, EPIC_PHASE.REVIEWING);
  });
});

test("pollEpicPhase wave-labels a live Implementing token from the plan_wave_progress rollup", async () => {
  await withData(async (data) => {
    await seedPlan(data, { epic_phase: EPIC_PHASE.REVIEWING });
    // Two levelized waves (0,1); wave 0 is settled (skipped → not in-flight) and wave 1 is still in
    // flight, so the frontier is wave 1 → current_wave 1, wave_count 2 → "Implementing (wave 2/2)".
    await planTasks(data).insert({ id: 1, plan_key: "owner/repo#7", task_index: 0, task_id: "a", status: "skipped", wave: 0, created_at: now(), updated_at: now() } as never);
    await planTasks(data).insert({ id: 2, plan_key: "owner/repo#7", task_index: 1, task_id: "b", status: "pending", wave: 1, created_at: now(), updated_at: now() } as never);
    const engine = {
      searchElementInstances: async () => [
        { elementInstanceKey: "e3", processInstanceKey: "pi-1", elementId: "implement-task", state: "ACTIVE" },
      ],
    };
    await pollEpicPhase(data, engine as never);
    assertEquals((await plans(data).get("owner/repo#7"))?.epic_phase, "Implementing (wave 2/2)");
  });
});

test("pollEpicPhase is a no-op when the derived phase is unchanged, and leaves the phase when nothing marks one", async () => {
  await withData(async (data) => {
    await seedPlan(data, { epic_phase: EPIC_PHASE.REVIEWING });
    // Only non-spine plumbing is active → derivation returns null → the last phase is untouched.
    const engine = {
      searchElementInstances: async () => [
        { elementInstanceKey: "e4", processInstanceKey: "pi-1", elementId: "some-gateway", state: "ACTIVE" },
      ],
    };
    await pollEpicPhase(data, engine as never);
    assertEquals((await plans(data).get("owner/repo#7"))?.epic_phase, EPIC_PHASE.REVIEWING);
  });
});

test("pollEpicPhase never touches a terminal (non-live) epic", async () => {
  await withData(async (data) => {
    await seedPlan(data, { status: "done", epic_phase: EPIC_PHASE.DISPATCHED });
    let called = false;
    const engine = {
      searchElementInstances: async () => {
        called = true;
        return [];
      },
    };
    await pollEpicPhase(data, engine as never);
    assertEquals(called, false);
    assertEquals((await plans(data).get("owner/repo#7"))?.epic_phase, EPIC_PHASE.DISPATCHED);
  });
});

test("pollEpicPhase freezes a done epic that dispatched a fleet at the terminal Dispatched phase", async () => {
  await withData(async (data) => {
    await seedPlan(data, { status: "done", task_count: 2, epic_phase: EPIC_PHASE.TRIAL_MERGING });
    let called = false;
    const engine = {
      searchElementInstances: async () => {
        called = true;
        return [];
      },
    };
    await pollEpicPhase(data, engine as never);
    // Derived from the terminal status, not the (skipped) live element search.
    assertEquals(called, false);
    assertEquals((await plans(data).get("owner/repo#7"))?.epic_phase, EPIC_PHASE.DISPATCHED);
  });
});

test("pollEpicPhase never labels a taskless done epic Dispatched", async () => {
  await withData(async (data) => {
    // A done epic that dispatched nothing (planner emitted no tasks) must NOT read Dispatched.
    await seedPlan(data, { status: "done", task_count: 0, epic_phase: EPIC_PHASE.PLANNING });
    await pollEpicPhase(data, { searchElementInstances: async () => [] } as never);
    assertEquals((await plans(data).get("owner/repo#7"))?.epic_phase, EPIC_PHASE.PLANNING);
  });
});

test("pollEpicPhase skips a live epic that has no engine instance yet", async () => {
  await withData(async (data) => {
    await seedPlan(data, { status: "planning", process_key: null, epic_phase: EPIC_PHASE.PLANNING });
    let called = false;
    const engine = {
      searchElementInstances: async () => {
        called = true;
        return [];
      },
    };
    await pollEpicPhase(data, engine as never);
    assertEquals(called, false);
  });
});

/** Stub `globalThis.fetch` so `pollEpicPhase`'s callActivity hierarchy walk (issue #633) reads its
 *  descendant instances from `childrenByParent` (keyed on the queried `parentProcessInstanceKey`), and
 *  404s any other path so a stray call is loud. Returns a restore fn. */
function stubProcessInstanceSearch(childrenByParent: Record<string, string[]>): () => void {
  const orig = globalThis.fetch;
  // biome-ignore lint/suspicious/noExplicitAny: minimal fetch double for the raw-REST search surface
  globalThis.fetch = (async (url: string | URL, init?: any) => {
    const u = String(url);
    if (!u.endsWith("/process-instances/search")) return new Response("not found", { status: 404 });
    const body = JSON.parse(init?.body ?? "{}");
    const parent: string = body?.filter?.parentProcessInstanceKey ?? "";
    const items = (childrenByParent[parent] ?? []).map((k) => ({ processInstanceKey: k }));
    return new Response(JSON.stringify({ items }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

test("pollEpicPhase derives from an element INSIDE a callActivity CHILD cell via parent/root traversal (issue #633)", async () => {
  // ADR 0006 S4 (#603/#633): once a wave/slice runs as a callActivity CHILD cell, the furthest-reached
  // live token can sit INSIDE that child instance ("child-pi"), not on the parent plan-fanout spine
  // ("pi-1"). The parent instance shows only a settled (COMPLETED) `record-plan`, so a parent-ONLY read
  // would leave the phase at PLANNING; walking the hierarchy (parent → child) surfaces the child's ACTIVE
  // `review-plan`, advancing the phase to Reviewing. The pure `deriveEpicPhaseLive` is unchanged — only
  // its INPUT is widened to the whole instance hierarchy.
  await withData(async (data) => {
    await seedPlan(data, { epic_phase: EPIC_PHASE.PLANNING });
    const engine = {
      searchElementInstances: async ({ processInstanceKey }: { processInstanceKey: string }) =>
        processInstanceKey === "child-pi"
          ? [{ elementInstanceKey: "c1", processInstanceKey: "child-pi", elementId: "review-plan", state: "ACTIVE" }]
          : [{ elementInstanceKey: "e1", processInstanceKey: "pi-1", elementId: "record-plan", state: "COMPLETED" }],
    };
    const restore = stubProcessInstanceSearch({ "pi-1": ["child-pi"], "child-pi": [] });
    try {
      await pollEpicPhase(data, engine as never, { restAddress: "http://engine.test/v2" });
    } finally {
      restore();
    }
    assertEquals((await plans(data).get("owner/repo#7"))?.epic_phase, EPIC_PHASE.REVIEWING);
  });
});

test("pollEpicPhase without a raw-REST surface reads the parent instance ALONE (no traversal, pre-#633 behaviour)", async () => {
  // The typed seam cannot enumerate children, so with no `engineRest` the walk degrades to the parent
  // plan-fanout instance only — a child-cell token is invisible and the phase stays at PLANNING. This
  // pins the two-arg (no-REST) call the unit path and degraded hosts use.
  await withData(async (data) => {
    await seedPlan(data, { epic_phase: EPIC_PHASE.PLANNING });
    const engine = {
      searchElementInstances: async ({ processInstanceKey }: { processInstanceKey: string }) =>
        processInstanceKey === "child-pi"
          ? [{ elementInstanceKey: "c1", processInstanceKey: "child-pi", elementId: "review-plan", state: "ACTIVE" }]
          : [{ elementInstanceKey: "e1", processInstanceKey: "pi-1", elementId: "record-plan", state: "COMPLETED" }],
    };
    await pollEpicPhase(data, engine as never);
    assertEquals((await plans(data).get("owner/repo#7"))?.epic_phase, EPIC_PHASE.PLANNING);
  });
});
