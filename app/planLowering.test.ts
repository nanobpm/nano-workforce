// Unit coverage for the inter-epic planner LOWERING (issue #292, slice S3) — the pure schedule
// derivation (`deriveEpicSchedule` / `capabilityProbeForEdge`) plus the `lowerAdmittedSet` executor
// that reads S2's staging, starts roots immediately, seeds a capability preflight for dependents, and
// materializes the durable `plan_deps` edges. Runs against an in-memory data/engine double (no engine,
// no network) exactly like the admission integration harness.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import type { PlanDep } from "./plan.ts";
import { capabilityProbeForEdge, deriveEpicSchedule, lowerAdmittedSet } from "./planLowering.ts";

const edge = (consumer: string, producer: string, pkg = "@scope/pkg", capRef = producer): PlanDep => ({
  plan_key: consumer,
  depends_on_plan_key: producer,
  package: pkg,
  capability_ref: capRef,
  created_at: "t0",
});

// ── in-memory data + engine double ───────────────────────────────────────────────────────────────
function makeData() {
  const tables = new Map<string, Record<string, unknown>[]>();
  const rowsFor = (name: string) => {
    const r = tables.get(name) ?? [];
    tables.set(name, r);
    return r;
  };
  const table = (name: string, key: string) => {
    const rows = rowsFor(name);
    return {
      get: (k: unknown) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
      find: (q: Record<string, unknown>) =>
        Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
      insert: (r: Record<string, unknown>) => {
        rows.push(r);
        return Promise.resolve(r);
      },
      update: (k: unknown, patch: Record<string, unknown>) => {
        const row = rows.find((r) => r[key] === k);
        if (row) Object.assign(row, patch);
        return Promise.resolve(row);
      },
      delete: (k: unknown) => {
        const i = rows.findIndex((r) => r[key] === k);
        if (i >= 0) rows.splice(i, 1);
        return Promise.resolve();
      },
    };
  };
  const started: { processDefinitionId: string; variables?: Record<string, unknown> }[] = [];
  const engine = {
    createInstance: (req: { processDefinitionId: string; variables?: Record<string, unknown> }) => {
      started.push(req);
      return Promise.resolve({ processInstanceKey: `PI-${started.length}` });
    },
  } as unknown as EngineClient;
  const data = { table } as unknown as DataLayer;
  return { data, engine, tables, started };
}

function stageEpic(tables: Map<string, Record<string, unknown>[]>, planKey: string, base: string) {
  const rows = tables.get("admitted_epics") ?? [];
  tables.set("admitted_epics", rows);
  const [repo, num] = planKey.split("#");
  rows.push({
    plan_key: planKey,
    repo,
    issue_number: Number(num),
    issue_url: `https://github.com/${repo}/issues/${num}`,
    base_branch: base,
    created_at: "t0",
  });
}

function stageEdge(tables: Map<string, Record<string, unknown>[]>, e: PlanDep) {
  const rows = tables.get("admitted_plan_deps") ?? [];
  tables.set("admitted_plan_deps", rows);
  rows.push({ ...e });
}

// Force token-transport with NO token so startPlan's best-effort issue-title lookup short-circuits to
// null (no `gh` shell-out, no network) — the epic falls back to its plan key for identity.
const noFetch = async <T>(fn: () => Promise<T>): Promise<T> => {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevTok = process.env["GITHUB_TOKEN"];
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  delete process.env["GITHUB_TOKEN"];
  try {
    return await fn();
  } finally {
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    if (prevTok === undefined) delete process.env["GITHUB_TOKEN"];
    else process.env["GITHUB_TOKEN"] = prevTok;
  }
};

// ── capabilityProbeForEdge ──────────────────────────────────────────────────────────────────────
test("capabilityProbeForEdge derives a capability probe pinned to the producer repo's releases", () => {
  const probe = capabilityProbeForEdge(edge("owner/repo#2", "owner/repo#1", "@scope/pkg", "owner/repo#1"));
  assertEquals(probe.kind, "capability");
  assertEquals(probe.target, "github-releases:owner/repo");
  assertEquals(probe.match?.package, "@scope/pkg");
  assertEquals(probe.match?.capabilityRef, "owner/repo#1");
  assertEquals(probe.onTimeout, "escalate");
});

test("capabilityProbeForEdge splits the producer repo even across different owner/repo producers", () => {
  const probe = capabilityProbeForEdge(edge("a/consumer#5", "b/producer#9", "@b/lib", "b/producer#9"));
  assertEquals(probe.target, "github-releases:b/producer");
  assertEquals(probe.match?.capabilityRef, "b/producer#9");
});

