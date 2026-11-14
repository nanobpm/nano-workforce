// Issue #943 — defect-class guard: a convergence/merge loop must never end without an outcome.
// A merge loop (nanobpm/nano-bpm#1452, instance 607414) was terminated in-app by the waiting-merge →
// convergence hand-off with NO successor, NO escalation and NO recorded reason, and silently dropped
// off `/status`. This suite guards the whole class:
//   1. every `cancelInstance(` call site in the app source is ENUMERATED and classified — a new site
//      fails here until it is routed through `terminatePrLoop` (which records a reason naming the
//      successor/outcome) or justified in the registry below;
//   2. `terminatePrLoop` records the reason BEFORE cancelling;
//   3. an orphaned PR (loop ended, base row still in flight, no reason, not merged) is VISIBLE in
//      `/status` as `orphaned` instead of being filtered out.
import { test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { assert, assertEquals } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import {
  activePrs,
  handoffWaitingMergeToConvergence,
  isOrphanedPr,
  ORPHANED_PR_STATUS,
  recordOperatorCancelProvenance,
  retireHandedOffMergeLoop,
  retryPendingRetirements,
  terminatePrLoop,
} from "./service.ts";

const ROOT = join(import.meta.dirname, "..");

/** Every sanctioned `cancelInstance(` call site, keyed `file` → count, with its outcome contract. */
const SANCTIONED_CANCEL_SITES: Record<string, { count: number; outcome: string }> = {
  // (a) `terminatePrLoop` — THE canonical PR-loop door: stamps `termination_reason` (naming the
  //     successor instance or the terminal GitHub state) before cancelling. Callers: the merge →
  //     convergence hand-off (successor started FIRST) and the terminal review-wait retire (row
  //     settled merged/abandoned).
  // (b) `submitPr` rollback — cancels the instance THIS submit just created and never published as
  //     owner; the prior row (owner key + status) is restored, so the prior owner remains the outcome.
  "app/service.ts": { count: 2, outcome: "terminatePrLoop door + submitPr rollback (prior owner restored)" },
  // Delivery-graph reconcile-before-relaunch: not a PR loop; cancels a duplicate original under the
  // stale-claim CAS lease so the run is relaunched (the successor) at-most-once.
  "app/deliveryGraphRun.ts": { count: 1, outcome: "duplicate original retired; relaunch is the successor" },
};

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      out.push(...(await sourceFiles(p)));
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".e2e.ts") && !e.name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

