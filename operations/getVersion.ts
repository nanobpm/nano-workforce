// GET /app/version → operationId `getVersion` (ADR 0058 OpenAPI surface, mounted under base /app).
// The running app's identity (app + resolved @nanobpm/urban versions, git commit/branch, JS runtime,
// pid, uptime). Because the app runs its `.ts` sources directly from a checkout with no build step,
// restarts alone don't tell you whether a fix is live; this endpoint does.
//
// Read-only and unauthenticated by design (no secrets in the payload). The optional shared-secret
// guard stays HERE (the runtime does not enforce OpenAPI `security`); the OpenAPI document only
// routes GET to this operation, so a wrong method is a 404 from the router (no explicit 405 needed).
import { defineOperation } from "@nanobpm/urban";
import { buildVersionInfo, envVar, type VersionInfo } from "../app/version.ts";

// Cross-runtime env read (Node `process.env` OR Deno `Deno.env`): reading via `process.env` alone
// would silently disable the guard under Deno/compiled runtimes where `process` is absent, leaving
// the endpoint open even when NANO_PR_WEBHOOK_SECRET is set. Captured once, at module load.
const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation<
  { params: Record<string, string>; query: Record<string, string | string[] | undefined>; body: undefined },
  VersionInfo | { error: string }
>("getVersion", ({ req }) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  return { status: 200, body: buildVersionInfo() };
});
