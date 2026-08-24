// Behaviour coverage for issue #503 — the ADR-0065 derive-only-terminal divergence at the terminal
// EDGE readers. Under `@nanobpm/urban@0.81.0` the `instanceTracking` reconciler no longer WRITES the
// terminal `abandoned`/`failed`/`reviewed` onto the base `status`; it re-derives it on read via the
// `<table>__tracking.derived_status` VIEW. A PR/plan whose engine instance was terminated out-of-band
// (or by an ordinary in-app cancel) therefore keeps its base `status` frozen at its last worker
// transient (e.g. `converging`/`dispatched`) while `derived_status` reads `abandoned`.
//
// Each test seeds that EXACT divergence (base row `status: "converging"`, `derived_status: "abandoned"`)
// via the `withTrackingViews` seam, and asserts the reader classifies on the derived edge:
//   - a terminated PR is RESUBMITTABLE (not wedged `alreadyRunning`) and absent from `activePrs`,
//   - a terminated instance sheds its stale incident,
//   - a terminated lane member counts as COMPLETE (does not stall the merge lane),
//   - a terminated epic is not counted active (no false same-base conflict) and is RE-ADMITTABLE.
// Reading only the base `status` (the pre-#503 behaviour) fails every one of these — the RED.

import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { withTrackingViews } from "../test/trackingViews.ts";
import { findActivePlansByBase, startPlan } from "./plan.ts";
import { activePrs, mergeLaneDecisionForPr, pollIncidentsImpl, pollWaveGatesImpl, submitPr } from "./service.ts";

function memTable(rows: any[], key: string) {
  return {
    get: (k: any) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
    all: () => Promise.resolve([...rows]),
    find: (q: any) =>
      Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
    findOne: (q: any) =>
      Promise.resolve(rows.find((r) => Object.entries(q).every(([f, v]) => r[f] === v)) ?? null),
    count: (q: any) =>
      Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v)).length),
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
    table: withTrackingViews((name: string, key: string) =>
      memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key)),
  } as any;
}

function withGithubOff(run: () => Promise<void>): Promise<void> {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevTok = process.env["GITHUB_TOKEN"];
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token"; // no token below -> fetchPrMeta returns null
  delete process.env["GITHUB_TOKEN"];
  return run().finally(() => {
    if (prevMode !== undefined) process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    else delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    if (prevTok !== undefined) process.env["GITHUB_TOKEN"] = prevTok;
  });
}

// #503 / #497: `submitPr`'s idempotency gate reads `derived_status`, so a derive-only-terminated PR
// (base frozen at `converging`, `derived_status = abandoned`) is seen terminal and RESUBMITTABLE —
// it re-opens for a fresh convergence run instead of wedging `alreadyRunning`.
test("submitPr re-opens a derive-only-terminated PR (base 'converging', derived 'abandoned') — not alreadyRunning", async () => {
  await withGithubOff(async () => {
    const PR_KEY = "owner/repo#42";
    const stores: Stores = {
      pull_requests: {
        rows: [{
          pr_key: PR_KEY,
          repo: "owner/repo",
          number: 42,
          url: "https://github.com/owner/repo/pull/42",
          title: "t",
          status: "converging", // base transient FROZEN — reconciler no longer writes the terminal
          derived_status: "abandoned", // ADR-0065 derive-only terminal
          current_round: 3,
        }],
        key: "pr_key",
      },
      escalations: { rows: [], key: "id" },
      pr_dependencies: { rows: [], key: "pr_key" },
    };
    const data = memData(stores);
    const engine = { createInstance: () => Promise.resolve({ processInstanceKey: "PI-9" }) } as any;

    const res = await submitPr(data, engine, {
      repo: "owner/repo",
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
      prKey: PR_KEY,
    });

    assertEquals((res as any).alreadyRunning, undefined); // NOT wedged
    assertEquals(res.processKey, "PI-9");
    const pr = stores.pull_requests.rows[0];
    assertEquals(pr.status, "converging");
    assertEquals(pr.current_round, 1); // re-opened for a fresh run
    assertEquals(pr.process_key, "PI-9");
  });
});

