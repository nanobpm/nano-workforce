// Unit tests for the merge-exclusion graph + conflict-scan (D1/D2, issues #57 #58 / #49).
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { DataLayer } from "@nanobpm/urban";
import {
  clearExclusions,
  deriveExclusions,
  type ExclusionEdge,
  mergeLanes,
  normalizePair,
  readExclusions,
  recordExclusions,
} from "./mergeExclusion.ts";
import { computeWaves } from "./waves.ts";

// In-memory record-gateway fake (insert/find/findOne/update/delete), mirroring the app tests.
// deno-lint-ignore no-explicit-any
function memData(): { data: DataLayer; stores: Record<string, any[]> } {
  // deno-lint-ignore no-explicit-any
  const stores: Record<string, any[]> = {};
  const seq: Record<string, number> = {};
  function tbl(name: string, pk = "id") {
    // deno-lint-ignore no-explicit-any
    const rows = (stores[name] ??= [] as any[]);
    // deno-lint-ignore no-explicit-any
    const match = (r: any, where: any) => Object.entries(where).every(([k, v]) => r[k] === v);
    return {
      // deno-lint-ignore no-explicit-any require-await
      async insert(row: any) {
        const id = (seq[name] = (seq[name] ?? 0) + 1);
        rows.push({ id, ...row });
        return id;
      },
      // deno-lint-ignore no-explicit-any require-await
      async find(where: any = {}) {
        return rows.filter((r) => match(r, where));
      },
      // deno-lint-ignore no-explicit-any require-await
      async findOne(where: any = {}) {
        return rows.find((r) => match(r, where));
      },
      // deno-lint-ignore no-explicit-any require-await
      async update(id: any, patch: any) {
        const r = rows.find((row) => row.id === id);
        if (r) Object.assign(r, patch);
      },
      // deno-lint-ignore no-explicit-any require-await
      async delete(id: any) {
        const i = rows.findIndex((row) => row.id === id);
        if (i >= 0) rows.splice(i, 1);
      },
    };
  }
  // deno-lint-ignore no-explicit-any
  const data = { table: (n: string, pk?: string) => tbl(n, pk) } as any as DataLayer;
  return { data, stores };
}

const files = (e: ExclusionEdge) => e.files;

Deno.test("normalizePair: orders deterministically and rejects self/blank pairs", () => {
  assertEquals(normalizePair("b", "a"), ["a", "b"]);
  assertEquals(normalizePair("a", "b"), ["a", "b"]);
  assertEquals(normalizePair("a", "a"), null, "a task never excludes itself");
  assertEquals(normalizePair("", "a"), null);
});

Deno.test("deriveExclusions: an edge per file-overlapping pair, carrying the sorted overlap", () => {
  const edges = deriveExclusions(
    new Map([
      ["gap-2", ["engine/tests.rs", "engine/state.rs"]],
      ["gap-8", ["engine/tests.rs"]],
      ["gap-9", ["engine/tests.rs", "engine/state.rs"]],
      ["gap-5", ["docs/readme.md"]], // no overlap with anyone
    ]),
  );
  // Pairs with overlap: (gap-2,gap-8) share tests.rs; (gap-2,gap-9) share both; (gap-8,gap-9) tests.rs.
  assertEquals(edges.map((e) => [e.taskA, e.taskB]), [
    ["gap-2", "gap-8"],
    ["gap-2", "gap-9"],
    ["gap-8", "gap-9"],
  ]);
  assertEquals(files(edges[1]), ["engine/state.rs", "engine/tests.rs"], "overlap sorted");
  assert(!edges.some((e) => e.taskA === "gap-5" || e.taskB === "gap-5"), "gap-5 excluded (no overlap)");
});

Deno.test("deriveExclusions: no overlap → no edges; blank paths ignored", () => {
  assertEquals(
    deriveExclusions(new Map([["a", ["x.rs"]], ["b", ["y.rs"]], ["c", ["", "  "]]])),
    [],
  );
});

