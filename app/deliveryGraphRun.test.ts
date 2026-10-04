// Unit coverage for the delivery-graph run aggregate (ADR 0005 Decision 7) — the pure decision helpers
// (the idempotency key, the parked human-label map, the derived parked-node phase), plus the durable
// at-most-once launch-claim fence (`claimRunForLaunch`) exercised against the real provisioned SQLite
// data layer so its actual `status <> 'running'` compare-and-swap SQL is validated, not just modelled.
// The COMPOSED dispatch behaviour at the edge is proven by operations/dispatchDeliveryGraph.test.ts
// and app/deliveryGraphDispatch.test.ts (the operator dispatch action).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import { bootTestApp } from "@nanobpm/urban-testkit";
import { compileDeliveryGraph } from "./deliveryGraphCompiler.ts";
import {
  buildDeliveryGraphRunRow,
  buildHumanLabels,
  claimRunForLaunch,
  computeRunKey,
  deriveDeliveryPhase,
  DELIVERY_PHASE,
  deliveryGraphRunIdentities,
  deliveryGraphRuns,
  humanTaskElementId,
  isStaleLaunchClaim,
  LAUNCH_CLAIM_TTL_MS,
  parseHumanLabels,
  reconcileOriginalInstanceBeforeRelaunch,
  reconcileStaleLaunchClaim,
} from "./deliveryGraphRun.ts";
import { pollDeliveryGraphPhase } from "./service.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");

