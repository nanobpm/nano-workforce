// GET /app/api/run/wait?key=<key>&until=<cond>&timeout=<ISO> → operationId `waitRun` (issue #1057).
// `d8ctl nwf wait <key> --until=…`: long-poll ONE run until it reaches a state, bounded server-side
// (≤ 25 min per request); on expiry `{ timedOut: true, view }` and the caller re-issues. An open
// escalation or a terminal run always ends the wait. Logic in app/runWait.ts; view from app/runLookup.ts.
import { lookupRun } from "../app/runLookup.ts";
import { parseWaitUntil, WAIT_UNTIL, waitForRun, waitTimeoutMs } from "../app/runWait.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("waitRun", async ({ req, query }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("waitRun rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  const key = typeof query.key === "string" ? query.key.trim() : "";
  const until = parseWaitUntil(query.until);
  if (until === null) return { status: 400, body: { error: `until must be one of ${WAIT_UNTIL.join("|")}` } };
  if (key === "") return { status: 404, body: { error: "nwf has never tracked a run with key " } };
  const res = await waitForRun(() => lookupRun(app.data, app.engine, key), until, waitTimeoutMs(query.timeout));
  if (!res.found) return { status: 404, body: { error: `nwf has never tracked a run with key ${key}` } };
  return { status: 200, body: { timedOut: res.timedOut, reason: res.reason, until: res.until, view: res.view } };
});
