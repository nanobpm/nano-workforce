// GET /app/api/agentic/registry → operationId `getAgenticRegistry` (enrolment epic #152 / N1 #145, ADR
// 0056 §8–10, ADR 0059 revised). The demand×supply report: the deployed models' demand (their
// `taskDefinition` leaves, read from the engine over the C8 v2 REST API) diffed against live supply
// (the H1 presence registry resolved through the crew vocab), per network, with the missing-agent-type
// reds and the diversity SLO. Read-only and advisory; it NEVER gates control flow.
//
// The engine demand read degrades gracefully: if the engine is unreachable the report is computed
// supply-only with `demandUnavailable: true` (never a hard 5xx — the report is advisory).
//
// The optional shared-secret guard stays HERE (the runtime does not enforce OpenAPI `security`): when
// NANO_PR_WEBHOOK_SECRET is set, callers must present it via the x-hook-secret header. Unset → open.
import { computeRegistryReport, toWireReport } from "../app/agentic/vocab/demand-report.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("getAgenticRegistry", async ({ req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("getAgenticRegistry rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  const report = await computeRegistryReport(app.log);
  return { status: 200, body: toWireReport(report) };
});