/** Boot an app purely for its provisioned data layer (migration 058 applied), run `fn`, tear down. */
async function withData(fn: (data: DataLayer) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-dgrun-"));
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dir, "app.db")}` } });
  try {
    await fn(app.db);
  } finally {
    await app.stop?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

const claimRow = (status: "awaiting-approval" | "running") =>
  buildDeliveryGraphRunRow({
    runKey: "rk",
    digest: "d",
    status,
    sideEffecting: true,
    nodeCount: 1,
    humanNodeCount: 0,
    sideEffectCount: 1,
    title: "t",
    phase: status === "running" ? DELIVERY_PHASE.RUNNING : DELIVERY_PHASE.AWAITING_APPROVAL,
    processKey: null,
  });

test("claimRunForLaunch: an empty slot is won by INSERT; a second racer that also read empty loses the run_key PK fence", async () => {
  await withData(async (data) => {
    const claim = claimRow("running");
    assertEquals(await claimRunForLaunch(data, false, claim), true); // inserted the claim → this caller launches
    assertEquals(await claimRunForLaunch(data, false, claim), false); // the row now exists → PK fence, no second launch
    assertEquals((await deliveryGraphRuns(data).get("rk"))?.status, "running");
  });
});

test("claimRunForLaunch: a parked awaiting-approval row is claimed by ONE compare-and-swap — a second approved racer loses the `status <> 'running'` guard, so a graph launches at most once", async () => {
  await withData(async (data) => {
    const runs = deliveryGraphRuns(data);
    await runs.insert(claimRow("awaiting-approval")); // a prior unapproved POST parked this run
    const claim = claimRow("running");
    assertEquals(await claimRunForLaunch(data, true, claim), true); // CAS flips awaiting-approval → running
    assertEquals(await claimRunForLaunch(data, true, claim), false); // already running → guard blocks the double-launch
    assertEquals((await runs.get("rk"))?.status, "running");
  });
});

test("claimRunForLaunch: a TERMINAL row re-runs — the CAS flips it to running, and a concurrent re-run racer loses the guard", async () => {
  await withData(async (data) => {
    const runs = deliveryGraphRuns(data);
    await runs.insert({ ...claimRow("running"), status: "failed" }); // a completed/terminal prior run
    const claim = claimRow("running");
    assertEquals(await claimRunForLaunch(data, true, claim), true); // re-run: failed <> running → flips
    assertEquals(await claimRunForLaunch(data, true, claim), false); // now running → no second launch
    assertEquals((await runs.get("rk"))?.status, "running");
  });
});

test("claimRunForLaunch: re-running a terminal row clears the PRIOR instance key in the SAME atomic flip — a claimed `running` row is never visible pointing at a stale process_key", async () => {
  await withData(async (data) => {
    const runs = deliveryGraphRuns(data);
    // A terminal prior run still carrying its old instance key + parked-node projection.
    await runs.insert({
      ...claimRow("running"),
      status: "failed",
      process_key: "OLD-PI",
      process_definition_id: "OLD-DEF",
      phase: "Parked on human node: publish",
      phase_node_id: "delivery-human-task__n1",
    });
    // The fresh launch claim carries no instance key yet (processKey: null).
    assertEquals(await claimRunForLaunch(data, true, claimRow("running")), true);
    const row = await runs.get("rk");
    assertEquals(row?.status, "running");
    assertEquals(row?.process_key, null); // stale key cleared atomically with the flip — not left as "OLD-PI"
    assertEquals(row?.process_definition_id, null);
    assertEquals(row?.phase_node_id, null);
    assertEquals(row?.phase, DELIVERY_PHASE.RUNNING);
  });
});

test("claimRunForLaunch: winning a re-run claim ATOMICALLY invalidates the prior run's identity side-row — a concurrent loser's short-circuit read sees a MISSING (unprovable) fingerprint, not the stale prior one (issue #778 review — thread deliveryGraphDispatch.ts:180)", async () => {
  await withData(async (data) => {
    const runs = deliveryGraphRuns(data);
    const identities = deliveryGraphRunIdentities(data);
    // A terminal prior run still carrying its stamped lossless identity fingerprint.
    await runs.insert({ ...claimRow("running"), status: "failed" });
    await identities.insert({ run_key: "rk", graph_fingerprint: "PRIOR-FP", created_at: "2020-01-01T00:00:00.000Z" });
    // The winner re-runs (conceptually a DIFFERENT graph that shares the digest-derived run_key but not
    // the credential-sensitive fingerprint). The CAS flips the row to running…
    assertEquals(await claimRunForLaunch(data, true, claimRow("running")), true);
    // …and the stale identity row must be GONE the instant the row is `running`. Otherwise a racing loser
    // reading between this flip and the winner's post-launch `upsertRunIdentity` re-stamp would read
    // "PRIOR-FP" and, if that matched ITS graph, wrongly confirm identity for a credential-different run.
    // Missing → dispatch's identityConfirmed is false (the safe 409) throughout the window.
    const after = await identities.get("rk");
    assert(after == null, `the stale identity row must be gone, got: ${JSON.stringify(after)}`);
  });
});

// ── #852: a launch claim stranded by a crash mid-launch must not wedge the run forever ──────────────
// The dispatch claims the row `running` (process_key null) BEFORE deploy; if the process dies mid-launch
// (merlin: a 54-node graph spent ~105 s in layout, the app went down) `markClaimFailed` never runs, and
// the phantom row short-circuited every re-dispatch onto a run that does not exist.
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

test("#852 isStaleLaunchClaim: only a `running` row with NO process key older than the launch TTL is stale", () => {
  const base = claimRow("running");
  assertEquals(isStaleLaunchClaim({ ...base, updated_at: ago(LAUNCH_CLAIM_TTL_MS + 1000) }), true);
  assertEquals(isStaleLaunchClaim({ ...base, updated_at: ago(1000) }), false, "an in-flight launch is not stale");
  assertEquals(isStaleLaunchClaim({ ...base, process_key: "29", updated_at: ago(LAUNCH_CLAIM_TTL_MS * 10) }), false, "a launched run is never stale");
  assertEquals(isStaleLaunchClaim({ ...base, status: "failed", updated_at: ago(LAUNCH_CLAIM_TTL_MS * 10) }), false);
  assert(LAUNCH_CLAIM_TTL_MS >= 10 * 60_000, "the TTL must comfortably exceed a slow large-graph launch");
});

test("#852 claimRunForLaunch: a STALE launch claim is re-claimable; a fresh in-flight claim still blocks the double-launch", async () => {
  await withData(async (data) => {
    const runs = deliveryGraphRuns(data);
    await runs.insert({ ...claimRow("running"), updated_at: ago(1000) });
    assertEquals(await claimRunForLaunch(data, true, claimRow("running")), false, "fresh claim: launch still in flight");
    await runs.update("rk", { updated_at: ago(LAUNCH_CLAIM_TTL_MS + 1000) });
    assertEquals(await claimRunForLaunch(data, true, claimRow("running")), true, "stale claim: the crashed launch is re-claimed");
    assertEquals(await claimRunForLaunch(data, true, claimRow("running")), false, "…by exactly one racer");
  });
});

test("#852 pollDeliveryGraphPhase: a stale launch claim is reconciled to failed; a fresh one is left alone", async () => {
  await withData(async (data) => {
    const runs = deliveryGraphRuns(data);
    await runs.insert({ ...claimRow("running"), run_key: "stale", updated_at: ago(LAUNCH_CLAIM_TTL_MS + 1000) });
    await runs.insert({ ...claimRow("running"), run_key: "fresh", updated_at: ago(1000) });
    const engine = {
      searchProcessInstances: async () => [],
      searchUserTasks: async () => [],
    };
    await pollDeliveryGraphPhase(data, engine as never);
    assertEquals((await runs.get("stale"))?.status, "failed");
    assertEquals((await runs.get("stale"))?.phase, DELIVERY_PHASE.FAILED);
    assertEquals((await runs.get("fresh"))?.status, "running");
  });
});

test("#852 pollDeliveryGraphPhase: retiring a stale claim cancels a still-running ORIGINAL instance first (at-most-once recovery)", async () => {
  await withData(async (data) => {
    const runs = deliveryGraphRuns(data);
    // A stale claim whose dispatch died AFTER createInstance but BEFORE stamping the key: the row has a
    // NULL process_key AND a NULL process_definition_id (the stamp never landed) — the poller derives the
    // definition id from the row's `digest` (`delivery-graph-d`). A LIVE instance of this run is ACTIVE.
    await runs.insert({
      ...claimRow("running"),
      run_key: "rk",
      digest: "d",
      updated_at: ago(LAUNCH_CLAIM_TTL_MS + 1000),
    });
    const cancelled: string[] = [];
    const engine = {
      searchProcessInstances: async (filter?: { processDefinitionId?: string; state?: string }) =>
        filter?.state === "ACTIVE" ? [{ processInstanceKey: "PI-live", state: "ACTIVE" }] : [],
      searchVariables: async (filter?: { processInstanceKey?: string; name?: string }) =>
        filter?.name === "runKey" && filter.processInstanceKey === "PI-live"
          ? [{ variableKey: "v", name: "runKey", value: JSON.stringify("rk"), scopeKey: "PI-live", processInstanceKey: "PI-live", isTruncated: false }]
          : [],
      cancelInstance: async (req: { processInstanceKey: string }) => {
        cancelled.push(req.processInstanceKey);
      },
      searchUserTasks: async () => [],
    };
    await pollDeliveryGraphPhase(data, engine as never);
    assertEquals(cancelled, ["PI-live"], "the live original is cancelled before the claim is retired");
    assertEquals((await runs.get("rk"))?.status, "failed");
  });
});

test("#852 pollDeliveryGraphPhase: a reconcile read failure leaves the stale claim for the next pass (no wedge, no blind retire)", async () => {
  await withData(async (data) => {
    const runs = deliveryGraphRuns(data);
    await runs.insert({
      ...claimRow("running"),
      run_key: "rk",
      digest: "d",
      updated_at: ago(LAUNCH_CLAIM_TTL_MS + 1000),
    });
    const engine = {
      searchProcessInstances: async () => {
        throw new Error("engine read unavailable");
      },
      searchUserTasks: async () => [],
    };
    await pollDeliveryGraphPhase(data, engine as never);
    // The claim is NOT retired this pass (the reconcile could not prove no live original), so a
    // re-dispatch is not waved through into a possible double-launch; the next pass retries.
    assertEquals((await runs.get("rk"))?.status, "running");
  });
});

test("#853 pollDeliveryGraphPhase: a FRESH in-flight claim (within TTL) is never engine-cancelled — the cancel is fenced behind the staleness CAS", async () => {
  await withData(async (data) => {
    const runs = deliveryGraphRuns(data);
    // A launch that is still in flight: running, no process key yet, but WELL within the launch TTL.
    // `createInstance` may have just succeeded (a legitimate live instance) with the key stamp still
    // pending. The poller must NOT cancel that instance — the row is not stale, so the reconcile lease
    // is never acquired and `finalize` (the cancel) never runs.
    await runs.insert({ ...claimRow("running"), run_key: "fresh", digest: "d", updated_at: ago(1000) });
    const cancelled: string[] = [];
    const engine = {
      searchProcessInstances: async (filter?: { state?: string }) =>
        filter?.state === "ACTIVE" ? [{ processInstanceKey: "PI-legit", state: "ACTIVE" }] : [],
      searchVariables: async (filter?: { processInstanceKey?: string; name?: string }) =>
        filter?.name === "runKey" && filter.processInstanceKey === "PI-legit"
          ? [{ variableKey: "v", name: "runKey", value: JSON.stringify("fresh"), scopeKey: "PI-legit", processInstanceKey: "PI-legit", isTruncated: false }]
          : [],
      cancelInstance: async (req: { processInstanceKey: string }) => {
        cancelled.push(req.processInstanceKey);
      },
      searchUserTasks: async () => [],
    };
    await pollDeliveryGraphPhase(data, engine as never);
    assertEquals(cancelled, [], "a fresh in-flight claim's legitimate instance is never cancelled");
    assertEquals((await runs.get("fresh"))?.status, "running", "the fresh claim is left running, not retired");
  });
});

test("#853 reconcileStaleLaunchClaim: a concurrent dispatch that re-claims the stale row first is NOT cancelled — the finalize cancel runs only for the lease owner", async () => {
  await withData(async (data) => {
    const runs = deliveryGraphRuns(data);
    // The poller read this row as a stale launch claim …
    const observed = { ...claimRow("running"), updated_at: ago(LAUNCH_CLAIM_TTL_MS + 1000) };
    await runs.insert(observed);
    // … but before the poller's CAS, a concurrent dispatch atomically RE-CLAIMS the stale row
    // (refreshing `updated_at`) and starts its replacement instance.
    assertEquals(await claimRunForLaunch(data, true, claimRow("running")), true, "concurrent dispatch re-claims the stale row");
    let cancelled = false;
    // The poller now reconciles off its STALE snapshot, passing the engine cancel as `finalize`. The CAS
    // matches zero rows (updated_at moved), so the lease is not acquired and `finalize` must NOT run —
    // the live replacement is never cancelled.
    const flipped = await reconcileStaleLaunchClaim(data, observed, async () => {
      cancelled = true;
    });
    assertEquals(flipped, false, "the stale snapshot no longer matches → no flip");
    assertEquals(cancelled, false, "the cancel is fenced: it never runs against a claim the poller did not win");
    assertEquals((await runs.get("rk"))?.status, "running", "the renewed claim is left running");
  });
});

test("#853 reconcileStaleLaunchClaim: the lease holder's finalize cancel DOES run, and the row is retired to failed only for the lease owner", async () => {
  await withData(async (data) => {
    const runs = deliveryGraphRuns(data);
    const observed = { ...claimRow("running"), updated_at: ago(LAUNCH_CLAIM_TTL_MS + 1000) };
    await runs.insert(observed);
    let cancelled = false;
    const flipped = await reconcileStaleLaunchClaim(data, observed, async () => {
      cancelled = true;
    });
    assertEquals(flipped, true, "the unchanged stale claim is flipped (lease acquired)");
    assertEquals(cancelled, true, "the lease owner's finalize cancel runs");
    assertEquals((await runs.get("rk"))?.status, "failed", "the row is retired to failed");
  });
});

test("#852 reconcileStaleLaunchClaim: the retire-to-failed flip is a CAS on the OBSERVED snapshot — a claim a concurrent dispatch re-claimed (refreshing updated_at) between the poller's read and the write is NOT clobbered", async () => {
  await withData(async (data) => {
    const runs = deliveryGraphRuns(data);
    // The poller read this row as a stale launch claim …
    const observed = { ...claimRow("running"), updated_at: ago(LAUNCH_CLAIM_TTL_MS + 1000) };
    await runs.insert(observed);
    // … but before it writes, a concurrent dispatch atomically RE-CLAIMS the stale row, refreshing
    // `updated_at` to a fresh in-flight claim (still running, still no process key yet).
    assertEquals(await claimRunForLaunch(data, true, claimRow("running")), true, "concurrent dispatch re-claims the stale row");
    const reclaimedAt = (await runs.get("rk"))?.updated_at;
    // The poller now reconciles off its STALE snapshot. The CAS must find no matching row and leave the
    // fresh claim untouched — otherwise a third dispatch could re-claim mid-layout and double-launch.
    assertEquals(await reconcileStaleLaunchClaim(data, observed), false, "stale snapshot no longer matches → no flip");
    const row = await runs.get("rk");
    assertEquals(row?.status, "running", "the renewed claim is left running, not clobbered to failed");
    assertEquals(row?.process_key, null);
    assertEquals(row?.updated_at, reclaimedAt, "the renewed claim's updated_at is preserved");
  });
});

test("#852 reconcileStaleLaunchClaim: a genuinely stale claim whose snapshot still matches IS retired to failed exactly once", async () => {
  await withData(async (data) => {
    const runs = deliveryGraphRuns(data);
    const observed = { ...claimRow("running"), updated_at: ago(LAUNCH_CLAIM_TTL_MS + 1000) };
    await runs.insert(observed);
    assertEquals(await reconcileStaleLaunchClaim(data, observed), true, "the unchanged stale claim is flipped");
    assertEquals((await runs.get("rk"))?.status, "failed");
    assertEquals((await runs.get("rk"))?.phase, DELIVERY_PHASE.FAILED);
    assertEquals(await reconcileStaleLaunchClaim(data, observed), false, "already failed → no second flip");
  });
});

test("#852 reconcileStaleLaunchClaim: a non-stale claim (launched, or within TTL) is never retired", async () => {
  await withData(async (data) => {
    const runs = deliveryGraphRuns(data);
    const fresh = { ...claimRow("running"), updated_at: ago(1000) };
    await runs.insert(fresh);
    assertEquals(await reconcileStaleLaunchClaim(data, fresh), false, "an in-flight launch is not stale");
    assertEquals((await runs.get("rk"))?.status, "running");
  });
});

// ── #852 review: reconcile-before-relaunch (the at-most-once fence a timeout-only reclaim lacks) ──
// A stale launch claim can hide a LIVE original instance (the dispatch died after createInstance but
// before stamping the process key). `reconcileOriginalInstanceBeforeRelaunch` cancels that original —
// matched by its seeded `runKey` variable — before a relaunch starts a second instance of the same
// side-effecting graph (thread deliveryGraphRun.ts:180).

/** A minimal engine stub for the reconcile seam: serves the configured ACTIVE instances, their `runKey`
 * variables, and records cancels. */
function reconcileEngine(instances: { processInstanceKey: string; runKey?: string }[]) {
  const cancelled: string[] = [];
  const engine = {
    searchProcessInstances: async (filter?: { processDefinitionId?: string; state?: string }) =>
      filter?.state === "ACTIVE" || filter?.state === undefined
        ? instances.map((i) => ({ processInstanceKey: i.processInstanceKey, state: "ACTIVE" }))
        : [],
    searchVariables: async (filter?: { processInstanceKey?: string; name?: string }) => {
      const inst = instances.find((i) => i.processInstanceKey === filter?.processInstanceKey);
      if (!inst || filter?.name !== "runKey" || inst.runKey === undefined) return [];
      return [{ variableKey: "v", name: "runKey", value: JSON.stringify(inst.runKey), scopeKey: inst.processInstanceKey, processInstanceKey: inst.processInstanceKey, isTruncated: false }];
    },
    cancelInstance: async (req: { processInstanceKey: string }) => {
      cancelled.push(req.processInstanceKey);
    },
  };
  return { engine, cancelled };
}

test("#852 reconcileOriginalInstanceBeforeRelaunch: a live original carrying THIS run key is cancelled before relaunch", async () => {
  const { engine, cancelled } = reconcileEngine([{ processInstanceKey: "PI-orig", runKey: "rk" }]);
  const cancelledKeys = await reconcileOriginalInstanceBeforeRelaunch(engine as never, { runKey: "rk", processDefinitionId: "delivery-graph-d" });
  assertEquals(cancelledKeys, ["PI-orig"]);
  assertEquals(cancelled, ["PI-orig"], "the live original is cancelled so the relaunch stays at-most-once");
});

test("#852 reconcileOriginalInstanceBeforeRelaunch: an ACTIVE instance of the SAME definition but a DIFFERENT run key is left running", async () => {
  // Two distinct runs of one graph share the content-addressed processDefinitionId; the definition
  // filter alone would cancel a DIFFERENT run's live instance. The runKey variable is the proof.
  const { engine, cancelled } = reconcileEngine([{ processInstanceKey: "PI-other", runKey: "other-run" }]);
  const cancelledKeys = await reconcileOriginalInstanceBeforeRelaunch(engine as never, { runKey: "rk", processDefinitionId: "delivery-graph-d" });
  assertEquals(cancelledKeys, []);
  assertEquals(cancelled, [], "a different run's instance is never cancelled");
});

test("#852 reconcileOriginalInstanceBeforeRelaunch: a candidate whose runKey variable is absent is NOT cancelled (unproven ownership)", async () => {
  const { engine, cancelled } = reconcileEngine([{ processInstanceKey: "PI-noseed" }]);
  const cancelledKeys = await reconcileOriginalInstanceBeforeRelaunch(engine as never, { runKey: "rk", processDefinitionId: "delivery-graph-d" });
  assertEquals(cancelledKeys, []);
  assertEquals(cancelled, [], "never cancel an instance we cannot prove belongs to this run");
});

test("#852 reconcileOriginalInstanceBeforeRelaunch: no ACTIVE instances → nothing to cancel", async () => {
  const { engine, cancelled } = reconcileEngine([]);
  const cancelledKeys = await reconcileOriginalInstanceBeforeRelaunch(engine as never, { runKey: "rk", processDefinitionId: "delivery-graph-d" });
  assertEquals(cancelledKeys, []);
  assertEquals(cancelled, []);
});

// ── pollDeliveryGraphPhase: engine-key coercion ───────────────────────────────
test("pollDeliveryGraphPhase: a numeric engine processInstanceKey still matches the string process_key, so a COMPLETED instance reconciles to done", async () => {
  await withData(async (data) => {
    const runs = deliveryGraphRuns(data);
    await runs.insert({ ...claimRow("running"), process_key: "12345" });
    // The engine can yield a NUMERIC key; the poller compares against the string process_key.
    const engine = {
      searchProcessInstances: async () => [{ processInstanceKey: 12345, state: "COMPLETED" }],
      searchUserTasks: async () => [],
    };
    await pollDeliveryGraphPhase(data, engine as never);
    assertEquals((await runs.get("rk"))?.status, "done");
  });
});

// ── pollDeliveryGraphPhase: engine 422 on USER_TASK wait-state read (nano-bpm#1042) ────────────
// The deployed engine's wait-state read model only accepts JOB | MESSAGE, so a `waitStateType:
// "USER_TASK"` filter 422s on a live gateway. This pass reads parks via `searchUserTasks({ state:
// "CREATED" })` — NOT `searchElementInstanceWaitStates` — precisely so that 422 can never reject the
// `Promise.all` and skip reconciliation. Guard both projections this pass owns against regressing back
// onto the wait-state channel: the parked-label projection AND the COMPLETED → `done` transition.
test("pollDeliveryGraphPhase: with an engine that 422s on waitStateType=USER_TASK, the parked label still projects (reads via searchUserTasks)", async () => {
  await withData(async (data) => {
    const runs = deliveryGraphRuns(data);
    const humanEl = humanTaskElementId("publish");
    await runs.insert({
      ...claimRow("running"),
      process_key: "PI-1",
      human_labels: JSON.stringify({ [humanEl]: "run the manual OTP publish" }),
    });
    // A client that rejects the wait-state read the way a live gateway does (HTTP 422). If the poller
    // reached for it, the throw would reject the Promise.all and reconciliation would be skipped.
    const engine = {
      searchProcessInstances: async () => [{ processInstanceKey: "PI-1", state: "ACTIVE" }],
      searchUserTasks: async () => [{ userTaskKey: "ut-1", elementId: humanEl }],
      searchElementInstanceWaitStates: async () => {
        throw new Error("HttpSdkError: HTTP 422 — filter.waitStateType did not match any variant of untagged enum WaitStateTypeFilterProperty");
      },
    };
    await pollDeliveryGraphPhase(data, engine as never);
    const row = await runs.get("rk");
    assertEquals(row?.status, "running");
    assertEquals(row?.phase, "Parked on human node: run the manual OTP publish");
    assertEquals(row?.phase_node_id, humanEl);
  });
});

