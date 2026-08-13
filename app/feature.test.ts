// Unit coverage for the single-issue feature run domain (issue #172).
//
// `startFeature` mirrors `startPlan`: it registers/refreshes the `feature_runs` aggregate
// (idempotent on `feature_key`), starts `feature.bpmn`, and persists the process key. These tests
// drive it against an in-memory data layer + a stub engine and assert the row shape, the
// short-circuit on an already-running run, the in-place restart of a settled run, and the seeded
// process variables (the single `task` slice + the base-branch brief).
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { FEATURE_PROCESS_ID, featureTaskId, startFeature } from "./feature.ts";

function memTable(rows: any[], key: string) {
  return {
    get: (k: any) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
    find: (q: any) =>
      Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
    insert: (r: any) => {
      rows.push(r);
      return Promise.resolve(r);
    },
    update: (k: any, patch: any) => {
      const r = rows.find((x) => x[key] === k);
      if (r) Object.assign(r, patch);
      return Promise.resolve(r);
    },
    delete: (k: any) => {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i][key] === k) rows.splice(i, 1);
      return Promise.resolve();
    },
  };
}

function memData(stores: Record<string, { rows: any[]; key: string }>) {
  return {
    table: (name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
  } as any;
}

const PARSED = {
  repo: "owner/repo",
  number: 42,
  url: "https://github.com/owner/repo/issues/42",
  planKey: "owner/repo#42",
};

test("featureTaskId: deterministic branch slug derivable from the issue number alone", () => {
  assertEquals(featureTaskId(42), "issue-42");
  assertEquals(featureTaskId(1), "issue-1");
});

test("startFeature: inserts a running feature_runs row and persists the process key", async () => {
  const stores = { feature_runs: { rows: [] as any[], key: "feature_key" } };
  const data = memData(stores);
  const engine = { createInstance: () => Promise.resolve({ processInstanceKey: "PI-9" }) } as any;

  const result = await startFeature(data, engine, PARSED, "main", false, false);

  assertEquals(result.featureKey, "owner/repo#42");
  assertEquals(result.processKey, "PI-9");
  const row = stores.feature_runs.rows[0];
  assertEquals(row.feature_key, "owner/repo#42");
  assertEquals(row.repo, "owner/repo");
  assertEquals(row.issue_number, 42);
  assertEquals(row.base_branch, "main");
  assertEquals(row.status, "running");
  assertEquals(row.process_key, "PI-9");
  assertEquals(row.converge, 0);
  assertEquals(row.auto_merge, 0);
  assertEquals(row.pr_key, null);
});

test("startFeature: converge/autoMerge flags are persisted as 0/1", async () => {
  const stores = { feature_runs: { rows: [] as any[], key: "feature_key" } };
  const engine = { createInstance: () => Promise.resolve({ processInstanceKey: "PI-1" }) } as any;
  await startFeature(memData(stores), engine, PARSED, "main", true, true);
  const row = stores.feature_runs.rows[0];
  assertEquals(row.converge, 1);
  assertEquals(row.auto_merge, 1);
});

test("startFeature: seeds the single task slice + base-branch brief onto the instance", async () => {
  let captured: any = null;
  const engine = {
    createInstance: (req: any) => {
      captured = req;
      return Promise.resolve({ processInstanceKey: "PI-2" });
    },
  } as any;
  await startFeature(
    memData({ feature_runs: { rows: [], key: "feature_key" } }),
    engine,
    PARSED,
    "epic/x",
    true,
    false,
  );
  assertEquals(captured.processDefinitionId, FEATURE_PROCESS_ID);
  const v = captured.variables;
  assertEquals(v.featureKey, "owner/repo#42");
  assertEquals(v.issue, "owner/repo#42");
  assertEquals(v.task.id, "issue-42");
  assertEquals(v.task.title, "owner/repo#42");
  assertEquals(typeof v.task.prompt, "string");
  assertEquals(v.task.prompt.includes("owner/repo#42"), true);
  assertEquals(v.converge, true);
  assertEquals(v.autoMerge, false);
  assertEquals(v.baseBranch, "epic/x");
  // The brief is the authoritative base-branch override the agent gets via appendPrompt.
  assertEquals(v.baseBranchBrief.includes("epic/x"), true);
  // Agent-result variables are pre-seeded so the escalation loop + record worker can reference them.
  assertEquals(v.pr, null);
  assertEquals(v.status, null);
});

test("startFeature: an already-running run short-circuits (no new instance)", async () => {
  const stores = {
    feature_runs: {
      rows: [{ feature_key: "owner/repo#42", status: "running", process_key: "PI-OLD" }],
      key: "feature_key",
    },
  };
  let created = 0;
  const engine = {
    createInstance: () => {
      created += 1;
      return Promise.resolve({ processInstanceKey: "PI-NEW" });
    },
  } as any;
  const result = await startFeature(memData(stores), engine, PARSED, "main", false, false);
  assertEquals(created, 0);
  assertEquals("alreadyRunning" in result && (result as any).alreadyRunning, true);
  assertEquals(result.processKey, "PI-OLD");
});

test("startFeature: a settled run is restarted in place (status reset, pr/outcome cleared)", async () => {
  const stores = {
    feature_runs: {
      rows: [
        {
          feature_key: "owner/repo#42",
          status: "opened",
          process_key: "PI-OLD",
          pr_key: "owner/repo#100",
          outcome: "prior run",
          converge: 0,
          auto_merge: 0,
        },
      ],
      key: "feature_key",
    },
  };
  const engine = { createInstance: () => Promise.resolve({ processInstanceKey: "PI-2" }) } as any;
  await startFeature(memData(stores), engine, PARSED, "main", true, true);
  const row = stores.feature_runs.rows[0];
  assertEquals(row.status, "running");
  assertEquals(row.pr_key, null);
  assertEquals(row.outcome, null);
  assertEquals(row.converge, 1);
  assertEquals(row.auto_merge, 1);
  assertEquals(row.process_key, "PI-2");
});
