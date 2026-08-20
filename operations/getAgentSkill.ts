// GET /app/api/agent/skill → operationId `getAgentSkill` (ADR 0058/0059 OpenAPI surface, base
// /app/api). Serves the portable operator *skill* (SKILL.md) an agent runtime loads on demand: a
// thin bootstrap that resolves which instance to drive and then fetches the live operator guide
// (GET /app/api/agent). Companion to getAgentInstructions.
//
// The runtime serializes an operation body as JSON, so the markdown skill is returned as the
// `skill` string field (alongside the app version + the base URL it was fetched from). Any
// `__BASE__` example is rewritten to THIS instance's control-API base (derived from the request).
//
// Read-only. The optional shared-secret guard mirrors /version and /agent: enforced HERE only when
// NANO_PR_WEBHOOK_SECRET is set (the runtime does not enforce OpenAPI `security`).

import { renderAgentSkill } from "../app/agentSkill.ts";
import { resolveApiBase } from "../app/resolveApiBase.ts";
import { buildVersionInfo, envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("getAgentSkill", ({ req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("getAgentSkill rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  const baseUrl = resolveApiBase(req, "agent/skill");
  return {
    status: 200,
    body: {
      format: "markdown",
      appVersion: buildVersionInfo().version,
      generatedAt: new Date().toISOString(),
      baseUrl,
      skill: renderAgentSkill(baseUrl),
    },
  };
});
