// nano-workforce — plan levelizer (issue #20).
//
// The planner may emit tasks with an optional `dependsOn: [taskId, ...]` DAG.
// This module turns that DAG into ordered **waves**: `wave(t) = 0` if the task has
// no dependencies, else `1 + max(wave(dep))` (the longest-path level). The
// `plan-fanout` process then runs its parallel multi-instance `implement` activity
// once per wave, in order — so independent tasks in the same wave run in parallel,
// while a dependent task waits for the wave containing all its dependencies.
//
// Pure and side-effect free: it does no I/O and is the red/green regression target
// (app/waves.test.ts). The workers (record-plan) call it to assign `plan_tasks.wave`.

/** A task as seen by the levelizer: a stable id and its (optional) dependency ids. */
export interface WaveTask {
  id: string;
  dependsOn?: readonly string[];
}

export interface WaveResult {
  /** 0-based wave index per task id (longest-path level). */
  waveOf: Map<string, number>;
  /** Task ids grouped by wave, in wave order; input order preserved within a wave. */
  waves: string[][];
  /** Number of waves (0 for an empty plan). */
  waveCount: number;
}

/** Thrown when the task graph is not a valid DAG (self-loop, cycle, dangling dep, or
 *  a duplicate task id) — the plan cannot be levelized and must be rejected. */
export class WaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WaveError";
  }
}

/**
 * Levelize a task DAG into ordered waves. Throws {@link WaveError} on a duplicate
 * task id, an unknown dependency id, a self-dependency, or a dependency cycle.
 */
export function computeWaves(tasks: readonly WaveTask[]): WaveResult {
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) throw new WaveError(`duplicate task id "${t.id}"`);
    ids.add(t.id);
  }

  const depsOf = new Map<string, string[]>();
  for (const t of tasks) {
    const deps: string[] = [];
    for (const raw of t.dependsOn ?? []) {
      const d = raw.trim();
      if (d === "") continue;
      if (d === t.id) throw new WaveError(`task "${t.id}" depends on itself`);
      if (!ids.has(d)) throw new WaveError(`task "${t.id}" depends on unknown task "${d}"`);
      deps.push(d);
    }
    depsOf.set(t.id, deps);
  }

  const waveOf = new Map<string, number>();
  const visiting = new Set<string>();
  const level = (id: string): number => {
    const cached = waveOf.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) throw new WaveError(`dependency cycle detected at task "${id}"`);
    visiting.add(id);
    let lvl = 0;
    for (const dep of depsOf.get(id) ?? []) lvl = Math.max(lvl, level(dep) + 1);
    visiting.delete(id);
    waveOf.set(id, lvl);
    return lvl;
  };
  for (const t of tasks) level(t.id);

  let waveCount = 0;
  for (const lvl of waveOf.values()) waveCount = Math.max(waveCount, lvl + 1);

  const waves: string[][] = [];
  for (let i = 0; i < waveCount; i++) waves.push([]);
  for (const t of tasks) {
    const w = waveOf.get(t.id) ?? 0;
    waves[w].push(t.id);
  }

  return { waveOf, waves, waveCount };
}

/** A `plan_tasks` row as seen by the wave-merge barrier: its levelized wave, its dispatch
 * status, and the PR it produced (if any). Structurally a subset of `PlanTask` (app/plan.ts). */
export interface WaveGateTask {
  wave: number | null;
  status: string;
  pr_key: string | null;
}

/** The PR keys that must MERGE for `gateWave` to clear the wave-merge barrier: the PRs opened by
 * that wave's tasks. `opened` tasks and `waiting-for-lane` tasks with PR keys produced a PR to
 * wait on — `blocked`/`skipped` tasks can never merge and must not wedge the barrier, and keyless
 * tasks are treated as having nothing to wait on.
 *
 * Pure and side-effect free (like {@link computeWaves}) so the poller's gate decision is a
 * red/green regression target: the poller releases the next wave iff every key returned here has
 * merged. An empty result means the wave clears vacuously (nothing to merge). */
export function waveMergeTargets(
  tasks: readonly WaveGateTask[],
  gateWave: number,
): string[] {
  const keys: string[] = [];
  for (const t of tasks) {
    if (t.wave !== gateWave) continue;
    if ((t.status !== "opened" && t.status !== "waiting-for-lane") || !t.pr_key) continue;
    keys.push(t.pr_key);
  }
  return keys;
}
