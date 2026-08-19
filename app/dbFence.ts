// nano-workforce — the ONE canonical classifier for a SQLite UNIQUE-constraint fence collision.
//
// A durable fence is a DB-level UNIQUE constraint that a check-then-insert races against: two
// concurrent/duplicate writers both observe "no row" and both attempt the insert, so the loser hits
// `UNIQUE constraint failed`. Turning that collision into the SAME intended idempotent outcome
// (instead of a spurious job failure) is a recurring pattern across the app — the world store's
// checkpoint/effect ledger (`db/migrations/049_world_checkpoint.sql`) and the merges-audit abandon
// guard (`abandonClosedPr`, `db/migrations/053_merges_abandon_dedupe.sql`) both rely on it.
//
// This is the ONE place that classifies the collision so every catch site shares a single
// implementation rather than re-encoding the driver's error shape (AGENTS.md: "no drift surfaces").
// Matched on the message substring the RAD `Table` surface propagates verbatim — the same one the
// schema/migration tests assert on — because that surface hides the concrete driver error type.

/** True when `err` is a SQLite `UNIQUE constraint failed` — the durable fence firing. */
export function isUniqueConstraintFence(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}
