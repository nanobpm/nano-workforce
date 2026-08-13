// Red/green for the no-work terminal guard (issue #86).
//
// `record-results` is the epic's finalizer. Before this guard it always marked the plan `done` and
// completed the process GREEN — even when ZERO PRs were opened (empty plan, or every task
// blocked/skipped). A no-op run was indistinguishable from success (instance 21). It now raises a
// non-retryable `NO_WORK_DISPATCHED` BpmnError (→ incident) when the epic finalizes with no opened
// PR, recording a `failed` terminal status + outcome first, so "accomplished nothing" surfaces
// instead of masquerading as a completed epic.
import { test } from "node:test";
import { assertEquals, assertRejects } from "#test-assert";
import { BpmnError } from "@nanobpm/urban";
import { noopLog } from "../../test/log.ts";
import handler from "./worker.ts";
import type { PlanTaskStatus } from "../../app/plan.ts";

interface Row {
  id: number;
  plan_key: string;
  task_id: string;
  status: PlanTaskStatus;
}

function fakeApp(rows: Row[], plan: Record<string, unknown> = {}) {
  const plans: Record<string, unknown>[] = [];
  return {
    data: {
      table(name: string, key: string) {
        if (name === "plans") {
          return {
            get: (_k: any) => Promise.resolve(plan),
            update: (k: any, patch: any) => {
              plans.push({ [key]: k, ...patch });
              return Promise.resolve(patch);
            },
          };
        }
        // plan_tasks
        return {
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
    log: noopLog(),
    _plans: plans,
  } as any;
}

const call = async (app: unknown, planKey = "o/r#1") =>
  await handler({ variables: { planKey } } as any, app as any);

test("no opened PRs (empty plan) hard-fails with NO_WORK_DISPATCHED", async () => {
  const app = fakeApp([]);
  const err = await assertRejects(() => call(app), BpmnError);
  assertEquals((err as BpmnError).errorCode, "NO_WORK_DISPATCHED");
  // The failure outcome + terminal `failed` status must be recorded before throwing, so the DB
  // state matches the parked incident and startPlan can re-plan it.
  const plan = app._plans.at(-1) as Record<string, unknown>;
  assertEquals(plan.status, "failed");
  assertEquals(plan.outcome, "no work dispatched — the planner produced no tasks");
});

test("failed finalization clears promote_ready (no stale readiness on non-done)", async () => {
  // A non-`done` status must never carry a stale readiness signal: even if a prior writer set
  // promote_ready = 1, the no-work failure path must clear it to 0 (#160).
  const app = fakeApp([], { base_branch: "epic/x", promotion_pr_url: null, promote_ready: 1 });
  await assertRejects(() => call(app), BpmnError);
  const plan = app._plans.at(-1) as Record<string, unknown>;
  assertEquals(plan.status, "failed");
  assertEquals(plan.promote_ready, 0);
});

test("tasks present but none opened (all skipped/blocked) hard-fails", async () => {
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

test("at least one opened PR finalizes cleanly (no throw)", async () => {
  const app = fakeApp([
    { id: 1, plan_key: "o/r#1", task_id: "a", status: "opened" },
    { id: 2, plan_key: "o/r#1", task_id: "b", status: "skipped" },
  ]);
  await call(app);
  const plan = app._plans.at(-1) as Record<string, unknown>;
  assertEquals(plan.status, "done");
  assertEquals(plan.outcome, "1 PR(s) dispatched to convergence");
});

// promote_ready read-model derivation (026_plan_promotion_pr_url.sql, #160): the finalizer is the
// ONE canonical writer of the signal. It is 1 exactly when the plan reaches `done` with a pinned
// integration `base_branch` and no promotion PR yet — gated on the three stored fields only.
const opened = (): Row[] => [{ id: 1, plan_key: "o/r#1", task_id: "a", status: "opened" }];

test("done + base_branch set + no promotion_pr_url → promote_ready = 1", async () => {
  const app = fakeApp(opened(), { base_branch: "epic/x", promotion_pr_url: null });
  await call(app);
  const plan = app._plans.at(-1) as Record<string, unknown>;
  assertEquals(plan.status, "done");
  assertEquals(plan.promote_ready, 1);
});

test("done but base_branch null → promote_ready = 0", async () => {
  const app = fakeApp(opened(), { base_branch: null, promotion_pr_url: null });
  await call(app);
  const plan = app._plans.at(-1) as Record<string, unknown>;
  assertEquals(plan.status, "done");
  assertEquals(plan.promote_ready, 0);
});

test("done but promotion_pr_url already set → promote_ready = 0", async () => {
  const app = fakeApp(opened(), { base_branch: "epic/x", promotion_pr_url: "o/r#99" });
  await call(app);
  const plan = app._plans.at(-1) as Record<string, unknown>;
  assertEquals(plan.status, "done");
  assertEquals(plan.promote_ready, 0);
});
