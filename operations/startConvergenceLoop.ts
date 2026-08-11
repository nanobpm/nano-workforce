// POST /app/api/actions/start/convergence-loop → operationId `startConvergenceLoop` (ADR 0058/0059,
// base /app/api). The ONE door for starting a convergence loop — the page's "Start review" form, an
// external webhook relay, a CI job, and Swagger all POST here. Parse the PR reference and
// register/refresh the PR aggregate (idempotent on prKey) before starting the loop.
//
// The request body is FLAT (`{ pr | url, dependsOn?, maxRounds?, convergeOnly? }`), not wrapped in a
// `variables` envelope: this is a purpose-built operation, not a generic engine "start process" call,
// so it does not leak the engine's variable-map concept to callers. The body is a `oneOf` — EXACTLY
// ONE of `pr` or `url` — so the runtime rejects an empty or ambiguous target at the edge (a 400 that
// names the allowed shapes); this delegate no longer coalesces `pr ?? url`, it just narrows the
// validated variant. It keeps the PR-parse guard because the reference FORMAT (owner/repo#123 or a
// URL) is app logic the JSON schema can't express — an unparseable reference is a 400.

import { clampRounds, MAX_ROUNDS, parsePr, submitPr } from "../app/service.ts";
import { defineOperation } from "../nano-generated/operations.ts";

export default defineOperation("startConvergenceLoop", async ({ body }, app) => {
  const raw = ("pr" in body ? body.pr : body.url).trim();
  const parsed = parsePr(raw);
  if (!parsed) {
    app.log.warn("start-convergence rejected: unparseable PR reference", { raw });
    return { status: 400, body: { error: "could not parse PR (use owner/repo#123 or a PR URL)" } };
  }
  const dependsOn = body.dependsOn ?? [];
  const maxRounds = clampRounds(body.maxRounds, MAX_ROUNDS);
  // Per-request review-only override: when true the PR stops at `converged` and is never
  // handed to the merge-loop, regardless of the global NANO_PR_AUTO_MERGE default.
  const convergeOnly = body.convergeOnly === true;
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
