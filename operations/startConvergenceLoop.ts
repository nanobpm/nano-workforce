// POST /app/api/actions/start/convergence-loop → operationId `startConvergenceLoop` (ADR 0058/0059,
// base /app/api). The ONE door for starting a convergence loop — the page's "Start review" form, an
// external webhook relay, a CI job, and Swagger all POST here. Parse the PR reference and
// register/refresh the PR aggregate (idempotent on prKey) before starting the loop.
//
// The request body is FLAT (`{ pr | url, dependsOn?, maxRounds?, autoMerge?, convergeOnly? }`), not
// wrapped in a `variables` envelope: this is a purpose-built operation, not a generic engine "start
// process" call, so it does not leak the engine's variable-map concept to callers. `autoMerge` is
// the positive, preferred form for UI/API callers; `convergeOnly` remains a legacy negative alias.
// When both are present, `autoMerge` wins. The body is a `oneOf` — EXACTLY ONE of `pr` or `url` — so
// the runtime rejects an empty or ambiguous target at the edge (a 400 that names the allowed
// shapes); this delegate no longer coalesces `pr ?? url`, it just narrows the validated variant. It
// keeps the PR-parse guard because the reference FORMAT (owner/repo#123 or a URL) is app logic the
// JSON schema can't express — an unparseable reference is a 400.

import { clampRounds, MAX_ROUNDS, parsePr, submitPr } from "../app/service.ts";
import { defineOperation } from "../nano-generated/operations.ts";

export default defineOperation("startConvergenceLoop", async ({ body }, app) => {
  // The runtime validates a well-formed body against openapi.yaml, but a directly-invoked delegate
  // (or a missing body) leaves `body` undefined — guard so that becomes a 400, not a 500 from `in`.
  if (!body || typeof body !== "object") {
    app.log.warn("start-convergence rejected: missing request body");
    return { status: 400, body: { error: "request body is required (owner/repo#123 or a PR URL)" } };
  }
  const raw = ("pr" in body ? body.pr : body.url).trim();
  const parsed = parsePr(raw);
  if (!parsed) {
    app.log.warn("start-convergence rejected: unparseable PR reference", { raw });
    return { status: 400, body: { error: "could not parse PR (use owner/repo#123 or a PR URL)" } };
  }
  const dependsOn = body.dependsOn ?? [];
  const maxRounds = clampRounds(body.maxRounds, MAX_ROUNDS);
  // Prefer the positive autoMerge form so an unchecked UI box is explicitly review-only. Legacy
  // callers that omit autoMerge retain the existing convergeOnly/global-default behavior.
  const hasAutoMerge = "autoMerge" in body;
  const convergeOnly = hasAutoMerge ? body.autoMerge !== true : body.convergeOnly === true;
  const result = await submitPr(app.data, app.engine, parsed, dependsOn, maxRounds, convergeOnly);
  app.log.info("convergence loop started", {
    prKey: parsed.prKey,
    alreadyRunning: "alreadyRunning" in result && result.alreadyRunning === true,
    dependsOn: dependsOn.length,
    maxRounds,
    convergeOnly,
  });
  return { status: 202, body: result };
});
