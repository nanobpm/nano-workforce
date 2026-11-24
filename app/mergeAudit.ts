// nano-workforce — bounded writers for the `merges` audit trail (issue #1047).
//
// The merge loop can spin (a stuck loop re-runs `pr.merge` every cycle, #1045). Any per-cycle audit
// row it writes must therefore be bounded, or the table grows without limit and the read-model views
// that scan `merges` per PR row (nano-ide#625) degrade. These are the ONE canonical writers for the
// loop's repeatable outcomes:
//   • `merged` — terminal, so AT MOST ONE row per PR, fenced at the DB level by the partial UNIQUE
//     index `ux_merges_merged_pr` (migration 147).
//   • repeatable wait states (e.g. `review-pending` for the same unreviewed head) — a new row only
//     when it differs from the PR's newest row, so an identical re-park doesn't append a duplicate.
import type { DataLayer } from "@nanobpm/urban";
import { isUniqueConstraintFence } from "./dbFence.ts";

export interface MergeAuditRow {
  pr_key: string;
  outcome: string;
  method: string;
  detail: string;
  at: string;
}

/** Record the terminal `merged` row at most once per PR. Returns true when a row was written. */
export async function recordMergedOnce(data: DataLayer, row: Omit<MergeAuditRow, "outcome">): Promise<boolean> {
  const merges = data.table("merges", "id");
  if ((await merges.findOne({ pr_key: row.pr_key, outcome: "merged" })) !== null) return false;
  try {
    await merges.insert({ ...row, outcome: "merged" });
    return true;
  } catch (err) {
    // A concurrent writer won the race; the `ux_merges_merged_pr` fence rejected the duplicate.
    if (!isUniqueConstraintFence(err)) throw err;
    return false;
  }
}

/** Append `row` unless the PR's newest audit row already records the same outcome/method/detail. */
export async function recordUnlessRepeat(data: DataLayer, row: MergeAuditRow): Promise<boolean> {
  const merges = data.table("merges", "id");
  const rows = await merges.find({ pr_key: row.pr_key });
  let newest: Record<string, unknown> | undefined;
  for (const r of rows) if (newest === undefined || Number(r.id ?? 0) > Number(newest.id ?? 0)) newest = r;
  if (
    newest !== undefined &&
    newest.outcome === row.outcome &&
    newest.method === row.method &&
    newest.detail === row.detail
  ) {
    return false;
  }
  await merges.insert({ ...row });
  return true;
}
