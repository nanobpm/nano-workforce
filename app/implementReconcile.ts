// Implement-step reconcile — reconcile the implement-cell result from GitHub BEFORE escalating to a
// human (issue #801).
//
// The shared `implement-cell` (resources/processes/implement-cell.bpmn) routes ANY implement-step
// outcome that is not a clean terminal (`opened`/`blocked`/`skipped`) to a human escalation. But a
// harness that returns NO machine-readable result envelope (a blank/absent `status`) can still have
// pushed the slice's branch and opened a green PR — a machine-observable, recoverable outcome the
// escalation question literally asked a human to go and check (#796's implement-stage twin). Dead-
// ending that at a person is the defect.
//
// This is the CANONICAL, pure decision for the cell's reconcile step: on a blank/absent `status`,
// look for an OPEN PR opened from the cell's deterministic branch (`feat/<task.id>`, the agent-guide
// convention every implement-cell caller shares — see resources/prompts/feature.md) and, when one
// exists, ADOPT it (derive `status = "opened"` + a `pr` key) so the run converges exactly as if the
// agent had reported it — no human escalation. Only when nothing is observable does the run escalate
// as today. The GitHub read is injected (the canonical `listPrsForHead`) so this stays a pure,
// exhaustively testable mirror of the `ic_reconcile_gw` gateway — no second GitHub reconciler.
import type { HeadPr } from "./github.ts";
import { parsePr } from "./prParse.ts";

/** The escalate-arm inputs the reconcile step reads from the implement-cell scope. `subjectKey` is the
 *  cell's `owner/repo#N` subject (a feature run's `feature_key`, or a wave slice's epic `plan_key`) —
 *  its `owner/repo` half is the repository to look in. `taskId` is `task.id`, which fixes the
 *  deterministic implement branch `feat/<task.id>`. `status` is the (blank, on this arm) implement-step
 *  status. `pr` is any PR key already in scope (the implement harness may have set it) — carried through
 *  unchanged on the non-adopt fall-through so re-emitting the output never wipes it. `baseBranch` is the
 *  run's pinned base branch (the epic/graph integration branch every implement-cell caller maps into the
 *  cell scope): when known, only a PR whose base matches it is adoptable, so a stale/unrelated PR sharing
 *  the deterministic head branch but targeting a different base is never adopted. */
export interface ReconcileImplementInput {
  status: unknown;
  subjectKey: unknown;
  taskId: unknown;
  pr?: unknown;
  baseBranch?: unknown;
}

/** The reconcile decision. `reconciled` is the `ic_reconcile_gw` gate: true → adopt-and-converge (with
 *  `status = "opened"` + `pr` set); false → escalate as today. `status`/`pr` are re-emitted so the
 *  cell (and its caller) route on the adopted values. */
export interface ReconcileImplementResult {
  reconciled: boolean;
  status: string | null;
  pr: string | null;
}

/** The injected GitHub read — the canonical `listPrsForHead(repo, headBranch, token)` (so this module
 *  never grows a second PR-lookup transport). */
export type OpenPrLookup = (repo: string, branch: string, token: string) => Promise<HeadPr[] | null>;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;

/** Reconcile ONLY when the agent left no machine-readable status (blank/absent) — the #796/#801
 *  no-result condition. A genuine escalation that carries its own status string is honoured (escalate),
 *  never silently overridden by a branch PR that may be unrelated to the agent's question. */
export function shouldReconcileImplement(status: unknown): boolean {
  return str(status) === undefined;
}

/** The cell's deterministic implement branch — `feat/<task.id>` (resources/prompts/feature.md). */
export function implementCellBranch(taskId: string): string {
  return `feat/${taskId}`;
}

/** The adoptable PR from a head-branch listing: the first OPEN one (a merged/closed PR on the branch is
 *  not an in-flight result to converge). When `baseBranch` is given, only an open PR whose `baseRef`
 *  matches it is adoptable — GitHub can carry multiple open PRs from one head branch to different bases,
 *  so adopting blind to the base could converge a stale/unrelated PR; with no base known, fall back to
 *  the first open PR (unchanged best-effort behaviour). `null` when the listing is absent (no transport)
 *  or has no adoptable PR. */
export function pickAdoptablePr(prs: HeadPr[] | null, baseBranch?: string): HeadPr | null {
  if (!prs) return null;
  const open = prs.filter((p) => p.state === "open");
  const base = typeof baseBranch === "string" ? baseBranch.trim() : "";
  if (base) return open.find((p) => p.baseRef === base) ?? null;
  return open[0] ?? null;
}

/** The canonical implement-cell reconcile decision (mirror of `ic_reconcile_gw`). Best-effort: any
 *  missing input, unusable transport, or lookup failure falls through to `escalate` — never worse than
 *  today's behaviour, and idempotent (a pure GitHub read that adopts the SAME open PR on a re-run, so
 *  a re-dispatch never opens or double-adopts a second PR). */
export async function reconcileImplement(
  input: ReconcileImplementInput,
  lookup: OpenPrLookup,
  token: string,
): Promise<ReconcileImplementResult> {
  const escalate: ReconcileImplementResult = {
    reconciled: false,
    status: str(input.status) ?? null,
    // Carry any existing PR key through unchanged — the reconcile step's `pr` output is mapped back
    // into the process variable, so returning a bare `null` here would wipe a `pr` the implement
    // harness already set. Only a successful adoption below overwrites it.
    pr: str(input.pr) ?? null,
  };
  if (!shouldReconcileImplement(input.status)) return escalate;
  const taskId = str(input.taskId);
  // `subjectKey` shares the `owner/repo#N` shape parsePr validates; we use only its `repo` half.
  const parsed = parsePr(input.subjectKey);
  if (!taskId || !parsed) return escalate;
  const branch = implementCellBranch(taskId);
  let prs: HeadPr[] | null;
  try {
    prs = await lookup(parsed.repo, branch, token);
  } catch {
    return escalate; // transport hiccup → escalate as today
  }
  const adopt = pickAdoptablePr(prs, str(input.baseBranch));
  if (!adopt) return escalate;
  return { reconciled: true, status: "opened", pr: `${parsed.repo}#${adopt.number}` };
}
