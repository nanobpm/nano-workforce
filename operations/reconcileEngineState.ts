// POST /app/api/reconcile → operationId `reconcileEngineState` (ADR 0058/0059, base /app/api).
//
// The explicit OPERATOR COMMAND for the app-side engine-reset reconciliation surface (issue #622) —
// the on-demand twin of the startup pass in main.ts, sharing the one `runEngineReconcile` seam so the
// two paths can never diverge. An operator (or a restore runbook) POSTs here after resetting /
// restoring / rewinding the engine to converge `app.db`: it probes the engine incarnation epoch and,
// on a regression, drives every dangling engine-backed inflight row to the defined `orphaned` terminal
// with provenance. Idempotent (a matching epoch is a no-op) and safe (an unreachable engine orphans
// nothing), so it is harmless to run at any time — a green "nothing to do" is the common case.
//
// The engine address is the canonical `resolveEngineAddress` (the same precedence the engine client
// and startup preflight use), so the operator command talks to exactly the engine the app runs
// against. The optional shared-secret guard stays HERE (the runtime does not enforce OpenAPI
// `security`): when NANO_PR_WEBHOOK_SECRET is set, callers must present it via the x-hook-secret header.

import { resolveEngineAddress } from "../app/enginePreflight.ts";
import { runEngineReconcile } from "../app/reconcile.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("reconcileEngineState", async ({ req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("reconcileEngineState rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  if (!app.data) {
    app.log.warn("reconcileEngineState: no data source configured — nothing to reconcile");
    return { status: 503, body: { error: "no data source configured" } };
  }
  const engineAddress = resolveEngineAddress();
  const result = await runEngineReconcile(
    app.data,
    { restAddress: engineAddress.restAddress, token: envVar("CAMUNDA_TOKEN") ?? undefined },
    { log: { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) } },
  );
  app.log.info("reconcileEngineState complete", {
    reason: result.reason,
    orphanedCount: result.orphanedCount,
    runId: result.runId,
  });
  return { status: 200, body: result };
});