// #503 / #497 phantom: `activePrs` filters on `derived_status`, so a derive-only-terminated PR drops
// off the Convergence tab instead of showing "active" indefinitely.
test("activePrs excludes a derive-only-terminated PR and keeps a genuinely active one", async () => {
  const stores: Stores = {
    pull_requests: {
      rows: [
        { pr_key: "o/r#1", repo: "o/r", number: 1, url: "u1", status: "converging", derived_status: "abandoned", current_round: 2, updated_at: "2024-01-02" },
        { pr_key: "o/r#2", repo: "o/r", number: 2, url: "u2", status: "converging", derived_status: "converging", current_round: 1, updated_at: "2024-01-01" },
      ],
      key: "pr_key",
    },
    escalations: { rows: [], key: "id" },
  };
  const active = await activePrs(memData(stores));
  assertEquals(active.map((p) => p.prKey), ["o/r#2"]);
});

// #503: `pollIncidentsImpl` classifies a dead instance on `derived_status`, so a derive-only-terminated
// PR sheds its stale incident (rather than re-reconciling against a gone instance), and NEVER queries
// the engine for it. A live PR still gets queried.
test("pollIncidentsImpl clears a stale incident off a derive-only-terminated PR without querying the engine", async () => {
  const stores: Stores = {
    pull_requests: {
      rows: [{
        pr_key: "o/r#7",
        repo: "o/r",
        number: 7,
        url: "u",
        status: "converging",
        derived_status: "abandoned",
        process_key: "PI-DEAD",
        incident_key: "INC-1",
        incident_message: "boom",
      }],
      key: "pr_key",
    },
  };
  const prevFetch = globalThis.fetch;
  let queried = false;
  globalThis.fetch = (() => {
    queried = true;
    throw new Error("engine must not be queried for a derive-only-terminated PR");
  }) as any;
  try {
    await pollIncidentsImpl(memData(stores), "http://engine", {});
  } finally {
    globalThis.fetch = prevFetch;
  }
  assertEquals(queried, false);
  const pr = stores.pull_requests.rows[0];
  assertEquals(pr.incident_key, null);
  assertEquals(pr.incident_message, null);
});

// #503: the merge-lane decision counts a lane member COMPLETE on the derived terminal edge, so a
// derive-only-abandoned member (base 'converging') no longer holds its lane-mate behind a dead PR.
test("mergeLaneDecisionForPr treats a derive-only-abandoned lane member as complete (does not hold the lane)", async () => {
  const PLAN_KEY = "o/r#100";
  const stores: Stores = {
    plan_tasks: {
      rows: [
        { id: 1, plan_key: PLAN_KEY, task_id: "a", pr_key: "o/r#1" },
        { id: 2, plan_key: PLAN_KEY, task_id: "b", pr_key: "o/r#2" },
      ],
      key: "id",
    },
    plan_merge_exclusions: {
      // a & b collide on a shared surface → one landing lane, land one-at-a-time
      rows: [{ id: 1, plan_key: PLAN_KEY, task_a: "a", task_b: "b", files: JSON.stringify(["shared.ts"]), source: "file-overlap" }],
      key: "id",
    },
    plan_task_deps: { rows: [], key: "plan_key" },
    pull_requests: {
      rows: [
        // lane head candidate `a`: derive-only-terminated (base frozen, derived abandoned)
        { pr_key: "o/r#1", repo: "o/r", number: 1, status: "converging", derived_status: "abandoned" },
        // `b`: the PR we ask about — still converging
        { pr_key: "o/r#2", repo: "o/r", number: 2, status: "converging", derived_status: "converging" },
      ],
      key: "pr_key",
    },
  };
  const decision = await mergeLaneDecisionForPr(memData(stores), "o/r#2");
  // With `a` counted complete, `b` is free to land — NOT held behind the dead member.
  assertEquals(decision?.isHeld, false);
});

