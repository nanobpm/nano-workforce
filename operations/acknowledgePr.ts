// POST /app/api/actions/acknowledge-pr → operationId `acknowledgePr` (issue #641; generalised by #654).
// The nwf UI's "Dismiss" (Done ✓) affordance for a TERMINAL pull request: an operator dismisses a
// finished PR (merged / converged / abandoned / closed / failed) directly from the Overview "Active PR
// convergences" or home "Pull requests" grid so it drops out of the Active convergence list into
// History. It is the PR twin of `acknowledgeDone` / `acknowledgeDeliveryGraph` / `acknowledgeEpic` — a
// terminal PR is NOT parked at a user task, so this op completes no user task and touches no engine/
// ledger: it simply stamps `acknowledged_at` on the `pull_requests` row.
//
// This op is now a one-liner over the shared `acknowledgeVia` helper (issue #654), which gates on the
// `pull_requests_read_model` VIEW's derived `ack_open` — the SAME oracle the Dismiss button reads via
// `showWhenField` — so the affordance and the guard cannot drift. That folds in the #652 fix (a PR
// terminated out-of-band freezes base `status` non-terminal while the read model's `derived_status`
// reads `abandoned`, so the old base-`status` guard 409'd a Dismiss the UI offered) categorically: the
// guard now reads the terminal-folded `ack_open`, never the base `status`.

import { acknowledgeVia } from "../app/acknowledge.ts";
import { pullRequestReadModel } from "../app/pullRequestReadModel.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export default defineOperation("acknowledgePr", async ({ body }, app) => {
  if (!body || typeof body !== "object") {
    app.log.warn("acknowledge-pr rejected: missing request body");
    return { status: 400, body: { ok: false, error: "pr_key is required" } };
  }

  const prKey = str(body.pr_key);
  if (!prKey) return { status: 400, body: { ok: false, error: "pr_key is required" } };

  return acknowledgeVia(
    app,
    {
      view: pullRequestReadModel.decl.name,
      baseTable: "pull_requests",
      keyColumn: "pr_key",
      label: "pull request",
      notDismissableError: "pull request is not terminal",
    },
    prKey,
  );
});
