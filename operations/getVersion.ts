// GET /app/api/version → operationId `getVersion` (ADR 0058 OpenAPI surface, mounted under base /app/api).
// The running app's identity (app + resolved @nanobpm/urban versions, git commit/branch, JS runtime,
// pid, uptime). Because the app runs its `.ts` sources directly from a checkout with no build step,
// restarts alone don't tell you whether a fix is live; this endpoint does.
//
// Read-only and unauthenticated by design (no secrets in the payload). The optional shared-secret
// guard stays HERE (the runtime does not enforce OpenAPI `security`); the OpenAPI document only
// routes GET to this operation, so a wrong method is a 404 from the router (no explicit 405 needed).

import { buildVersionInfo, envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

// The optional shared-secret guard: when NANO_PR_WEBHOOK_SECRET is set, callers must present it via
// the x-hook-secret header. Captured once, at module load.
const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("getVersion", ({ req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("getVersion rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  return { status: 200, body: buildVersionInfo() };
});
