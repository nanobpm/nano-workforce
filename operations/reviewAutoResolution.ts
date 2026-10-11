// POST /app/api/auto-resolutions/review → operationId `reviewAutoResolution` (issue #889). The
// Auto-resolutions view's review affordance: mark a steward auto-resolution `dismissed` (reviewed,
// no action) or `intervened` (the operator stepped in), with an optional note. Both fold the
// record's `review_state` off `pending` — idempotently, so an already-reviewed record is a 404-style
// no-op — and record who reviewed it and when. Reopening the completed user task is NOT required.
import { reviewResolution } from "../app/escalationSteward.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export default defineOperation("reviewAutoResolution", async ({ req, body }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("reviewAutoResolution rejected: missing/invalid shared secret");
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }
  if (!body || typeof body !== "object") {
    app.log.warn("reviewAutoResolution rejected: missing request body");
    return { status: 400, body: { ok: false, error: "id and action are required" } };
  }
  const id = typeof body.id === "number" && Number.isInteger(body.id) ? body.id : NaN;
  if (!Number.isFinite(id)) return { status: 400, body: { ok: false, error: "id must be an integer" } };
  const actionRaw = str(body.action);
  if (actionRaw !== "dismiss" && actionRaw !== "intervene") {
    return { status: 400, body: { ok: false, error: "action must be `dismiss` or `intervene`" } };
  }
  const operator = str(body.operator) || "operator";
  const note = str(body.note) || null;
  // `dismiss` → review_state `dismissed`; `intervene` → `intervened`.
  const reviewState = actionRaw === "dismiss" ? "dismissed" : "intervened";
  const changed = await reviewResolution(app.data, id, reviewState, operator, note);
  if (!changed) {
    app.log.warn("reviewAutoResolution: no pending record", { id });
    return { status: 404, body: { ok: false, error: "no pending auto-resolution record with that id (already reviewed, or unknown)" } };
  }
  app.log.info("auto-resolution reviewed", { id, action: actionRaw, operator });
  return { status: 200, body: { ok: true, id, reviewState } };
});
