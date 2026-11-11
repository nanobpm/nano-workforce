// Red/green for issue #916 — the effective merge policy must be VISIBLE on every PR status row.
//
// The defect: whether a PR run will merge was explicit nowhere an operator looks. The
// convergence-loop instance carried only the INVERTED legacy `convergeOnly` variable (a feature
// run's `autoMerge: true` became `convergeOnly: false`, so searching the loop's variables for
// `autoMerge` found nothing and it looked as if auto-merge had been dropped), and the `/status`
// projection (`activePrs`) carried no merge-intent field at all — `waiting_merge` only appears once
// merging has STARTED. An operator concluded auto-merge was lost and wrote `autoMerge=true` onto a
// running loop — a no-op write, because the loop had `convergeOnly=false` from the start.
//
// The fix projects a structured `merge` block onto every ActivePr:
//   merge.requested — the run's merge intent: the canonical positive `autoMerge` process variable
//     when present, falling back to the INVERSE of the legacy `convergeOnly` variable for in-flight
//     loops seeded before `autoMerge` existed (and to `true` — the historical default — when the
//     instance key is unreadable or carries neither variable).
//   merge.enabled   — the deployment's global `NANO_PR_AUTO_MERGE` switch.
//   merge.effective — requested && enabled && !humanApproval: the run merges with no human gate.
//   merge.blockedBy — "env" | "human-approval" | null: WHY a requested merge will not proceed.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { withTrackingViews } from "../test/trackingViews.ts";
import { activePrs } from "./service.ts";