// ── deriveEpicSchedule ──────────────────────────────────────────────────────────────────────────
test("deriveEpicSchedule: an epic with no inbound edge is a ROOT (started immediately)", () => {
  const sched = deriveEpicSchedule(["o/r#1", "o/r#2"], [edge("o/r#2", "o/r#1")]);
  assertEquals(sched.roots, ["o/r#1"]);
  assertEquals(sched.dependents.length, 1);
  assertEquals(sched.dependents[0].planKey, "o/r#2");
  assertEquals(sched.dependents[0].producers, ["o/r#1"]);
  assertEquals(sched.dependents[0].probes.length, 1);
});

test("deriveEpicSchedule: a set with no edges makes every epic a root, no dependents", () => {
  const sched = deriveEpicSchedule(["o/r#1", "o/r#2"], []);
  assertEquals(sched.roots.sort(), ["o/r#1", "o/r#2"]);
  assertEquals(sched.dependents.length, 0);
});

test("deriveEpicSchedule: a dependent with MULTIPLE inbound edges waits for ALL its producers", () => {
  const sched = deriveEpicSchedule(
    ["o/r#1", "o/r#2", "o/r#3"],
    [edge("o/r#3", "o/r#1", "@a/x", "o/r#1"), edge("o/r#3", "o/r#2", "@b/y", "o/r#2")],
  );
  assertEquals(sched.roots.sort(), ["o/r#1", "o/r#2"]);
  assertEquals(sched.dependents.length, 1);
  const dep = sched.dependents[0];
  assertEquals(dep.planKey, "o/r#3");
  assertEquals(dep.producers.sort(), ["o/r#1", "o/r#2"]);
  assertEquals(dep.probes.length, 2); // one probe per producer — must satisfy both to fan out
  assert(dep.probeTimeout.startsWith("PT") || dep.probeTimeout.startsWith("P"), "an ISO-8601 bound");
});

// ── lowerAdmittedSet ────────────────────────────────────────────────────────────────────────────
test("lowerAdmittedSet starts roots with no probe and dependents with their seeded capability gate", async () => {
  const { data, engine, tables, started } = makeData();
  stageEpic(tables, "o/r#1", "epic/producer");
  stageEpic(tables, "o/r#2", "epic/consumer");
  stageEdge(tables, edge("o/r#2", "o/r#1"));

  const res = await noFetch(() => lowerAdmittedSet(data, engine, ["o/r#1", "o/r#2"]));

  assertEquals(res.roots, ["o/r#1"]);
  assertEquals(res.dependents, [{ planKey: "o/r#2", producers: ["o/r#1"] }]);
  assertEquals(res.edgesMaterialized, 1);
  assertEquals(started.length, 2);

  const byKey = new Map(started.map((s) => [s.variables?.["planKey"], s.variables ?? {}]));
  assertEquals(byKey.get("o/r#1")?.["readinessProbes"], null); // root fans out immediately
  const depProbes = byKey.get("o/r#2")?.["readinessProbes"] as unknown[] | null;
  assert(Array.isArray(depProbes) && depProbes.length === 1, "dependent seeded with one capability probe");
  assert(byKey.get("o/r#2")?.["probeTimeout"] != null, "dependent seeded with a bounded timeout");

  // Durable edge materialized (after the plans rows exist), and a plans row per epic.
  assertEquals((tables.get("plan_deps") ?? []).length, 1);
  assertEquals((tables.get("plans") ?? []).length, 2);
});

test("lowerAdmittedSet is idempotent: re-running neither double-starts an epic nor duplicates an edge", async () => {
  const { data, engine, tables, started } = makeData();
  stageEpic(tables, "o/r#1", "epic/producer");
  stageEpic(tables, "o/r#2", "epic/consumer");
  stageEdge(tables, edge("o/r#2", "o/r#1"));

  await noFetch(() => lowerAdmittedSet(data, engine, ["o/r#1", "o/r#2"]));
  assertEquals(started.length, 2);
  assertEquals((tables.get("plan_deps") ?? []).length, 1);

  // Second admission of the same set: startPlan short-circuits the already-running plans, recordPlanDep
  // collapses the duplicate edge — no new instance, no duplicate row.
  await noFetch(() => lowerAdmittedSet(data, engine, ["o/r#1", "o/r#2"]));
  assertEquals(started.length, 2, "no epic re-started on a re-run");
  assertEquals((tables.get("plan_deps") ?? []).length, 1, "no duplicate durable edge on a re-run");
});
