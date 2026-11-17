// Feature-run blocked reconcile — reconcile a self-reported `blocked` outcome against the REMOTE
// before routing the run to the `feature-blocked` operator inbox (issue #967).
//
// The defect: the feature process trusted the agent's self-reported `outcome.status` even when the
// observable state contradicted it. Feature run 742704 ended `feature-blocked` with the agent's
// summary saying "complete and committed LOCALLY … cut off before I could push" — but the branch
// WAS pushed (`git ls-remote origin feat/issue-1600` showed the agent's own reported headSha, and
// the exit code was 0). Only the PR step was missing. The run then sat in the human inbox until an
// operator opened the PR by hand.
//
// This is the CANONICAL, pure decision for that reconcile, consulted by `pr.record-feature` before
// it persists a `blocked` outcome (which is what routes the run to `feature-blocked` via the
// `gw-blocked` gateway). On a `blocked` report it checks the run's deterministic branch
// (`feat/<task.id>` — the ONE canonical `sliceBranchCreate`, shared with the implement-cell
// reconcile and the harness envelope) against the remote:
//
//   • branch pushed + an OPEN PR already on it (on the run's base) → ADOPT the PR — resolve
//     `opened` with its key, exactly as if the agent had reported it (mirrors the implement-cell's
//     `pickAdoptablePr` adoption, one stage up);
//   • branch pushed + AHEAD of base + no open PR → OPEN the PR from the branch (a DRAFT — the agent
//     never vouched for it as review-ready) and resolve `opened` with the new key, so the run
//     continues to the converge/merge path instead of escalating;
//   • no commit to deliver (no branch on the remote, or the branch carries nothing over base) →
//     escalate as today (`blocked`), the only case a human is pulled in.
//
// The agent's self-reported `headSha` is carried for context but never GATES delivery: the
// observable remote state is the authority in both directions — a stale/mismatched self-report
// cannot re-block a deliverable branch, and a self-report alone (no observable branch) cannot
// deliver anything. All GitHub I/O is injected (the canonical `fetchBranchHead` / `compareCommits` /
// `listPrsForHead` / `createPullRequest`), so this stays a pure, exhaustively testable mirror of the
// worker's pre-`blocked` reconcile — no second GitHub reconciler. Best-effort throughout: any
// missing input, unusable transport, or lookup/create failure falls through to `blocked` — never
// worse than the pre-fix behaviour, and idempotent (a re-run re-adopts the SAME open PR rather than
// opening a second one, because the adoption lookup runs before any create).
import type { HeadPr } from "./github.ts";
import { pickAdoptablePr } from "./implementReconcile.ts";
import { parsePr } from "./prParse.ts";
import { sliceBranchCreate } from "./repoEnvelope.ts";

/** The blocked-reconcile inputs the record-feature worker reads from the process scope.
 *  `subjectKey` is the run's `owner/repo#N` feature key — its `owner/repo` half is the repository
 *  to reconcile in. `taskId` is `task.id`, which fixes the deterministic implement branch
 *  `feat/<task.id>`. `baseBranch` is the run's pinned base: only a PR targeting it is adoptable,
 *  and a reconcile-opened PR targets it. `status` is the agent's reported outcome (this module only
 *  ever acts on `blocked`). `headSha` is the agent's self-reported tip — context only, never a gate
 *  (see the module doc). */
export interface ReconcileBlockedFeatureInput {
  status: unknown;
  subjectKey: unknown;
  taskId: unknown;
  baseBranch?: unknown;
  headSha?: unknown;
}

/** The reconcile resolution the worker routes on: the `featureStatus` to persist (and hand the
 *  `gw-blocked` gateway) plus the `prKey` to record/enroll. `blocked` + `null` is the unchanged
 *  fall-through (park for a human); `opened` + a key is a delivered PR the run converges. */
export interface ReconcileBlockedFeatureResult {
  featureStatus: string;
  prKey: string | null;
}

/** The injected GitHub reads/write — the canonical helpers from `app/github.ts`, injected so this
 *  module never grows a second transport. Each mirrors its canonical contract: a `null` return is
 *  the idle no-transport/unknown case (never an exception); only a genuine transport failure throws
 *  (and is treated as "unknown" by the reconcile — escalate, never guess). */
export type BranchLookup = (repo: string, branch: string, token: string) => Promise<string | null>;
export type ComparisonLookup = (
  repo: string,
  base: string,
  head: string,
  token: string,
) => Promise<{ status: "ahead" | "behind" | "identical" | "diverged"; aheadBy: number; behindBy: number } | null>;
export type OpenPrLookup = (repo: string, branch: string, token: string) => Promise<HeadPr[] | null>;
export type PrCreator = (
  repo: string,
  headBranch: string,
  baseBranch: string,
  title: string,
  body: string,
  draft: boolean,
  token: string,
) => Promise<{ number: number; url: string } | null>;

