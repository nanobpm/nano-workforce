// POST /app/api/actions/delivery-graph/dismiss → operationId `dismissProposal` (#520). The OPERATOR-ONLY
// dismiss door: the cockpit's staged-proposals grid posts the `digest` of the proposal the operator
// wants to discard as noise; this door loads that live `staged` proposal and flips it to the terminal
// `dismissed` status (`markProposalDismissed`), so it drops out of the staged list — exactly like
// `superseded`/`expired`, but recording a deliberate operator discard.
//
// It launches nothing (unlike dispatch) and is reachable only from the cockpit. Idempotent: a re-dismiss
// of an already-terminal (dismissed / dispatched / superseded / expired) or unknown digest is a clean
// 400 — the `getStagedProposal` liveness guard only resolves a live `staged` row, so a second dismiss
// finds no live proposal and refuses without touching state.

import { getStagedProposal, markProposalDismissed } from "../app/deliveryGraphProposals.ts";
import type { DeliveryGraphTextResult } from "../nano-generated/api-io.d.ts";
import { defineOperation } from "../nano-generated/operations.ts";

export default defineOperation("dismissProposal", async ({ body }, app) => {
  const digest = body && typeof body === "object" && "digest" in body && typeof body.digest === "string" ? body.digest.trim() : "";
  if (digest === "") {
    app.log.warn("dismiss-delivery-graph rejected: missing digest");
    return { status: 400, body: { ok: false, error: "request body must carry a `digest` naming the staged proposal to dismiss" } };
  }

  // Load the live staged proposal for this digest — refuses an unknown or already-terminal (dismissed /
  // dispatched / superseded / expired) digest cleanly. This is what makes the door idempotent: a second
  // dismiss finds no live `staged` row and 400s without re-writing anything.
  const proposal = await getStagedProposal(app.data, digest);
  if (!proposal) {
    app.log.warn("dismiss-delivery-graph rejected: no live staged proposal", { digest });
    return {
      status: 400,
      body: { ok: false, error: `no staged proposal for digest ${digest} — it may already be dismissed, dispatched, superseded, or aged out` },
    };
  }

  await markProposalDismissed(app.data, digest);
  app.log.info("dismiss-delivery-graph: proposal dismissed", { digest });

  const outBody: DeliveryGraphTextResult = { ok: true, digest, message: `staged proposal ${digest} dismissed` };
  return { status: 200, body: outBody };
});
