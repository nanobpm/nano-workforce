// GET /app/api/agentic/supply → operationId `getAgenticSupply` (ADR 0058/0059 OpenAPI surface, mounted
// under base /app/api). The SUPPLY-ONLY visibility report the H5 cockpit page (#148) polls: the live
// worker list — family, host, current jobs, liveness — grouped by leaf token, sourced from the H1
// presence registry (#144). Read-only projection; it NEVER gates control flow (advisory-only, ADR 0056).
//
// H6 (#149) closes the loop: the correlation registry (`app/agentic/correlation.ts`) supplies the
// `jobKeysFor` resolver the presence snapshot exposes as a seam, so each worker's current jobKeys light
// up; each worker's drill `stream` is repointed at its jobKey-scoped relay stream (`job:<jobKey>`); and
// the report carries the `correlations` — the process-instance / plan context for every current job —
// so the cockpit lines a worker's terminal up with "that process instance / this plan".
//
// This is the supply half of the visibility plane only. The demand×supply matrix, missing-agent-type
// reds, and diversity-SLO lights are DE-SCOPED to the enrolment epic #152 — this report carries no
// demand-side fields, and the cockpit renders none.
//
// The optional shared-secret guard stays HERE (the runtime does not enforce OpenAPI `security`): when
// NANO_PR_WEBHOOK_SECRET is set, callers must present it via the x-hook-secret header. Unset → open.

import { type CorrelationRegistry, currentCorrelation, type JobCorrelation } from "../app/agentic/correlation.ts";
import { currentPresenceRegistry, type SupplyWorker } from "../app/agentic/families/presence.family.ts";
import { envVar } from "../app/version.ts";
import type { AgenticJobCorrelation, AgenticSupplyReport, AgenticSupplyWorker } from "../nano-generated/api-io.d.ts";
import { defineOperation } from "../nano-generated/operations.ts";

// The optional shared-secret guard: when NANO_PR_WEBHOOK_SECRET is set, callers must present it via
// the x-hook-secret header. Captured once, at module load.
const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

// Project a presence-registry row to the wire worker. The drill `stream` defaults to the worker
// instance (H5) but is repointed at the worker's jobKey-scoped relay stream (`job:<jobKey>`) when the
// correlation registry knows a current job for it (H6) — so drilling in opens the LIVE job's terminal.
function toWorker(w: SupplyWorker, correlation: CorrelationRegistry | undefined): AgenticSupplyWorker {
  const out: AgenticSupplyWorker = {
    instance: w.instance,
    identity: w.identity,
    stream: correlation?.primaryStreamFor(w.instance) ?? w.instance,
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

  // Thread the H6 correlation registry (if mounted) as the presence snapshot's jobKeysFor resolver so a
  // worker's current jobKeys populate; absent → jobKeys stay empty (advisory, never an error).
  const correlation = currentCorrelation();
  const snapshot = registry.snapshot(correlation ? { jobKeysFor: (instance) => correlation.jobKeysFor(instance) } : {});
  const report: AgenticSupplyReport = {
    count: snapshot.count,
    generatedAt: new Date().toISOString(),
    workers: snapshot.workers.map((w) => toWorker(w, correlation)),
    leaves: snapshot.leaves.map((leaf) => ({ token: leaf.token, workers: leaf.workers.map((w) => toWorker(w, correlation)) })),
    correlations: correlation ? correlation.snapshot().correlations.map(toCorrelation) : [],
  };
  return { status: 200, body: report };
});
