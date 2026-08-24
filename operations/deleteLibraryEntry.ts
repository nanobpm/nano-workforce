// DELETE /app/api/delivery-graph/library/{id} → operationId `deleteLibraryEntry` (issue #522, epic
// #519 S3). Delete one saved library entry by its `id`. Idempotent: deleting an id that names no entry
// returns `deleted: false` (a clean no-op), not an error — so a double-click / retry from the S4
// Library App-View never errors.
//
// The optional shared-secret guard mirrors the other write/read doors: when NANO_PR_WEBHOOK_SECRET is
// set, callers must present it via the x-hook-secret header; unset → open.

import { deleteLibraryEntry } from "../app/deliveryGraphLibrary.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("deleteLibraryEntry", async ({ params, req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("deleteLibraryEntry rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  const deleted = await deleteLibraryEntry(app.data, params.id);
  app.log.info("delete-library-entry", { id: params.id, deleted });
  return { status: 200, body: { ok: true, deleted } };
});