function memTable(rows: any[], key: string) {
  return {
    get: (k: any) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
    all: () => Promise.resolve([...rows]),
    find: (q: any) =>
      Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
    findOne: (q: any) =>
      Promise.resolve(rows.find((r) => Object.entries(q).every(([f, v]) => r[f] === v)) ?? null),
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

type Stores = Record<string, { rows: any[]; key: string }>;

function memData(stores: Stores) {
  return {
    table: withTrackingViews((name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key)),
  } as any;
}

/** A fake engine whose `searchVariables` serves the given per-instance variables. A name-less,
 *  key-less query (`{}` — the batched /status read, issue #936) returns EVERY variable across all
 *  instances, each row carrying its owning `processInstanceKey`, exactly as the real engine does.
 *  These tests exercise the LEGACY fallback path (issue #947): the row carries no
 *  `merge_requested` projection, so the policy is read back off the engine. */
function fakeEngine(varsByInstance: Record<string, Record<string, unknown>>) {
  return {
    searchVariables: (q: { processInstanceKey?: string; scopeKey?: string; name?: string }) => {
      const rows: { name: string; value: string; processInstanceKey: string; scopeKey: string }[] = [];
      for (const [piKey, vars] of Object.entries(varsByInstance)) {
        if (q.processInstanceKey != null && piKey !== String(q.processInstanceKey)) continue;
        if (q.scopeKey != null && piKey !== String(q.scopeKey)) continue;
        for (const [name, v] of Object.entries(vars)) {
          if (q.name != null && name !== q.name) continue;
          rows.push({ name, value: JSON.stringify(v), processInstanceKey: piKey, scopeKey: piKey });
        }
      }
      return Promise.resolve(rows);
    },
  } as any;
}

function prRow(over: Record<string, unknown>) {
  return {
    pr_key: "owner/repo#1",
    repo: "owner/repo",
    number: 1,
    url: "https://github.com/owner/repo/pull/1",
    title: "t",
    status: "converging",
    current_round: 1,
    process_key: "PI-1",
    updated_at: "2024-01-01",
    ...over,
  };
}

async function mergeOf(vars: Record<string, unknown>, rowOver: Record<string, unknown> = {}) {
  return mergeOfWith({ activePrs }, vars, rowOver);
}

/** `mergeOf` against an explicitly-loaded service module — for the env-switched tests that import
 *  a fresh copy of app/service.ts (e.g. `NANO_PR_AUTO_MERGE=0`). */
async function mergeOfWith(
  mod: Pick<typeof import("./service.ts"), "activePrs">,
  vars: Record<string, unknown>,
  rowOver: Record<string, unknown> = {},
) {
  const stores: Stores = {
    pull_requests: { rows: [prRow(rowOver)], key: "pr_key" },
    user_tasks: { rows: [], key: "id" },
  };
  const [pr] = await mod.activePrs(memData(stores), fakeEngine({ "PI-1": vars }));
  return pr.merge;
}

// AUTO_MERGE is computed once at app/service.ts import time; the test env leaves NANO_PR_AUTO_MERGE
// unset, so the global switch is ON here (the default).

test("merge policy: a loop seeded autoMerge=true reads requested+effective (the #916 phantom)", async () => {
  const merge = await mergeOf({ autoMerge: true, convergeOnly: false, humanApproval: false });
  assertEquals(merge, { requested: true, enabled: true, effective: true, blockedBy: null, stale: false });
});

test("merge policy: a legacy in-flight loop (convergeOnly only) derives requested from its inverse", async () => {
  // Seeded BEFORE `autoMerge` existed: only the legacy inverted variable is present.
  const review = await mergeOf({ convergeOnly: true });
  assertEquals(review, { requested: false, enabled: true, effective: false, blockedBy: null, stale: false });
  const merging = await mergeOf({ convergeOnly: false });
  assertEquals(merging, { requested: true, enabled: true, effective: true, blockedBy: null, stale: false });
});

test("merge policy: humanApproval gates the effective merge and is named as the blocker", async () => {
  const merge = await mergeOf({ autoMerge: true, humanApproval: true });
  assertEquals(merge, { requested: true, enabled: true, effective: false, blockedBy: "human-approval", stale: false });
});

test("merge policy: an approved PR with finalization still pending reports no blocker (PR #917 review)", async () => {
  // The `merge-approval` user task clears the loop's `humanApproval` variable on an explicit
  // "approve" (convergence-loop.bpmn), so while `pr.finalize` is still queued or incidented the
  // projection reads humanApproval=false and must NOT keep reporting a human-approval blocker for
  // an approval that is already complete. (`status` stays non-terminal: `converged_at` is only
  // stamped once `pr.finalize` actually runs.)
  const merge = await mergeOf({ autoMerge: true, humanApproval: false }, { status: "converging" });
  assertEquals(merge, { requested: true, enabled: true, effective: true, blockedBy: null, stale: false });
});

test("merge policy: a review-only request reads requested=false (distinct from env/human blocking)", async () => {
  const merge = await mergeOf({ autoMerge: false, convergeOnly: true });
  assertEquals(merge, { requested: false, enabled: true, effective: false, blockedBy: null, stale: false });
});

test("merge policy: no readable instance key (or neither variable) defaults to the historical merge default", async () => {
  // A mid-handoff row (process_key null) or a legacy loop carrying neither variable: the pre-#916
  // behaviour merged by default, so the projection must NOT read such a PR as review-only.
  const stores: Stores = {
    pull_requests: { rows: [prRow({ process_key: null })], key: "pr_key" },
    user_tasks: { rows: [], key: "id" },
  };
  const [noKey] = await activePrs(memData(stores), fakeEngine({}));
  assertEquals(noKey.merge, { requested: true, enabled: true, effective: true, blockedBy: null, stale: true });
  const bare = await mergeOf({});
  assertEquals(bare, { requested: true, enabled: true, effective: true, blockedBy: null, stale: true });
});

test("merge policy: NANO_PR_AUTO_MERGE=0 blocks a requested merge as env, never a review-only one", async () => {
  // `AUTO_MERGE` is read once at app/service.ts import time, so load a fresh copy of the module
  // under the env (the same pattern app/service.test.ts uses) — every other test here runs with
  // the switch ON (the default) and none exercised `blockedBy: "env"` before this one.
  const prev = process.env["NANO_PR_AUTO_MERGE"];
  process.env["NANO_PR_AUTO_MERGE"] = "0";
  try {
    const mod: typeof import("./service.ts") = await import(`./service.ts?mergeStatusAutoMergeOff=${Date.now()}`);
    const requested = await mergeOfWith(mod, { autoMerge: true, humanApproval: true });
    assertEquals(requested, { requested: true, enabled: false, effective: false, blockedBy: "env", stale: false });
    const reviewOnly = await mergeOfWith(mod, { autoMerge: false });
    assertEquals(reviewOnly, { requested: false, enabled: false, effective: false, blockedBy: null, stale: false });
  } finally {
    if (prev === undefined) delete process.env["NANO_PR_AUTO_MERGE"];
    else process.env["NANO_PR_AUTO_MERGE"] = prev;
  }
});

function activeStores() {
  return {
    pull_requests: { rows: [prRow({})], key: "pr_key" },
    user_tasks: { rows: [], key: "id" },
  } satisfies Stores;
}

type Row = { name: string; value: string; processInstanceKey: string; scopeKey: string };
const row = (name: string, v: unknown): Row => ({ name, value: JSON.stringify(v), processInstanceKey: "PI-1", scopeKey: "PI-1" });

test("merge policy: an unusable autoMerge row still probes a page-cut convergeOnly (PR #937 review)", async () => {
  // Batch: autoMerge present but null (unusable), convergeOnly cut from its page; the root probe finds it.
  const engine = {
    searchVariables: (q: { processInstanceKey?: string; name?: string }) => {
      if (q.processInstanceKey == null) {
        if (q.name === "autoMerge") return Promise.resolve([row("autoMerge", null)]);
        if (q.name === "humanApproval") return Promise.resolve([row("humanApproval", false)]);
        return Promise.resolve([]);
      }
      return Promise.resolve(q.name === "convergeOnly" ? [row("convergeOnly", true)] : []);
    },
  } as any;
  const [pr] = await activePrs(memData(activeStores()), engine);
  assertEquals(pr.merge.requested, false, "the legacy convergeOnly:true must be honoured when autoMerge is unusable");
});

test("merge policy: a delayed successful probe cannot resurrect a policy after a sibling probe failed (PR #937 review)", async () => {
  // Batch cuts every name. PI-1: autoMerge probe rejects early, humanApproval:true resolves late.
  // PI-2 (another PR) has a slower probe, so the projection is still pending when PI-1's late probe lands.
  const stores = {
    pull_requests: {
      rows: [prRow({}), prRow({ pr_key: "owner/repo#2", number: 2, process_key: "PI-2" })],
      key: "pr_key",
    },
    user_tasks: { rows: [], key: "id" },
  } satisfies Stores;
  const engine = {
    searchVariables: (q: { processInstanceKey?: string; name?: string }) => {
      if (q.processInstanceKey == null) return Promise.resolve([]);
      if (q.processInstanceKey === "PI-2") return new Promise<Row[]>((r) => setTimeout(() => r([]), 60));
      if (q.name === "autoMerge") return Promise.reject(new Error("boom"));
      return new Promise<Row[]>((r) => setTimeout(() => r([row(q.name ?? "", true)]), 20));
    },
  } as any;
  const prs = await activePrs(memData(stores), engine);
  const pr = prs.find((p: { prKey?: string; pr_key?: string; number?: number }) => p.number === 1);
  assertEquals(pr?.merge, { requested: true, enabled: true, effective: true, blockedBy: null, stale: true }, "failed probe → default, not a half-read policy");
});
