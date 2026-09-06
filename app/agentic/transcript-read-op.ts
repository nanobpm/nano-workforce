// nano-workforce — the SHARED single-transcript READ resolver (issue #744).
//
// Both transcript READ operations serve the SAME stored-transcript-bytes payload, differing ONLY in
// how the stream id reaches them:
//   - `getAgenticTranscript`  — the id is a PATH segment (`GET .../agentic/transcripts/{stream}`),
//     kept for back-compat (a worker-emitted `transcriptUrl` for a slash-free `job:<jobKey>` stream).
//   - `listAgenticTranscripts` — the id is the `stream` QUERY parameter (`GET
//     .../agentic/transcripts?stream=<enc>`), the proxy-safe form a slash-bearing past-session id must
//     use (see `transcript-read-url.ts`).
//
// This module is the ONE implementation of the read itself (validate `from`, resolve the mounted
// relay/transcript service, read the durable store with the #486 live-ring fallback, correlate
// best-effort) so the two entry points can never drift: a fix here fixes both. Advisory read-only
// (ADR 0056) — it NEVER gates a BPMN sequence flow.

import type { AgenticTranscriptData } from "../../nano-generated/api-io.d.ts";
import { currentCorrelation } from "./correlation.ts";
import { currentRelayTranscriptService } from "./families/relay.family.ts";
import { readTranscriptFrom } from "./transcript-read.ts";

/** The status + body a transcript read resolves to (200 with the bytes, or a 400/404 error body). */
export interface TranscriptReadResult {
  readonly status: number;
  readonly body: AgenticTranscriptData | { error: string };
}

/**
 * Resolve one stored transcript's bytes from offset `from` (inclusive, default 0). An empty/blank
 * `stream` or a malformed `from` is a 400; no mounted service / unknown stream is a 404; otherwise 200
 * with the range/offset payload the cockpit terminal replays through the SAME resume-from-offset
 * renderer it uses for a live stream.
 */
export function resolveTranscriptRead(stream: string, fromRaw: number | undefined): TranscriptReadResult {
  // A blank stream id (`?stream=` or whitespace) is a MALFORMED request, not an unknown-stream 404:
  // conflating the two would mask a client bug that drops the id (issue #744 query form). Reject it up
  // front so a genuine 404 only ever means "this id resolved to no stored transcript".
  if (stream.trim() === "") {
    return { status: 400, body: { error: "invalid stream: expected a non-empty stream id" } };
  }
  const from = fromRaw ?? 0;
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
    stream,
    from,
    service.store,
    currentCorrelation(),
    service.correlationStore,
    service.liveFallback(stream),
  );
  if (data === undefined) {
    return { status: 404, body: { error: "no transcript for stream" } };
  }
  return { status: 200, body: data };
}