test("pollDeliveryGraphPhase: with an engine that 422s on waitStateType=USER_TASK, a COMPLETED instance still reconciles to done", async () => {
  await withData(async (data) => {
    const runs = deliveryGraphRuns(data);
    await runs.insert({ ...claimRow("running"), process_key: "PI-2" });
    const engine = {
      searchProcessInstances: async () => [{ processInstanceKey: "PI-2", state: "COMPLETED" }],
      searchUserTasks: async () => [],
      searchElementInstanceWaitStates: async () => {
        throw new Error("HttpSdkError: HTTP 422 — filter.waitStateType did not match any variant of untagged enum WaitStateTypeFilterProperty");
      },
    };
    await pollDeliveryGraphPhase(data, engine as never);
    assertEquals((await runs.get("rk"))?.status, "done");
  });
});

// ── computeRunKey ─────────────────────────────────────────────────────────────
test("computeRunKey: a non-blank caller key wins; a blank/absent key falls back to the digest", () => {
  assertEquals(computeRunKey("run-1", "digestX"), "run-1");
  assertEquals(computeRunKey("  run-2  ", "digestX"), "run-2"); // trimmed
  assertEquals(computeRunKey("", "digestX"), "digestX");
  assertEquals(computeRunKey("   ", "digestX"), "digestX");
  assertEquals(computeRunKey(null, "digestX"), "digestX");
  assertEquals(computeRunKey(undefined, "digestX"), "digestX");
});

