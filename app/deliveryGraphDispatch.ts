// app/deliveryGraphDispatch.ts — the delivery-graph DISPATCH core (ADR 0005 Decision 7, issue #460).
// This is the retained run-launch logic (compile → content-address → idempotent at-most-once claim →
// deploy+start the S4 runner → stamp the instance) extracted out of the removed agent `start` door so
// it is invoked ONLY from the cockpit dispatch action — never an agent-callable operation.
//
// The old `start` door gated dispatch on a REPLAYABLE `approvalToken` (the content digest handed back
// to the same caller), which let any holder of the API credential self-approve. Under issue #460 the
// human clicking Dispatch in the cockpit IS the approval — so there is NO approval gate here; the
// authorization lives in the fact that only the cockpit dispatch seam reaches this code, not the agent
// surface. What IS retained is the durable at-most-once launch fence (`claimRunForLaunch`) and the
// idempotency short-circuit, so a double-click or a re-dispatch never double-launches a graph's side
// effects.

import { createHash } from "node:crypto";
import type { AppApi } from "@nanobpm/urban";
import type { DeliveryGraph } from "../nano-generated/api-io.d.ts";
import { canonicalJson, validateDeliveryGraph } from "./deliveryGraph.ts";
import { compileDeliveryGraphSemantic, DELIVERY_GRAPH_PROCESS_ID, digestInvisibleRawValues, graphCarriesRedactedSecrets } from "./deliveryGraphCompiler.ts";
import {
  buildDeliveryGraphRunRow,
  buildHumanLabels,
  claimRunForLaunch,
  computeRunKey,
  DELIVERY_PHASE,
  type DeliveryGraphRunIdentity,
  deliveryGraphRunIdentities,
  deliveryGraphRuns,
  isStaleLaunchClaim,
  reconcileOriginalInstanceBeforeRelaunch,
} from "./deliveryGraphRun.ts";
import type { DeliveryRunTimeouts } from "./deliveryRunner.ts";
import { deliveryGraphDigest, runDeliveryGraph } from "./deliveryRunner.ts";

/** The outcome of a dispatch attempt — mirrors the retained run lifecycle. `ok:false` carries the
 * path-qualified compile/validation errors (a staged graph should always recompile, but a corrupt
 * stored graph is refused cleanly rather than throwing). */
export type DispatchDeliveryGraphResult =
  | {
      ok: true;
      status: "running";
      runKey: string;
      digest: string;
      sideEffecting: boolean;
      alreadyRunning: boolean;
      /** Whether the returned run is PROVABLY this exact graph. Always true for a fresh launch. For an
       *  `alreadyRunning` short-circuit it is true iff the running row's persisted lossless
       *  {@link deliveryGraphIdentityFingerprint} matches the incoming graph's — i.e. a same-payload
       *  retry, not a credential-different graph re-staged under the same explicit `idempotencyKey` (and
       *  false for a pre-migration-113 row whose fingerprint is NULL, an unprovable identity). The
       *  dispatch door refuses a secret-bearing short-circuit only when this is false (issue #778 review
       *  — thread dispatchDeliveryGraph.ts:332). */
      identityConfirmed: boolean;
      processInstanceKey?: string;
      processDefinitionId?: string;
    }
  | { ok: false; errors: { path: string; message: string }[] };

/** The LOSSLESS content-identity fingerprint of a graph — `sha256(digest \0
 * canonicalJson(digestInvisibleRawValues(graph)))`. The `digest` is content-addressed over the REDACTED
 * `semanticBpmn`, so it alone collapses secret-differing graphs onto one identity; folding in
 * {@link digestInvisibleRawValues} (the exact raw content the digest CANNOT see) restores a FULL identity
 * that distinguishes them — the SAME `(digest, invisible-values)` pair `stableProposalRunKey` keys the
 * keyless run key on. Persisted on the run row so an explicit-`idempotencyKey` short-circuit can prove
 * the running run is THIS exact graph (issue #778 review — thread dispatchDeliveryGraph.ts:332). */
