// GET /app/api/agentic/transcripts/{stream} → operationId `getAgenticTranscript` (ADR 0056, H3 #222).
//
// Fetch a stored transcript's bytes, range/offset-based (?from=<offset>, default 0) so the cockpit
// terminal replays a closed stream through the SAME resume-from-offset renderer it uses for a live one
// (static playback of an exited agent). Sourced from the mounted relay/transcript service's
// TranscriptStore over `app.data`, correlated best-effort via `app/agentic/correlation.ts`.
//
// This is the PATH-segment form, kept for back-compat with a worker-emitted `transcriptUrl` (a
// slash-free `job:<jobKey>` stream). A slash-bearing past-session stream id must instead use the
// proxy-safe QUERY form served by `listAgenticTranscripts` (`?stream=<enc>`, issue #744) — an encoded
// slash in a path segment is decoded by the console gateway proxy and 404s. Both forms resolve through
// the ONE shared reader (`resolveTranscriptRead`) so they can never drift.
//
// Advisory read-only (ADR 0056): it NEVER gates a BPMN sequence flow. Unknown stream -> 404; a
// malformed `from` -> 400. Shared-secret guard mirrors getAgenticSupply (x-hook-secret when
// NANO_PR_WEBHOOK_SECRET is set; unset -> open).

import { resolveTranscriptRead } from "../app/agentic/transcript-read-op.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("getAgenticTranscript", async ({ params, query, req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("getAgenticTranscript rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  return resolveTranscriptRead(params.stream, query.from);
});
