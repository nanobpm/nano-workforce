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
// This is the CANONICAL, pure decision for the cell's reconcile step: on a blank/absent `status` — OR
// an off-vocabulary status such as `completed` that CLAIMED completion without being a recognised
// terminal (issue #865) — look for an OPEN PR opened from the cell's deterministic branch
// (`feat/<task.id>`, the agent-guide convention every implement-cell caller shares — see
// resources/prompts/feature.md) and, when one exists, ADOPT it (derive `status = "opened"` + a `pr`
// key) so the run converges exactly as if the agent had reported it — no human escalation. When no PR
// is observable, a claimed-completion-without-delivery is AUTO-RETRIED once with a nudge (#865) before
// it escalates; a true no-result escalates as today. The GitHub read is injected (the canonical
// `listPrsForHead`) so this stays a pure, exhaustively testable mirror of the `ic_reconcile_gw`
// gateway — no second GitHub reconciler.
import { hasAnswerableQuestion } from "./escalationTaxonomy.ts";
import type { HeadPr } from "./github.ts";
import { isClaimedCompletion } from "./implementEscalationReason.ts";
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
  /** The agent's own question. An answerable question means a GENUINE escalation even under an
   *  off-vocabulary status — honour it (escalate), never auto-reconcile/auto-retry over it. */
  question?: unknown;
  /** Whether this slice has ALREADY consumed its one automatic retry (the `implementRetried` process
   *  variable). A claimed-completion-without-delivery is auto-retried ONCE (issue #865) before it
   *  escalates; this flag bounds that race to a single retry. */
  retried?: unknown;
}

/** The reconcile decision. `reconciled` is the `ic_reconcile_gw` gate: true → adopt-and-converge (with
 *  `status = "opened"` + `pr` set); false → retry-or-escalate. `retry` is the auto-retry arm (issue
 *  #865): true → re-dispatch the implement agent ONCE with `retryNudge` appended to its prompt; false →
 *  escalate as today. `retried` is the bounded-once marker re-emitted into `implementRetried` so the
 *  second pass can never retry again. `status`/`pr` are re-emitted so the cell (and its caller) route on
 *  the resolved values. */
export interface ReconcileImplementResult {
  reconciled: boolean;
  status: string | null;
  pr: string | null;
  retry: boolean;
  retryNudge: string | null;
  retried: boolean;
}

/** The injected GitHub read — the canonical `listPrsForHead(repo, headBranch, token)` (so this module
 *  never grows a second PR-lookup transport). */
export type OpenPrLookup = (repo: string, branch: string, token: string) => Promise<HeadPr[] | null>;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;

/** Reconcile (look for a delivered PR) when the agent left no CLEAN, intentional result to route on:
 *  a blank/absent status (#796/#801's no-result), OR an off-vocabulary status such as `completed` that
 *  CLAIMED completion without being a recognised terminal (#865) — both may nonetheless have pushed the
 *  branch and opened a green PR. A genuine escalation (`status = "escalated"`, or ANY status carrying an
 *  answerable `question`) is honoured as the agent's own decision — never silently overridden by a
 *  branch PR that may be unrelated to the question. */
export function shouldReconcileImplement(status: unknown, question?: unknown): boolean {
  if (hasAnswerableQuestion(typeof question === "string" ? question : null)) return false;
  return str(status) === undefined || isClaimedCompletion(status);
}

/** The nudge appended to the implement agent's prompt on its one automatic retry (issue #865), naming
 *  exactly what was missing (a committed, pushed PR) and the workspace-confinement rule its lost attempt
 *  violated. `status` is the off-vocabulary status it reported. */
export function retryNudgeFor(status: string): string {
  return `\n\n---\n\n**Automatic retry — your previous attempt claimed completion but delivered nothing.** You reported status "${status}" yet opened NO pull request and pushed NO branch, so your work was discarded. This is your FINAL automatic retry; the next failure escalates to a human. You MUST work ONLY inside your run workspace (never \`cd /tmp\` or edit files outside it — those edits are lost on teardown), then \`git commit -s\`, push \`feat/<task.id>\`, and open a PR with \`gh pr create\`. Report \`status: "opened"\` with the \`pr\` key — not "${status}".`;
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
  const alreadyRetried = input.retried === true;
  const escalate: ReconcileImplementResult = {
    reconciled: false,
    status: str(input.status) ?? null,
    // Carry any existing PR key through unchanged — the reconcile step's `pr` output is mapped back
    // into the process variable, so returning a bare `null` here would wipe a `pr` the implement
    // harness already set. Only a successful adoption below overwrites it.
    pr: str(input.pr) ?? null,
    retry: false,
    retryNudge: null,
    retried: alreadyRetried,
  };
  if (!shouldReconcileImplement(input.status, input.question)) return escalate;
  const taskId = str(input.taskId);
  // `subjectKey` shares the `owner/repo#N` shape parsePr validates; we use only its `repo` half.
  const parsed = parsePr(input.subjectKey);
  if (!taskId || !parsed) return escalate;
  const branch = implementCellBranch(taskId);
  let prs: HeadPr[] | null;
  try {
    prs = await lookup(parsed.repo, branch, token);
  } catch {
    return maybeRetry(input, alreadyRetried, escalate); // transport hiccup → retry/escalate as today
  }
  const adopt = pickAdoptablePr(prs, str(input.baseBranch));
  if (adopt) {
    return {
      reconciled: true,
      status: "opened",
      pr: `${parsed.repo}#${adopt.number}`,
      retry: false,
      retryNudge: null,
      retried: alreadyRetried,
    };
  }
  return maybeRetry(input, alreadyRetried, escalate);
}

/** No adoptable PR was found. A claimed-completion-without-delivery (an off-vocabulary status such as
 *  `completed`) is auto-retried ONCE with a nudge (issue #865) before it escalates; everything else — a
 *  true no-result, or a slice that has already consumed its retry — escalates as today. */
function maybeRetry(
  input: ReconcileImplementInput,
  alreadyRetried: boolean,
  escalate: ReconcileImplementResult,
): ReconcileImplementResult {
  const status = str(input.status);
  if (!alreadyRetried && status !== undefined && isClaimedCompletion(status)) {
    return {
      reconciled: false,
      status: escalate.status,
      pr: escalate.pr,
      retry: true,
      retryNudge: retryNudgeFor(status),
      retried: true,
    };
  }
  return escalate;
}
