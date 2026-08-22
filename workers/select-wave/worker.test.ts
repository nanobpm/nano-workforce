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

test("select-wave dispatches the active wave without writing wave-progress columns", async () => {
  const rows: Row[] = [
    { id: 1, plan_key: "owner/repo#63", task_id: "a", title: "A", prompt: "do A", status: "pending", wave: 1 },
  ];
  const plans: Record<string, unknown>[] = [{ plan_key: "owner/repo#63" }];
  const out = await handler(
    { variables: { planKey: "owner/repo#63", currentWave: 1 }, elementId: "select-wave" } as any,
    fakeApp(rows, [], plans),
  );
  assertEquals((out as { waveTasks: unknown[] }).waveTasks.length, 1);
  // Wave progress (current_wave/wave_count/wave_label) was retired as a stored projection (epic
  // #412; the columns are dropped by migration 070) — it is derived from `plan_tasks` by the
  // plan_wave_label VIEW — so select-wave introduces no wave-progress field onto the plan row.
  assertEquals(plans[0].current_wave, undefined);
  assertEquals(plans[0].wave_count, undefined);
  assertEquals(plans[0].wave_label, undefined);
  // Domain-phase projection (#261): dispatching the wave marks the epic Implementing (wave n/t),
  // derived from this worker's BPMN element id + the levelize records.
  assertEquals(plans[0].epic_phase, "Implementing (wave 2/2)");
});

test("select-wave captures the preflight's resolvedArtifacts onto plans.bound_artifacts (#292 S4)", async () => {
  // A dependent epic reaching select-wave proves its S3 capability preflight went green; the bound
  // pkg@version(s) ride `resolvedArtifacts` and must be captured for the S4 operator projection.
  const rows: Row[] = [
    { id: 1, plan_key: "owner/repo#63", task_id: "a", title: "A", prompt: "do A", status: "pending", wave: 0 },
  ];
  const plans: Record<string, unknown>[] = [{ plan_key: "owner/repo#63" }];
  await handler(
    {
      variables: {
        planKey: "owner/repo#63",
        currentWave: 0,
        // MI output collection: one entry per producer probe; null/empty/whitespace-only entries
        // are filtered out (a probe may publish without a bind).
        resolvedArtifacts: ["@scope/api@1.4.0", null, "", "   ", "@scope/core@2.0.0"],
      },
      elementId: "select-wave",
    } as any,
    fakeApp(rows, [], plans),
  );
  assertEquals(plans[0].bound_artifacts, JSON.stringify(["@scope/api@1.4.0", "@scope/core@2.0.0"]));
});

test("select-wave leaves bound_artifacts untouched for a root epic (no resolvedArtifacts)", async () => {
  // A root fans out with no preflight -> resolvedArtifacts is null; the stamp must not write an
  // empty/garbage bound_artifacts (the S4 projection reads NULL as "no bound version").
  const rows: Row[] = [
    { id: 1, plan_key: "owner/repo#63", task_id: "a", title: "A", prompt: "do A", status: "pending", wave: 0 },
  ];
  const plans: Record<string, unknown>[] = [{ plan_key: "owner/repo#63" }];
  await handler(
    { variables: { planKey: "owner/repo#63", currentWave: 0 }, elementId: "select-wave" } as any,
    fakeApp(rows, [], plans),
  );
  assertEquals(plans[0].bound_artifacts, undefined);
});

test("select-wave writes no wave-progress columns when there are no levelized rows", async () => {
  // Wave progress was retired as a stored projection (epic #412; the columns are dropped by
  // migration 070; it is derived from `plan_tasks` by the plan_wave_label VIEW), so select-wave
  // introduces no wave-progress field onto the plan row.
  const plans: Record<string, unknown>[] = [{ plan_key: "owner/repo#63" }];
  await handler(
    { variables: { planKey: "owner/repo#63", currentWave: 0 } } as any,
    fakeApp([], [], plans),
  );
  assertEquals(plans[0].current_wave, undefined);
  assertEquals(plans[0].wave_count, undefined);
  assertEquals(plans[0].wave_label, undefined);
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
