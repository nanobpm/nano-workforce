// GET /app/version — the running app's identity (ADR: version endpoint for debugging).
//
// Answers "which code is this process actually running?" — the app version, the resolved
// `@nanobpm/urban` runtime version, the git commit/branch of the working tree, the JS runtime,
// pid, and how long it has been up. Because the app runs its `.ts` sources directly from a
// checkout with no build step, restarts alone don't tell you whether the fix you shipped is live;
// this endpoint does.
//
// Read-only and unauthenticated by design (no secrets in the payload); it mirrors the open
// posture of the pages surface. Optional shared-secret guard when NANO_PR_WEBHOOK_SECRET is set,
// mirroring /app/status.
import type { ActionHandler } from "@nanobpm/urban";
import { buildVersionInfo } from "../app/version.ts";

const SECRET = process.env.NANO_PR_WEBHOOK_SECRET ?? "";

const handler: ActionHandler = ({ req }) => {
  if (req.method !== "GET") return { status: 405, body: { error: "method not allowed (use GET)" } };
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  return { status: 200, body: buildVersionInfo() };
};

export default handler;
