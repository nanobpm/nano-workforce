// Regression coverage for record-plan's operator-visibility wave progress projection (issue #137).
//
// record-plan initializes plans.wave_count/current_wave/wave_label when a plan is dispatched. The
// three fields must stay consistent: a taskful plan gets wave_count N, current_wave 0, "1/N"; a
// taskless plan gets all three NULL (never wave_count 0 against NULL current_wave/wave_label, which
// would leak a misleading value to the epics-index — the documented contract is "NULL until
// dispatched with tasks").
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import handler from "./worker.ts";

interface Row extends Record<string, unknown> {
  id?: number;
  plan_key: string;
}

function fakeApp() {
  const planTasks: Row[] = [];
  const planTaskDeps: Row[] = [];
  const planTaskNeeds: Row[] = [];
  const plans: Row[] = [{ plan_key: "owner/repo#137" }];
  let nextId = 1;
  const app = {
    log: { error() {}, info() {}, warn() {} },
    data: {
      table(name: string, key: string) {
        const store = name === "plan_tasks"
          ? planTasks
          : name === "plan_task_deps"
          ? planTaskDeps
          : name === "plan_task_needs"
          ? planTaskNeeds
          : plans;
        return {
          get: (k: unknown) => Promise.resolve(store.find((r) => r[key] === k)),
          find: (q: Record<string, unknown>) =>
            Promise.resolve(
              store.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v)),
            ),
          insert: (row: Row) => {
            store.push({ ...row, id: row.id ?? nextId++ });
            return Promise.resolve();
          },
          delete: (k: unknown) => {
            for (let i = store.length - 1; i >= 0; i--) {
              if (store[i][key] === k) store.splice(i, 1);
            }
            return Promise.resolve();
          },
          update: (k: unknown, patch: Record<string, unknown>) => {
            const row = store.find((r) => r[key] === k);
            if (row) Object.assign(row, patch);
            return Promise.resolve(row);
          },
        };
      },
    },
  } as any;
  return { app, plans, planTasks, planTaskNeeds };
}

test("record-plan dispatches a taskful plan and levelizes its tasks (wave progress is now VIEW-derived)", async () => {
  const { app, plans } = fakeApp();
  await handler(
    {
      variables: {
        planKey: "owner/repo#137",
        tasks: [
          { id: "a", prompt: "do A" },
          { id: "b", prompt: "do B", dependsOn: ["a"] },
        ],
      },
    } as any,
    app,
  );
  assertEquals(plans[0].status, "dispatched");
  // Wave progress (wave_count/current_wave/wave_label) was retired as a stored projection (epic
  // #412) — it is derived from `plan_tasks` by the plan_wave_label/plan_read_model VIEWs — so
  // record-plan no longer writes it onto the plans row.
  assertEquals(plans[0].wave_count, undefined);
  assertEquals(plans[0].current_wave, undefined);
  assertEquals(plans[0].wave_label, undefined);
});

test("record-plan marks a taskless plan done (no wave-progress columns written)", async () => {
  const { app, plans } = fakeApp();
  await handler(
    { variables: { planKey: "owner/repo#137", tasks: [], note: "planner emitted no tasks" } } as any,
    app,
  );
  assertEquals(plans[0].status, "done");
  assertEquals(plans[0].wave_count, undefined);
  assertEquals(plans[0].current_wave, undefined);
  assertEquals(plans[0].wave_label, undefined);
});

test("record-plan persists per-task capability needs into plan_task_needs (issue #289)", async () => {
  const { app, planTaskNeeds } = fakeApp();
  await handler(
    {
      variables: {
        planKey: "owner/repo#137",
        tasks: [
          {
            id: "a",
            prompt: "do A",
            needs: [
              { capabilityRef: "nanobpm/nano-ide#274", package: "@nanobpm/urban", verifyCommand: "v.sh" },
              { capabilityRef: "  ", package: "dropme" }, // malformed -> dropped by parse
            ],
          },
          { id: "b", prompt: "do B", dependsOn: ["a"] }, // no needs
        ],
      },
    } as any,
    app,
  );
  assertEquals(planTaskNeeds.length, 1);
  assertEquals(planTaskNeeds[0].plan_key, "owner/repo#137");
  assertEquals(planTaskNeeds[0].task_id, "a");
  assertEquals(planTaskNeeds[0].capability_ref, "nanobpm/nano-ide#274");
  assertEquals(planTaskNeeds[0].package, "@nanobpm/urban");
  assertEquals(planTaskNeeds[0].verify_command, "v.sh");
});
