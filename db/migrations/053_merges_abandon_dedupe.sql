-- Enforce the abandon-audit invariant at the DB level (#352, PR #354 review — suppressed advisory on
-- app/service.ts:867). `abandonClosedPr`'s "write the terminal `merges` audit row only once" guard was
-- a NON-ATOMIC find-then-insert: the two observers that reconcile a closed-unmerged member — the merge
-- worker's `attempt-merge` closed short-circuit and the wave-gate self-heal in `pollWaveGatesImpl` —
-- can run concurrently, so both observe "no row" between the `find` and the `insert` and both write an
-- `abandoned`/`pr-closed` row for the same `pr_key`. Sequential-idempotency tests pass, but the guard
-- is only best-effort under a real concurrent race.
--
-- Make the invariant a DB constraint (the canonical durable-fence idiom — cf. the `UNIQUE` fences on
-- `world_effects`/`world_checkpoints` in 049): AT MOST ONE (outcome='abandoned', method='pr-closed')
-- `merges` row per `pr_key`. The writer keeps its fast-path `find` guard (so the common retry never
-- throws) but now tolerates the UNIQUE fence as the SAME idempotent outcome (see `app/dbFence.ts`).
--
-- Expand phase (additive, forward-only): first collapse any duplicates a pre-fence race already wrote
-- — keep the earliest row (`MIN(id)`) per `pr_key` — so the partial UNIQUE index can be created on an
-- already-populated database, then add the index. Only `abandoned`/`pr-closed` rows are touched;
-- `merged`/`queued`/`blocked` audit rows are untouched and may still repeat per `pr_key`.
DELETE FROM merges
WHERE outcome = 'abandoned'
  AND method = 'pr-closed'
  AND id NOT IN (
    SELECT MIN(id) FROM merges
    WHERE outcome = 'abandoned' AND method = 'pr-closed'
    GROUP BY pr_key
  );

CREATE UNIQUE INDEX IF NOT EXISTS ux_merges_abandon_pr_closed
  ON merges (pr_key)
  WHERE outcome = 'abandoned' AND method = 'pr-closed';
