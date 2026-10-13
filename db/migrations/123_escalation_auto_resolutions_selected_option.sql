-- Issue #889 review (Copilot "Previously missed"): the Auto-resolutions grid omitted the SELECTED
-- option, so an operator could not see whether the steward chose retry/continue/etc. without decoding
-- the raw submitted variables. Add a first-class `selected_option` column (the option value the steward
-- actually selected, derived host-side by the record worker from the decision's own form variables) and
-- re-create the read-model VIEW to expose it as a list column.
--
-- Expand-and-contract: the column is nullable (existing rows keep NULL — they predate the projection),
-- and the VIEW is re-created forward-only (DROP then CREATE) to add the new pass-through. Migration 120
-- is immutable and cannot be edited in place. Numbered after 122.

ALTER TABLE escalation_auto_resolutions ADD COLUMN selected_option TEXT;

DROP VIEW IF EXISTS escalation_auto_resolutions__read_model;
CREATE VIEW escalation_auto_resolutions__read_model AS
SELECT
  id,
  user_task_key,
  escalation_kind,
  element_id,
  subject_type,
  subject_key,
  subject_url,
  process_instance_key,
  -- The cockpit "Agent" transcript link keys on `process_key` (the #833 invariant: every Agent →
  -- cockpit link uses keyField `process_key`). The ANSWERING agent ran under `steward_instance_key`
  -- (the steward process), NOT `process_instance_key` (the escalated SUBJECT's process), so project
  -- the steward key under the canonical `process_key` name for that link (issue #889 review).
  steward_instance_key AS process_key,
  question,
  options,
  outcome,
  submitted_variables,
  selected_option,
  rationale,
  evidence,
  steward_instance_key,
  agent_job_key,
  worker,
  model,
  created_at,
  review_state,
  reviewed_by,
  reviewed_at,
  review_note,
  CASE WHEN review_state = 'pending' THEN 1 ELSE 0 END AS pending_review
FROM escalation_auto_resolutions
WHERE outcome IN ('resolved', 'abstained');
