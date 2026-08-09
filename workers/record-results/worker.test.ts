// Red/green for the no-work terminal guard (issue #86).
//
// `record-results` is the epic's finalizer. Before this guard it always marked the plan `done` and
// completed the process GREEN — even when ZERO PRs were opened (empty plan, or every task
// blocked/skipped). A no-op run was indistinguishable from success (instance 21). It now raises a
// non-retryable `NO_WORK_DISPATCHED` BpmnError (→ incident) when the epic finalizes with no opened
// PR, recording a `failed` terminal status + outcome first, so "accomplished nothing" surfaces
// instead of masquerading as a completed epic.
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { BpmnError } from "@nanobpm/urban";
import handler from "./worker.ts";
import type { PlanTaskStatus } from "../../app/plan.ts";

interface Row {
  id: number;
  plan_key: string;
  task_id: string;
  status: PlanTaskStatus;
}

function fakeApp(rows: Row[]) {
  const plans: Record<string, unknown>[] = [];
  return {
    data: {
      table(name: string, key: string) {
        if (name === "plans") {
          return {
            // deno-lint-ignore no-explicit-any
            update: (k: any, patch: any) => {
              plans.push({ [key]: k, ...patch });
              return Promise.resolve(patch);
            },
          };
        }
        // plan_tasks
        return {
          // deno-lint-ignore no-explicit-any
          find: (q: any) =>
            Promise.resolve(
              rows.filter((r) =>
                Object.entries(q).every(([f, v]) =>
                  (r as unknown as Record<string, unknown>)[f] === v
                )
              ),
            ),
        };
      },
    },
    log: () => {},
    _plans: plans,
    // deno-lint-ignore no-explicit-any
  } as any;
}

const call = async (app: unknown, planKey = "o/r#1") =>
  // deno-lint-ignore no-explicit-any
  await handler({ variables: { planKey } } as any, app as any);

Deno.test("no opened PRs (empty plan) hard-fails with NO_WORK_DISPATCHED", async () => {
  const app = fakeApp([]);
  const err = await assertRejects(() => call(app), BpmnError);
  assertEquals((err as BpmnError).errorCode, "NO_WORK_DISPATCHED");
  // The failure outcome + terminal `failed` status must be recorded before throwing, so the DB
  // state matches the parked incident and startPlan can re-plan it.
  const plan = app._plans.at(-1) as Record<string, unknown>;
  assertEquals(plan.status, "failed");
  assertEquals(plan.outcome, "no work dispatched — the planner produced no tasks");
});

Deno.test("tasks present but none opened (all skipped/blocked) hard-fails", async () => {
  const app = fakeApp([
    { id: 1, plan_key: "o/r#1", task_id: "a", status: "skipped" },
    { id: 2, plan_key: "o/r#1", task_id: "b", status: "blocked" },
  ]);
  const err = await assertRejects(() => call(app), BpmnError);
  assertEquals((err as BpmnError).errorCode, "NO_WORK_DISPATCHED");
  const plan = app._plans.at(-1) as Record<string, unknown>;
  assertEquals(plan.status, "failed");
  assertEquals(plan.outcome, "no work dispatched — every task was blocked or skipped");
});

Deno.test("at least one opened PR finalizes cleanly (no throw)", async () => {
  const app = fakeApp([
    { id: 1, plan_key: "o/r#1", task_id: "a", status: "opened" },
    { id: 2, plan_key: "o/r#1", task_id: "b", status: "skipped" },
  ]);
  await call(app);
  const plan = app._plans.at(-1) as Record<string, unknown>;
  assertEquals(plan.status, "done");
  assertEquals(plan.outcome, "1 PR(s) dispatched to convergence");
});