export function deliveryGraphIdentityFingerprint(graph: DeliveryGraph, digest: string): string {
  const invisible = canonicalJson(digestInvisibleRawValues(graph));
  return createHash("sha256").update(`${digest}\u0000${invisible}`).digest("hex");
}

/** Persist a run's lossless identity fingerprint (upsert on `run_key`). A relaunch off a persisted row
 * under an explicit `idempotencyKey` may carry a DIFFERENT graph, so a PRIMARY-KEY fence collision folds
 * into an UPDATE that overwrites the stored fingerprint rather than surfacing — the same intended
 * outcome as the insert branch (mirrors `DurableResumeRegistry.recordEnrolment`). */
async function upsertRunIdentity(
  identities: ReturnType<typeof deliveryGraphRunIdentities>,
  row: DeliveryGraphRunIdentity,
): Promise<void> {
  try {
    await identities.insert(row);
  } catch (err) {
    if (!(err instanceof Error) || !/UNIQUE constraint failed/i.test(err.message)) throw err;
    await identities.update(row.run_key, { graph_fingerprint: row.graph_fingerprint });
  }
}

/** Dispatch a delivery graph as a running engine-native process — the operator action. Re-validates
 * and re-compiles the (already-staged) graph to derive its content digest + run-row shape, then
 * launches it through the durable at-most-once fence. Idempotent: a re-dispatch of an already-running
 * run short-circuits with `alreadyRunning` instead of double-launching. */