test("#943 guard: every cancelInstance call site that can end a loop is enumerated and records an outcome", async () => {
  const found: Record<string, number> = {};
  for (const dir of ["app", "workers", "actions", "operations"]) {
    let files: string[] = [];
    try {
      files = await sourceFiles(join(ROOT, dir));
    } catch {
      continue; // directory absent
    }
    for (const f of files) {
      const n = ((await readFile(f, "utf8")).match(/\.cancelInstance\(/g) ?? []).length;
      if (n > 0) found[relative(ROOT, f)] = n;
    }
  }
  const expected = Object.fromEntries(Object.entries(SANCTIONED_CANCEL_SITES).map(([k, v]) => [k, v.count]));
  assertEquals(
    found,
    expected,
    "a cancelInstance call site was added/removed: route a PR-loop cancel through terminatePrLoop (reason + successor/outcome), then update SANCTIONED_CANCEL_SITES",
  );
});

function memData(rows: any[], tracking: any[]) {
  const stores: Record<string, any[]> = { pull_requests: rows, pull_requests__tracking: tracking, user_tasks: [] };
  const tbl = (name: string, pk: string) => {
    const r = (stores[name] ??= []);
    return {
      all: async () => r.slice(),
      get: async (id: any) => r.find((x) => x[pk] === id),
      find: async (w: any = {}) => r.filter((x) => Object.entries(w).every(([k, v]) => x[k] === v)),
      update: async (id: any, patch: any) => {
        const x = r.find((y) => y[pk] === id);
        if (x) Object.assign(x, patch);
      },
    };
  };
  const data = { table: (n: string, pk = "id") => tbl(n, pk) } as unknown as DataLayer;
  return { data, stores };
}

test("#943 terminatePrLoop records the reason BEFORE the engine cancel", async () => {
  const { data, stores } = memData([{ pr_key: "o/r#1", process_key: "k1", termination_reason: null }], []);
  const seen: (string | null)[] = [];
  const engine = {
    cancelInstance: async () => {
      seen.push(stores.pull_requests[0].termination_reason);
    },
  };
  await terminatePrLoop(data, engine as never, "o/r#1", "k1", "handed back -> successor k2", false);
  assertEquals(seen, ["handed back -> successor k2"]);
  assertEquals(stores.pull_requests[0].termination_process_key, "k1", "the reason is bound to the cancelled instance");
});

test("#943/PR#944 terminatePrLoop never stamps a predecessor's reason onto a successor-owned row", async () => {
  const { data, stores } = memData([{ pr_key: "o/r#1", process_key: "succ", termination_reason: null }], []);
  const cancelled: string[] = [];
  const engine = { cancelInstance: async (a: { processInstanceKey: string }) => void cancelled.push(a.processInstanceKey) };
  await terminatePrLoop(data, engine as never, "o/r#1", "pred", "handed back -> successor succ", true);
  assertEquals(cancelled, ["pred"], "the predecessor is still retired");
  assertEquals(stores.pull_requests[0].termination_reason, null, "the successor's row carries no predecessor provenance");
});

test("#943/PR#944 terminatePrLoop still cancels when the provenance write fails", async () => {
  const data = {
    table: () => ({
      get: async () => ({ pr_key: "o/r#1", process_key: "k1" }),
      update: async () => {
        throw new Error("db down");
      },
    }),
  } as unknown as DataLayer;
  const cancelled: string[] = [];
  const engine = { cancelInstance: async (a: { processInstanceKey: string }) => void cancelled.push(a.processInstanceKey) };
  await terminatePrLoop(data, engine as never, "o/r#1", "k1", "r", true);
  assertEquals(cancelled, ["k1"]);
});

test("#943/PR#944 retireHandedOffMergeLoop retries the CAPTURED merge key and never touches the successor row's stage", async () => {
  const { data, stores } = memData([{ pr_key: "o/r#1", process_key: "succ", status: "waiting_review" }], []);
  let calls = 0;
  const engine = {
    cancelInstance: async (a: { processInstanceKey: string }) => {
      calls++;
      assertEquals(a.processInstanceKey, "merge-1");
      if (calls === 1) throw new Error("transient");
    },
  };
  assert(await retireHandedOffMergeLoop(data, engine as never, "o/r#1", "merge-1", "succ", "test"));
  assertEquals(calls, 2);
  assertEquals(stores.pull_requests[0].status, "waiting_review");
  assertEquals(stores.pull_requests[0].process_key, "succ");
  const failing = { cancelInstance: async () => Promise.reject(new Error("down")) };
  assert(!(await retireHandedOffMergeLoop(data, failing as never, "o/r#1", "merge-1", "succ", "test")));
  assertEquals(stores.pull_requests[0].status, "waiting_review", "a persistent retire failure never demotes the successor");
});

test("#943/PR#944 recordOperatorCancelProvenance binds an operator cancel to the owning instance", async () => {
  const { data, stores } = memData([{ pr_key: "o/r#1", process_key: "k1" }, { pr_key: "o/r#2", process_key: "k2" }], []);
  await recordOperatorCancelProvenance(data, "k1", "/actions/cancel-pr");
  assertEquals(stores.pull_requests[0].termination_reason, "operator cancel (/actions/cancel-pr)");
  assertEquals(stores.pull_requests[0].termination_process_key, "k1");
  assertEquals(stores.pull_requests[1].termination_reason, undefined);
});

test("#943/PR#944 the page Cancel button routes through the provenance-recording door, not the built-in route", async () => {
  const page = await readFile(join(ROOT, "pages/home.page.json"), "utf8");
  assert(!page.includes('"/app/actions/cancel"'), "the built-in /app/actions/cancel bypasses termination provenance");
  assert(page.includes('"/app/api/actions/cancel-pr"'));
});

test("#943 terminatePrLoop: strict rethrows a failed cancel; lenient only logs", async () => {
  const { data } = memData([{ pr_key: "o/r#1" }], []);
  const engine = {
    cancelInstance: async () => {
      throw new Error("boom");
    },
  };
  let threw = false;
  try {
    await terminatePrLoop(data, engine as never, "o/r#1", "k1", "r", true);
  } catch {
    threw = true;
  }
  assert(threw, "strict rethrows");
  await terminatePrLoop(data, engine as never, "o/r#1", "k1", "r", false);
});

const base = {
  repo: "o/r",
  url: "u",
  title: null,
  current_round: 1,
  waiting_since: null,
  last_review_id: null,
  outcome: null,
  created_at: "t",
  updated_at: "t",
  converged_at: "t",
  merged_at: null,
  active_worker: null,
  lease_until: null,
  incident_key: null,
  incident_type: null,
  incident_message: null,
  incident_since: null,
  auto_resolve_escalations: 0,
  termination_reason: null,
};

test("#943 isOrphanedPr: loop ended in-app with the row still in flight and no reason → orphaned", () => {
  assert(isOrphanedPr({ status: "waiting_review", derived_status: "abandoned", termination_reason: null, merged_at: null }));
  assert(
    !isOrphanedPr({ status: "waiting_review", derived_status: "abandoned", process_key: "k", termination_reason: "handed back", termination_process_key: "k", merged_at: null }),
    "a reason recorded for the current owner is not an orphan",
  );
  assert(
    isOrphanedPr({ status: "waiting_review", derived_status: "abandoned", process_key: "succ", termination_reason: "handed back", termination_process_key: "pred", merged_at: null }),
    "a predecessor's reason never masks an orphaned successor (PR #944 review)",
  );
  assert(
    isOrphanedPr({ status: "waiting_review", derived_status: "abandoned", process_key: "k", termination_reason: "legacy", merged_at: null }),
    "an unbound reason explains nothing",
  );
  assert(!isOrphanedPr({ status: "abandoned", derived_status: "abandoned", termination_reason: null, merged_at: null }), "a settled row (human cancel/close) is not an orphan");
  assert(!isOrphanedPr({ status: "waiting_merge", derived_status: "waiting_merge", termination_reason: null, merged_at: null }), "a live loop is not an orphan");
  assert(!isOrphanedPr({ status: "merging", derived_status: "abandoned", termination_reason: null, merged_at: "t" }), "a merged PR is not an orphan");
});

test("#943 /status surfaces an orphaned PR instead of filtering it out", async () => {
  const orphan = { ...base, pr_key: "o/r#1452", number: 1452, status: "waiting_review", process_key: "607414" };
  const live = { ...base, pr_key: "o/r#2", number: 2, status: "waiting_merge", process_key: "9" };
  const { data } = memData(
    [orphan, live],
    [
      { ...orphan, derived_status: "abandoned" },
      { ...live, derived_status: "waiting_merge" },
    ],
  );
  const rows = await activePrs(data);
  const o = rows.find((r) => r.prKey === "o/r#1452");
  assert(o, "the orphaned PR is listed in /status");
  assertEquals(o?.status, ORPHANED_PR_STATUS);
  assertEquals(o?.terminationReason, null);
  assertEquals(rows.find((r) => r.prKey === "o/r#2")?.status, "waiting_merge");
});

test("#943/PR#944 a persistently failed retirement is persisted and retried by later poll passes", async () => {
  const { data, stores } = memData([{ pr_key: "o/r#1", process_key: "succ", status: "waiting_review" }], []);
  const failing = { cancelInstance: async () => Promise.reject(new Error("down")) };
  assert(!(await retireHandedOffMergeLoop(data, failing as never, "o/r#1", "merge-1", "succ", "test")));
  assertEquals(stores.pull_requests[0].retire_pending_key, "merge-1", "the predecessor key is never dropped");
  await retryPendingRetirements(data, failing as never);
  assertEquals(stores.pull_requests[0].retire_pending_key, "merge-1");
  const cancelled: string[] = [];
  const ok = { cancelInstance: async (a: { processInstanceKey: string }) => void cancelled.push(a.processInstanceKey) };
  await retryPendingRetirements(data, ok as never);
  assertEquals(cancelled, ["merge-1"]);
  assertEquals(stores.pull_requests[0].retire_pending_key, null);
  assertEquals(stores.pull_requests[0].process_key, "succ");
  assertEquals(stores.pull_requests[0].status, "waiting_review");
});

test("PR#944 a pending retirement whose key still OWNS the row (unpublished successor) is never retired", async () => {
  const { data, stores } = memData([{ pr_key: "o/r#1", process_key: "merge-1", status: "waiting_review", retire_pending_key: "merge-1" }], []);
  const cancelled: string[] = [];
  const ok = { cancelInstance: async (a: { processInstanceKey: string }) => void cancelled.push(a.processInstanceKey) };
  await retryPendingRetirements(data, ok as never);
  assertEquals(cancelled, [], "a live owning merge loop is never retired into nothing");
  assertEquals(stores.pull_requests[0].retire_pending_key, "merge-1");
});

test("PR#944 round 5: a KEYLESS owner row (unpublished handoff) is never retired into nothing — it stays recoverable", async () => {
  // `submitPr` can publish a null `process_key` (phantom row, #704/#497); if the app stops before the
  // handoff rollback lands (or the rollback write fails), the pending predecessor key survives with NO
  // successor. Cancelling the still-live merge loop here would recreate the ownerless termination this
  // PR prevents — the retirement must be deferred, leaving the NULL-key row for the dead-owner guard in
  // `pollMerges` to re-drive the handoff.
  const { data, stores } = memData([{ pr_key: "o/r#1", process_key: null, status: "waiting_review", retire_pending_key: "merge-1" }], []);
  const cancelled: string[] = [];
  const ok = { cancelInstance: async (a: { processInstanceKey: string }) => void cancelled.push(a.processInstanceKey) };
  await retryPendingRetirements(data, ok as never);
  assertEquals(cancelled, [], "no live successor → the predecessor is never retired");
  assertEquals(stores.pull_requests[0].retire_pending_key, "merge-1", "the pending marker survives for recovery");
  // Once a successor IS published, the same pass retires the predecessor against it.
  stores.pull_requests[0].process_key = "succ";
  await retryPendingRetirements(data, ok as never);
  assertEquals(cancelled, ["merge-1"]);
  assertEquals(stores.pull_requests[0].retire_pending_key, null);
});

// ── PR #944 round-6 review: restart-recovery of a pending handoff ───────────────────────────────
// A restart between the handoff's staging write and the successor publication strands the row in a
// shape NEITHER poll pass recovers: the `waiting_review`/`converging` stages sit outside the
// `waiting_merge` recovery scan, and the one-pending-retirement guard rejected a KEYLESS owner row
// outright, so even a keyless `waiting_merge` row could never re-drive its handoff. The recovery
// must be fenced to the LIVE merge stages (never demote a successor-owned `converging` row) and the
// pending-predecessor guard must admit a keyless owner row (there IS no live owner to protect).

/** In-memory `data` double with the exact tables `submitPr` touches on a phantom (null-key) publish. */
function handoffData(rows: any[], tracking: any[]) {
  const stores: Record<string, any[]> = {
    pull_requests: rows,
    pull_requests__tracking: tracking,
    escalations: [],
    pr_dependencies: [],
    worker_durable_resume: [],
    world_checkpoints: [],
    world_effects: [],
  };
  const tbl = (name: string, pk: string) => {
    const r = (stores[name] ??= []);
    return {
      all: async () => r.slice(),
      get: async (id: any) => r.find((x) => x[pk] === id),
      find: async (w: any = {}) => r.filter((x) => Object.entries(w).every(([k, v]) => x[k] === v)),
      findOne: async (w: any = {}) => r.find((x) => Object.entries(w).every(([k, v]) => x[k] === v)),
      insert: async (row: any) => void r.push(row),
      update: async (id: any, patch: any) => {
        const x = r.find((y) => y[pk] === id);
        if (x) Object.assign(x, patch);
      },
      delete: async (id: any) => {
        const i = r.findIndex((y) => y[pk] === id);
        if (i >= 0) r.splice(i, 1);
      },
    };
  };
  const data = {
    table: (n: string, pk = "id") => tbl(n, pk),
    open: () => ({ exec: async () => {} }),
  } as unknown as DataLayer;
  return { data, stores };
}

/** Run a handoff with the GitHub transport DISABLED (PR #944 round-7 review): forcing the `token`
 * transport with no `GITHUB_TOKEN` makes `submitPr`'s best-effort `fetchPrMeta` return `null`
 * WITHOUT any `gh` subprocess or network fetch — the test never depends on ambient credentials,
 * the network, or an unroutable host failing fast. The engine double publishes a NULL key (the
 * phantom-row path, #704/#497), so `submitPr` starts no successor and the handoff must roll back. */
async function runPhantomHandoff(row: any, tracking: any[]) {
  const prevTransport = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevToken = process.env["GITHUB_TOKEN"];
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  delete process.env["GITHUB_TOKEN"];
  try {
    const { data, stores } = handoffData([row], tracking);
    const engine = {
      createInstance: async () => ({ processInstanceKey: null }),
      cancelInstance: async () => {},
    };
    await handoffWaitingMergeToConvergence(data, engine as never, stores.pull_requests[0], "test");
    return stores;
  } finally {
    if (prevTransport === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevTransport;
    if (prevToken === undefined) delete process.env["GITHUB_TOKEN"];
    else process.env["GITHUB_TOKEN"] = prevToken;
  }
}

test("PR#944 round 6: a restart-stranded KEYLESS waiting_merge row re-drives its handoff past the pending-predecessor guard", async () => {
  const stores = await runPhantomHandoff(
    { pr_key: "o/r#1", repo: "o/r", number: 1, url: "u", process_key: null, status: "waiting_merge", retire_pending_key: "merge-1" },
    [{ pr_key: "o/r#1", derived_status: "waiting_merge" }],
  );
  assertEquals(stores.pull_requests[0].status, "waiting_merge", "the failed handoff restores the live merge stage");
  assertEquals(stores.pull_requests[0].process_key, null, "a keyless row stays keyless (the durable unfinished-handoff marker)");
  assertEquals(stores.pull_requests[0].retire_pending_key, "merge-1", "the pending predecessor survives the retry for later passes");
});

test("PR#944 round 6: a restart-stranded waiting_review row still OWNED by its live merge loop is left for the retirement-retry pass, not demoted", async () => {
  // The staging write already flipped the row to `waiting_review` and the owner is still the merge
  // loop: this is a MID-HANDOFF shape, not a stranded one. The stage fence correctly skips it —
  // re-staging would strand it outside `waiting_merge`'s scan. `retryPendingRetirements` recovers it
  // once the successor publishes (the round-5 test covers that retirement); the fence must NOT
  // "recover" it by demoting the stage back.
  const stores = await runPhantomHandoff(
    { pr_key: "o/r#1", repo: "o/r", number: 1, url: "u", process_key: "merge-1", status: "waiting_review", retire_pending_key: "merge-1" },
    [{ pr_key: "o/r#1", derived_status: "waiting_merge" }],
  );
  assertEquals(stores.pull_requests[0].status, "waiting_review", "a mid-handoff row is never demoted back to waiting_merge");
  assertEquals(stores.pull_requests[0].process_key, "merge-1", "the merge loop keeps owning the row until the successor publishes");
  assertEquals(stores.pull_requests[0].retire_pending_key, "merge-1", "the pending marker survives for retryPendingRetirements");
});

test("PR#944 round 6: a restart-stranded KEYLESS converging row re-drives its handoff past the pending-predecessor guard", async () => {
  // The reviewer's second stranded shape: the app stopped after the phantom (null-key) publish but
  // before the rollback, leaving the row keyless at `converging` with the pending predecessor. The
  // dead-owner guard in `pollMerges` re-drives the handoff from this shape; the pending-predecessor
  // guard must admit it (there is no live owner to protect), and the rollback restores the live
  // merge stage so the next pass retries cleanly.
  const stores = await runPhantomHandoff(
    { pr_key: "o/r#1", repo: "o/r", number: 1, url: "u", process_key: null, status: "converging", retire_pending_key: "merge-1" },
    [{ pr_key: "o/r#1", derived_status: "converging" }],
  );
  assertEquals(stores.pull_requests[0].status, "waiting_merge", "the failed recovery handoff restores the live merge stage");
  assertEquals(stores.pull_requests[0].process_key, null, "a keyless row stays keyless (the durable unfinished-handoff marker)");
  assertEquals(stores.pull_requests[0].retire_pending_key, "merge-1", "the pending predecessor survives the retry for later passes");
});

test("PR#944 round 6: a successor-owned converging row is NEVER demoted by a redelivered handoff", async () => {
  const { data, stores } = handoffData(
    [{ pr_key: "o/r#1", repo: "o/r", number: 1, url: "u", process_key: "succ", status: "converging", retire_pending_key: "merge-1" }],
    [{ pr_key: "o/r#1", derived_status: "converging" }],
  );
  const engine = {
    createInstance: async () => {
      throw new Error("must not be called — the successor owns the row");
    },
    cancelInstance: async () => {},
  };
  await handoffWaitingMergeToConvergence(data, engine as never, stores.pull_requests[0], "test");
  assertEquals(stores.pull_requests[0].status, "converging");
  assertEquals(stores.pull_requests[0].process_key, "succ");
  assertEquals(stores.pull_requests[0].retire_pending_key, "merge-1", "the pending retirement is left for retryPendingRetirements");
});

test("#959 isOrphanedPr: an audit-only landing (derived merged, base merging, no merged_at) is never orphaned", () => {
  assert(!isOrphanedPr({ status: "merging", derived_status: "merged", termination_reason: null, merged_at: null }));
});
