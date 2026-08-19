// Integration coverage for the inter-epic gate projection PASS (issue #292, slice S4). `pollWaitGate`
// is the `pollDelivery` twin for the readiness gate: it joins each `plans` row against its inbound
// `plan_deps` edges (the S1 read API) and stamps the pure `deriveWaitGate` result onto the row so the
// declarative epic index/detail can read `wait_gate` / `wait_gate_label` as flat columns. Runs against
// an in-memory data layer + the real `plans` gateway, mirroring app/promotionPoll.test.ts.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import { plans, recordPlanDep } from "./plan.ts";
import { pollWaitGate } from "./service.ts";

// In-memory record gateway (all/get/find/insert/update/delete), same shape as promotionPoll.test.ts.
function memData(): { data: DataLayer; stores: Record<string, any[]> } {
  const stores: Record<string, any[]> = {};
  function tbl(name: string, pk = "id") {
    const rows = (stores[name] ??= [] as any[]);
    const match = (r: any, where: any) => Object.entries(where).every(([k, v]) => r[k] === v);
    return {
      async all() {
        return rows.slice();
      },
      async get(id: any) {
        return rows.find((r) => r[pk] === id);
      },
      async find(where: any = {}) {
        return rows.filter((r) => match(r, where));
      },
      async insert(row: any) {
        rows.push({ ...row });
        return row[pk];
      },
      async update(id: any, patch: any) {
        const r = rows.find((row) => row[pk] === id);
        if (r) Object.assign(r, patch);
      },
      async delete(id: any) {
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i][pk] === id) rows.splice(i, 1);
      },
    };
  }
  const data = { table: (n: string, pk?: string) => tbl(n, pk) } as any as DataLayer;
  return { data, stores };
}

async function seedPlan(data: DataLayer, over: Record<string, unknown>) {
  const planKey = over.plan_key as string;
  const [repo, num] = planKey.split("#");
  await plans(data).insert({
    plan_key: planKey,
    repo,
    issue_number: Number(num),
    issue_url: `https://github.com/${repo}/issues/${num}`,
    title: planKey,
    status: "planning",
    task_count: 0,
    current_wave: null,
    bound_artifacts: null,
    wait_gate: null,
    wait_gate_label: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  } as any);
}

test("pollWaitGate: a root epic (no inbound edge) gets no wait-gate", async () => {
  const { data } = memData();
  await seedPlan(data, { plan_key: "o/r#1" });
  await pollWaitGate(data);
  const row = await plans(data).get("o/r#1");
  assertEquals(row!.wait_gate, null);
  assertEquals(row!.wait_gate_label, null);
});

test("pollWaitGate: a parked dependent is projected 'waiting on <producer>'", async () => {
  const { data } = memData();
  await seedPlan(data, { plan_key: "o/r#1" }); // producer
  // Dependent parked NOW (within the gate's bounded timeout — not yet escalated).
  await seedPlan(data, { plan_key: "o/r#2", created_at: new Date().toISOString() }); // dependent, parked (no wave)
  await recordPlanDep(data, {
    plan_key: "o/r#2",
    depends_on_plan_key: "o/r#1",
    package: "@scope/api",
    capability_ref: "o/r#1",
  });
  await pollWaitGate(data);
  const dep = await plans(data).get("o/r#2");
  assertEquals(dep!.wait_gate, "waiting");
  assert(dep!.wait_gate_label.includes("o/r#1 @ @scope/api"), "shows the blocking producer/package");
  // The producer itself is a root — never gets a gate.
  assertEquals((await plans(data).get("o/r#1"))!.wait_gate, null);
});

test("pollWaitGate: a satisfied dependent shows its bound version", async () => {
  const { data } = memData();
  await seedPlan(data, { plan_key: "o/r#1" });
  await seedPlan(data, {
    plan_key: "o/r#2",
    current_wave: 0,
    bound_artifacts: JSON.stringify(["@scope/api@1.4.0"]),
  });
  await recordPlanDep(data, {
    plan_key: "o/r#2",
    depends_on_plan_key: "o/r#1",
    package: "@scope/api",
    capability_ref: "o/r#1",
  });
  await pollWaitGate(data);
  const dep = await plans(data).get("o/r#2");
  assertEquals(dep!.wait_gate, "ready");
  assert(dep!.wait_gate_label.includes("@scope/api@1.4.0"), "surfaces the bound pkg@version");
});

test("pollWaitGate: is idempotent — a steady-state second pass rewrites nothing", async () => {
  const { data } = memData();
  await seedPlan(data, { plan_key: "o/r#1" });
  await seedPlan(data, { plan_key: "o/r#2" });
  await recordPlanDep(data, {
    plan_key: "o/r#2",
    depends_on_plan_key: "o/r#1",
    package: "@scope/api",
    capability_ref: "o/r#1",
  });
  await pollWaitGate(data);
  const afterFirst = (await plans(data).get("o/r#2"))!.updated_at;
  await pollWaitGate(data);
  const afterSecond = (await plans(data).get("o/r#2"))!.updated_at;
  assertEquals(afterSecond, afterFirst, "no-op pass must not re-stamp updated_at");
});

test("pollWaitGate: clears a stale gate when a plan no longer has inbound edges", async () => {
  const { data } = memData();
  await seedPlan(data, {
    plan_key: "o/r#2",
    wait_gate: "waiting",
    wait_gate_label: "waiting on o/r#1 @ @scope/api",
  });
  // No plan_deps edges exist -> the projection must clear the phantom gate.
  await pollWaitGate(data);
  const row = await plans(data).get("o/r#2");
  assertEquals(row!.wait_gate, null);
  assertEquals(row!.wait_gate_label, null);
});
