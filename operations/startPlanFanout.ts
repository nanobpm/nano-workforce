// POST /app/api/actions/start/plan-fanout → operationId `startPlanFanout` (ADR 0058/0059, base
// /app/api). The ONE door for starting a planning fan-out — the epic page's "Plan & implement" form,
// an external webhook relay (a GitHub relay on issue open/label), a CI job, and Swagger all POST
// here. Parse the issue reference and register/refresh the plan aggregate (idempotent on planKey)
// before starting the planning fan-out. An unparseable reference is a 400; an already-running plan
// short-circuits.
//
// The request body is FLAT (`{ issue | url }`), not wrapped in a `variables` envelope — this is a
// purpose-built operation, not a generic engine "start process" call.

import { parseIssue, startPlan } from "../app/plan.ts";
import { defineOperation } from "../nano-generated/operations.ts";

export default defineOperation("startPlanFanout", async ({ body }, app) => {
  const b = body ?? {};
  const raw = String(b.issue ?? b.url ?? "").trim();
  const parsed = parseIssue(raw);
  if (!parsed) {
    return { status: 400, body: { error: "could not parse issue (use owner/repo#123 or an issue URL)" } };
  }
  return { status: 202, body: await startPlan(app.data, app.engine, parsed) };
});
