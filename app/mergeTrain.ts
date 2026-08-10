// nano-workforce — D6 merge-side lane serialization (issue #49).
//
// The D2 merge-exclusion graph groups tasks into landing lanes: tasks in the same lane can
// implement concurrently but must merge serially. This pure planner chooses exactly one PR per
// non-singleton lane to proceed now. Order is dependency depth first (a task that depends on another
// lands later), then task id for stable tie-breaking; tasks with no PR key are ignored because there
// is nothing to land.

export interface LanePlan {
  headTaskId: string | null;
  headPrKey: string | null;
  heldTaskIds: string[];
  heldPrKeys: string[];
}

export interface PrLaneDecision {
  isHeld: boolean;
  laneHeadOf: string | null;
  laneHeadTaskId: string | null;
  laneTaskIds: string[];
}

export interface TaskDependencyEdge {
  task_id: string;
  depends_on_task_id: string;
}

/** Compute the same dependency depth used for lane order: roots at 0, dependants at
 * `1 + max(dep depth)`. Cycles should already be rejected by plan review; if stale data contains
 * one, break the recursive back-edge rather than wedging the poller. */
export function taskDependencyDepths(edges: readonly TaskDependencyEdge[]): Map<string, number> {
  const depsByTask = new Map<string, string[]>();
  const ids = new Set<string>();
  for (const e of edges) {
    ids.add(e.task_id);
    ids.add(e.depends_on_task_id);
    const deps = depsByTask.get(e.task_id) ?? [];
    deps.push(e.depends_on_task_id);
    depsByTask.set(e.task_id, deps);
  }
  const depthOf = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (taskId: string): number => {
    const cached = depthOf.get(taskId);
    if (cached !== undefined) return cached;
    if (visiting.has(taskId)) return 0;
    visiting.add(taskId);
    let d = 0;
    for (const dep of depsByTask.get(taskId) ?? []) d = Math.max(d, depth(dep) + 1);
    visiting.delete(taskId);
    depthOf.set(taskId, d);
    return d;
  };
  for (const id of ids) depth(id);
  return depthOf;
}

const depthOf = (taskDepth: ReadonlyMap<string, number> | undefined, taskId: string) =>
  taskDepth?.get(taskId) ?? 0;

function compareTaskOrder(
  a: string,
  b: string,
  taskDepth?: ReadonlyMap<string, number>,
): number {
  const da = depthOf(taskDepth, a);
  const db = depthOf(taskDepth, b);
  if (da !== db) return da - db;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Plan one serial landing lane. Singleton lanes never hold their sole PR; lanes with no unmerged
 * PR-backed members have no head. */
export function planLane(
  laneTaskIds: readonly string[],
  taskToPr: ReadonlyMap<string, string>,
  mergedPrKeys: ReadonlySet<string>,
  taskDepth?: ReadonlyMap<string, number>,
): LanePlan {
  if (laneTaskIds.length <= 1) {
    return { headTaskId: null, headPrKey: null, heldTaskIds: [], heldPrKeys: [] };
  }
  const candidates = laneTaskIds
    .filter((taskId) => {
      const prKey = taskToPr.get(taskId);
      return prKey && !mergedPrKeys.has(prKey);
    })
    .sort((a, b) => compareTaskOrder(a, b, taskDepth));
  const headTaskId = candidates[0] ?? null;
  const headPrKey = headTaskId ? taskToPr.get(headTaskId) ?? null : null;
  const heldTaskIds = candidates.slice(1);
  const heldPrKeys = heldTaskIds.map((taskId) => taskToPr.get(taskId)).filter((p): p is string => !!p);
  return { headTaskId, headPrKey, heldTaskIds, heldPrKeys };
}

/** Decide whether a PR is currently held by its merge-exclusion lane. PRs outside a non-singleton
 * exclusion lane are backward-compatible: they are never held. */
export function planPrLane(
  lanes: readonly (readonly string[])[],
  taskToPr: ReadonlyMap<string, string>,
  mergedPrKeys: ReadonlySet<string>,
  prKey: string,
  taskDepth?: ReadonlyMap<string, number>,
): PrLaneDecision {
  for (const lane of lanes) {
    if (lane.length <= 1) continue;
    if (!lane.some((taskId) => taskToPr.get(taskId) === prKey)) continue;
    const plan = planLane(lane, taskToPr, mergedPrKeys, taskDepth);
    return {
      isHeld: plan.heldPrKeys.includes(prKey),
      laneHeadOf: plan.headPrKey,
      laneHeadTaskId: plan.headTaskId,
      laneTaskIds: [...lane],
    };
  }
  return { isHeld: false, laneHeadOf: null, laneHeadTaskId: null, laneTaskIds: [] };
}
