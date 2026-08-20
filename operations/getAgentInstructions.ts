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
import { resolveApiBase } from "../app/resolveApiBase.ts";
import { buildVersionInfo, envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("getAgentInstructions", ({ req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("getAgentInstructions rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  const baseUrl = resolveApiBase(req, "agent");
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
