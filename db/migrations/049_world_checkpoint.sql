-- 049_world_checkpoint.sql — issue #324 (ADR 0062, Slice 4/5): the **world** half of durable
-- agent-session resume. Durable resume splits into `mind` (the harness conversation; Slices 1–3)
-- and `world` (the git working tree + irreversible side effects; this slice). A replacement
-- activation lands on a FRESH worktree, so restoring the mind is useless unless the world is
-- reconstructed to the same turn boundary.
--
-- THE INVERSION OF OPERATION. The authoritative durable store for committed work is ALREADY the
-- git remote — the round `git push`ed a SHA. So world-restore INVERTS the forward op: the round's
-- outbound `git push` becomes an inbound `git fetch && git checkout <sha>` on resume. We DERIVE the
-- tree from `remote SHA + effect-tail`; we never snapshot it into a log (no duplicate source of
-- truth — AGENTS.md "derivation over duplication"). The lossy frontier is work after the last push,
-- which is exactly why the resume boundary is a PUSH-checkpoint.
--
-- Two tables, both keyed by the PR under convergence (`pr_key` = `<owner>/<repo>#<n>`):
--
--   world_checkpoints — one row per push-checkpoint (a durable resume boundary). `checkpoint_offset`
--     is a per-PR monotonic counter (0,1,2,…). At each push the app records `{commit_sha}` AND joins
--     it to the mind's `session.checkpoint(...)` at the SAME offset, so mind + world always commit at
--     one turn boundary — the divergence guard (harness thinks it hasn't pushed but the push landed,
--     or vice-versa) is closed structurally by the shared offset.
--
--   world_effects — the EFFECT LEDGER + FENCE. One row per irreversible action (git push → commit
--     SHA; PR comment → comment id; `gh merge` → merge key), each with an `idempotency_key`. On
--     restore we replay the post-checkpoint effect tail THROUGH THE FENCE so an already-applied effect
--     is SKIPPED, not repeated. `UNIQUE(pr_key, idempotency_key)` is the durable fence: an effect
--     recorded once cannot be double-applied, and `applied` records whether its side effect has been
--     realised (1) or is a pending tail entry to replay (0).
--
-- EXPAND (additive) phase: two new FK-free tables and their indexes; nothing is dropped or renamed.
-- The store is FK-free by design (like the 045 admission-staging twins): a checkpoint may be recorded
-- for an in-flight PR whose `pull_requests` row a store desync momentarily lost, and the heal path
-- must not FK-fail. Numbered after the current highest prefix on origin/main (048). The runner wraps
-- each file in its own transaction, so this file must NOT contain BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS world_checkpoints (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_key            TEXT NOT NULL,           -- "<owner>/<repo>#<number>" the checkpoint belongs to
  round_no          INTEGER NOT NULL,        -- convergence round that produced the push
  checkpoint_offset INTEGER NOT NULL,        -- per-PR monotonic resume boundary (0,1,2,…)
  commit_sha        TEXT NOT NULL,           -- the pushed SHA the fresh worktree is reconstructed to
  created_at        TEXT NOT NULL,
  -- One checkpoint per (pr, offset): the join records mind + world at the SAME offset, so a duplicate
  -- offset for one PR would mean two worlds claiming one turn boundary — reject it.
  UNIQUE(pr_key, checkpoint_offset),
  -- One checkpoint per (pr, commit SHA): `recordCheckpoint` is idempotent on `{pr_key, commit_sha}`
  -- (it `findOne`s the existing row and REUSES its offset rather than allocating a fresh one), but the
  -- application check alone is racy — a concurrent/duplicate persist-round could still land two rows
  -- for one SHA, and `findOne` would then pick an arbitrary offset, reintroducing the "newest
  -- checkpoint shadows the real effect tail" silent-effect-loss class. This constraint makes the
  -- invariant durable: a second row for the same SHA is rejected at the schema, so the offset a SHA
  -- maps to is unique and stable.
  UNIQUE(pr_key, commit_sha)
);

-- The newest checkpoint for a PR is `MAX(checkpoint_offset)`; index the lookup the restore path runs.
CREATE INDEX IF NOT EXISTS idx_world_checkpoints_pr
  ON world_checkpoints(pr_key, checkpoint_offset);

CREATE TABLE IF NOT EXISTS world_effects (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_key            TEXT NOT NULL,           -- the PR whose ledger this effect belongs to
  checkpoint_offset INTEGER NOT NULL,        -- the exact checkpoint boundary this effect was recorded at
  seq               INTEGER NOT NULL,        -- intra-checkpoint order the fence replays effects in
  kind              TEXT NOT NULL,           -- push | pr-comment | merge (an irreversible action class)
  idempotency_key   TEXT NOT NULL,           -- commit SHA / comment id / merge key — the fence key
  description       TEXT,                    -- human audit note (nullable)
  applied           INTEGER NOT NULL DEFAULT 0,  -- 1 once its side effect is realised; 0 = pending tail
  created_at        TEXT NOT NULL,
  -- The durable FENCE: an effect's idempotency key is unique within a PR, so replaying a tail can
  -- never re-record — and hence never re-apply — an effect that already landed.
  UNIQUE(pr_key, idempotency_key)
);

-- The restore path reads the effect tail recorded at a checkpoint's exact `checkpoint_offset`, in
-- `seq` order (an exact-offset lookup, not a range scan).
CREATE INDEX IF NOT EXISTS idx_world_effects_pr_offset
  ON world_effects(pr_key, checkpoint_offset, seq);
