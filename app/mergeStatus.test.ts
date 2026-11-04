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

/** A fake engine whose `searchVariables` serves the given per-instance variables. */
function fakeEngine(varsByInstance: Record<string, Record<string, unknown>>) {
  return {
    searchVariables: (q: { processInstanceKey?: string; name?: string }) => {
      const vars = varsByInstance[String(q.processInstanceKey)] ?? {};
      return Promise.resolve(
        Object.entries(vars)
          .filter(([name]) => q.name == null || name === q.name)
          .map(([name, v]) => ({ name, value: JSON.stringify(v) })),
      );
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
  const stores: Stores = {
    pull_requests: { rows: [prRow(rowOver)], key: "pr_key" },
    user_tasks: { rows: [], key: "id" },
  };
  const [pr] = await activePrs(memData(stores), fakeEngine({ "PI-1": vars }));
  return pr.merge;
}

// AUTO_MERGE is computed once at app/service.ts import time; the test env leaves NANO_PR_AUTO_MERGE
// unset, so the global switch is ON here (the default).

test("merge policy: a loop seeded autoMerge=true reads requested+effective (the #916 phantom)", async () => {
  const merge = await mergeOf({ autoMerge: true, convergeOnly: false, humanApproval: false });
  assertEquals(merge, { requested: true, enabled: true, effective: true, blockedBy: null });
});

test("merge policy: a legacy in-flight loop (convergeOnly only) derives requested from its inverse", async () => {
  // Seeded BEFORE `autoMerge` existed: only the legacy inverted variable is present.
  const review = await mergeOf({ convergeOnly: true });
  assertEquals(review, { requested: false, enabled: true, effective: false, blockedBy: null });
  const merging = await mergeOf({ convergeOnly: false });
  assertEquals(merging, { requested: true, enabled: true, effective: true, blockedBy: null });
});

test("merge policy: humanApproval gates the effective merge and is named as the blocker", async () => {
  const merge = await mergeOf({ autoMerge: true, humanApproval: true });
  assertEquals(merge, { requested: true, enabled: true, effective: false, blockedBy: "human-approval" });
});

test("merge policy: a review-only request reads requested=false (distinct from env/human blocking)", async () => {
  const merge = await mergeOf({ autoMerge: false, convergeOnly: true });
  assertEquals(merge, { requested: false, enabled: true, effective: false, blockedBy: null });
});

test("merge policy: no readable instance key (or neither variable) defaults to the historical merge default", async () => {
  // A mid-handoff row (process_key null) or a legacy loop carrying neither variable: the pre-#916
  // behaviour merged by default, so the projection must NOT read such a PR as review-only.
  const stores: Stores = {
    pull_requests: { rows: [prRow({ process_key: null })], key: "pr_key" },
    user_tasks: { rows: [], key: "id" },
  };
  const [noKey] = await activePrs(memData(stores), fakeEngine({}));
  assertEquals(noKey.merge, { requested: true, enabled: true, effective: true, blockedBy: null });
  const bare = await mergeOf({});
  assertEquals(bare, { requested: true, enabled: true, effective: true, blockedBy: null });
});
