// GET /app/api/prs/history → operationId `getPrHistory` (issue #668, N4 of epic #664). Surface a PR's
// escalation + round history — "why did this escalate?" / "what happened in prior rounds?" — as an
// MCP read tool, so an operator or external harness no longer has to ssh into the instance and query
// the `escalations`/`rounds` tables by hand.
//
// Read-only projection over the SAME `rounds`/`escalations` tables the Convergence page's PR detail
// reads (see app/prHistory.ts). Identify the PR by `prKey` directly, or by `processKey` (resolved to
// its pr_key). At least one is required; neither → 400.
//
// The optional shared-secret guard stays HERE (the runtime does not enforce OpenAPI `security`):
// when NANO_PR_WEBHOOK_SECRET is set, callers must present it via the x-hook-secret header.
import { prHistory, prKeyForProcess } from "../app/prHistory.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("getPrHistory", async ({ query, req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("getPrHistory rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  const rawPrKey = query.prKey;
  const rawProcessKey = query.processKey;
  const prKeyArg = typeof rawPrKey === "string" ? rawPrKey.trim() : "";
  const processKeyArg = typeof rawProcessKey === "string" ? rawProcessKey.trim() : "";

  if (!prKeyArg && !processKeyArg) {
    return { status: 400, body: { error: "prKey or processKey is required" } };
  }

  const prKey = prKeyArg || (await prKeyForProcess(app.data, processKeyArg));
  if (!prKey) {
    // A processKey with no tracked PR: report an empty history for a stable, echoable identity
    // rather than a 404, mirroring getLineage's "empty if unknown" read semantics.
    return { status: 200, body: { prKey: processKeyArg, rounds: [], escalations: [] } };
  }

  const history = await prHistory(app.data, prKey);
  return { status: 200, body: history };
});
