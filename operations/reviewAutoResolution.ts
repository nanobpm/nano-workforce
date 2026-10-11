// POST /app/api/auto-resolutions/review → operationId `reviewAutoResolution` (issue #889). The
// Auto-resolutions view's review affordance: mark a steward auto-resolution `dismissed` (reviewed,
// no action) or `intervened` (the operator stepped in), with an optional note. Both fold the
// record's `review_state` off `pending` — idempotently, so an already-reviewed record is a 404-style
// no-op — and record who reviewed it and when. Reopening the completed user task is NOT required.
//
// AUTHORIZATION (issue #889 review): this is an OPERATOR-PAGE mutation, driven by the declarative
// Dismiss/Intervene row actions + the guidance form on `pages/auto-resolutions.page.json`. Like every
// other UI-driven operator door (`acknowledgePr`/`acknowledgeDone`/`acknowledgeEpic`/`dismissProposal`)
// it carries NO `x-hook-secret` guard — declarative page actions structurally cannot attach that header
// (see `pages/mcp.page.json`), so guarding on it would 401 the very UI it exists to serve on any
// secured deployment. The guard is instead the read-model's derived `pending_review` flag the button
// reads via `showWhenField`, enforced host-side by `reviewResolution` (which only transitions a FINAL,
// still-`pending` record) — the same "affordance and guard read one oracle" pattern as `acknowledgeVia`.
import { reviewResolution } from "../app/escalationSteward.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export default defineOperation("reviewAutoResolution", async ({ body }, app) => {
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
