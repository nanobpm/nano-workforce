// GET /app/api/agentic/agent-instances/{agentInstanceKey}/history → operationId `getAgentInstanceHistory`
// (issue #745/#747, umbrella #746).
//
// Fetch ONE AgentInstance's durable conversation history (turns + per-turn metrics) from the engine read
// model through the single engine-read seam — `@nanobpm/urban`'s `EngineClient.searchAgentInstanceHistory`
// / `getAgentInstance` (added in urban 0.93 / nanobpm/nano-ide#563). The cockpit renders the HISTORICAL
// transcript + metrics from this, keyed by `agentInstanceKey` — NEVER the slash-bearing relay stream id
// (#744 moot). The token-granular relay stays the LIVE overlay only.
//
// Advisory read-only (ADR 0056): observes the engine read model, never gates control flow. Read-as-absence
// — a blank/unknown key, or an engine with no AgentHistory channel (the testkit WASM double), yields an
// empty history (200), never an error. Shared-secret guard mirrors the other agentic reads.

import { type AgentHistoryQuery, readAgentHistory } from "../app/agentic/agent-history.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("getAgentInstanceHistory", async ({ params, query, req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("getAgentInstanceHistory rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  if (!app.engine) {
    app.log.warn("getAgentInstanceHistory: no engine client configured — no agent-history read path");
    return { status: 503, body: { error: "no engine read path available" } };
  }

  const filter: AgentHistoryQuery = {
    ...(query.role !== undefined ? { role: query.role } : {}),
    ...(query.loopIteration !== undefined ? { loopIteration: query.loopIteration } : {}),
    ...(query.elementInstanceKey !== undefined ? { elementInstanceKey: query.elementInstanceKey } : {}),
  };
  const body = await readAgentHistory(app.engine, params.agentInstanceKey, filter);
  return { status: 200, body };
});
