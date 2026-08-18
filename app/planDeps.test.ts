// Red/green regression for the INTER-epic dependency edge (PlanDep) data layer — issue #292 slice S1.
//
// This slice adds `plan_deps` (db/migrations/041_inter_epic_plan_deps.sql) and its typed read/write
// surface in app/plan.ts, mirroring the intra-epic `plan_task_deps` accessors. The durable table
// enforces "one edge per consumer→producer pair" (PRIMARY KEY) and "no self-edge" (CHECK); these
// tests pin the app-layer accessors that admission (S2) and the planner (S3) build on, driven against
// the same in-memory data layer the rest of app/plan's tests use.
import { test } from "node:test";
import { assertEquals, assertRejects } from "#test-assert";
import {
  inboundPlanDeps,
  type PlanDep,
  planDepsForSet,
  recordPlanDep,
} from "./plan.ts";

// Minimal in-memory data layer, matching the helper style in app/plan.test.ts: equality-filtered
// `find`, append `insert`, and a `delete(planKey)` that clears every row keyed on `plan_key` (so a
// re-seed of a plan's inbound edge set is one delete, exactly as `plan_task_deps` is cleared).
function memData() {
  const rows: any[] = [];
  const key = "plan_key";
  const table = {
    get: (k: any) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
    find: (q: any) =>
      Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
    insert: (r: any) => {
      rows.push(r);
      return Promise.resolve(r);
    },
    count: (q: any) =>
      Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v)).length),
    delete: (k: any) => {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i][key] === k) rows.splice(i, 1);
      return Promise.resolve();
    },
  };
  return {
    rows,
    data: { table: () => table } as any,
  };
}

const EDGE = {
  plan_key: "owner/repo#2",
  depends_on_plan_key: "owner/repo#1",
  package: "@nanobpm/producer",
  capability_ref: "owner/repo#1",
};

test("recordPlanDep persists an edge with a stamped created_at", async () => {
  const { data, rows } = memData();
  const row = await recordPlanDep(data, EDGE);
  assertEquals(rows.length, 1);
  assertEquals(row.plan_key, "owner/repo#2");
  assertEquals(row.depends_on_plan_key, "owner/repo#1");
  assertEquals(row.package, "@nanobpm/producer");
  assertEquals(row.capability_ref, "owner/repo#1");
  assertEquals(typeof row.created_at, "string");
  assertEquals(row.created_at.length > 0, true);
});

test("recordPlanDep rejects a self-edge (an epic cannot depend on itself)", async () => {
  const { data, rows } = memData();
  await assertRejects(() =>
    recordPlanDep(data, { ...EDGE, plan_key: "owner/repo#1", depends_on_plan_key: "owner/repo#1" }),
  );
  assertEquals(rows.length, 0);
});

test("recordPlanDep is idempotent on a duplicate edge (no second row)", async () => {
  const { data, rows } = memData();
  const first = await recordPlanDep(data, EDGE);
  const again = await recordPlanDep(data, { ...EDGE, package: "@nanobpm/ignored-on-dupe" });
  assertEquals(rows.length, 1);
  // The existing row wins — a re-submission does not overwrite nor append.
  assertEquals(again.created_at, first.created_at);
  assertEquals(again.package, "@nanobpm/producer");
});

test("recordPlanDep treats a concurrent PK collision as idempotent (no throw)", async () => {
  // Simulate the check-then-insert race the durable composite PRIMARY KEY backstops: a sibling
  // caller wins between our find and our insert, so `find` sees nothing but `insert` collides.
  const rows: any[] = [];
  const key = "plan_key";
  let raceArmed = true;
  const table = {
    get: (k: any) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
    find: (q: any) =>
      Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
    insert: (r: any) => {
      // On the first insert, a concurrent writer has already landed the same pair: append the
      // rival row and reject this one with a UNIQUE/PK constraint error, as SQLite would.
      if (raceArmed) {
        raceArmed = false;
        rows.push({ ...r, package: "@nanobpm/winner", created_at: "1999-01-01T00:00:00.000Z" });
        return Promise.reject(new Error("UNIQUE constraint failed: plan_deps.plan_key"));
      }
      rows.push(r);
      return Promise.resolve(r);
    },
    count: (q: any) =>
      Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v)).length),
    delete: (k: any) => {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i][key] === k) rows.splice(i, 1);
      return Promise.resolve();
    },
  };
  const data = { table: () => table } as any;

  const row = await recordPlanDep(data, EDGE);
  // The rival row is returned rather than the constraint error surfacing, and no duplicate lands.
  assertEquals(rows.length, 1);
  assertEquals(row.package, "@nanobpm/winner");
  assertEquals(row.created_at, "1999-01-01T00:00:00.000Z");
});

