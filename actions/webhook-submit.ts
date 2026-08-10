// POST /hooks/submit — submit a PR out-of-band (shared-secret auth via X-Hook-Secret). Not
// part of the page UI; lets an external system (a GitHub webhook relay, a CI job) kick off a
// convergence run. Same idempotent submit path as the page's "Start review" action.
import type { ActionHandler } from "@nanobpm/urban";
import { clampRounds, MAX_ROUNDS, parsePr, submitPr } from "../app/service.ts";

const WEBHOOK_SECRET = process.env.NANO_PR_WEBHOOK_SECRET ?? "";

const handler: ActionHandler = async ({ req, body }, app) => {
  if (WEBHOOK_SECRET && req.headers.get("x-hook-secret") !== WEBHOOK_SECRET) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
  const b = (body ?? {}) as { url?: unknown; pr?: unknown; dependsOn?: unknown; maxRounds?: unknown };
  const parsed = parsePr(String(b.url ?? b.pr ?? ""));
  if (!parsed) return { status: 400, body: { error: "could not parse PR url" } };
  const dependsOn = Array.isArray(b.dependsOn) ? b.dependsOn.map((d) => String(d)) : [];
  const maxRounds = clampRounds(b.maxRounds, MAX_ROUNDS);
  return { status: 202, body: await submitPr(app.data, app.engine, parsed, dependsOn, maxRounds) };
};

export default handler;
