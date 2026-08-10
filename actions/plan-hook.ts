// POST /hooks/plan — kick off a planning fan-out out of band (shared-secret auth via
// X-Hook-Secret). Lets an external system (a GitHub webhook relay on issue open/label, a CI job)
// hand an issue to the fleet. Same idempotent startPlan path as the page's "Plan issue" action.
import type { ActionHandler } from "@nanobpm/urban";
import { parseIssue, startPlan } from "../app/plan.ts";

const WEBHOOK_SECRET = process.env.NANO_PR_WEBHOOK_SECRET ?? "";

const handler: ActionHandler = async ({ req, body }, app) => {
  if (WEBHOOK_SECRET && req.headers.get("x-hook-secret") !== WEBHOOK_SECRET) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
  const b = (body ?? {}) as { url?: unknown; issue?: unknown };
  // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
  const parsed = parseIssue(String((b.issue ?? b.url ?? "") as string));
  if (!parsed) return { status: 400, body: { error: "could not parse issue (use owner/repo#123 or an issue URL)" } };
  return { status: 202, body: await startPlan(app.data, app.engine, parsed) };
};

export default handler;