test("recordPlanDep re-raises a non-collision insert failure", async () => {
  // A genuine failure (the pair is still absent after the re-read) must not be swallowed.
  const table = {
    get: () => Promise.resolve(null),
    find: () => Promise.resolve([] as any[]),
    insert: () => Promise.reject(new Error("disk I/O error")),
    count: () => Promise.resolve(0),
    delete: () => Promise.resolve(),
  };
  const data = { table: () => table } as any;
  await assertRejects(() => recordPlanDep(data, EDGE), Error, "disk I/O error");
});

test("inboundPlanDeps returns every producer a dependent waits on; empty for a root", async () => {
  const { data } = memData();
  await recordPlanDep(data, EDGE);
  await recordPlanDep(data, { ...EDGE, depends_on_plan_key: "owner/repo#3", capability_ref: "owner/repo#3" });

  const inbound = await inboundPlanDeps(data, "owner/repo#2");
  assertEquals(inbound.length, 2);
  assertEquals(
    inbound.map((e: PlanDep) => e.depends_on_plan_key).sort(),
    ["owner/repo#1", "owner/repo#3"],
  );

  const root = await inboundPlanDeps(data, "owner/repo#1");
  assertEquals(root.length, 0);
});

test("planDepsForSet returns the whole DAG for a submitted set, de-duplicated", async () => {
  const { data } = memData();
  // #3 -> #1, #3 -> #2, #2 -> #1 : a small DAG across three epics.
  await recordPlanDep(data, {
    plan_key: "owner/repo#3",
    depends_on_plan_key: "owner/repo#1",
    package: "@nanobpm/a",
    capability_ref: "owner/repo#1",
  });
  await recordPlanDep(data, {
    plan_key: "owner/repo#3",
    depends_on_plan_key: "owner/repo#2",
    package: "@nanobpm/b",
    capability_ref: "owner/repo#2",
  });
  await recordPlanDep(data, {
    plan_key: "owner/repo#2",
    depends_on_plan_key: "owner/repo#1",
    package: "@nanobpm/a",
    capability_ref: "owner/repo#1",
  });

  const edges = await planDepsForSet(data, ["owner/repo#1", "owner/repo#2", "owner/repo#3"]);
  assertEquals(edges.length, 3);
  // A root (#1) contributes no inbound edges; passing overlapping keys never double-counts an edge.
  const overlapped = await planDepsForSet(data, ["owner/repo#3", "owner/repo#3"]);
  assertEquals(overlapped.length, 2);
});

test("planDepsForSet reads each key once even when planKeys repeats", async () => {
  // Prove the key de-dup: a repeated key must not drive a redundant inbound read.
  const findKeys: string[] = [];
  const table = {
    get: () => Promise.resolve(null),
    find: (q: any) => {
      findKeys.push(q.plan_key);
      return Promise.resolve([] as any[]);
    },
    insert: (r: any) => Promise.resolve(r),
    count: () => Promise.resolve(0),
    delete: () => Promise.resolve(),
  };
  const data = { table: () => table } as any;
  await planDepsForSet(data, ["owner/repo#3", "owner/repo#3", "owner/repo#4", "owner/repo#3"]);
  assertEquals(findKeys.sort(), ["owner/repo#3", "owner/repo#4"]);
});
