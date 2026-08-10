// pr.record-plan — persists the plan the `senior:plan` agent emitted, LEVELIZES the task
// DAG into ordered waves (issue #20), and hands the process the first wave to run.
//
// The planner emits `{ tasks: [{ id?, title?, prompt, dependsOn? }] }`. This worker:
//   • assigns each task a stable `id` (planner slug, else `t<index>`) and an index,
//   • computes each task's `wave` from its `dependsOn` DAG (app/waves.ts): independent
//     tasks share a wave, a dependent task lands 1 + max(dep wave),
//   • writes one `plan_tasks` row per task (status `pending`, with its `wave`) and one
//     `plan_task_deps` row per dependency edge (idempotent: cleared + rewritten per plan),
//   • records the task count, moves the plan to `dispatched`, and emits `currentWave = 0`
//     plus `waveCount` so the wave loop (`select-wave → implement → record-wave`) can run.
//
// If the planner emits a malformed DAG (cycle / unknown or self dependency / duplicate id),
// levelization can't order the tasks. Rather than dead-lock the plan we DEGRADE to the old
// flat behaviour — a single wave (wave 0) of all tasks, run fully in parallel — and log a
// warning; the ordering is lost but every task still runs. No `plan_task_deps` are recorded
// in that case (the edges were invalid).
import type { AppJobHandler } from "@nanobpm/urban";
import { planTaskDeps, planTasks } from "../../app/plan.ts";
import { computeWaves, WaveError, type WaveTask } from "../../app/waves.ts";

interface RawTask {
  id?: unknown;
  title?: unknown;
  prompt?: unknown;
  dependsOn?: unknown;
}
interface In extends Record<string, unknown> {
  planKey: string;
  tasks?: RawTask[];
  note?: string;
}
interface NormalTask {
  id: string;
  title: string;
  prompt: string;
  dependsOn: string[];
}
interface Out extends Record<string, unknown> {
  currentWave: number;
  waveCount: number;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => str(x).trim()).filter((s) => s !== "") : [];

const handler: AppJobHandler<In, Out> = async (job, app) => {
  const { planKey, note } = job.variables;
  const raw = Array.isArray(job.variables.tasks) ? job.variables.tasks : [];
  const ts = new Date().toISOString();

  const tasks: NormalTask[] = raw.map((t, i) => {
    const id = str(t?.id).trim() || `t${i + 1}`;
    return {
      id,
      title: str(t?.title).trim() || id,
      prompt: str(t?.prompt),
      // Dedupe: a planner-emitted `["a","a"]` would otherwise violate the
      // `plan_task_deps` PK on the second edge insert and fail the job.
      dependsOn: [...new Set(strList(t?.dependsOn))],
    };
  });

  // Levelize the DAG. A malformed graph degrades to a single all-parallel wave (see header).
  const forLevel: WaveTask[] = tasks.map((t) => ({ id: t.id, dependsOn: t.dependsOn }));
  let waveOf = new Map<string, number>();
  let waveCount = tasks.length > 0 ? 1 : 0;
  let depsValid = true;
  try {
    const levelled = computeWaves(forLevel);
    waveOf = levelled.waveOf;
    waveCount = levelled.waveCount;
  } catch (err) {
    if (!(err instanceof WaveError)) throw err;
    depsValid = false;
    // The DAG is unusable (cycle / self / unknown dep, or a DUPLICATE task id). Rewrite every
    // task to a guaranteed-unique positional id and drop deps: the wave loop's task_id-keyed
    // maps (select-wave / record-wave) would otherwise collide on duplicate ids and silently
    // lose updates, leaving some rows stuck `pending`. Ordering is lost; all tasks run flat.
    tasks.forEach((t, i) => {
      t.id = `t${i + 1}`;
    });
    waveOf = new Map();
    for (const t of tasks) waveOf.set(t.id, 0);
    app.log("warn", `record-plan: ${planKey} plan not levelizable, running flat`, {
      err: err.message,
    });
  }

  // Idempotency: a retry (or re-run) of this job must not duplicate rows for the same plan.
  const taskTable = planTasks(app.data);
  const existing = await taskTable.find({ plan_key: planKey });
  for (const row of existing) await taskTable.delete(row.id);
  // `plan_task_deps` is keyed on `plan_key`, so one delete clears the plan's whole edge set.
  const depTable = planTaskDeps(app.data);
  await depTable.delete(planKey);

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    await taskTable.insert({
      plan_key: planKey,
      task_index: i,
      task_id: t.id,
      title: t.title,
      prompt: t.prompt,
      status: "pending",
      wave: waveOf.get(t.id) ?? 0,
      created_at: ts,
      updated_at: ts,
    });
    if (depsValid) {
      for (const dep of t.dependsOn) {
        await depTable.insert({
          plan_key: planKey,
          task_id: t.id,
          depends_on_task_id: dep,
        });
      }
    }
  }

  const patch: Record<string, unknown> = {
    status: tasks.length > 0 ? "dispatched" : "done",
    task_count: tasks.length,
    updated_at: ts,
  };
  if (tasks.length === 0) patch.outcome = note ? str(note) : "planner emitted no tasks";
  await app.data.table("plans", "plan_key").update(planKey, patch);

  // Kick off the wave loop at wave 0.
  return { currentWave: 0, waveCount };
};

export default handler;