// ── buildHumanLabels / parseHumanLabels ───────────────────────────────────────
test("buildHumanLabels: maps each human node's compiled user-task element id → its FULL instruction", async () => {
  const graph = {
    nodes: [
      { id: "open-b", kind: "agent", agent: { jobType: "j" } },
      { id: "publish", kind: "human", human: { prompt: "run the manual OTP publish\nsecond line" } },
      { id: "ack", kind: "human" }, // no prompt → falls back to the node id
    ],
    edges: [{ from: "open-b", to: "publish" }, { from: "publish", to: "ack" }],
  };
  const compiled = await compileDeliveryGraph(graph);
  assertEquals(compiled.ok, true);
  if (!compiled.ok) return;
  const labels = buildHumanLabels(compiled);
  const publishEl = compiled.resolved.nodes.find((n) => n.id === "publish")?.element ?? "";
  const ackEl = compiled.resolved.nodes.find((n) => n.id === "ack")?.element ?? "";
  // The FULL prompt is stored (issue #813) — not a clamped first line — so the Tasks "Decision
  // context" can show the whole instruction. The phase pill clamps this at display (deriveDeliveryPhase).
  assertEquals(labels[humanTaskElementId(publishEl)], "run the manual OTP publish\nsecond line");
  assertEquals(labels[humanTaskElementId(ackEl)], "ack"); // fallback to node id
});

