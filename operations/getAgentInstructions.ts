// GET /app/api/agent → operationId `getAgentInstructions` (ADR 0058/0059 OpenAPI surface, base
// /app/api). Serves the agent operator guide: how to submit a PR for convergence (review-only vs.
// merge), submit an epic, answer escalations, and debug the system (find engine instances, relate
// them to PRs, inspect the models/prompts, unstick stuck processes, and raise issues/PRs). A user
// can point their coding agent at this URL and it can drive AND debug the workforce.
//
// The runtime serializes an operation body as JSON, so the markdown guide is returned as the
// `instructions` string field (alongside the app version + the base URLs the examples are keyed
// to), rather than as a raw text/markdown body. The embedded examples are rewritten to THIS
// instance's control-API base (derived from the request) and engine base (from the environment).
//
// Read-only. The optional shared-secret guard mirrors /version: enforced HERE only when
// NANO_PR_WEBHOOK_SECRET is set (the runtime does not enforce OpenAPI `security`).

import { renderAgentGuide, resolveEngineBase } from "../app/agentGuide.ts";
import { buildVersionInfo, envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

/**
 * Reconstruct the app control-API base the caller reached us on (e.g. "https://host/app/api"), so
 * the guide's example commands are copy-pasteable. Honour reverse-proxy forwarding headers; fall
 * back to a localhost default when the Host header is absent (e.g. a raw unit-test request).
 */
function resolveApiBase(req: { path: string; headers: Headers }): string {
  const rawProto = (req.headers.get("x-forwarded-proto") ?? "http").split(",")[0].trim().toLowerCase();
  // x-forwarded-proto is user-controlled behind some proxies; only trust http/https.
  const proto = rawProto === "http" || rawProto === "https" ? rawProto : "http";
  const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").split(",")[0].trim();
  // The op is mounted at "<base>/agent"; strip the trailing segment to recover the base path.
  const basePath = req.path.replace(/\/agent\/?$/, "") || "/app/api";
  return host ? `${proto}://${host}${basePath}` : `http://localhost:3000${basePath}`;
}

export default defineOperation("getAgentInstructions", ({ req }) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
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
      engineBase: resolveEngineBase(),
      instructions: renderAgentGuide(baseUrl),
    },
  };
});
