// GET /app/api/status → operationId `listActivePrs` (ADR 0058 OpenAPI surface, mounted under base /app/api).
// List the PRs currently in flight (every tracked PR not converged/abandoned) so an operator or an
// external automation harness can see active work — and grab a `processKey` to cancel — without
// opening the DB or the UI. Read-only projection over the datasource.
//
// The runtime validates the (empty) request against openapi.yaml; the optional shared-secret guard
// stays HERE (the runtime does not enforce OpenAPI `security`): when NANO_PR_WEBHOOK_SECRET is set,
// callers must present it via the x-hook-secret header. Unset → open (unchanged default).

import { activeDeliveries, activePrs } from "../app/service.ts";
import { buildVersionInfo, envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

// The optional shared-secret guard: when NANO_PR_WEBHOOK_SECRET is set, callers must present it via
// the x-hook-secret header. Captured once, at module load.
const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("listActivePrs", async ({ req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("listActivePrs rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  // Per-phase timing (issue #936, budget raised for #947): /status regressed to ~13 s (and
  // serialised concurrent callers into proxy 502s) on an unprofiled per-row engine fan-out, then
  // to ~30 s on merlin when the batched fallback's page-cut probes still scaled with the fleet.
  // The merge-policy engine read is now served from the app's OWN projection (zero engine reads
  // for every projected row; the #937 batched read only for legacy rows), and these phase timings
  // make any future regression attributable from the logs instead of rediscovered by hand. Debug
  // level: /status is a hot polling endpoint, so this must not spam info.
  const t0 = Date.now();
  const [prs, deliveries] = await Promise.all([activePrs(app.data, app.engine), activeDeliveries(app.data)]);
  const readMs = Date.now() - t0;
  // The running app's identity, derived from the SAME app/version.ts getter /version uses (never
  // re-read), so the endpoint everyone polls answers "is the fix live?" in one call (issue #925).
  const { version, gitSha } = buildVersionInfo();
  app.log.debug("listActivePrs served", {
    ms: readMs,
    prRows: prs.length,
    deliveryRows: deliveries.length,
  });
  if (readMs > STATUS_SLOW_MS) {
    app.log.warn("listActivePrs slow", { ms: readMs, prRows: prs.length, deliveryRows: deliveries.length });
  }
  return { status: 200, body: { count: prs.length, prs, deliveries, version: { version, gitSha } } };
});

/** The wall-clock budget over which a /status serve is logged as slow (issue #947: raised from the
 *  #936 1 s to 5 s — the console-proxy timeout is the hard ceiling this must never approach; the
 *  acceptance target is 2 s at fleet scale, so 5 s leaves headroom that is still an unmistakable
 *  regression signal an operator can grep for). The endpoint targets well under 1 s for a handful
 *  of rows now that the merge policy is served from the app's own projection. */
const STATUS_SLOW_MS = 5_000;