test("buildHumanLabels: redacts a credential-bearing human prompt before it lands in human_labels (issue #778 review)", async () => {
  const graph = {
    nodes: [
      { id: "publish", kind: "human", human: { prompt: "deploy via https://user:s3cr3t@registry.example.com then confirm" } },
    ],
    edges: [],
  };
  const compiled = await compileDeliveryGraph(graph);
  assertEquals(compiled.ok, true);
  if (!compiled.ok) return;
  const labels = buildHumanLabels(compiled);
  const publishEl = compiled.resolved.nodes.find((n) => n.id === "publish")?.element ?? "";
  const label = labels[humanTaskElementId(publishEl)];
  assert(!label.includes("s3cr3t") && !label.includes("user:s3cr3t"), "the credential must not survive into the denormalised inbox label");
  assertStringIncludes(label, "//***@");
});

test("parseHumanLabels: round-trips a stored map and tolerates null/blank/corrupt", () => {
  assertEquals(parseHumanLabels(null), {});
  assertEquals(parseHumanLabels(""), {});
  assertEquals(parseHumanLabels("  "), {});
  assertEquals(parseHumanLabels("{not json"), {});
  assertEquals(parseHumanLabels(JSON.stringify({ n1: "manual OTP publish", n2: "confirm deploy" })), {
    n1: "manual OTP publish",
    n2: "confirm deploy",
  }); // round-trips a valid string→string map
  assertEquals(parseHumanLabels(JSON.stringify(["a"])), {}); // non-object
  assertEquals(parseHumanLabels(JSON.stringify({ a: 1, b: "y" })), { b: "y" }); // drops non-string values
});

