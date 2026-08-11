// GET /app/api/hooks/abandon?token=<capabilityToken> → operationId `checkAbandon` (ADR 0059
// webhook operation; was the `/hooks/abandon` action, issue #76).
//
// A DIRECT side-channel for a running `senior:*` agent to learn whether its run was cancelled
// before it performs an irreversible side effect (push / open PR / request review / merge). The
// per-PR capability token (query string) IS the credential: it scopes the read to exactly one PR,
// so no shared secret is needed — the agent curls the exact URL it was handed in its prompt. An
// unknown token is a 404 (never leaks which PRs exist).
//
//   GET → { prKey, status, abandoned }  — `abandoned` is derived from `pull_requests.status`,
//          which Urban's cancel primitive sets to 'abandoned' on cancel. `true` ⇒ the agent must stop.

import { abandonStatusForToken } from "../app/abandon.ts";
import { defineOperation } from "../nano-generated/operations.ts";

export default defineOperation("checkAbandon", async ({ req }, app) => {
  const token = (req.query.get("token") ?? req.headers.get("x-abandon-token") ?? "").trim();
  if (!token) return { status: 400, body: { error: "missing abandon token" } };
  const state = await abandonStatusForToken(app.data, token);
  if (!state) {
    app.log.warn("checkAbandon: unknown abandon token");
    return { status: 404, body: { error: "unknown abandon token" } };
  }
  return { status: 200, body: state };
});