// #503: `classifyWaveTarget` classifies a wave member on the derived terminal edge, so a
// derive-only-abandoned member (base frozen at `converging`, still notionally open) is treated
// NON-BLOCKING (`cleared`) WITHOUT a GitHub round-trip — the wave gate advances instead of wedging on
// a dead member. Driven through `pollWaveGatesImpl`: with the sole gate member cleared and the token
// parked at `wait-wave-merged`, the barrier is released (`wave-merged` published). Reading the base
// `status` (the RED) would fall through to a GitHub liveness read (which, with no live "merged"
// signal, returns `pending`) and never publish.
test("classifyWaveTarget treats a derive-only-abandoned wave member as cleared and releases the gate (no GitHub read)", async () => {
  await withGithubOff(async () => {
    const PLAN_KEY = "o/r#200";
    const stores: Stores = {
      plans: { rows: [{ plan_key: PLAN_KEY, gate_wave: 0, process_key: "PI-1" }], key: "plan_key" },
      plan_tasks: {
        rows: [{ id: 1, plan_key: PLAN_KEY, task_id: "a", wave: 0, status: "opened", pr_key: "o/r#1" }],
        key: "id",
      },
      pull_requests: {
        rows: [{ pr_key: "o/r#1", repo: "o/r", number: 1, status: "converging", derived_status: "abandoned" }],
        key: "pr_key",
      },
    };
    const published: unknown[] = [];
    const engine = { publishMessage: (m: unknown) => (published.push(m), Promise.resolve()) } as any;
    const prevFetch = globalThis.fetch;
    // Confirm the token is parked at the `wave-merged` wait so the barrier is releasable; a GitHub
    // liveness read for the abandoned member would be a bug (it's classified `cleared` off the view).
    globalThis.fetch = ((url: string) => {
      if (String(url).endsWith("/message-subscriptions/search")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ items: [{ messageName: "wave-merged", correlationKey: PLAN_KEY, messageSubscriptionState: "CREATED" }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      throw new Error(`no GitHub read expected for a derive-only-abandoned wave member: ${url}`);
    }) as any;
    try {
      await pollWaveGatesImpl(memData(stores), engine, "", "http://engine", {});
    } finally {
      globalThis.fetch = prevFetch;
    }
    assertEquals(published.length, 1); // wave released — the abandoned member did not block it
  });
});


// derive-only-abandoned epic (base frozen at `dispatched`) is NOT counted active and raises no false
// same-base conflict.
test("findActivePlansByBase excludes a derive-only-abandoned epic", async () => {
  const stores: Stores = {
    plans: {
      rows: [
        { plan_key: "o/r#10", repo: "o/r", base_branch: "epic/x", status: "dispatched", derived_status: "abandoned" },
        { plan_key: "o/r#11", repo: "o/r", base_branch: "epic/x", status: "dispatched", derived_status: "dispatched" },
      ],
      key: "plan_key",
    },
  };
  const active = await findActivePlansByBase(memData(stores), "o/r", "epic/x");
  assertEquals(active.map((p) => p.plan_key), ["o/r#11"]);
});

// #503: `startPlan`'s idempotency gate reads `derived_status`, so a derive-only-abandoned epic (base
// frozen at `dispatched`) is seen terminal and RE-ADMITTABLE — it re-plans instead of wedging
// `alreadyRunning`.
test("startPlan re-admits a derive-only-abandoned epic (base 'dispatched', derived 'abandoned') — not alreadyRunning", async () => {
  await withGithubOff(async () => {
    const PLAN_KEY = "owner/repo#7";
    const stores: Stores = {
      plans: {
        rows: [{ plan_key: PLAN_KEY, repo: "owner/repo", base_branch: "epic/x", status: "dispatched", derived_status: "abandoned", task_count: 1 }],
        key: "plan_key",
      },
      plan_tasks: { rows: [{ id: 1, plan_key: PLAN_KEY }], key: "id" },
      plan_reviews: { rows: [], key: "plan_key" },
      plan_task_deps: { rows: [], key: "plan_key" },
    };
    const engine = { createInstance: () => Promise.resolve({ processInstanceKey: "PI-1" }) } as any;

    const res = await startPlan(memData(stores), engine, {
      repo: "owner/repo",
      number: 7,
      url: "https://github.com/owner/repo/issues/7",
      planKey: PLAN_KEY,
    }, "epic/x");

    assertEquals((res as any).alreadyRunning, undefined); // NOT wedged — re-planned
    // The prior epic's tasks were cleared on the re-plan path (proves it did NOT short-circuit).
    assertEquals(stores.plan_tasks.rows.length, 0);
  });
});
