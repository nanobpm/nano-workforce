// POST /app/api/actions/acknowledge-pr → operationId `acknowledgePr` (issue #641).
// The nwf UI's "Dismiss" (Done ✓) affordance for a TERMINAL pull request: an operator dismisses a
// finished PR (merged / converged / abandoned / closed / failed) directly from the Overview "Active PR
// convergences" or home "Pull requests" grid so it drops out of the Active convergence list into
// History. It is the PR twin of `acknowledgeDone` (the feature-run tick-off) and `acknowledgeEpic` — a
// terminal PR is NOT parked at a user task, so this op completes no user task and touches no engine/
// ledger: it simply stamps `acknowledged_at` on the `pull_requests` row.
//
// `list_bucket`/`ack_open` are DERIVED by the `pull_requests_read_model` VIEW (094, issue #641) from
// the terminal-folded `derived_status` + `acknowledged_at` — a terminal, now-acknowledged PR reads
// `list_bucket` = 'history' and `ack_open` = 0 — so this op NEVER writes a derived projection. Keyed on
// the row's `pr_key`. Idempotent-safe: re-acknowledging re-stamps the timestamp and keeps it in
// History.
//
// It rejects (409) a PR that is NOT terminal (still converging/waiting_review/…), so it can never
// pre-seed the tick-off on a live PR: were `acknowledged_at` set early, the moment the PR later settled
// the VIEW would drop it straight into History, skipping the operator dismiss this op exists to
// require. The terminal check reads the base `status` — the reconciler's `onTerminated` edge persists
// an out-of-band terminate to base `status` = 'abandoned', so a resolved PR is matched here too.

import { PR_TERMINAL_STATUSES } from "../app/pullRequestReadModel.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export default defineOperation("acknowledgePr", async ({ body }, app) => {
  if (!body || typeof body !== "object") {
    app.log.warn("acknowledge-pr rejected: missing request body");
    return { status: 400, body: { ok: false, error: "pr_key is required" } };
  }

  const prKey = str(body.pr_key);
  if (!prKey) return { status: 400, body: { ok: false, error: "pr_key is required" } };

  const table = app.data.table<{ pr_key: string; status: string; acknowledged_at: string | null; updated_at: string }>(
    "pull_requests",
    "pr_key",
  );
  const pr = await table.get(prKey);
  if (!pr) {
    app.log.warn("acknowledge-pr: no such pull request", { prKey });
    return { status: 404, body: { ok: false, error: "no such pull request" } };
  }

  // Guard: only a TERMINAL PR (a `PR_TERMINAL_STATUSES` status — the same set the read model's
  // `list_bucket` folds to History) carries the Dismiss affordance. Acknowledging a live PR would
  // pre-seed `acknowledged_at`, so the moment it later settled the VIEW would drop it straight into
  // History, skipping the operator tick-off this op exists to require.
  if (!PR_TERMINAL_STATUSES.includes(pr.status)) {
    app.log.warn("acknowledge-pr rejected: PR is not terminal", { prKey, status: pr.status });
    return { status: 409, body: { ok: false, error: "pull request is not terminal" } };
  }

  // Stamp the dismissal. `list_bucket` (→ 'history') and `ack_open` (→ 0) are derived by the
  // `pull_requests_read_model` VIEW from the terminal, now-acknowledged row, so we never hand-set them
  // here. Idempotent: re-acknowledging re-stamps and stays in History.
  const now = new Date().toISOString();
  await table.update(prKey, { acknowledged_at: now, updated_at: now });

  app.log.info("operator dismissed terminal pull request", { prKey });
  return { status: 200, body: { ok: true, message: "acknowledged" } };
});
