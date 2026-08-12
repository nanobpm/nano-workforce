// POST /app/api/actions/start/plan-fanout → operationId `startPlanFanout` (ADR 0058/0059, base
// /app/api). The ONE door for starting a planning fan-out — the epic page's "Plan & implement" form,
// an external webhook relay (a GitHub relay on issue open/label), a CI job, and Swagger all POST
// here. Parse the issue reference and register/refresh the plan aggregate (idempotent on planKey)
// before starting the planning fan-out. An unparseable reference is a 400; an already-running plan
// short-circuits.
//
// The request body is FLAT (`{ issue | url }`), not wrapped in a `variables` envelope — this is a
// purpose-built operation, not a generic engine "start process" call. The body is a `oneOf` — EXACTLY
// ONE of `issue` or `url` — so an empty or ambiguous target is a 400 at the edge; this delegate just
// narrows the validated variant and keeps the issue-FORMAT parse guard (schema can't express it).

import { parseIssue, startPlan } from "../app/plan.ts";
import { defineOperation } from "../nano-generated/operations.ts";

export default defineOperation("startPlanFanout", async ({ body }, app) => {
  // The runtime validates a well-formed body against openapi.yaml, but a directly-invoked delegate
  // (or a missing body) leaves `body` undefined — guard so that becomes a 400, not a 500 from `in`.
  if (!body || typeof body !== "object") {
    app.log.warn("start-plan rejected: missing request body");
    return { status: 400, body: { error: "request body is required (owner/repo#123 or an issue URL)" } };
  }
  const raw = ("issue" in body ? body.issue : body.url).trim();
  const parsed = parseIssue(raw);
  if (!parsed) {
    app.log.warn("start-plan rejected: unparseable issue reference", { raw });
    return { status: 400, body: { error: "could not parse issue (use owner/repo#123 or an issue URL)" } };
  }
  // Optional epic base branch: the branch the fleet branches off and opens every PR against instead
  // of the repo default. Present on both oneOf variants; blank/absent keeps the default-branch
  // behaviour. `startPlan` normalises blank → null.
  const baseBranch = "baseBranch" in body && typeof body.baseBranch === "string" ? body.baseBranch : null;
  const result = await startPlan(app.data, app.engine, parsed, baseBranch);
  app.log.info("plan fan-out started", {
    planKey: parsed.planKey,
    baseBranch: baseBranch?.trim() || "(default branch)",
    alreadyRunning: "alreadyRunning" in result && result.alreadyRunning === true,
  });
  return { status: 202, body: result };
});
