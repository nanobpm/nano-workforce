// nano-workforce — the merge-exclusion graph + conflict-scan (D1/D2, issues #57 #58 / #49).
//
// The planner already models the DISPATCH-DAG (`plan_task_deps` → waves): edges that gate when a
// task may *start*. This is the SECOND graph the retro (nano-bpm#614) exposed: **merge-exclusion**
// — undirected edges between tasks that can run in parallel but touch the same surface and so can't
// *land* independently. They gate ordering at merge time only and MUST NEVER enter `computeWaves`.
//
//   D1 (#57) — the graph as data: record/read/clear, and `mergeLanes` (connected components =
//              the serial landing lanes the merge-train, D6, will drive).
//   D2 (#58) — derive the edges MECHANICALLY from file-overlap (`deriveExclusions`): any two tasks
//              whose known touched-file sets intersect get an edge carrying the overlap. Fed from
//              D5's reported `newlyTouches` and/or a PR's actual changed files. This is a
//              conservative over-approximation (file-overlap flags a *potential* landing collision;
//              a textual `git merge-tree` / trial-merge, D3, would confirm/prune it later).
//
// Data access goes through the record gateway (`data.table`), never hand-written SQL.
import type { DataLayer } from "@nanobpm/urban";

const now = () => new Date().toISOString();

/** The default provenance tag for a file-overlap-derived edge. */
export const EXCLUSION_SOURCE_FILE_OVERLAP = "file-overlap";

/** The stored row shape. `task_a < task_b` (normalised); `files` is JSON-encoded, or NULL. */
export interface MergeExclusionRow {
	id: number;
	plan_key: string;
	task_a: string;
	task_b: string;
	files: string | null;
	source: string;
	created_at: string;
	updated_at: string;
}

/** One undirected merge-exclusion edge (agent-facing: files decoded, pair normalised). */
export interface ExclusionEdge {
	taskA: string;
	taskB: string;
	files: string[];
	source: string;
}

/** Order a pair deterministically so an unordered `{a, b}` maps to exactly one `(task_a, task_b)`
 * row (the upsert key). Returns `null` for a self-pair — a task never excludes itself. */
export function normalizePair(a: string, b: string): [string, string] | null {
	const x = a.trim();
	const y = b.trim();
	if (!x || !y || x === y) return null;
	return x < y ? [x, y] : [y, x];
}

function decodeFiles(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.map(String) : [];
	} catch {
		return [];
	}
}

/** Derive merge-exclusion edges from a map of `taskId → touched files`: an edge for every pair of
 * distinct tasks whose file sets intersect, carrying the sorted overlap. Pure and deterministic —
 * the same input always yields the same edges in the same order. */
export function deriveExclusions(
	taskFiles: Map<string, Iterable<string>>,
	source: string = EXCLUSION_SOURCE_FILE_OVERLAP,
): ExclusionEdge[] {
	// Normalise to sorted, de-duplicated, non-blank file sets keyed by task, in stable task order.
	const sets: { task: string; files: Set<string> }[] = [];
	for (const [task, files] of taskFiles) {
		const t = task.trim();
		if (!t) continue;
		const set = new Set<string>();
		for (const f of files) {
			const p = String(f).trim();
			if (p) set.add(p);
		}
		if (set.size > 0) sets.push({ task: t, files: set });
	}
	sets.sort((a, b) => (a.task < b.task ? -1 : a.task > b.task ? 1 : 0));

	const edges: ExclusionEdge[] = [];
	for (let i = 0; i < sets.length; i++) {
		for (let j = i + 1; j < sets.length; j++) {
			const overlap: string[] = [];
			for (const f of sets[i].files) if (sets[j].files.has(f)) overlap.push(f);
			if (overlap.length === 0) continue;
			const pair = normalizePair(sets[i].task, sets[j].task);
			if (!pair) continue;
			edges.push({
				taskA: pair[0],
				taskB: pair[1],
				files: overlap.sort(),
				source,
			});
		}
	}
	return edges;
}

const exclusionTable = (data: DataLayer) =>
	data.table<MergeExclusionRow>("plan_merge_exclusions", "id");

