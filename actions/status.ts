// GET /app/status — list the PRs currently in flight (every tracked PR not converged/abandoned).
// A read-only projection over the app datasource so an operator or an external automation
// harness can see active work — and grab a `processKey` to cancel — without opening the DB or the UI.
//
// Optional shared-secret guard, mirroring /hooks/submit: when NANO_PR_WEBHOOK_SECRET is set,
// callers must present it via the x-hook-secret header. Unset → open (unchanged default). The
// pages UI does not call this endpoint (its grid reads the datasource directly), so the guard
// never affects the UI.
import type { ActionHandler } from "@nanobpm/urban";
import { activePrs } from "../app/service.ts";

const SECRET = process.env.NANO_PR_WEBHOOK_SECRET ?? "";

const handler: ActionHandler = async ({ req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  const prs = await activePrs(app.data);
  return { status: 200, body: { count: prs.length, prs } };
};

export default handler;
