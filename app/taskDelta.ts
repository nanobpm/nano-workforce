// nano-workforce — structured scope/impl-change report from implementers (D5, issue #55 / #49).
//
// The implementer result contract (prompts/feature.md) can carry an optional `delta`: a machine-
// readable record of how a slice's implementation diverged from its brief — a changed contract, a
// discovered constraint, files it now touches beyond its slice, or other tasks it affects. Before
// this, that information lived only in PR prose: invisible to the planner, to sibling agents, and
// to any later merge-planning (D6). Here we parse it, persist one row per (plan, task), aggregate
// a plan into a single epic-level report, and (in record-wave) auto-broadcast the file/constraint
// facts onto the D4 coordination blackboard.
//
// Data access goes through the record gateway (`data.table`), never hand-written SQL — matching
// app/plan.ts and app/blackboard.ts.
import type { DataLayer } from "@nanobpm/urban";

const now = () => new Date().toISOString();

/** The stored row shape. `newly_touches`/`affects_tasks` are JSON-encoded string arrays or NULL. */
export interface TaskDeltaRow {
	id: number;
	plan_key: string;
	task_id: string;
	wave: number | null;
	contract_change: string | null;
	newly_touches: string | null;
	affects_tasks: string | null;
	constraint_note: string | null;
	created_at: string;
	updated_at: string;
}

/** The parsed, structured delta an implementer reports (all fields optional). */
export interface TaskDelta {
	contractChange?: string;
	newlyTouches: string[];
	affectsTasks: string[];
	constraint?: string;
}

/** The agent-facing view of a persisted delta (arrays decoded, keyed to its task). */
export interface TaskDeltaEntry extends TaskDelta {
	taskId: string;
	wave: number | null;
	updatedAt: string;
}

function trimStr(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function strArray(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	const seen = new Set<string>();
	for (const raw of v) {
		const s = typeof raw === "string" ? raw.trim() : "";
		if (s !== "") seen.add(s);
	}
	return [...seen];
}

function decodeArray(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.map(String) : [];
	} catch {
		return [];
	}
}

/** Coerce an arbitrary result-`delta` payload into a {@link TaskDelta}, or `null` when it carries
 * nothing actionable (so callers persist/broadcast only real deltas, never empty noise). */
export function parseTaskDelta(raw: unknown): TaskDelta | null {
	if (!raw || typeof raw !== "object") return null;
	// biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
	const o = raw as Record<string, unknown>;
	const delta: TaskDelta = {
		contractChange: trimStr(o.contractChange),
		newlyTouches: strArray(o.newlyTouches),
		affectsTasks: strArray(o.affectsTasks),
		constraint: trimStr(o.constraint),
	};
	const empty =
		!delta.contractChange &&
		!delta.constraint &&
		delta.newlyTouches.length === 0 &&
		delta.affectsTasks.length === 0;
	return empty ? null : delta;
}

const deltaTable = (data: DataLayer) =>
	data.table<TaskDeltaRow>("plan_task_deltas", "id");

function toEntry(r: TaskDeltaRow): TaskDeltaEntry {
	return {
		taskId: r.task_id,
		wave: r.wave,
		contractChange: r.contract_change ?? undefined,
		newlyTouches: decodeArray(r.newly_touches),
		affectsTasks: decodeArray(r.affects_tasks),
		constraint: r.constraint_note ?? undefined,
		updatedAt: r.updated_at,
	};
}

/** Upsert the delta for one (plan, task). A worker retry or a post-escalation resume overwrites the
 * prior report in place (idempotent), rather than appending a duplicate. */
export async function recordTaskDelta(
	data: DataLayer,
	planKey: string,
	taskId: string,
	delta: TaskDelta,
	opts: { wave?: number | null } = {},
): Promise<{ inserted: boolean; id: number | bigint }> {
	const table = deltaTable(data);
	const ts = now();
	const fields = {
		wave: opts.wave ?? null,
		contract_change: delta.contractChange ?? null,
		newly_touches: delta.newlyTouches.length
			? JSON.stringify(delta.newlyTouches)
			: null,
		affects_tasks: delta.affectsTasks.length
			? JSON.stringify(delta.affectsTasks)
			: null,
		constraint_note: delta.constraint ?? null,
		updated_at: ts,
	};
	const existing = await table.findOne({ plan_key: planKey, task_id: taskId });
	if (existing) {
		await table.update(existing.id, fields);
		return { inserted: false, id: existing.id };
	}
	const id = await table.insert({
		plan_key: planKey,
		task_id: taskId,
		created_at: ts,
		...fields,
	});
	return { inserted: true, id };
}

/** A plan's per-task deltas in write order. */
export async function readTaskDeltas(
	data: DataLayer,
	planKey: string,
): Promise<TaskDeltaEntry[]> {
	const rows = await deltaTable(data).find({ plan_key: planKey });
	return rows
		.slice()
		.sort((a, b) => a.id - b.id)
		.map(toEntry);
}

/** Delete a plan's whole delta set (called on re-plan, alongside the other plan-scoped tables). */
export async function clearTaskDeltas(
	data: DataLayer,
	planKey: string,
): Promise<void> {
	for (const r of await deltaTable(data).find({ plan_key: planKey })) {
		await deltaTable(data).delete(r.id);
	}
}

/** The single epic-level report: every per-task delta plus cross-task rollups (the union of
 * newly-touched files and affected tasks, and the list of contract changes / constraints). The
 * rollups are what a coordinator (D10) and merge-planning (D6) read; `touchedFiles`/`affectedTasks`
 * are the seed for D2's conflict graph. */
export interface EpicDeltaReport {
	deltas: TaskDeltaEntry[];
	touchedFiles: string[];
	affectedTasks: string[];
	contractChanges: { taskId: string; change: string }[];
	constraints: { taskId: string; constraint: string }[];
}

export async function aggregateEpicDeltas(
	data: DataLayer,
	planKey: string,
): Promise<EpicDeltaReport> {
	const deltas = await readTaskDeltas(data, planKey);
	const files = new Set<string>();
	const affected = new Set<string>();
	const contractChanges: { taskId: string; change: string }[] = [];
	const constraints: { taskId: string; constraint: string }[] = [];
	for (const d of deltas) {
		for (const f of d.newlyTouches) files.add(f);
		for (const t of d.affectsTasks) affected.add(t);
		if (d.contractChange)
			contractChanges.push({ taskId: d.taskId, change: d.contractChange });
		if (d.constraint)
			constraints.push({ taskId: d.taskId, constraint: d.constraint });
	}
	return {
		deltas,
		touchedFiles: [...files].sort(),
		affectedTasks: [...affected].sort(),
		contractChanges,
		constraints,
	};
}
