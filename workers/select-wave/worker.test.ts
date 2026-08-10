// Red/green regression for `waiting-for-lane` in the wave dependency cascade (D7 / issue #63).
//
// A predecessor parked behind a merge lane is not a failed slice: dependents must remain pending
// so a later retry can dispatch them once the lane clears. Real non-open failures still cascade
// to `skipped` as before.
import { assertEquals } from "jsr:@std/assert@1";
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

function fakeApp(rows: Row[], deps: DepRow[]) {
  return {
    data: {
      table(name: string, key: string) {
        const store = name === "plan_tasks" ? rows : deps;
        return {
          // deno-lint-ignore no-explicit-any
          find: (q: any) =>
            Promise.resolve(
              store.filter((r) =>
                Object.entries(q).every(([f, v]) =>
                  ((r as unknown) as Record<string, unknown>)[f] === v
                )
              ),
            ),
          // deno-lint-ignore no-explicit-any
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
    // deno-lint-ignore no-explicit-any
  } as any;
}

async function selectWave(rows: Row[], deps: DepRow[]) {
  const out = await handler(
    // deno-lint-ignore no-explicit-any
    { variables: { planKey: "owner/repo#63", currentWave: 1 } } as any,
    fakeApp(rows, deps),
  );
  return out as { waveTasks: unknown[] };
}

Deno.test("select-wave leaves dependents pending behind a waiting-for-lane dependency", async () => {
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

Deno.test("select-wave still skips dependents behind failed or otherwise non-open dependencies", async (t) => {
  for (const depStatus of ["blocked", "skipped", "pending"] as const) {
    await t.step(depStatus, async () => {
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
