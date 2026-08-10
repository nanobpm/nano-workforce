// POST /app/actions/start/convergence-loop → operationId `startConvergenceLoop` (ADR 0058, base /app).
// Replaces the hand-rolled action that overrode the generic "start process" palette action: parse the
// PR reference and register/refresh the PR aggregate (idempotent on prKey) before starting the loop.
//
// The runtime validates the body against openapi.json (a `variables` object is required); this
// delegate keeps the PR-parse guard because the reference format (owner/repo#123 or a URL) is app
// logic, not something the JSON schema can express — an unparseable reference is a 400.
import { defineOperation } from "@nanobpm/urban";
import { clampRounds, MAX_ROUNDS, parsePr, submitPr } from "../app/service.ts";

interface Body {
  variables?: { pr?: string; url?: string; dependsOn?: unknown; maxRounds?: unknown };
}

export default defineOperation<
  { params: Record<string, string>; query: Record<string, string | string[] | undefined>; body: Body },
  { prKey: string; alreadyRunning?: boolean; processKey?: string | null } | { error: string }
>("startConvergenceLoop", async ({ body }, app) => {
  const vars = body?.variables ?? {};
  const raw = String(vars.pr ?? vars.url ?? "").trim();
  const parsed = parsePr(raw);
  if (!parsed) {
    return { status: 400, body: { error: "could not parse PR (use owner/repo#123 or a PR URL)" } };
  }
  const dependsOn = Array.isArray(vars.dependsOn) ? vars.dependsOn.map((d) => String(d)) : [];
  const maxRounds = clampRounds(vars.maxRounds, MAX_ROUNDS);
  return { status: 202, body: await submitPr(app.data, app.engine, parsed, dependsOn, maxRounds) };
});
