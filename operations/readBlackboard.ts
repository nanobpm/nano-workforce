// GET /app/api/hooks/blackboard?token=<capabilityToken> → operationId `readBlackboard` (ADR 0059
// webhook operation; was the GET half of the `/hooks/blackboard` action; Tier 1, issues #51 / #49 D4).
//
// A DIRECT side-channel for agents, distinct from the c8ctl-nano activation/completion channel. The
// per-plan capability token (query string) IS the credential: it scopes every read to exactly one
// plan, so no shared secret is needed — the agent curls the exact URL it was handed in its prompt.
// An unknown token is a 404 (never leaks which plans exist).
//
//   GET → { planKey, entries: [ { id, author_task, kind, files, body, wave, created_at } ], cursor }
//          optional ?since=<id> returns only entries with id > since (incremental poll). `cursor` is
//          the plan's current head id; pass it back as `since` on the next poll (Tier 2).
import { defineOperation } from "@nanobpm/urban";
import { planKeyForToken, readBlackboardPage } from "../app/blackboard.ts";

export default defineOperation<
  { params: Record<string, string>; query: { token?: string; since?: string }; body: unknown },
  { planKey: string; entries: unknown[]; cursor: number | null } | { error: string }
>("readBlackboard", async ({ req }, app) => {
  const token = (req.query.get("token") ?? req.headers.get("x-blackboard-token") ?? "").trim();
  if (!token) return { status: 400, body: { error: "missing blackboard token" } };
  const planKey = await planKeyForToken(app.data, token);
  if (!planKey) return { status: 404, body: { error: "unknown blackboard token" } };

  const rawSince = req.query.get("since");
  const since = rawSince != null && /^\d+$/.test(rawSince) ? Number(rawSince) : undefined;
  const { entries, cursor } = await readBlackboardPage(app.data, planKey, { since });
  return { status: 200, body: { planKey, entries, cursor } };
});