export interface ReconcileBlockedFeatureIo {
  branch: BranchLookup;
  compare: ComparisonLookup;
  listPrs: OpenPrLookup;
  createPr?: PrCreator;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;

/** Reconcile ONLY a self-reported `blocked` outcome. Every other status — a clean terminal
 *  (`opened`/`skipped`), a blank/absent status (the implement-CELL's reconcile surface, #801 — the
 *  feature parent never sees it because the cell adopts/escalates first), or an escalation — routes
 *  untouched; this gate exists because `blocked` is the one outcome whose self-report the pushed
 *  remote state can contradict. */
export function shouldReconcileBlockedFeature(status: unknown): boolean {
  return str(status) === "blocked";
}

/** The title/body for a reconcile-opened PR. The PR stands in for the one the agent failed to open,
 *  so it names the issue it delivers and links it with a NON-blocking ref (`Refs #N`): the agent
 *  reported it could not vouch for the delivery, so the draft PR must not auto-close the issue on
 *  merge — the scope-integrity classifier would (rightly) scrutinise a `Closes` the delivering agent
 *  never claimed. */
export function reconcilePrTitle(subjectKey: string): string {
  return `feat: ${subjectKey} (reconciled delivery)`;
}

export function reconcilePrBody(subjectKey: string, branch: string): string {
  return [
    `Refs ${subjectKey}`,
    "",
    `The implementation agent reported \`blocked\` after pushing \`${branch}\`, so the feature run`,
    `reconciled with the remote and opened this PR from the pushed branch itself (issue #967) — the`,
    `work was delivered; only the PR step was missing. Opened as a draft because the agent never`,
    `vouched for it as review-ready.`,
  ].join("\n");
}

/** The canonical feature-run blocked reconcile (issue #967). Pure over its injected I/O: a pure
 *  GitHub read first (adopt an existing open PR), then — only when the branch observably carries
 *  commits base lacks — the single PR create. A re-run adopts the PR an earlier pass opened, so the
 *  reconcile never opens a duplicate. */
export async function reconcileBlockedFeature(
  input: ReconcileBlockedFeatureInput,
  io: ReconcileBlockedFeatureIo,
  token: string,
): Promise<ReconcileBlockedFeatureResult> {
  const escalate: ReconcileBlockedFeatureResult = { featureStatus: "blocked", prKey: null };
  if (!shouldReconcileBlockedFeature(input.status)) {
    // Not this gate's outcome — pass it through untouched (prKey resolution stays with the caller's
    // own parsing; this gate only ever overrides `blocked`).
    return { featureStatus: str(input.status) ?? "blocked", prKey: null };
  }
  const taskId = str(input.taskId);
  // `subjectKey` shares the `owner/repo#N` shape parsePr validates; we use only its `repo` half.
  const parsed = parsePr(input.subjectKey);
  const base = str(input.baseBranch);
  if (!taskId || !parsed || !base) return escalate;
  const branch = sliceBranchCreate(taskId);
  if (!branch) return escalate;

  // 1. Is the branch on the remote at all? No branch → no commit to deliver → escalate. A null
  //    (no transport) or a throw (GitHub down) is "unknown", never "absent" — escalate either way,
  //    exactly the pre-fix behaviour.
  let headSha: string | null;
  try {
    headSha = await io.branch(parsed.repo, branch, token);
  } catch {
    return escalate;
  }
  if (!headSha) return escalate;

  // 2. An OPEN PR already on the branch (on the run's base) is adopted outright — the agent
  //    delivered everything and merely misreported. The adoption lookup runs BEFORE any create, so
  //    a re-run of this reconcile re-adopts the PR an earlier pass opened instead of duplicating it.
  //    A null listing (no transport) or a throw is "unknown" — escalate rather than risk a blind
  //    duplicate create.
  let prs: HeadPr[] | null;
  try {
    prs = await io.listPrs(parsed.repo, branch, token);
  } catch {
    return escalate;
  }
  if (prs === null) return escalate;
  const adopt = pickAdoptablePr(prs, base);
  if (adopt) return { featureStatus: "opened", prKey: `${parsed.repo}#${adopt.number}` };

  // 3. No open PR. Deliver only when the branch observably carries commits base lacks
  //    (`aheadBy > 0` — GitHub's three-dot compare counts commits on head since the merge-base, so a
  //    `diverged` branch that merely needs a rebase still qualifies; the convergence loop owns
  //    green/mergeability, not this gate). `identical`/`behind` means no commit to deliver —
  //    escalate. Unknown (null/throw) escalates rather than opening a maybe-empty PR.
  let aheadBy: number;
  try {
    const cmp = await io.compare(parsed.repo, base, branch, token);
    if (!cmp) return escalate;
    aheadBy = cmp.aheadBy;
  } catch {
    return escalate;
  }
  if (aheadBy <= 0) return escalate;

  // 4. The branch is pushed and ahead with no open PR — open it (a DRAFT: the agent reported
  //    `blocked`, so it never vouched for the work as review-ready) and converge it. A create
  //    failure/null escalates — the run records `blocked` with the branch still pushed, so the
  //    human (or a re-dispatch) can open the same PR; never record an `opened` run with no PR.
  if (!io.createPr) return escalate;
  let created: { number: number; url: string } | null;
  try {
    created = await io.createPr(parsed.repo, branch, base, reconcilePrTitle(parsed.prKey), reconcilePrBody(parsed.prKey, branch), true, token);
  } catch {
    return escalate;
  }
  if (!created || !Number.isFinite(created.number) || created.number <= 0) return escalate;
  return { featureStatus: "opened", prKey: `${parsed.repo}#${created.number}` };
}