// ── deriveDeliveryPhase ───────────────────────────────────────────────────────
test("deriveDeliveryPhase: COMPLETED → done, TERMINATED → failed", () => {
  assertEquals(deriveDeliveryPhase("COMPLETED", [], {}), { status: "done", phase: DELIVERY_PHASE.COMPLETED, phase_node_id: null });
  assertEquals(deriveDeliveryPhase("TERMINATED", [], {}), { status: "failed", phase: DELIVERY_PHASE.FAILED, phase_node_id: null });
});

test("deriveDeliveryPhase: ACTIVE with an open human task → parked on that node with its label", () => {
  const el = humanTaskElementId("n2");
  const p = deriveDeliveryPhase("ACTIVE", [{ elementId: el }], { [el]: "manual OTP publish" });
  assertEquals(p.status, "running");
  assertEquals(p.phase, "Parked on human node: manual OTP publish");
  assertEquals(p.phase_node_id, el);
});

test("deriveDeliveryPhase: clamps a long/multi-line stored instruction to a first-line phase pill (#813)", () => {
  const el = humanTaskElementId("n2");
  const full = `Review the console dependency-adopt PR opened by adopt-console (bumps the ranges).\nSecond line.`;
  const p = deriveDeliveryPhase("ACTIVE", [{ elementId: el }], { [el]: full });
  // Full instruction is stored for the Decision context, but the phase pill shows only the clamped
  // first line (77 chars + …), never the second line.
  assertEquals(p.phase, "Parked on human node: Review the console dependency-adopt PR opened by adopt-console (bumps the ran…");
  assert(!p.phase.includes("Second line"));
});

