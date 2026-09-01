// Unit coverage for the single-issue feature run domain (issue #172).
//
// `startFeature` mirrors `startPlan`: it registers/refreshes the `feature_runs` aggregate
// (idempotent on `feature_key`), starts `feature.bpmn`, and persists the process key. These tests
// drive it against an in-memory data layer + a stub engine and assert the row shape, the
// short-circuit on an already-running run, the in-place restart of a settled run, and the seeded
// process variables (the single `task` slice + the base-branch brief).
import { after, test } from "node:test";
import { assertEquals } from "#test-assert";
import { FEATURE_PROCESS_ID, FEATURE_TERMINAL_STATUSES, featureTaskId, startFeature } from "./feature.ts";

// `startFeature` now fetches the issue title (issue #248) via the GitHub transport. Force the token
// transport with no token so the fetch is a hermetic no-op (returns null) — no `gh` subprocess, no
// network — and the row `title` deterministically coalesces to the `owner/repo#N` key. A dedicated
// test below stubs a successful fetch to cover the real-title path. Capture the prior values and
// restore them after this file's tests so the module-scope mutation never leaks into other test
// files under concurrent `node --test`.
const PRIOR_TRANSPORT = process.env["NANO_PR_GITHUB_TRANSPORT"];
const PRIOR_TOKEN = process.env["GITHUB_TOKEN"];
process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
delete process.env["GITHUB_TOKEN"];
after(() => {
  if (PRIOR_TRANSPORT === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
  else process.env["NANO_PR_GITHUB_TRANSPORT"] = PRIOR_TRANSPORT;
  if (PRIOR_TOKEN === undefined) delete process.env["GITHUB_TOKEN"];
  else process.env["GITHUB_TOKEN"] = PRIOR_TOKEN;
});

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
  // A single-issue run owns its issue, so the agent is told it may claim it (epic slices never set this).
  assertEquals(v.claimIssue, true);
  assertEquals(v.baseBranch, "epic/x");
  // The brief is the authoritative base-branch override the agent gets via appendPrompt.
  assertEquals(v.baseBranchBrief.includes("epic/x"), true);
  // Agent-result variables are pre-seeded so the escalation loop + record worker can reference them.
  assertEquals(v.pr, null);
  assertEquals(v.status, null);
});