Deno.test("recordExclusions: upserts per unordered pair — a re-scan refreshes files, never duplicates", async () => {
  const { data, stores } = memData();
  const first = await recordExclusions(data, "p", deriveExclusions(
    new Map([["gap-2", ["a.rs"]], ["gap-8", ["a.rs"]]]),
  ));
  assertEquals(first, { inserted: 1, updated: 0 });

  // Re-scan with a larger overlap and the pair given in the OTHER order → same row, updated.
  const second = await recordExclusions(data, "p", [
    { taskA: "gap-8", taskB: "gap-2", files: ["a.rs", "b.rs"], source: "file-overlap" },
  ]);
  assertEquals(second, { inserted: 0, updated: 1 });
  assertEquals(stores["plan_merge_exclusions"].length, 1, "exactly one row for the pair");

  const [edge] = await readExclusions(data, "p");
  assertEquals([edge.taskA, edge.taskB], ["gap-2", "gap-8"]);
  assertEquals(edge.files, ["a.rs", "b.rs"], "files refreshed in place");
});

Deno.test("recordExclusions: a duplicate pair within one batch folds into an update, never a second row", async () => {
  const { data, stores } = memData();
  // The same unordered pair appears twice in one call (second given in the other order + more files).
  // The in-memory map must fold the newly inserted id back so the second occurrence updates in place.
  const res = await recordExclusions(data, "p", [
    { taskA: "a", taskB: "b", files: ["x.rs"], source: "file-overlap" },
    { taskA: "b", taskB: "a", files: ["x.rs", "y.rs"], source: "file-overlap" },
  ]);
  assertEquals(res, { inserted: 1, updated: 1 });
  assertEquals(stores["plan_merge_exclusions"].length, 1, "exactly one row for the pair");
  const [edge] = await readExclusions(data, "p");
  assertEquals(edge.files, ["x.rs", "y.rs"], "later occurrence refreshed files in place");
});

Deno.test("clearExclusions: drops one plan's graph, leaving others intact", async () => {
  const { data } = memData();
  await recordExclusions(data, "p", deriveExclusions(new Map([["a", ["x"]], ["b", ["x"]]])));
  await recordExclusions(data, "q", deriveExclusions(new Map([["c", ["y"]], ["d", ["y"]]])));
  await clearExclusions(data, "p");
  assertEquals((await readExclusions(data, "p")).length, 0);
  assertEquals((await readExclusions(data, "q")).length, 1, "the other plan survives");
});

Deno.test("mergeLanes: connected components are serial landing lanes; singletons land in parallel", () => {
  // gap-2—gap-8—gap-9 form one chain (transitive shared surface); gap-5 stands alone.
  const edges = deriveExclusions(
    new Map([
      ["gap-2", ["a.rs"]],
      ["gap-8", ["a.rs", "b.rs"]],
      ["gap-9", ["b.rs"]],
      ["gap-5", ["z.rs"]],
    ]),
  );
  const lanes = mergeLanes(edges, ["gap-2", "gap-8", "gap-9", "gap-5"]);
  assertEquals(lanes, [["gap-2", "gap-8", "gap-9"], ["gap-5"]]);
});

Deno.test("mergeLanes: with no edges, every task is its own lane (fully parallel landing)", () => {
  assertEquals(mergeLanes([], ["b", "a", "c"]), [["a"], ["b"], ["c"]]);
});

Deno.test("D1 invariant: a merge-exclusion is NOT a dispatch dependency", () => {
  // Two tasks that collide on a shared file but declare no build-on dependency.
  const overlap = new Map([["gap-2", ["engine/tests.rs"]], ["gap-8", ["engine/tests.rs"]]]);
  const edges = deriveExclusions(overlap);
  const lanes = mergeLanes(edges, ["gap-2", "gap-8"]);

  // Landing: they share ONE lane → must land serially.
  assertEquals(lanes, [["gap-2", "gap-8"]]);

  // Dispatch: computeWaves sees only `dependsOn` (never the exclusion graph), so with no build-on
  // edge both tasks are in wave 0 → dispatched in PARALLEL. This is the whole point of D1: the
  // exclusion never over-encodes into a dispatch barrier.
  const waves = computeWaves([{ id: "gap-2" }, { id: "gap-8" }]);
  assertEquals(waves.waveCount, 1);
  assertEquals(waves.waves[0].sort(), ["gap-2", "gap-8"]);
});
