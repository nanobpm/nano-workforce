// GET /app/api/run?key=<key> → operationId `getRun` (issue #1054). `d8ctl nwf show <key>`: look up ONE
// run by key — `owner/repo#N` (feature / epic / PR) or a delivery-graph runKey — at ANY stage, so a
// caller no longer filters the whole `/status` list client-side (and can see a feature run before its
// PR exists). The projection lives in app/runLookup.ts and reuses the `/status` row projections.
// Read-only. The optional shared-secret guard mirrors `listActivePrs`.
import { lookupRun } from "../app/runLookup.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("getRun", async ({ req, query }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("getRun rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  const key = typeof query.key === "string" ? query.key.trim() : "";
  const run = key === "" ? null : await lookupRun(app.data, app.engine, key);
  if (!run) return { status: 404, body: { error: `nwf has never tracked a run with key ${key}` } };
  return { status: 200, body: run };
});
