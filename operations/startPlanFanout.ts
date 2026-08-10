// POST /app/api/actions/start/plan-fanout → operationId `startPlanFanout` (ADR 0058, base /app/api).
// Replaces the hand-rolled action that overrode the generic "start process" palette action: parse the
// issue reference and register/refresh the plan aggregate (idempotent on planKey) before starting the
// planning fan-out. An unparseable reference is a 400; an already-running plan short-circuits.
import { defineOperation } from "@nanobpm/urban";
import { parseIssue, startPlan } from "../app/plan.ts";

interface Body {
  variables?: { issue?: string; url?: string };
}

type Res =
  | { planKey: string; alreadyRunning?: boolean; processKey?: string | null }
  | { error: string };

export default defineOperation<
  { params: Record<string, string>; query: Record<string, string | string[] | undefined>; body: Body },
  Res
>("startPlanFanout", async ({ body }, app) => {
  const vars = body?.variables ?? {};
  const raw = String(vars.issue ?? vars.url ?? "").trim();
  const parsed = parseIssue(raw);
  if (!parsed) {
    return { status: 400, body: { error: "could not parse issue (use owner/repo#123 or an issue URL)" } };
  }
  return { status: 202, body: await startPlan(app.data, app.engine, parsed) };
});
