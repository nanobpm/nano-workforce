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

import { admitPlan, admitPlanErrorResponse, parseIssue, startPlan } from "../app/plan.ts";
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
  // Epic base branch (ADR 0003): admit the launch through the fail-fast `admitPlan` gate BEFORE any
  // fan-out. It composes the four ordered admission rules — required+explicit, create-if-missing
  // (epic/* guard, run synchronously so a typo is a clean edge 400), confirm-default, and
  // shared-base — and returns the normalized base. Errors map to specific HTTP statuses at the edge.
  const rawBase = "baseBranch" in body && typeof body.baseBranch === "string" ? body.baseBranch : null;
  const allowSharedBase = "allowSharedBase" in body && body.allowSharedBase === true;
  const confirmDefaultBase = "confirmDefaultBase" in body && body.confirmDefaultBase === true;
  const token = process.env.GITHUB_TOKEN ?? "";
  let normalizedBase: string;
  try {
    normalizedBase = await admitPlan(app.data, parsed.repo, rawBase, token, {
      allowSharedBase,
      confirmDefaultBase,
      selfPlanKey: parsed.planKey,
    });
  } catch (err) {
    const mapped = admitPlanErrorResponse(err);
    if (mapped) {
      app.log.warn("start-plan rejected: admission gate", { status: mapped.status, error: mapped.error });
      return { status: mapped.status, body: { error: mapped.error } };
    }
    throw err;
  }
  const result = await startPlan(app.data, app.engine, parsed, normalizedBase);
  const alreadyRunning = "alreadyRunning" in result && result.alreadyRunning === true;
  app.log.info("plan fan-out started", {
    planKey: parsed.planKey,
    // The base the caller requested. When `alreadyRunning`, `startPlan` short-circuits before this
    // base takes effect (it may not match the in-flight plan's persisted base), so name it as the
    // request — not the effective base — to keep the log honest.
    requestedBaseBranch: normalizedBase,
    alreadyRunning,
  });
  return { status: 202, body: result };
});
