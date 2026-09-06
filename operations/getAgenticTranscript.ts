// GET /app/api/agentic/transcripts/{stream} → operationId `getAgenticTranscript` (ADR 0056, H3 #222).
//
// Fetch a stored transcript's bytes, range/offset-based (?from=<offset>, default 0) so the cockpit
// terminal replays a closed stream through the SAME resume-from-offset renderer it uses for a live one
// (static playback of an exited agent). The PATH form of the single-stream read, kept for back-compat
// (the worker-emitted `transcriptUrl` and Explorer links resolve here — safe because `job:<jobKey>`
// ids never contain a slash); proxy-exposed clients use the `?stream=` QUERY form on the collection
// route instead (#744 — a gateway that decodes %2F in a path segment 404s this route). Both forms run
// the ONE canonical read (`readSingleTranscript` in app/agentic/transcript-read.ts), so they can never
// answer differently for the same stream/from.
//
// Advisory read-only (ADR 0056): it NEVER gates a BPMN sequence flow. Unknown stream -> 404; a
// malformed `from` -> 400. Shared-secret guard mirrors getAgenticSupply (x-hook-secret when
// NANO_PR_WEBHOOK_SECRET is set; unset -> open).

import { currentCorrelation } from "../app/agentic/correlation.ts";
import { currentRelayTranscriptService } from "../app/agentic/families/relay.family.ts";
import { readSingleTranscript } from "../app/agentic/transcript-read.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("getAgenticTranscript", async ({ params, query, req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("getAgenticTranscript rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }

  return readSingleTranscript(params.stream, query.from, currentRelayTranscriptService(), currentCorrelation());
});
