// GET /app/api/agentic/supply → operationId `getAgenticSupply` (ADR 0058/0059 OpenAPI surface, mounted
// under base /app/api). The SUPPLY-ONLY visibility report the H5 cockpit page (#148) polls: the live
// worker list — family, host, current jobs, liveness — grouped by leaf token, sourced from the H1
// presence registry (#144). Read-only projection; it NEVER gates control flow (advisory-only, ADR 0056).
//
// H6/#713 closes the loop with an EXPLICIT claim registry (`app/agentic/claim-registry.ts`): it is the
// AUTHORITATIVE source the presence snapshot's `jobKeysFor` seam resolves against, so each worker's
// current jobKeys light up from `claim` frames — not inferred from the relay terminal — and appear even
// with ZERO transcript. Each worker's drill `stream` is repointed at its claimed jobKey-scoped relay
// stream (`job:<jobKey>`), keyed by the CLAIM (explicit instance+jobKey), not by a connection. The
// relay correlation registry is DEMOTED to drill-in context only: it still supplies the `correlations`
// — the process-instance / plan context for a job's terminal — so the cockpit lines a worker's terminal
// up with "that process instance / this plan", but it is no longer the visibility source.
//
// This is the supply half of the visibility plane only. The demand×supply matrix, missing-agent-type
// reds, and diversity-SLO lights are DE-SCOPED to the enrolment epic #152 — this report carries no
// demand-side fields, and the cockpit renders none.
//
// The optional shared-secret guard stays HERE (the runtime does not enforce OpenAPI `security`): when
// NANO_PR_WEBHOOK_SECRET is set, callers must present it via the x-hook-secret header. Unset → open.

import { type ClaimRegistry, currentClaimRegistry } from "../app/agentic/claim-registry.ts";
import { currentCorrelation, type JobCorrelation } from "../app/agentic/correlation.ts";
import { currentPresenceRegistry, type SupplyWorker } from "../app/agentic/families/presence.family.ts";
import { envVar } from "../app/version.ts";
import type { AgenticJobCorrelation, AgenticSupplyReport, AgenticSupplyWorker } from "../nano-generated/api-io.d.ts";
import { defineOperation } from "../nano-generated/operations.ts";

// The optional shared-secret guard: when NANO_PR_WEBHOOK_SECRET is set, callers must present it via
// the x-hook-secret header. Captured once, at module load.
const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

// Project a presence-registry row to the wire worker. The drill `stream` defaults to the worker
// instance (H5) but is repointed at the worker's claimed jobKey-scoped relay stream (`job:<jobKey>`)
// when the claim registry knows a current claim for it (#713) — keyed by the CLAIM, not by the
// connection — so drilling in opens the LIVE job's terminal even before any transcript lands.
function toWorker(w: SupplyWorker, claims: ClaimRegistry | undefined): AgenticSupplyWorker {
  const out: AgenticSupplyWorker = {
    instance: w.instance,
    identity: w.identity,
    stream: claims?.primaryStreamFor(w.instance) ?? w.instance,
    jobKeys: [...w.jobKeys],
    live: w.live,
    staleMs: w.staleMs,
  };
  if (w.family !== undefined) out.family = w.family;
  if (w.host !== undefined) out.host = w.host;
  return out;
}

// Project a correlation-registry entry to the wire correlation. Optional fields are only set when
// known (biome bans `undefined`-valued keys crossing the boundary).
function toCorrelation(c: JobCorrelation): AgenticJobCorrelation {
  const out: AgenticJobCorrelation = { jobKey: c.jobKey, stream: c.stream };
  if (c.processInstanceKey !== undefined) out.processInstanceKey = c.processInstanceKey;
  if (c.bpmnProcessId !== undefined) out.bpmnProcessId = c.bpmnProcessId;
  if (c.elementId !== undefined) out.elementId = c.elementId;
  if (c.planKey !== undefined) out.planKey = c.planKey;
  return out;
}

export default defineOperation("getAgenticSupply", async ({ req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("getAgenticSupply rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }

  const registry = currentPresenceRegistry();
  if (!registry) {
    // The presence family has not mounted (or has torn down) — no supply to report, not an error.
    const empty: AgenticSupplyReport = { count: 0, generatedAt: new Date().toISOString(), workers: [], leaves: [], correlations: [] };
    return { status: 200, body: empty };
  }

  // #713: the CLAIM registry (if mounted) is the authoritative `jobKeysFor` source the presence
  // snapshot resolves against — a worker's current jobKeys come from explicit `claim` frames, not the
  // relay terminal, so they populate with zero transcript. Absent → jobKeys stay empty (advisory).
  const claims = currentClaimRegistry();
  // The correlation registry is demoted to drill-in context only: it still carries the per-job
  // process-instance / plan context surfaced in `correlations`, but no longer feeds visibility.
  const correlation = currentCorrelation();
  const snapshot = registry.snapshot(claims ? { jobKeysFor: (instance) => claims.jobKeysFor(instance) } : {});
  const report: AgenticSupplyReport = {
    count: snapshot.count,
    generatedAt: new Date().toISOString(),
    workers: snapshot.workers.map((w) => toWorker(w, claims)),
    leaves: snapshot.leaves.map((leaf) => ({ token: leaf.token, workers: leaf.workers.map((w) => toWorker(w, claims)) })),
    correlations: correlation ? correlation.snapshot().correlations.map(toCorrelation) : [],
  };
  return { status: 200, body: report };
});
