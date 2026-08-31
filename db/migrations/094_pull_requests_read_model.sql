-- Convergence (PRs) read model: DECLARE ONCE, compile to BOTH backends (ADR-0065, nano-ide#452) — the
-- `pull_requests_read_model` VIEW that gives the Convergence surfaces the SAME acknowledge-to-dismiss
-- Active/History partition Features/Epics/Delivery-Graphs already have (issue #641).
--
-- Before #641 the Overview "Active PR convergences" and home "Pull requests" grids filtered the RAW
-- `pull_requests` table on a hand-synced base-`status` allowlist (the 7 in-flight convergence states),
-- so a PR dropped out of Active the instant its `status` reached terminal, with NO operator dismiss —
-- the last-but-one base-`status` allowlist #637 set out to retire. This VIEW introduces a declared
-- `list_bucket` (active/history) + `ack_open` (the Dismiss affordance flag) derived from the ONE shared
-- oracle (app/listBucket.ts): a terminal PR STAYS in `active` until `acknowledged_at` is stamped
-- (`acknowledgePr`), then folds to `history`.
--
-- Every DERIVED column below is emitted VERBATIM from the ONE declaration in
-- app/pullRequestReadModel.ts (`pullRequestReadModel.sqlSelectFor(col, { baseAlias: "pr" })`), which
-- ALSO drives the runtime TS via `fnFor` — the two lowerings fall out of the same closed-DSL AST and
-- cannot diverge. A drift guard (app/pullRequestReadModel.test.ts) fails if this file stops matching the
-- declaration, and `assertReadModelParity` proves the SQL and TS lowerings agree.
--
-- SEMANTICS. The status-classifying `list_bucket`/`ack_open` read the terminal-folded `derived_status`
-- off the auto-provisioned `pull_requests__tracking` derived VIEW (ADR-0065), so an out-of-band-
-- terminated PR classifies on ENGINE TRUTH (`abandoned`) rather than a frozen base `status`. Base
-- columns stay aliased identity pass-throughs (so the static pages↔schema contract guard sees the
-- VIEW's columns), sourced off `pull_requests__tracking`'s re-export of the base `pull_requests.*`;
-- `status` is exposed as the effective `COALESCE(derived_status, status)` so the pages' Status cell and
-- any status reader track a terminated PR. `acknowledged_at` (093) passes through so the read model can
-- classify on it.
--
-- Forward-only VIEW definition (DROP then CREATE). `pull_requests__tracking` is the managed VIEW urban
-- provisions at mount; SQLite does not validate a view body at CREATE time, so this migration (which
-- runs before that mount) is created fine and resolves once the managed VIEW exists. The runner wraps
-- each file in its own transaction, so this file must NOT contain BEGIN/COMMIT. Numbered after 093.

DROP VIEW IF EXISTS pull_requests_read_model;

CREATE VIEW pull_requests_read_model AS
SELECT
  pr.pr_key AS pr_key,
  pr.repo AS repo,
  pr.number AS number,
  pr.url AS url,
  pr.title AS title,
  COALESCE(pr.derived_status, pr.status) AS status,
  pr.current_round AS current_round,
  pr.process_key AS process_key,
  pr.waiting_since AS waiting_since,
  pr.last_review_id AS last_review_id,
  pr.outcome AS outcome,
  pr.created_at AS created_at,
  pr.updated_at AS updated_at,
  pr.converged_at AS converged_at,
  pr.merged_at AS merged_at,
  pr.active_worker AS active_worker,
  pr.lease_until AS lease_until,
  pr.last_nudge_at AS last_nudge_at,
  pr.fresh_head_run_head AS fresh_head_run_head,
  pr.abandon_token AS abandon_token,
  pr.incident_key AS incident_key,
  pr.incident_message AS incident_message,
  pr.last_round_head AS last_round_head,
  pr.root_request_key AS root_request_key,
  pr.epic_phase_label AS epic_phase_label,
  pr.acknowledged_at AS acknowledged_at,
  CASE WHEN COALESCE((COALESCE((COALESCE(("pr"."derived_status" = 'merged'), 0) OR COALESCE(("pr"."derived_status" = 'converged'), 0) OR COALESCE(("pr"."derived_status" = 'abandoned'), 0) OR COALESCE(("pr"."derived_status" = 'closed'), 0) OR COALESCE(("pr"."derived_status" = 'failed'), 0)), 0) AND COALESCE(("pr"."acknowledged_at" = "pr"."acknowledged_at"), 0)), 0) THEN 'history' ELSE 'active' END AS list_bucket,
  CASE WHEN COALESCE((COALESCE((COALESCE(("pr"."derived_status" = 'merged'), 0) OR COALESCE(("pr"."derived_status" = 'converged'), 0) OR COALESCE(("pr"."derived_status" = 'abandoned'), 0) OR COALESCE(("pr"."derived_status" = 'closed'), 0) OR COALESCE(("pr"."derived_status" = 'failed'), 0)), 0) AND (NOT COALESCE(COALESCE(("pr"."acknowledged_at" = "pr"."acknowledged_at"), 0), 0))), 0) THEN 1 ELSE 0 END AS ack_open
FROM pull_requests__tracking pr;
