// GET /app/api/agentic/supply → operationId `getAgenticSupply` (ADR 0058/0059 OpenAPI surface, mounted
// under base /app/api). The SUPPLY-ONLY visibility report the H5 cockpit page (#148) polls: the live
// worker list — family, host, current jobs, liveness — grouped by leaf token, sourced from the H1
// presence registry (#144). Read-only projection; it NEVER gates control flow (advisory-only, ADR 0056).
//
// This is the supply half of the visibility plane only. The demand×supply matrix, missing-agent-type
// reds, and diversity-SLO lights are DE-SCOPED to the enrolment epic #152 — this report carries no
// demand-side fields, and the cockpit renders none.
//
// The optional shared-secret guard stays HERE (the runtime does not enforce OpenAPI `security`): when
// NANO_PR_WEBHOOK_SECRET is set, callers must present it via the x-hook-secret header. Unset → open.

import { currentPresenceRegistry, type SupplyWorker } from "../app/agentic/families/presence.family.ts";
import { envVar } from "../app/version.ts";
import type { AgenticSupplyReport, AgenticSupplyWorker } from "../nano-generated/api-io.d.ts";
import { defineOperation } from "../nano-generated/operations.ts";

// The optional shared-secret guard: when NANO_PR_WEBHOOK_SECRET is set, callers must present it via
// the x-hook-secret header. Captured once, at module load.
const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

// The relay stream id to subscribe when drilling into a worker's terminal. Presence keys the relay by
// worker instance; the H6 correlation slice (#149) may repoint this at a jobKey-scoped stream.
function toWorker(w: SupplyWorker): AgenticSupplyWorker {
  const out: AgenticSupplyWorker = {
    instance: w.instance,
    identity: w.identity,
    stream: w.instance,
    jobKeys: [...w.jobKeys],
    live: w.live,
    staleMs: w.staleMs,
  };
  if (w.family !== undefined) out.family = w.family;
  if (w.host !== undefined) out.host = w.host;
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
    const empty: AgenticSupplyReport = { count: 0, generatedAt: new Date().toISOString(), workers: [], leaves: [] };
    return { status: 200, body: empty };
  }

  const snapshot = registry.snapshot();
  const report: AgenticSupplyReport = {
    count: snapshot.count,
    generatedAt: new Date().toISOString(),
    workers: snapshot.workers.map(toWorker),
    leaves: snapshot.leaves.map((leaf) => ({ token: leaf.token, workers: leaf.workers.map(toWorker) })),
  };
  return { status: 200, body: report };
});
