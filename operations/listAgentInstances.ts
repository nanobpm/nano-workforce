// GET /app/api/agentic/agent-instances → operationId `listAgentInstances` (issue #745/#747, umbrella #746).
//
// The CONSUMER half of the engine-native agent-transcript work: list the durable AgentInstances the
// worker harness minted (against the `<zeebe:agentDefinition agentType="external"/>` marker, #748), read
// back from the engine read model through the SINGLE engine-read seam — `@nanobpm/urban`'s `EngineClient`
// (`searchAgentInstances`, added in urban 0.93 / nanobpm/nano-ide#563). Feeds the cockpit "historical
// sessions" view (settled history = engine; the token-granular relay stays the LIVE overlay only).
//
// Keyed/filtered by process / element / status — NEVER the slash-bearing `job:<jobKey>` relay stream id,
// so the #744 gateway-proxy bug class is moot for settled history. Advisory read-only (ADR 0056): it
// observes the engine read model, never activates/completes a job or gates a sequence flow.
//
// Read-as-absence: the testkit WASM double records no AgentInstance channel (returns an empty list), and
// a live engine with no matching instance does the same — an empty list is a 200, never an error. The
// optional shared-secret guard mirrors the other agentic reads (x-hook-secret when NANO_PR_WEBHOOK_SECRET
// is set; unset -> open).

import { type AgentInstanceQuery, listAgentInstances } from "../app/agentic/agent-history.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("listAgentInstances", async ({ query, req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("listAgentInstances rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  if (!app.engine) {
    app.log.warn("listAgentInstances: no engine client configured — no agent-history read path");
    return { status: 503, body: { error: "no engine read path available" } };
  }

  const filter: AgentInstanceQuery = {
    ...(query.processInstanceKey !== undefined ? { processInstanceKey: query.processInstanceKey } : {}),
    ...(query.rootProcessInstanceKey !== undefined ? { rootProcessInstanceKey: query.rootProcessInstanceKey } : {}),
    ...(query.elementId !== undefined ? { elementId: query.elementId } : {}),
    ...(query.status !== undefined ? { status: query.status } : {}),
  };
  const body = await listAgentInstances(app.engine, filter);
  return { status: 200, body };
});
