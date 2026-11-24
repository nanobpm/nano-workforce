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
  if ((await merges.findOne({ pr_key: row.pr_key, outcome: "merged" })) != null) return false;
  try {
    await merges.insert({ ...row, outcome: "merged" });
    return true;
  } catch (err) {
    // A concurrent writer won the race; the `ux_merges_merged_pr` fence rejected the duplicate.
    if (!isUniqueConstraintFence(err)) throw err;
    return false;
  }
}

/** The audit outcomes that make up one review-wait cycle (park → ask → re-arm). */
const WAIT_CYCLE_OUTCOMES: readonly string[] = ["review-pending", "review-requested", "review-wait-ended"];

/**
 * Record a repeatable wait-state row (e.g. `review-pending` for the same unreviewed head), bounded per
 * PR/head across the WHOLE wait cycle. A same-head re-park runs `review-pending` → `review-requested`
 * (pr.request-review) → `review-wait-ended` (pr.arm-merge) → `review-pending` again, so a newest-row
 * comparison never sees the repeat. Instead scan the PR's trailing run of wait-cycle rows: when it
 * already holds an identical row, that run is a previous lap of THIS wait — collapse it (delete its
 * rows, keeping only the poller's head-marked asks, which `requestHeadReviewIfMissing` budgets per
 * head) and append the fresh row. The newest row is then the live wait, so `reviewWaitReason` still
 * reports `waiting_review(<sha7>)`, and the per-PR/head lifecycle stays bounded to one lap.
 */
export async function recordUnlessRepeat(data: DataLayer, row: MergeAuditRow): Promise<boolean> {
  const merges = data.table("merges", "id");
  const rows = [...(await merges.find({ pr_key: row.pr_key }))].sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0));
  const run: Record<string, unknown>[] = [];
  for (const r of rows) {
    if (!WAIT_CYCLE_OUTCOMES.includes(String(r.outcome ?? ""))) break;
    run.push(r);
  }
  const same = (r: Record<string, unknown>) =>
    r.outcome === row.outcome && r.method === row.method && r.detail === row.detail;
  // Already the live wait (newest row identical) — nothing new to record.
  if (rows.length > 0 && same(rows[0])) return false;
  if (run.some(same)) {
    for (const r of run) {
      const pollerAsk = r.outcome === "review-requested" && /\[head [0-9a-fA-F]{7,64}\]/.test(String(r.detail ?? ""));
      if (!pollerAsk) await merges.delete(r.id);
    }
  }
  await merges.insert({ ...row });
  return true;
}