/** Upsert derived edges for a plan: one row per unordered pair, `files` refreshed in place on a
 * re-scan. Idempotent — re-running the scan never duplicates a pair. Existing pairs are preloaded
 * with a single `find({plan_key})` into an in-memory map (keyed by the normalised pair) so a dense
 * wave costs O(edges) writes instead of an `await findOne(...)` round-trip per edge (worst-case
 * O(n²) queries). Newly inserted ids are folded back into the map so a duplicate pair in the same
 * batch updates rather than inserts twice. */
export async function recordExclusions(
	data: DataLayer,
	planKey: string,
	edges: ExclusionEdge[],
): Promise<{ inserted: number; updated: number }> {
	const table = exclusionTable(data);
	const ts = now();
	let inserted = 0;
	let updated = 0;
	const key = (a: string, b: string) => `${a}\u0000${b}`;
	const byPair = new Map<string, number>();
	for (const r of await table.find({ plan_key: planKey })) {
		byPair.set(key(r.task_a, r.task_b), r.id);
	}
	for (const e of edges) {
		const pair = normalizePair(e.taskA, e.taskB);
		if (!pair) continue;
		const files = e.files.length ? JSON.stringify(e.files) : null;
		const existingId = byPair.get(key(pair[0], pair[1]));
		if (existingId !== undefined) {
			await table.update(existingId, {
				files,
				source: e.source,
				updated_at: ts,
			});
			updated++;
		} else {
			const id = await table.insert({
				plan_key: planKey,
				task_a: pair[0],
				task_b: pair[1],
				files,
				source: e.source,
				created_at: ts,
				updated_at: ts,
			});
			byPair.set(key(pair[0], pair[1]), Number(id));
			inserted++;
		}
	}
	return { inserted, updated };
}

/** A plan's exclusion graph in write order (files decoded). */
export async function readExclusions(
	data: DataLayer,
	planKey: string,
): Promise<ExclusionEdge[]> {
	const rows = await exclusionTable(data).find({ plan_key: planKey });
	return rows
		.slice()
		.sort((a, b) => a.id - b.id)
		.map((r) => ({
			taskA: r.task_a,
			taskB: r.task_b,
			files: decodeFiles(r.files),
			source: r.source,
		}));
}

/** Delete a plan's whole exclusion graph (re-plan cleanup). */
export async function clearExclusions(
	data: DataLayer,
	planKey: string,
): Promise<void> {
	for (const r of await exclusionTable(data).find({ plan_key: planKey })) {
		await exclusionTable(data).delete(r.id);
	}
}

/** Group tasks into serial LANDING LANES: each connected component of the exclusion graph is a
 * lane whose members must land one-at-a-time (they collide on a shared surface), while separate
 * lanes land in parallel. `allTasks` (optional) seeds singleton lanes for tasks with no exclusion
 * so a caller gets the full partition. Lanes and their members are sorted for determinism.
 *
 * This is the merge-train's (D6) input; it is a LANDING order, never a dispatch order — these
 * lanes must not be fed back into `computeWaves`. */
export function mergeLanes(
	edges: ExclusionEdge[],
	allTasks: Iterable<string> = [],
): string[][] {
	const parent = new Map<string, string>();
	const find = (x: string): string => {
		let root = x;
		let nextRoot = parent.get(root);
		while (nextRoot !== undefined && nextRoot !== root) {
			root = nextRoot;
			nextRoot = parent.get(root);
		}
		// Path-compress so repeated finds stay near-flat.
		let cur = x;
		while (parent.get(cur) !== root) {
			const next = parent.get(cur);
			if (next === undefined) break;
			parent.set(cur, root);
			cur = next;
		}
		return root;
	};
	const add = (x: string) => {
		if (!parent.has(x)) parent.set(x, x);
	};
	const union = (a: string, b: string) => {
		add(a);
		add(b);
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
	};

	for (const t of allTasks) add(t.trim());
	for (const e of edges) {
		const pair = normalizePair(e.taskA, e.taskB);
		if (pair) union(pair[0], pair[1]);
	}

	const byRoot = new Map<string, string[]>();
	for (const task of parent.keys()) {
		if (!task) continue;
		const root = find(task);
		const lane = byRoot.get(root) ?? [];
		lane.push(task);
		byRoot.set(root, lane);
	}
	return [...byRoot.values()]
		.map((lane) => lane.sort())
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