test("deriveDeliveryPhase: a parked node with no stored label falls back to the element id", () => {
  const el = humanTaskElementId("n5");
  const p = deriveDeliveryPhase("ACTIVE", [{ elementId: el }], {});
  assertEquals(p.phase, `Parked on human node: ${el}`);
  assertEquals(p.phase_node_id, el);
});

test("deliveryHuman: a parked bounded-timeout twin (`…__esc`) resolves the base node's stored label in the phase pill (#813)", () => {
  // The twin's exact `…__esc` id is never stamped into `human_labels` (only the base id is), so the
  // phase-pill lookup must strip `__esc` — the same fallback the Tasks Decision-context helpers use —
  // else a parked timeout twin shows the raw element id instead of the instruction's first line.
  const base = humanTaskElementId("n2");
  const twin = `${base}__esc`;
  const p = deriveDeliveryPhase("ACTIVE", [{ elementId: twin }], { [base]: "manual OTP publish" });
  assertEquals(p.phase, "Parked on human node: manual OTP publish");
  assertEquals(p.phase_node_id, twin);
});

test("deriveDeliveryPhase: ACTIVE with only a non-human open task (or none) → a bare Running", () => {
  assertEquals(deriveDeliveryPhase("ACTIVE", [], {}), { status: "running", phase: DELIVERY_PHASE.RUNNING, phase_node_id: null });
  assertEquals(deriveDeliveryPhase("ACTIVE", [{ elementId: "some-service-task" }], {}), {
    status: "running",
    phase: DELIVERY_PHASE.RUNNING,
    phase_node_id: null,
  });
  // A null state (instance not found this pass) is treated as still-running, never a false terminal.
  assertEquals(deriveDeliveryPhase(null, [], {}), { status: "running", phase: DELIVERY_PHASE.RUNNING, phase_node_id: null });
});

test("deriveDeliveryPhase: multiple open human tasks pick the lowest element id deterministically", () => {
  const a = humanTaskElementId("n1");
  const b = humanTaskElementId("n3");
  const p = deriveDeliveryPhase("ACTIVE", [{ elementId: b }, { elementId: a }], { [a]: "first", [b]: "second" });
  assertEquals(p.phase, "Parked on human node: first");
  assertEquals(p.phase_node_id, a);
});
