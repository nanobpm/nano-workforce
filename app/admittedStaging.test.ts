// Unit coverage for the S2 admission-STAGING data layer (issue #292 slice S2): `recordAdmittedEpic`
// and `recordAdmittedPlanDep`, the FK-free twins the set/batch door persists into instead of the
// durable `plans` / `plan_deps` graph. Driven against the same minimal in-memory data layer style as
// app/planDeps.test.ts. The edge writer shares `insertEdgeIdempotent` with `recordPlanDep`, so these
// pin the staging-specific surface: per-table isolation, epic idempotency on `plan_key`, and that a
// self-edge is still rejected.
import { test } from "node:test";
import { assertEquals, assertRejects } from "#test-assert";
import { recordAdmittedEpic, recordAdmittedPlanDep } from "./plan.ts";

/** Minimal in-memory data layer with per-name tables (so `admitted_epics` and `admitted_plan_deps`
 * stay isolated), matching the equality-filtered `find` / append `insert` / `get`-first style. */
function memData() {
  const tables = new Map<string, any[]>();
  const rowsOf = (name: string) => tables.get(name) ?? (tables.set(name, []), tables.get(name)!);
  return {
    tables,
    data: {
      table: (name: string, key: string) => {
        const rows = rowsOf(name);
        return {
          get: (k: any) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
          find: (q: any) =>
            Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
          insert: (r: any) => {
            rows.push(r);
            return Promise.resolve(r);
          },
          update: (k: any, patch: any) => {
            const i = rows.findIndex((r) => r[key] === k);
            if (i === -1) return Promise.resolve({ changed: 0 });
            rows[i] = { ...rows[i], ...patch };
            return Promise.resolve({ changed: 1 });
          },
        };
      },
    } as any,
  };
}

const EPIC = {
  plan_key: "owner/repo#1",
  repo: "owner/repo",
  issue_number: 1,
  issue_url: "https://github.com/owner/repo/issues/1",
  base_branch: "epic/a",
};

test("recordAdmittedEpic stages an epic with a stamped created_at", async () => {
  const { data, tables } = memData();
  const row = await recordAdmittedEpic(data, EPIC);
  assertEquals(tables.get("admitted_epics")!.length, 1);
  assertEquals(row.plan_key, "owner/repo#1");
  assertEquals(row.base_branch, "epic/a");
  assertEquals(typeof row.created_at, "string");
  assertEquals(row.created_at.length > 0, true);
});

test("recordAdmittedEpic is idempotent on plan_key (no second row, existing wins)", async () => {
  const { data, tables } = memData();
  const first = await recordAdmittedEpic(data, EPIC);
  const again = await recordAdmittedEpic(data, { ...EPIC, base_branch: "epic/ignored-on-dupe" });
  assertEquals(tables.get("admitted_epics")!.length, 1);
  assertEquals(again.created_at, first.created_at);
  assertEquals(again.base_branch, "epic/a"); // the existing staged row is returned, not overwritten
});

test("recordAdmittedEpic widens the staged escalation opt-in monotonically on an idempotent retry", async () => {
  const { data, tables } = memData();
  // Stage the epic OPTED OUT (the caller omitted the flag → 0), as a crashed-before-lowering request
  // would leave it.
  const first = await recordAdmittedEpic(data, EPIC);
  assertEquals(first.auto_resolve_escalations, 0, "an omitted opt-in stages as 0 (opted out)");
  // Retry the SAME admission now opting in: the staged row must WIDEN to opted-in (issue #889 review),
  // not stay opted out — otherwise the epic starts opted out despite the caller's opt-in.
  const retried = await recordAdmittedEpic(data, { ...EPIC, auto_resolve_escalations: 1 });
  assertEquals(tables.get("admitted_epics")!.length, 1, "still one staged row (idempotent)");
  assertEquals(retried.auto_resolve_escalations, 1, "the retry widened the staged opt-in to 1");
  assertEquals(retried.created_at, first.created_at, "the original staged row is preserved");
  assertEquals(tables.get("admitted_epics")![0].auto_resolve_escalations, 1, "the widening is persisted");
});

test("recordAdmittedEpic never narrows an opted-in staged row back to opted-out", async () => {
  const { data, tables } = memData();
  await recordAdmittedEpic(data, { ...EPIC, auto_resolve_escalations: 1 });
  // A retry that omits (or explicitly clears) the flag must NOT narrow the staged opt-in back to 0 —
  // the flag is monotonic (mirrors submitPr's live-loop adoption, service.ts).
  const retried = await recordAdmittedEpic(data, { ...EPIC, auto_resolve_escalations: 0 });
  assertEquals(retried.auto_resolve_escalations, 1, "an opted-in staged row is never narrowed to 0");
  assertEquals(tables.get("admitted_epics")![0].auto_resolve_escalations, 1);
});

test("recordAdmittedPlanDep stages an edge and stays out of plan_deps", async () => {
  const { data, tables } = memData();
  await recordAdmittedPlanDep(data, {
    plan_key: "owner/repo#2",
    depends_on_plan_key: "owner/repo#1",
    package: "@nanobpm/p",
    capability_ref: "owner/repo#1",
  });
  assertEquals(tables.get("admitted_plan_deps")!.length, 1);
  assertEquals(tables.get("plan_deps") ?? [], []); // never touches the durable graph
});

test("recordAdmittedPlanDep is idempotent on a duplicate edge (no second row)", async () => {
  const { data, tables } = memData();
  const edge = {
    plan_key: "owner/repo#2",
    depends_on_plan_key: "owner/repo#1",
    package: "@nanobpm/p",
    capability_ref: "owner/repo#1",
  };
  await recordAdmittedPlanDep(data, edge);
  await recordAdmittedPlanDep(data, { ...edge, package: "@nanobpm/ignored-on-dupe" });
  assertEquals(tables.get("admitted_plan_deps")!.length, 1);
});

test("recordAdmittedPlanDep rejects a self-edge", async () => {
  const { data, tables } = memData();
  await assertRejects(() =>
    recordAdmittedPlanDep(data, {
      plan_key: "owner/repo#1",
      depends_on_plan_key: "owner/repo#1",
      package: "@nanobpm/p",
      capability_ref: "owner/repo#1",
    }),
  );
  assertEquals(tables.get("admitted_plan_deps") ?? [], []);
});
