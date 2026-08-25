// GET /app/api/agentic/transcripts/{stream} → operationId `getAgenticTranscript` (ADR 0056, H3 #222).
//
// Fetch a stored transcript's bytes, range/offset-based (?from=<offset>, default 0) so the cockpit
// terminal replays a closed stream through the SAME resume-from-offset renderer it uses for a live one
// (static playback of an exited agent). Sourced from the mounted relay/transcript service's
// TranscriptStore over `app.data`, correlated best-effort via `app/agentic/correlation.ts`.
//
// Advisory read-only (ADR 0056): it NEVER gates a BPMN sequence flow. Unknown stream -> 404; a
// malformed `from` -> 400. Shared-secret guard mirrors getAgenticSupply (x-hook-secret when
// NANO_PR_WEBHOOK_SECRET is set; unset -> open).

import { currentCorrelation } from "../app/agentic/correlation.ts";
import { currentRelayTranscriptService } from "../app/agentic/families/relay.family.ts";
import { readTranscriptFrom } from "../app/agentic/transcript-read.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("getAgenticTranscript", async ({ params, query, req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("getAgenticTranscript rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }

  const from = query.from ?? 0;
  if (!Number.isSafeInteger(from) || from < 0) {
    return { status: 400, body: { error: "invalid from: expected a non-negative integer offset" } };
  }

  const service = currentRelayTranscriptService();
  if (!service) {
    // No relay/transcript service mounted at all - nothing to replay.
    return { status: 404, body: { error: "no transcript for stream" } };
  }

  // Read the durable store first, falling back to the still-live relay ring (#486) so a `transcriptUrl`
  // emitted by a job on a still-live multiplexing worker is readable before its ring is flushed.
  const data = readTranscriptFrom(
    params.stream,
    from,
    service.store,
    currentCorrelation(),
    service.correlationStore,
    service.liveFallback(params.stream),
  );
  if (data === undefined) {
    return { status: 404, body: { error: "no transcript for stream" } };
  }
  return { status: 200, body: data };
});
