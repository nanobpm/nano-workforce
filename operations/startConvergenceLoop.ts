// POST /app/api/actions/start/convergence-loop → operationId `startConvergenceLoop` (ADR 0058/0059,
// base /app/api). The ONE door for starting a convergence loop — the page's "Start review" form, an
// external webhook relay, a CI job, and Swagger all POST here. Parse the PR reference and
// register/refresh the PR aggregate (idempotent on prKey) before starting the loop.
//
// The request body is FLAT (`{ pr | url, dependsOn?, maxRounds? }`), not wrapped in a `variables`
// envelope: this is a purpose-built operation, not a generic engine "start process" call, so it does
// not leak the engine's variable-map concept to callers. The runtime validates the body against
// openapi.yaml; this delegate keeps the PR-parse guard because the reference format (owner/repo#123
// or a URL) is app logic, not something the JSON schema can express — an unparseable reference is a 400.

import { clampRounds, MAX_ROUNDS, parsePr, submitPr } from "../app/service.ts";
import { defineOperation } from "../nano-generated/operations.ts";

export default defineOperation("startConvergenceLoop", async ({ body }, app) => {
  const b = body ?? {};
  const raw = String(b.pr ?? b.url ?? "").trim();
  const parsed = parsePr(raw);
  if (!parsed) {
    return { status: 400, body: { error: "could not parse PR (use owner/repo#123 or a PR URL)" } };
  }
  const dependsOn = Array.isArray(b.dependsOn) ? b.dependsOn.map((d) => String(d)) : [];
  const maxRounds = clampRounds(b.maxRounds, MAX_ROUNDS);
  return { status: 202, body: await submitPr(app.data, app.engine, parsed, dependsOn, maxRounds) };
});
