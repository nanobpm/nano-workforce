// GET /app/api/agentic/vocab → operationId `getAgenticVocab` (enrolment epic #152 / N1 #145, ADR 0059
// revised). Publishes the crew vocabulary artifact — the ONE capability→token map a worker resolves
// its SERVE set against — as `{ networks, requirements, version }`. Read-only and advisory; it never
// gates control flow.
//
// The optional shared-secret guard stays HERE (the runtime does not enforce OpenAPI `security`): when
// NANO_PR_WEBHOOK_SECRET is set, callers must present it via the x-hook-secret header. Unset → open.
import { vocabView } from "../app/agentic/vocab/publish.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("getAgenticVocab", ({ req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("getAgenticVocab rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  return { status: 200, body: vocabView() };
});
