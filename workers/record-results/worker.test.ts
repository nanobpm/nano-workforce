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
import { deriveEpicBucket } from "../../app/delivery.ts";
import { noopLog } from "../../test/log.ts";
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
          // A full in-memory table double so the real `plans` gateway proxy (which reads back the row
          // to reproject `list_bucket`/`ack_open`) works: get/all/insert/update, update upserting so a
          // worker that updates an as-yet-unseeded plan still lands a row (mirrors production, where
          // startPlan inserted it first).
          return {
            all: () => Promise.resolve(plans.slice()),
            get: (k: any) => Promise.resolve(plans.find((p) => p[key] === k)),
            find: (q: any) =>
              Promise.resolve(plans.filter((p) => Object.entries(q).every(([f, v]) => p[f] === v))),
            insert: (row: any) => {
              plans.push({ ...row });
              return Promise.resolve(row[key]);
            },
            update: (k: any, patch: any) => {
              const existing = plans.find((p) => p[key] === k);
              if (existing) Object.assign(existing, patch);
              else plans.push({ [key]: k, ...patch });
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
  // `list_bucket` is derived by the `plan_read_model` VIEW: under the uniform acknowledge-to-dismiss
  // rule (issue #641) a terminal-but-UNACKNOWLEDGED epic — including a `failed` one — STAYS in Active
  // (offering the operator a Dismiss) until it is acknowledged, rather than vanishing straight to
  // History. Cross-checked against the pure `deriveEpicBucket` oracle the VIEW mirrors.
  assertEquals(deriveEpicBucket(plan.status as string, null, plan.acknowledged_at as string | null), "active");
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
  // A just-`done` epic (delivery not yet converging, unacknowledged) reads as Active through the VIEW —
  // it must not vanish (#298). Cross-checked against the pure `deriveEpicBucket` oracle.
  assertEquals(deriveEpicBucket(plan.status as string, null, plan.acknowledged_at as string | null), "active");
});
