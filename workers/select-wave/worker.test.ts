// Red/green regression for `waiting-for-lane` in the wave dependency cascade (D7 / issue #63).
//
// A predecessor parked behind a merge lane is not a failed slice: dependents must remain pending
// so a later retry can dispatch them once the lane clears. Real non-open failures still cascade
// to `skipped` as before.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import handler from "./worker.ts";
import type { PlanTaskStatus } from "../../app/plan.ts";

interface Row {
  id: number;
  plan_key: string;
  task_id: string;
  title?: string | null;
  prompt?: string | null;
  status: PlanTaskStatus;
  wave?: number | null;
  summary?: string | null;
}

interface DepRow {
  plan_key: string;
  task_id: string;
  depends_on_task_id: string;
}

function fakeApp(rows: Row[], deps: DepRow[], plans: Record<string, unknown>[] = [], needs: Record<string, unknown>[] = []) {
  return {
    log: { error() {}, info() {}, warn() {} },
    data: {
      table(name: string, key: string) {
        const store = name === "plan_tasks"
          ? rows
          : name === "plans"
          ? plans
          : name === "plan_task_needs"
          ? needs
          : deps;
        return {
          find: (q: any) =>
            Promise.resolve(
              store.filter((r) =>
                Object.entries(q).every(([f, v]) =>
                  ((r as unknown) as Record<string, unknown>)[f] === v
                )
              ),
            ),
          update: (k: any, patch: any) => {
            const row = store.find((r) =>
              ((r as unknown) as Record<string, unknown>)[key] === k
            );
            if (row) Object.assign(row, patch);
            return Promise.resolve(row);
          },
        };
      },
    },
  } as any;
}

async function selectWave(rows: Row[], deps: DepRow[]) {
  const out = await handler(
    { variables: { planKey: "owner/repo#63", currentWave: 1 } } as any,
    fakeApp(rows, deps),
  );
  return out as { waveTasks: unknown[] };
}

test("select-wave projects the active wave onto plans.current_wave", async () => {
  const rows: Row[] = [
    { id: 1, plan_key: "owner/repo#63", task_id: "a", title: "A", prompt: "do A", status: "pending", wave: 1 },
  ];
  const plans: Record<string, unknown>[] = [{ plan_key: "owner/repo#63", current_wave: 0 }];
  const out = await handler(
    { variables: { planKey: "owner/repo#63", currentWave: 1 }, elementId: "select-wave" } as any,
    fakeApp(rows, [], plans),
  );
  assertEquals((out as { waveTasks: unknown[] }).waveTasks.length, 1);
  assertEquals(plans[0].current_wave, 1);
  // wave_count is derived from the levelized rows (max wave + 1) and the 1-based "X/N" label
  // is pre-formatted for the epics-index at-a-glance column.
  assertEquals(plans[0].wave_count, 2);
  assertEquals(plans[0].wave_label, "2/2");
  // Domain-phase projection (#261): dispatching the wave marks the epic Implementing (wave n/t),
  // derived from this worker's BPMN element id + the levelize records.
  assertEquals(plans[0].epic_phase, "Implementing (wave 2/2)");
});

test("select-wave nulls all three progress fields when there are no levelized rows", async () => {
  // No plan_tasks rows => waveCount 0. current_wave must be NULL too (not a stray index against a
  // NULL wave_count/wave_label), matching the documented "NULL until dispatched with tasks".
  const plans: Record<string, unknown>[] = [{ plan_key: "owner/repo#63", current_wave: 5 }];
  await handler(
    { variables: { planKey: "owner/repo#63", currentWave: 0 } } as any,
    fakeApp([], [], plans),
  );
  assertEquals(plans[0].current_wave, null);
  assertEquals(plans[0].wave_count, null);
  assertEquals(plans[0].wave_label, null);
});

test("select-wave leaves dependents pending behind a waiting-for-lane dependency", async () => {
  const rows: Row[] = [
    {
      id: 1,
      plan_key: "owner/repo#63",
      task_id: "a",
      status: "waiting-for-lane",
      wave: 0,
    },
    {
      id: 2,
      plan_key: "owner/repo#63",
      task_id: "b",
      title: "B",
      prompt: "do B",
      status: "pending",
      wave: 1,
    },
  ];
  const deps: DepRow[] = [{
    plan_key: "owner/repo#63",
    task_id: "b",
    depends_on_task_id: "a",
  }];

  const out = await selectWave(rows, deps);

  assertEquals(out.waveTasks, []);
  assertEquals(rows[1].status, "pending");
  assertEquals(rows[1].summary, undefined);
});

test("select-wave still skips dependents behind failed or otherwise non-open dependencies", async (t) => {
  for (const depStatus of ["blocked", "skipped", "pending"] as const) {
    await t.test(depStatus, async () => {
      const rows: Row[] = [
        {
          id: 1,
          plan_key: "owner/repo#63",
          task_id: "a",
          status: depStatus,
          wave: 0,
        },
        {
          id: 2,
          plan_key: "owner/repo#63",
          task_id: "b",
          status: "pending",
          wave: 1,
        },
      ];
      const deps: DepRow[] = [{
        plan_key: "owner/repo#63",
        task_id: "b",
        depends_on_task_id: "a",
      }];

      const out = await selectWave(rows, deps);

      assertEquals(out.waveTasks, []);
      assertEquals(rows[1].status, "skipped");
      assertEquals(rows[1].summary, "dependency not opened: a");
    });
  }
});

test("select-wave attaches each dispatched task's capability needs, [] when none (issue #289)", async () => {
  const rows: Row[] = [
    { id: 1, plan_key: "owner/repo#63", task_id: "a", title: "A", prompt: "do A", status: "pending", wave: 1 },
    { id: 2, plan_key: "owner/repo#63", task_id: "b", title: "B", prompt: "do B", status: "pending", wave: 1 },
  ];
  const needs: Record<string, unknown>[] = [
    {
      plan_key: "owner/repo#63",
      task_id: "a",
      capability_ref: "nanobpm/nano-ide#274",
      package: "@nanobpm/urban",
      verify_command: "verify.sh",
    },
  ];
  const out = await handler(
    { variables: { planKey: "owner/repo#63", currentWave: 1 } } as any,
    fakeApp(rows, [], [], needs),
  );
  const waveTasks = (out as { waveTasks: any[] }).waveTasks;
  const byId = new Map(waveTasks.map((t) => [t.id, t]));
  assertEquals(byId.get("a").needs, [
    { capabilityRef: "nanobpm/nano-ide#274", package: "@nanobpm/urban", verifyCommand: "verify.sh" },
  ]);
  assertEquals(byId.get("b").needs, []);
});