export async function dispatchDeliveryGraphRun(
  app: Pick<AppApi, "data" | "engine" | "log">,
  graph: unknown,
  options: { runKey?: string | null; title?: string | null; repository?: string | null; baseBranch?: string | null; repoless?: boolean; expectedDigest?: string | null } & DeliveryRunTimeouts = {},
): Promise<DispatchDeliveryGraphResult> {
  const validationErrors = validateDeliveryGraph(graph);
  if (validationErrors.length > 0) {
    return { ok: false, errors: validationErrors };
  }
  // The graph passed the semantic validator above, so it is safe to narrow to the typed contract.
  // biome-ignore lint/plugin: validated external body narrowed to its contract after validateDeliveryGraph
  const typedGraph = graph as DeliveryGraph;
  // Semantic compile only (#852): this needs the digest / resolved model / side effects / human stops,
  // not the laid-out BPMN — `runDeliveryGraph` below runs the CPU-bound layout exactly once.
  const compiled = await compileDeliveryGraphSemantic(typedGraph);
  if (!compiled.ok) {
    return { ok: false, errors: compiled.errors };
  }

  const digest = deliveryGraphDigest(compiled.semanticBpmn);
  // ADDRESS-BEFORE-LAUNCH (issue #778 review — thread deliveryGraphCompiler.ts:1605): a staged proposal
  // is keyed by the digest computed AT STAGE TIME. The labels/`<bpmn:documentation>` this PR adds are
  // covered by that content digest, so after this compiler ships every proposal staged by the PREVIOUS
  // compiler RECOMPILES to a different digest. The caller (the dispatch door) hands us that stage-time
  // digest as `expectedDigest`; if the fresh recompile no longer matches it, the stored graph pre-dates
  // this compiler and its content address has drifted. REFUSE here — BEFORE the durable launch claim —
  // so we never launch the run and THEN report a post-launch 409 mismatch, which stranded a live run
  // against a proposal left `staged`. A clean refusal leaves nothing running; the operator recompiles to
  // re-stage under the current compiler. (A normal, same-compiler dispatch recompiles deterministically
  // to the same digest, so this is a no-op there.)
  const expectedDigest = typeof options.expectedDigest === "string" && options.expectedDigest.trim() !== "" ? options.expectedDigest.trim() : "";
  if (expectedDigest !== "" && digest !== expectedDigest) {
    app.log.warn("dispatch-delivery-graph refused: recompiled digest drifted from the staged address", { expectedDigest, digest });
    return {
      ok: false,
      errors: [
        {
          path: "digest",
          message:
            `this staged proposal was compiled under a different compiler version — it now recompiles to digest ${digest}, ` +
            `not the staged ${expectedDigest} its content address was pinned to, so it was NOT launched; recompile the graph to ` +
            "re-stage it under the current compiler before dispatching (issue #778)",
        },
      ],
    };
  }
  const explicitKey = typeof options.runKey === "string" && options.runKey.trim() !== "";
  // Option C (issue #778): the graph's identity is content-addressed over the REDACTED `semanticBpmn`
  // (issue #716), so two graphs differing ONLY in a redacted-away credential (a URL secret/`?query`/
  // `#fragment`, a `command` target, a `verifyCommand`/`bodyIncludes`/`stdoutIncludes` match secret, or
  // a free-form connector `payload`) share one digest — and a KEYLESS dispatch defaults `runKey` to that
  // digest, silently collapsing the second onto the first's still-running instance and reusing its
  // config. We accept the collision as by-design but REQUIRE an explicit `idempotencyKey` to
  // disambiguate such a secret-bearing graph, rather than launch it under an ambiguous identity.
  if (!explicitKey && graphCarriesRedactedSecrets(typedGraph)) {
    app.log.warn("dispatch-delivery-graph refused: secret-bearing graph needs an explicit idempotencyKey", { digest });
    return {
      ok: false,
      errors: [
        {
          path: "idempotencyKey",
          message:
            "this graph carries runtime values that redaction/normalisation strips from its content-addressed " +
            "digest — a URL credential/`?query`/`#fragment`, a `command` target, a `verifyCommand`/`bodyIncludes`/" +
            "`stdoutIncludes` match secret, a free-form connector `payload`, an untrimmed-whitespace difference in " +
            "an agent/human `prompt`, or a value that loses characters to XML sanitisation — so its digest cannot " +
            "distinguish it from another graph differing only in those values; supply an explicit `idempotencyKey` " +
            "to dispatch it (issue #778)",
        },
      ],
    };
  }
  const runKey = computeRunKey(options.runKey, digest);
  const sideEffecting = compiled.sideEffects.length > 0;
  const explicitTitle = typeof options.title === "string" && options.title.trim() !== "" ? options.title.trim() : "";
  const graphName = typeof typedGraph.name === "string" && typedGraph.name.trim() !== "" ? typedGraph.name.trim() : "";
  const title = explicitTitle || graphName || runKey;
  const runs = deliveryGraphRuns(app.data);
  const identities = deliveryGraphRunIdentities(app.data);
  // The lossless identity of THIS graph — persisted at launch in the `delivery_graph_run_identity` side
  // table, compared on a short-circuit so the door can distinguish a same-payload retry from a
  // credential-different graph re-staged under the same explicit key (issue #778 review — thread
  // dispatchDeliveryGraph.ts:332).
  const graphFingerprint = deliveryGraphIdentityFingerprint(typedGraph, digest);
  // Whether the run at `runKey` is PROVABLY this exact graph: a stored identity row that MATCHES ours. A
  // MISSING row (a run launched before this table existed, or a not-yet-stamped concurrent claim) is
  // unprovable → false, so the door refuses a secret-bearing short-circuit (the safe pre-existing 409).
  const identityConfirmed = async (): Promise<boolean> => {
    const identity = await identities.get(runKey);
    // `table.get()` resolves to `null` (NOT `undefined`) for a MISSING row — a run launched before this
    // side table existed, or a not-yet-stamped concurrent claim. A bare `!== undefined` admits that
    // `null` and then throws on `.graph_fingerprint`; `!= null` treats both absences as unprovable →
    // false, so the door reaches the safe pre-existing 409 instead of an incident (issue #778 review —
    // thread deliveryGraphDispatch.ts:175).
    return identity != null && identity.graph_fingerprint === graphFingerprint;
  };

  // Idempotency short-circuit — a re-dispatch onto a still-running run does NOT double-launch.
  const existing = await runs.get(runKey);
  // Capture staleness NOW, off the pre-claim snapshot: the claim CAS below rewrites `updated_at`, so a
  // staleness check after it would read the fresh claim and never fire. Only a STALE re-claim needs
  // reconcile-before-relaunch (a fresh claim or a terminal-row re-run has no possibly-live original).
  const reclaimingStaleClaim = existing != null && isStaleLaunchClaim(existing);
  if (existing && existing.status === "running" && !isStaleLaunchClaim(existing)) {
    app.log.info("dispatch-delivery-graph short-circuit: already running", { runKey });
    return {
      ok: true,
      status: "running",
      runKey,
      digest: existing.digest,
      sideEffecting: existing.side_effecting === 1,
      alreadyRunning: true,
      identityConfirmed: await identityConfirmed(),
      processInstanceKey: existing.process_key ?? undefined,
      processDefinitionId: existing.process_definition_id ?? undefined,
    };
  }

  const rowBase = {
    runKey,
    digest,
    sideEffecting,
    nodeCount: compiled.resolved.nodes.length,
    humanNodeCount: compiled.humanNodes.length,
    sideEffectCount: compiled.sideEffects.length,
    title,
    humanLabels: buildHumanLabels(compiled),
    createdAt: existing?.created_at,
  };

  // Claim the run durably BEFORE the side effect (the at-most-once dispatch fence). A losing racer
  // never reaches `runDeliveryGraph` — it re-reads the winner's row and short-circuits.
  const claim = buildDeliveryGraphRunRow({ ...rowBase, status: "running", phase: DELIVERY_PHASE.RUNNING, processKey: null });
  const wonClaim = await claimRunForLaunch(app.data, Boolean(existing), claim);
  if (!wonClaim) {
    const won = await runs.get(runKey);
    app.log.info("dispatch-delivery-graph short-circuit: launch claim raced a concurrent dispatch", { runKey });
    return {
      ok: true,
      status: "running",
      runKey,
      digest: won?.digest ?? digest,
      sideEffecting: won ? won.side_effecting === 1 : sideEffecting,
      alreadyRunning: true,
      identityConfirmed: await identityConfirmed(),
      processInstanceKey: won?.process_key ?? undefined,
      processDefinitionId: won?.process_definition_id ?? undefined,
    };
  }
  // On ANY post-claim failure — the identity/patch persistence just below OR the launch further down —
  // flip the claimed row to `failed` so no null-process_key `running` row is ever stranded and later
  // dispatches never short-circuit onto a phantom run.
  const markClaimFailed = async () => {
    const failed = buildDeliveryGraphRunRow({ ...rowBase, status: "failed", phase: DELIVERY_PHASE.FAILED, processKey: null });
    const { run_key, created_at, ...patch } = failed;
    await runs.update(runKey, patch);
  };
  // Reconcile-before-relaunch (issue #852 review — thread deliveryGraphRun.ts:180): if we just RE-CLAIMED
  // a STALE launch claim (a `running`/NULL-key row past its TTL), the original dispatch may have died
  // AFTER `createInstance` succeeded but BEFORE stamping the process key — leaving a LIVE instance
  // executing this graph's side-effecting nodes. A timeout alone cannot tell that from "died before
  // create". Now that the engine seam exposes it, close the window: cancel any still-ACTIVE instance of
  // this run (matched by its seeded `runKey` variable) BEFORE we launch a replacement, so the relaunch
  // stays at-most-once. Only a STALE re-claim needs this — a fresh claim or a terminal-row re-run has no
  // possibly-live original. The content-addressed definition id is derived from the STALE ROW's own
  // `digest` (`existing.digest`), NOT the freshly-compiled `digest` of THIS dispatch: under an explicit
  // idempotency key the re-dispatched graph can differ (digest drift), and the original was deployed
  // under `delivery-graph-<existing.digest>`. Searching under the new digest would miss the original and
  // strand it live — the exact double-launch this reconcile exists to prevent. Mirrors the poller, which
  // uses the stored `run.digest` (service.ts). `existing` is non-null whenever `reclaimingStaleClaim`.
  if (reclaimingStaleClaim) {
    const originalDigest = existing?.digest ?? digest;
    try {
      const cancelled = await reconcileOriginalInstanceBeforeRelaunch(app.engine, {
        runKey,
        processDefinitionId: `${DELIVERY_GRAPH_PROCESS_ID}-${originalDigest}`,
      });
      if (cancelled.length > 0) {
        app.log.warn("dispatch-delivery-graph cancelled a still-running original instance before relaunch", { runKey, cancelled });
      }
    } catch (err) {
      // A reconciliation read failure must not strand the claim: fail the claim (so it is not a phantom)
      // and surface the error rather than relaunching blind into a possible double-launch.
      await markClaimFailed();
      app.log.error("dispatch-delivery-graph reconcile-before-relaunch threw", { runKey });
      throw err;
    }
  }
  // The claim is ours — persist THIS run's lossless identity so a later same-key short-circuit can prove
  // the running run is this exact graph. Upsert: a relaunch off a persisted (e.g. failed) row under an
  // explicit key may carry a different graph, so overwrite the stored fingerprint. This runs AFTER the
  // durable `running` claim but is a SEPARATE write, so a transient failure here would otherwise strand
  // the claimed row as `running` with a null process key — later same-key dispatches would then
  // short-circuit onto that phantom run. Route the failure through the same claim-failure cleanup before
  // rethrowing so the phantom self-heals (issue #778 review — thread deliveryGraphDispatch.ts:229).
  try {
    await upsertRunIdentity(identities, { run_key: runKey, graph_fingerprint: graphFingerprint, created_at: claim.created_at });
    if (existing) {
      const { run_key, created_at, ...patch } = claim;
      await runs.update(runKey, patch);
    }
  } catch (err) {
    await markClaimFailed();
    app.log.error("dispatch-delivery-graph identity persistence threw", { runKey });
    throw err;
  }

  // Launch — deploy + start the compiled definition.
  let launched: Awaited<ReturnType<typeof runDeliveryGraph>>;
  try {
    // Thread the operator-supplied run-level timeouts (#505) so a submission override reaches every
    // node's seeded `nodeInputs` (absent → the runner's PT1H/PT30M/P1D defaults).
    launched = await runDeliveryGraph(app.engine, typedGraph, {
      runKey,
      nodeTimeout: options.nodeTimeout,
      probeTimeout: options.probeTimeout,
      escalationSlaTimeout: options.escalationSlaTimeout,
      probePollEvery: options.probePollEvery,
      escalationAssignee: options.escalationAssignee,
      // Host-git provisioning (#684/#686/#729): forward the run-level repo/base so the runner seeds the
      // `io.nanobpm.agentTask.repository` isolation envelope onto every agent cell's job. The envelope is
      // REQUIRED unless the run is EXPLICITLY `repoless` — an unresolved repo/base on a non-`repoless`
      // run is a hard launch failure (marked `failed` below via the catch), never a silent no-envelope
      // fallback to the shared launch dir. The dispatch door enforces the same contract at submit (400).
      repository: options.repository,
      baseBranch: options.baseBranch,
      repoless: options.repoless,
    });
  } catch (err) {
    await markClaimFailed();
    app.log.error("dispatch-delivery-graph launch threw", { runKey });
    throw err;
  }
  if (!launched.ok) {
    await markClaimFailed();
    app.log.error("dispatch-delivery-graph launch failed", { runKey, count: launched.errors.length });
    return { ok: false, errors: launched.errors };
  }

  // Stamp the started instance key onto the claimed row.
  {
    const running = buildDeliveryGraphRunRow({
      ...rowBase,
      status: "running",
      phase: DELIVERY_PHASE.RUNNING,
      processKey: launched.handle.processInstanceKey,
      processDefinitionId: launched.handle.processDefinitionId,
    });
    const { run_key, created_at, ...patch } = running;
    await runs.update(runKey, patch);
  }
  app.log.info("delivery graph dispatched", { runKey, processInstanceKey: launched.handle.processInstanceKey });
  return {
    ok: true,
    status: "running",
    runKey,
    digest,
    sideEffecting,
    alreadyRunning: false,
    identityConfirmed: true,
    processInstanceKey: launched.handle.processInstanceKey,
    processDefinitionId: launched.handle.processDefinitionId,
  };
}
