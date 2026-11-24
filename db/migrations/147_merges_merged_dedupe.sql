-- At most ONE `merged` audit row per PR (issue #1047). `pr.merge` appended a fresh `merged` row on
-- every attempt against an already-merged PR, so a spinning merge loop (#1045) built up thousands of
-- rows, and the read-model views that scan `merges` per PR row (nano-ide#625) slowed to seconds.
--
-- Same durable-fence idiom as `ux_merges_abandon_pr_closed` (053): first collapse existing
-- duplicates — keep the earliest row (`MIN(id)`) per `pr_key` — then add the partial UNIQUE index.
-- The writer (`recordMergedOnce`, app/mergeAudit.ts) skips the insert when a row exists and
-- tolerates the fence as the same idempotent outcome under a race.
DELETE FROM merges
WHERE outcome = 'merged'
  AND id NOT IN (
    SELECT MIN(id) FROM merges
    WHERE outcome = 'merged'
    GROUP BY pr_key
  );

CREATE UNIQUE INDEX IF NOT EXISTS ux_merges_merged_pr
  ON merges (pr_key)
  WHERE outcome = 'merged';
