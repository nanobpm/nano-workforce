// GET /app/api/delivery-graph/library → operationId `listLibrary` (issue #522, epic #519 S3). The read
// behind the Library App-View (S4/#523): every saved library entry, newest first, with its full
// `graph` JSON so the export affordance (S6/#525) can build a client-side download straight from the
// list payload.
//
// The optional shared-secret guard mirrors the other read doors (getLineage / listActivePrs /
// listStagedProposals): when NANO_PR_WEBHOOK_SECRET is set, callers must present it via the
// x-hook-secret header; unset → open.

import { libraryEntryDto, listLibraryEntries } from "../app/deliveryGraphLibrary.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("listLibrary", async ({ req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("listLibrary rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  const rows = await listLibraryEntries(app.data);
  const entries = rows.map(libraryEntryDto);
  return { status: 200, body: { count: entries.length, entries } };
});
