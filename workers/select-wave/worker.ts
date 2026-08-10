// pr.select-wave — pick the tasks to run in the current wave (issue #20).
//
// The plan-fanout wave loop calls this before each parallel `implement` fan-out. It loads
// `plan_tasks` for the plan, keeps the still-`pending` tasks whose `wave` equals the process's
// `currentWave`, and emits them as `waveTasks: [{ id, title, prompt }]` — the multi-instance
// input collection.
//
// A task is only runnable when EVERY dependency it declared has an `opened` PR. If any
// dependency ended `blocked` / `skipped` (or is otherwise not opened), the dependent can't be
// built: this worker marks it `skipped` (recording which deps were unmet) and excludes it from
// the wave, so the failure cascades forward instead of dispatching an agent that can't succeed.
// A dependency in `waiting-for-lane` is different: its PR is good but parked behind a merge lane,
// so the dependent stays `pending` and simply waits for a later wave retry.
//
// Emitting an empty `waveTasks` is fine: the MI activity over an empty collection completes
// immediately (the same 0-task path the flat fan-out already relied on).
import type { AppJobHandler } from "@nanobpm/urban";
import { planTaskDeps, planTasks } from "../../app/plan.ts";

interface In extends Record<string, unknown> {
  planKey: string;
  currentWave: number;
}
interface WaveTaskOut {
  id: string;
  title: string;
  prompt: string;
}
interface Out extends Record<string, unknown> {
  waveTasks: WaveTaskOut[];
}

// Coerce a wave index to a non-negative integer, falling back to 0. A NaN currentWave would make
// the `(r.wave ?? 0) !== currentWave` filter always true, silently emitting an empty wave.
const toWave = (v: unknown): number => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const planKey = job.variables.planKey;
  const currentWave = toWave(job.variables.currentWave);
  const ts = new Date().toISOString();

  const taskTable = planTasks(app.data);
  const rows = await taskTable.find({ plan_key: planKey });
  const statusById = new Map<string, string>();
  for (const r of rows) statusById.set(r.task_id, r.status);

  const deps = await planTaskDeps(app.data).find({ plan_key: planKey });
  const depsByTask = new Map<string, string[]>();
  for (const d of deps) {
    const list = depsByTask.get(d.task_id) ?? [];
    list.push(d.depends_on_task_id);
    depsByTask.set(d.task_id, list);
  }

  const waveTasks: WaveTaskOut[] = [];
  for (const r of rows) {
    if ((r.wave ?? 0) !== currentWave) continue;
    // Only fresh tasks are dispatchable; a retry of this wave must not re-run resolved ones.
    if (r.status !== "pending") continue;

    const depIds = depsByTask.get(r.task_id) ?? [];
    const unmet = depIds.filter((d) => {
      const status = statusById.get(d);
      return status !== "opened" && status !== "waiting-for-lane";
    });
    if (unmet.length > 0) {
      await taskTable.update(r.id, {
        status: "skipped",
        summary: `dependency not opened: ${unmet.join(", ")}`,
        updated_at: ts,
      });
      continue;
    }
    if (depIds.some((d) => statusById.get(d) === "waiting-for-lane")) continue;
    waveTasks.push({ id: r.task_id, title: r.title ?? r.task_id, prompt: r.prompt ?? "" });
  }

  return { waveTasks };
};

export default handler;
