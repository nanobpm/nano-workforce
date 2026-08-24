// GET /app/api/delivery-graph/library/{id} → operationId `getLibraryEntry` (issue #522, epic #519 S3).
// Fetch one saved library entry by its `id`, including its full `graph` JSON (the S4 Reuse action loads
// it into the compose textarea; the S6 export action downloads it). An unknown id is a clean 404.
//
// The optional shared-secret guard mirrors the other read doors (getLineage / listActivePrs /
// listStagedProposals): when NANO_PR_WEBHOOK_SECRET is set, callers must present it via the
// x-hook-secret header; unset → open.

import { getLibraryEntry, libraryEntryDto } from "../app/deliveryGraphLibrary.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("getLibraryEntry", async ({ params, req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("getLibraryEntry rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  const entry = await getLibraryEntry(app.data, params.id);
  if (!entry) {
    return { status: 404, body: { error: `no library entry for id ${params.id}` } };
  }
  return { status: 200, body: libraryEntryDto(entry) };
});
