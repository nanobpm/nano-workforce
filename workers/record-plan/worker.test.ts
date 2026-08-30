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
  const out = await handler(
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
  // taskCount drives the plan-fanout gateway (`gw-plan-empty`): non-zero ⇒ proceed to review (#623).
  assertEquals((out as any).taskCount, 2);
  // Wave progress (wave_count/current_wave/wave_label) was retired as a stored projection (epic
  // #412) — it is derived from `plan_tasks` by the plan_wave_label/plan_read_model VIEWs — so
  // record-plan no longer writes it onto the plans row.
  assertEquals(plans[0].wave_count, undefined);
  assertEquals(plans[0].current_wave, undefined);
  assertEquals(plans[0].wave_label, undefined);
});

test("record-plan keeps a taskless plan NON-terminal (planning) with an outcome note (issue #624)", async () => {
  const { app, plans } = fakeApp();
  const out = await handler(
    { variables: { planKey: "owner/repo#137", tasks: [], note: "planner emitted no tasks" } } as any,
    app,
  );
  // A taskless plan is INTERMEDIATE, not terminal: the plan-fanout instance is still live (may
  // re-plan / escalate / be cancelled). Terminal `done` follows engine liveness (reconciled by the
  // poller), never this empty-plan heuristic, so the status stays non-terminal here (issue #624).
  assertEquals(plans[0].status, "planning");
  assertEquals(plans[0].task_count, 0);
  // `taskCount` still drives the plan-fanout gateway (`gw-plan-empty`): zero routes to the operator
  // empty-plan escalation instead of the adversarial plan-review loop (issues #623/#624).
  assertEquals((out as any).taskCount, 0);
  assertEquals(plans[0].outcome, "planner emitted no tasks");
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
