// GET /app/api/delivery-graph/vocabulary → operationId `getDeliveryGraphVocabulary` (epic
// nano-workforce#605, S3/#609). A read tool — projected onto the MCP surface like
// `getAgentInstructions` — that returns the closed delivery-graph vocabulary + wait-probe semantics
// as STRUCTURED JSON, so an agent can discover the node/probe/connector vocabulary and the non-obvious
// wait/poll/fact-threading rules from the surface instead of reading source (ADR 0005).
//
// The payload is derived from the implementing code (`app/deliveryGraphVocabulary.ts`) — every closed
// set is imported from its owning module, and a drift test fails the build if a probe kind / connector
// target lands in the compiler without a vocabulary entry. Cross-linked from docs/agent-guide.md §9.
//
// Read-only. The optional shared-secret guard mirrors /agent and /version: enforced HERE only when
// NANO_PR_WEBHOOK_SECRET is set (the runtime does not enforce OpenAPI `security`).
import { deliveryGraphVocabulary } from "../app/deliveryGraphVocabulary.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("getDeliveryGraphVocabulary", ({ req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("getDeliveryGraphVocabulary rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  return { status: 200, body: deliveryGraphVocabulary() };
});
