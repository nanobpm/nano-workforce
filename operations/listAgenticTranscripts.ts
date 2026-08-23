// GET /app/api/agentic/transcripts → operationId `listAgenticTranscripts` (ADR 0056, H3 read path #222).
//
// The READ counterpart to the write-only transcript store (H3 #146): it lists the durable transcripts an
// ephemeral agent flushed on job completion, so an operator can review "what did that agent do" AFTER it
// is gone. Sourced from the mounted relay/transcript service's TranscriptStore (over `app.data`) and
// correlated via `app/agentic/correlation.ts` (best-effort — jobKey is always recovered from the stream
// id, engine context only while the job is still live). Feeds the cockpit "past sessions" view.
//
// Advisory read-only (ADR 0056): it NEVER gates a BPMN sequence flow. Optional filters (jobKey / process
// instance / plan / time) narrow the feed. The optional shared-secret guard mirrors getAgenticSupply:
// when NANO_PR_WEBHOOK_SECRET is set, callers must present it via the x-hook-secret header; unset -> open.

import { currentCorrelation } from "../app/agentic/correlation.ts";
import { currentRelayTranscriptService } from "../app/agentic/families/relay.family.ts";
import { listTranscripts, type TranscriptFilter } from "../app/agentic/transcript-read.ts";
import { envVar } from "../app/version.ts";
import type { AgenticTranscriptList } from "../nano-generated/api-io.d.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

/** Reject an ISO-8601 filter that does not parse (a malformed since/until is a 400, not a silent no-op). */
function badInstant(value: string | undefined): boolean {
  return value !== undefined && !Number.isFinite(Date.parse(value));
}

export default defineOperation("listAgenticTranscripts", async ({ query, req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("listAgenticTranscripts rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }

  if (badInstant(query.since) || badInstant(query.until)) {
    return { status: 400, body: { error: "invalid since/until: expected an ISO-8601 instant" } };
  }

  const service = currentRelayTranscriptService();
  const store = service?.store;
  if (!store) {
    // The relay family has not mounted, or is running unpersisted (no DataLayer) - no transcripts to
    // report, not an error (advisory).
    const empty: AgenticTranscriptList = { count: 0, generatedAt: new Date().toISOString(), transcripts: [] };
    return { status: 200, body: empty };
  }

  const filter: TranscriptFilter = {
    ...(query.jobKey !== undefined ? { jobKey: query.jobKey } : {}),
    ...(query.processInstanceKey !== undefined ? { processInstanceKey: query.processInstanceKey } : {}),
    ...(query.planKey !== undefined ? { planKey: query.planKey } : {}),
    ...(query.instance !== undefined ? { instance: query.instance } : {}),
    ...(query.since !== undefined ? { since: query.since } : {}),
    ...(query.until !== undefined ? { until: query.until } : {}),
  };
  const transcripts = listTranscripts(store, currentCorrelation(), filter, service?.correlationStore);
  const body: AgenticTranscriptList = {
    count: transcripts.length,
    generatedAt: new Date().toISOString(),
    retentionMs: store.ephemeralRetentionMs,
    transcripts,
  };
  return { status: 200, body };
});