test("startFeature: seeds the pre-PR repository envelope so the harness provisions an isolated clone (#684)", async () => {
  let captured: any = null;
  const engine = {
    createInstance: (req: any) => {
      captured = req;
      return Promise.resolve({ processInstanceKey: "PI-684" });
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
  // Without the envelope the c8ctl harness leaves cwd undefined and the agent mutates the worker's
  // shared launch dir; with it, the harness clones a throwaway workspace. The implementation path is
  // PRE-PR, so it checks out the BASE branch (`ref`) and the harness cuts the deterministic
  // `feat/<task.id>` feature branch off it (`branch.create`).
  const repo = (captured.variables as Record<string, any>)["io.nanobpm.agentTask"].repository;
  assertEquals(repo.url, "https://github.com/owner/repo.git");
  assertEquals(repo.ref, "epic/x");
  assertEquals(repo.branch.create, "feat/issue-42");
  assertEquals(repo.branch.create, `feat/${featureTaskId(PARSED.number)}`);
  // The blobless/single-branch monorepo shaping rides along, exactly like the PR-based envelope.
  assertEquals(repo.singleBranch, true);
  assertEquals(repo.filter, "blob:none");
});

test("startFeature: custom instructions ride the instance as a variable (trimmed)", async () => {
  let captured: any = null;
  const engine = {
    createInstance: (req: any) => {
      captured = req;
      return Promise.resolve({ processInstanceKey: "PI-3" });
    },
  } as any;
  await startFeature(
    memData({ feature_runs: { rows: [], key: "feature_key" } }),
    engine,
    PARSED,
    "main",
    false,
    false,
    "  prefer Deno; keep the diff small  ",
  );
  assertEquals(captured.variables.customInstructions, "prefer Deno; keep the diff small");
});

test("startFeature: blank/absent custom instructions are seeded as null", async () => {
  let captured: any = null;
  const engine = {
    createInstance: (req: any) => {
      captured = req;
      return Promise.resolve({ processInstanceKey: "PI-4" });
    },
  } as any;
  // Absent (default arg) → null.
  await startFeature(memData({ feature_runs: { rows: [], key: "feature_key" } }), engine, PARSED, "main", false, false);
  assertEquals(captured.variables.customInstructions, null);
  // Whitespace-only → null (so the appendPrompt FEEL skips the block instead of appending an empty heading).
  await startFeature(memData({ feature_runs: { rows: [], key: "feature_key" } }), engine, PARSED, "main", false, false, "   ");
  assertEquals(captured.variables.customInstructions, null);
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

test("startFeature: a run parked at the operator task (awaiting_operator) short-circuits a re-dispatch", async () => {
  // A blocked run parked at the feature-blocked user task is NON-terminal, so re-dispatching the
  // same issue must not spawn an orphaned parallel instance — it short-circuits until the operator
  // acknowledges it (which settles it to terminal `blocked`).
  assertEquals(FEATURE_TERMINAL_STATUSES.includes("awaiting_operator" as any), false);
  const stores = {
    feature_runs: {
      rows: [{ feature_key: "owner/repo#42", status: "awaiting_operator", process_key: "PI-PARK" }],
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
  assertEquals(result.processKey, "PI-PARK");
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

test("startFeature: an in-place restart clears a stale acknowledged_at (re-earn the tick-off)", async () => {
  const stores = {
    feature_runs: {
      rows: [
        {
          feature_key: "owner/repo#42",
          status: "merged",
          process_key: "PI-OLD",
          pr_key: "owner/repo#100",
          acknowledged_at: "2024-01-01T00:00:00Z",
          converge: 1,
          auto_merge: 1,
        },
      ],
      key: "feature_key",
    },
  };
  const engine = { createInstance: () => Promise.resolve({ processInstanceKey: "PI-3" }) } as any;
  await startFeature(memData(stores), engine, PARSED, "main", true, true);
  const row = stores.feature_runs.rows[0];
  assertEquals(row.status, "running");
  assertEquals(row.acknowledged_at, null);
});

// Issue #248: the human-readable identity for the feature grids. Every start persists a non-blank
// `title` — the fetched issue title when available, else the `owner/repo#N` key — on BOTH the insert
// (new run) and update (in-place restart) paths, so the title-led grid never renders a blank cell.
test("startFeature: coalesces title to the key when the fetch yields nothing (insert path)", async () => {
  const stores = { feature_runs: { rows: [] as any[], key: "feature_key" } };
  const engine = { createInstance: () => Promise.resolve({ processInstanceKey: "PI-T1" }) } as any;
  await startFeature(memData(stores), engine, PARSED, "main", false, false);
  assertEquals(stores.feature_runs.rows[0].title, "owner/repo#42");
});

test("startFeature: repopulates a non-blank title on the in-place restart (update path)", async () => {
  const stores = {
    feature_runs: {
      rows: [{ feature_key: "owner/repo#42", status: "opened", title: null, process_key: "PI-OLD" }],
      key: "feature_key",
    },
  };
  const engine = { createInstance: () => Promise.resolve({ processInstanceKey: "PI-T2" }) } as any;
  await startFeature(memData(stores), engine, PARSED, "main", false, false);
  assertEquals(stores.feature_runs.rows[0].title, "owner/repo#42");
});

test("startFeature: persists the real issue title when the fetch succeeds", async () => {
  const prevTok = process.env["GITHUB_TOKEN"];
  const prevFetch = globalThis.fetch;
  process.env["GITHUB_TOKEN"] = "t0ken";
  globalThis.fetch = ((url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/repos/owner/repo/issues/42")) {
      return Promise.resolve(new Response(JSON.stringify({ title: "Add the widget" }), { status: 200 }));
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as typeof fetch;
  try {
    const stores = { feature_runs: { rows: [] as any[], key: "feature_key" } };
    const engine = { createInstance: () => Promise.resolve({ processInstanceKey: "PI-T3" }) } as any;
    await startFeature(memData(stores), engine, PARSED, "main", false, false);
    assertEquals(stores.feature_runs.rows[0].title, "Add the widget");
  } finally {
    globalThis.fetch = prevFetch;
    if (prevTok === undefined) delete process.env["GITHUB_TOKEN"];
    else process.env["GITHUB_TOKEN"] = prevTok;
  }
});

test("startFeature: no readiness ⇒ readinessProbes/probeTimeout/gateKey seeded null (gate skipped)", async () => {
  let captured: any = null;
  const engine = {
    createInstance: (req: any) => {
      captured = req;
      return Promise.resolve({ processInstanceKey: "PI-R0" });
    },
  } as any;
  await startFeature(memData({ feature_runs: { rows: [], key: "feature_key" } }), engine, PARSED, "main", false, false);
  const v = captured.variables;
  assertEquals(v.readinessProbes, null);
  assertEquals(v.probeTimeout, null);
  assertEquals(v.probePollEvery, null);
  assertEquals(v.gateKey, null);
  assertEquals(v.resolvedArtifacts, null);
});

test("startFeature: readiness probes seed the gate variables + a non-blank correlation key", async () => {
  let captured: any = null;
  const engine = {
    createInstance: (req: any) => {
      captured = req;
      return Promise.resolve({ processInstanceKey: "PI-R1" });
    },
  } as any;
  const probes = [
    {
      kind: "capability",
      target: "github-releases:nanobpm/nano-bpm",
      match: { package: "@nanobpm/engine-wasm", capabilityRef: "nanobpm/nano-bpm#631" },
      onTimeout: "escalate",
    },
  ] as any;
  await startFeature(
    memData({ feature_runs: { rows: [], key: "feature_key" } }),
    engine,
    PARSED,
    "main",
    false,
    false,
    null,
    { probes, probeTimeout: "PT30M", probePollEvery: "PT15S" },
  );
  const v = captured.variables;
  assertEquals(v.readinessProbes, probes);
  assertEquals(v.probeTimeout, "PT30M");
  assertEquals(v.probePollEvery, "PT15S");
  // The preflight probe worker requires a non-blank gateKey to publish readiness-ready on.
  assertEquals(v.gateKey, "feature-readiness:owner/repo#42");
  assertEquals(v.resolvedArtifacts, null);
});

test("startFeature: probes without a probeTimeout fail fast (both are load-bearing together)", async () => {
  const engine = { createInstance: () => Promise.resolve({ processInstanceKey: "PI-R2" }) } as any;
  let threw = false;
  try {
    await startFeature(
      memData({ feature_runs: { rows: [], key: "feature_key" } }),
      engine,
      PARSED,
      "main",
      false,
      false,
      null,
      { probes: [{ kind: "command", target: "x" }] as any, probeTimeout: null },
    );
  } catch (err) {
    threw = true;
    assertEquals((err as Error).message.includes("probeTimeout"), true);
  }
  assertEquals(threw, true);
});
