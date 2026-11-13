-- 111 (issue #811): converge-gate shadow-scoring calibration store.
--
-- The convergence loop's deterministic `pr.converge-gate` (app/convergeGate.ts) is the source of
-- truth for whether a self-reported "converged" round may proceed. A NON-GATING shadow pass scores
-- the same decision with the tier-3a fixed-answer model (app/scoreChoices.ts) and records BOTH here,
-- so we can measure the scored model's agreement / coverage / covered-accuracy against the gate's own
-- verdicts BEFORE it is ever granted any authority. The gate itself never reads this table.
--
-- Additive (expand): a new append-only table only. `ground_truth` is the canonical label derived
-- from the deterministic gate result; the `shadow_*` columns are NULL when no model was loaded (the
-- graceful-degradation path — we still capture the labelled row for later training).
CREATE TABLE IF NOT EXISTS converge_shadow (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_key         TEXT NOT NULL,
  round_no       INTEGER,
  features       TEXT NOT NULL,          -- deterministic text view of the gate inputs (training input)
  ground_truth   TEXT NOT NULL,          -- converged | escalate | ack-retry (from the deterministic gate)
  shadow_action  TEXT,                   -- the model's action (a label, or __escalate__); NULL if no model
  shadow_top_p   REAL,                   -- top-1 restricted-softmax probability; NULL if no model
  shadow_confident INTEGER,              -- 1/0 whether the model cleared its confidence bar; NULL if no model
  agree          INTEGER,                -- 1/0 shadow_action == ground_truth; NULL if no model
  model_name     TEXT,                   -- model artifact name/version scored with; NULL if no model
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_converge_shadow_pr ON converge_shadow(pr_key);
CREATE INDEX IF NOT EXISTS idx_converge_shadow_agree ON converge_shadow(agree);
