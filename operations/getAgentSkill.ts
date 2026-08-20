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
import { buildVersionInfo, envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

/**
 * Reconstruct the app control-API base the caller reached us on (e.g. "https://host/app/api"), so
 * any embedded example is copy-pasteable. Honour reverse-proxy forwarding headers; fall back to a
 * localhost default when the Host header is absent (e.g. a raw unit-test request).
 */
function resolveApiBase(req: { path: string; headers: Headers }): string {
  const rawProto = (req.headers.get("x-forwarded-proto") ?? "http").split(",")[0].trim().toLowerCase();
  // x-forwarded-proto is user-controlled behind some proxies; only trust http/https.
  const proto = rawProto === "http" || rawProto === "https" ? rawProto : "http";
  const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").split(",")[0].trim();
  // The op is mounted at "<base>/agent/skill"; strip the trailing segments to recover the base path.
  const basePath = req.path.replace(/\/agent\/skill\/?$/, "") || "/app/api";
  return host ? `${proto}://${host}${basePath}` : `http://localhost:3000${basePath}`;
}

export default defineOperation("getAgentSkill", ({ req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("getAgentSkill rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  const baseUrl = resolveApiBase(req);
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
