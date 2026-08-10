// Unit tests for the structured scope/impl-change report (D5, issue #55 / #49).
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { DataLayer } from "@nanobpm/urban";
import {
  aggregateEpicDeltas,
  clearTaskDeltas,
  parseTaskDelta,
  readTaskDeltas,
  recordTaskDelta,
} from "./taskDelta.ts";

// A tiny in-memory stand-in for the record gateway (insert/find/findOne/update/delete), mirroring
// the fake-app style used across the app tests (see app/blackboard.test.ts).
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
        rows.push(pk === "id" ? { id, ...row } : { ...row });
        return pk === "id" ? id : row[pk];
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
        const r = rows.find((row) => row[pk] === id);
        if (r) Object.assign(r, patch);
      },
      // deno-lint-ignore no-explicit-any require-await
      async delete(id: any) {
        const i = rows.findIndex((row) => row[pk] === id);
        if (i >= 0) rows.splice(i, 1);
      },
    };
  }
  // deno-lint-ignore no-explicit-any
  const data = { table: (n: string, pk?: string) => tbl(n, pk) } as any as DataLayer;
  return { data, stores };
}

Deno.test("parseTaskDelta: trims, dedupes arrays, and drops empties", () => {
  const d = parseTaskDelta({
    contractChange: "  new signature  ",
    newlyTouches: ["a.rs", " a.rs ", "", "b.rs"],
    affectsTasks: ["gap-8", "gap-8"],
    constraint: "",
  });
  assert(d);
  assertEquals(d.contractChange, "new signature");
  assertEquals(d.newlyTouches, ["a.rs", "b.rs"], "trimmed + de-duplicated");
  assertEquals(d.affectsTasks, ["gap-8"]);
  assertEquals(d.constraint, undefined, "a blank constraint is dropped");
});

Deno.test("parseTaskDelta: a delta with nothing actionable is null", () => {
  assertEquals(parseTaskDelta(undefined), null);
  assertEquals(parseTaskDelta({}), null);
  assertEquals(parseTaskDelta({ newlyTouches: [], affectsTasks: [], contractChange: "  " }), null);
  assertEquals(parseTaskDelta("not an object"), null);
});

Deno.test("recordTaskDelta: upserts per (plan, task) — a resume overwrites, not duplicates", async () => {
  const { data, stores } = memData();
  const first = await recordTaskDelta(data, "o/r#1", "gap-2", {
    newlyTouches: ["a.rs"],
    affectsTasks: [],
    contractChange: "v1",
  }, { wave: 0 });
  assertEquals(first.inserted, true);

  const second = await recordTaskDelta(data, "o/r#1", "gap-2", {
    newlyTouches: ["a.rs", "b.rs"],
    affectsTasks: ["gap-9"],
    constraint: "seeded",
  }, { wave: 1 });
  assertEquals(second.inserted, false, "same (plan, task) → update in place");
  assertEquals(second.id, first.id);
  assertEquals(stores["plan_task_deltas"].length, 1, "exactly one row");

  const [entry] = await readTaskDeltas(data, "o/r#1");
  assertEquals(entry.newlyTouches, ["a.rs", "b.rs"], "latest report wins");
  assertEquals(entry.constraint, "seeded");
  assertEquals(entry.contractChange, undefined, "cleared when the new report omits it");
  assertEquals(entry.wave, 1);
});

Deno.test("readTaskDeltas: scoped to a plan, in write order, arrays decoded", async () => {
  const { data } = memData();
  await recordTaskDelta(data, "o/r#1", "gap-2", { newlyTouches: ["a.rs"], affectsTasks: [] });
  await recordTaskDelta(data, "o/r#1", "gap-8", { newlyTouches: [], affectsTasks: ["gap-2"], constraint: "x" });
  await recordTaskDelta(data, "o/r#2", "gap-1", { newlyTouches: ["z.rs"], affectsTasks: [] }); // other plan

  const entries = await readTaskDeltas(data, "o/r#1");
  assertEquals(entries.map((e) => e.taskId), ["gap-2", "gap-8"], "write order, scoped to plan");
  assertEquals(entries[0].newlyTouches, ["a.rs"]);
  assertEquals(entries[1].affectsTasks, ["gap-2"]);
});

Deno.test("aggregateEpicDeltas: unions touched files + affected tasks, lists changes/constraints", async () => {
  const { data } = memData();
  await recordTaskDelta(data, "p", "gap-2", {
    newlyTouches: ["engine/state.rs"],
    affectsTasks: ["gap-8"],
    contractChange: "restructured complete_adhoc_tool",
  });
  await recordTaskDelta(data, "p", "gap-8", {
    newlyTouches: ["engine/state.rs", "engine/tests.rs"],
    affectsTasks: ["gap-2", "gap-4"],
    constraint: "results:[] seed",
  });

  const report = await aggregateEpicDeltas(data, "p");
  assertEquals(report.touchedFiles, ["engine/state.rs", "engine/tests.rs"], "union, sorted, de-duplicated");
  assertEquals(report.affectedTasks, ["gap-2", "gap-4", "gap-8"]);
  assertEquals(report.contractChanges, [{ taskId: "gap-2", change: "restructured complete_adhoc_tool" }]);
  assertEquals(report.constraints, [{ taskId: "gap-8", constraint: "results:[] seed" }]);
  assertEquals(report.deltas.length, 2);
});

Deno.test("clearTaskDeltas: drops a plan's whole set (re-plan cleanup), leaving other plans intact", async () => {
  const { data, stores } = memData();
  await recordTaskDelta(data, "p", "gap-2", { newlyTouches: ["a.rs"], affectsTasks: [] });
  await recordTaskDelta(data, "p", "gap-8", { newlyTouches: ["b.rs"], affectsTasks: [] });
  await recordTaskDelta(data, "other", "gap-1", { newlyTouches: ["z.rs"], affectsTasks: [] });

  await clearTaskDeltas(data, "p");
  assertEquals((await readTaskDeltas(data, "p")).length, 0);
  assertEquals(stores["plan_task_deltas"].length, 1, "the other plan's delta survives");
});
