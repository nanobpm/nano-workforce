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
import { KEYLESS_OPENED_SUMMARY } from "./plan.ts";
import { parsePr } from "./prParse.ts";
import { sliceBranchCreate } from "./repoEnvelope.ts";

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
  /** The agent's own summary — passed through unchanged, except on the keyless-`opened` fail-closed arm
   *  where it is stamped with `KEYLESS_OPENED_SUMMARY` so the provenance survives an Abandon/SLA
   *  auto-abandon into record-feature / record-wave / the finalizer (issue #1011 review). */
  summary?: unknown;
  /** Whether this slice has ALREADY consumed its one automatic retry (the `implementRetried` process
   *  variable). A claimed-completion-without-delivery is auto-retried ONCE (issue #865) before it
   *  escalates; this flag bounds that race to a single retry. */
  retried?: unknown;
  /** The branch the agent reported it actually pushed (its result's `branch` key, when present) —
   *  issue #1011. Looked up FIRST, then the deterministic `feat/<task.id>` fallback, so an agent that
   *  pushed a non-deterministic branch is still reconcilable. */
  branch?: unknown;
}

/** The reconcile decision. `reconciled` is the `ic_reconcile_gw` gate: true → adopt-and-converge (with
 *  `status = "opened"` + `pr` set); false → retry-or-escalate. `retry` is the auto-retry arm (issue
 *  #865): true → re-dispatch the implement agent ONCE with `retryNudge` appended to its prompt; false →
 *  escalate as today. `retried` is the bounded-once marker re-emitted into `implementRetried` so the
 *  second pass can never retry again. `status`/`pr` are re-emitted so the cell (and its caller) route on
 *  the resolved values. `deliveryVerified` is the EVIDENCE the escalation reason needs (issue #865
 *  review): `true` ONLY when a GitHub lookup actually ran and CONFIRMED the delivery state (an adoptable
 *  PR, or a verified absence); `false` when no lookup ran, it threw, or the transport was unavailable —
 *  so the reason never asserts an UNVERIFIED "no pull request / none was found". */
export interface ReconcileImplementResult {
  reconciled: boolean;
  status: string | null;
  pr: string | null;
  retry: boolean;
  retryNudge: string | null;
  retried: boolean;
  deliveryVerified: boolean;
  /** Human-readable lookup evidence for a keyless `opened` that could NOT be reconciled (issue #1011):
   *  "reported opened but no PR from <branch> into <base>". Present ONLY on that arm (omitted
   *  otherwise) so the escalation reason can name exactly what was looked for. */
  evidence?: string;
  /** The (possibly provenance-stamped) summary — see `ReconcileImplementInput.summary`. */
  summary: string | null;
}

/** The injected GitHub read — the canonical `listPrsForHead(repo, headBranch, token)` (so this module
 *  never grows a second PR-lookup transport). */
export type OpenPrLookup = (repo: string, branch: string, token: string) => Promise<HeadPr[] | null>;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;

/** Reconcile (look for a delivered PR) when the agent left no CLEAN, intentional result to route on:
 *  a blank/absent status (#796/#801's no-result), OR an AFFIRMATIVE-completion alias such as `completed`
 *  that CLAIMED completion without being a recognised terminal (#865) — both may nonetheless have pushed
 *  the branch and opened a green PR. A genuine escalation (`status = "escalated"`, or ANY status carrying
 *  an answerable `question`), and a reported non-completion outcome (`failed`/`needs_input`/unknown), are
 *  honoured as the agent's own decision and escalate accurately — never silently reconciled/adopted as a
 *  success by a branch PR that may be unrelated (#865 review). */
export function shouldReconcileImplement(status: unknown, question?: unknown, pr?: unknown): boolean {
  if (hasAnswerableQuestion(typeof question === "string" ? question : null)) return false;
  return str(status) === undefined || isClaimedCompletion(status) || isKeylessOpened(status, pr);
}

/** True iff the agent reported the clean `opened` terminal but its result carried NO `pr` key (issue
 *  #1011) — it opened the PR itself with `gh pr create` and left `pr` out of the envelope. Downstream
 *  (the wave gate, `converge-cell`) keys entirely on `pr`, so this is NOT a clean finish: the cell
 *  routes it through the reconcile step (mirror of the `ic_done` guard in implement-cell.bpmn) to
 *  recover the key from GitHub, or escalate with evidence — never pass `pr: null` downstream. */
export function isKeylessOpened(status: unknown, pr: unknown): boolean {
  return str(status) === "opened" && str(pr) === undefined;
}

/** The head branches to look up, in priority order (issue #1011): the branch the agent REPORTED it
 *  pushed (feature runs may use e.g. `feat/issue-<N>`), then the deterministic `feat/<task.id>`
 *  fallback — de-duplicated. */
export function reconcileBranches(taskId: string, reportedBranch?: unknown): string[] {
  const out: string[] = [];
  const reported = str(reportedBranch);
  if (reported) out.push(reported);
  const det = implementCellBranch(taskId);
  if (!out.includes(det)) out.push(det);
  return out;
}

/** The nudge appended to the implement agent's prompt on its one automatic retry (issue #865), naming
 *  exactly what was missing (an ADOPTABLE PR on the run's base) and the workspace-confinement rule.
 *  `status` is the off-vocabulary status it reported.
 *
 *  It does NOT over-assert "no branch was pushed / your work was discarded" (#865 review): this nudge
 *  also fires when an open PR merely targets the WRONG base (a verified absence ON the run's base), where
 *  the pushed work was NOT discarded. So it describes the missing ADOPTABLE PR and points the agent at
 *  recovering an already-pushed branch or retargeting an existing PR — consistent with the resume
 *  instructions in `resources/prompts/feature.md` (check `git ls-remote`, continue from an existing
 *  branch/PR rather than restarting). */
export function retryNudgeFor(status: string): string {
  return `\n\n---\n\n**Automatic retry — your previous attempt claimed completion but no adoptable pull request was found.** You reported status "${status}", yet a GitHub lookup confirmed there is no adoptable pull request for this slice on its base branch. Your work may NOT be lost: if you already pushed the \`feat/<task.id>\` branch, recover it — check the remote with \`git ls-remote --heads origin feat/<task.id>\`, and if a pull request exists but targets the WRONG base, retarget it onto this run's base branch with \`gh pr edit --base <base>\`. Otherwise you likely worked OUTSIDE your run workspace (e.g. \`cd /tmp\`), and those edits were discarded on teardown. This is your FINAL automatic retry; the next failure escalates to a human. Work ONLY inside your run workspace, then \`git commit -s\`, push \`feat/<task.id>\`, and open a PR on the correct base with \`gh pr create\`. Report \`status: "opened"\` with the \`pr\` key — not "${status}".`;
}

/** The cell's deterministic implement branch — `feat/<task.id>` (resources/prompts/feature.md).
 *  Delegates to the ONE canonical `sliceBranchCreate` (issue #945) so the reconcile lookup, the
 *  repository-envelope `branch.create` the harness cuts, and the prompt's branch instruction all share
 *  a single derivation — they can never drift into two branch-naming sources. A task id reaching the
 *  reconcile step is always a real id, so the derivation is never null here; the `?? `` fallback is
 *  defensive only (an implausible id would simply find no adoptable PR, the pre-existing behaviour). */
export function implementCellBranch(taskId: string): string {
  return sliceBranchCreate(taskId) ?? `feat/${taskId}`;
}

/** The adoptable-PR verdict for a head-branch listing. Only OPEN PRs are candidates (a merged/closed PR
 *  is not an in-flight result to converge); when `baseBranch` is given, only an open PR whose `baseRef`
 *  matches it is a candidate. Adoption requires EXACTLY ONE candidate: GitHub can carry several open PRs
 *  from one head branch (a stale one from an earlier attempt plus a fresh one, or one per base), and
 *  adopting whichever the API lists first could converge the stale/unrelated PR — so more than one
 *  candidate is `ambiguous`, never silently resolved. `none` covers an absent listing (no transport) too. */
export type AdoptableVerdict =
  | { kind: "none" }
  | { kind: "one"; pr: HeadPr }
  | { kind: "ambiguous"; prs: HeadPr[] };

export function classifyAdoptablePrs(prs: HeadPr[] | null, baseBranch?: string): AdoptableVerdict {
  if (!prs) return { kind: "none" };
  const base = typeof baseBranch === "string" ? baseBranch.trim() : "";
  const candidates = prs.filter((p) => p.state === "open" && (!base || p.baseRef === base));
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "one", pr: candidates[0] };
  return { kind: "ambiguous", prs: candidates };
}

/** The single adoptable PR from a head-branch listing, or `null` when there is none OR the listing is
 *  ambiguous (see `classifyAdoptablePrs`). */
export function pickAdoptablePr(prs: HeadPr[] | null, baseBranch?: string): HeadPr | null {
  const v = classifyAdoptablePrs(prs, baseBranch);
  return v.kind === "one" ? v.pr : null;
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
  const res = await reconcileImplementCore(input, lookup, token);
  const summary = str(input.summary) ?? null;
  // A keyless `opened` that could NOT be reconciled (verified absence, ambiguous listing, failed/null
  // lookup, missing inputs, or an answerable question) must NEVER leave the cell with the SUCCESS status
  // `opened` and no PR (issue #1011 review): an operator Abandon or the escalation-SLA auto-abandon ends
  // the cell straight from the escalation, and `record-feature` would persist a terminal `opened` row with
  // `pr_key: null` — read as delivered. Fail closed: rewrite to the non-success `blocked`, and always
  // carry lookup evidence so the escalation reason names what happened.
  if (!res.reconciled && isKeylessOpened(input.status, input.pr)) {
    return {
      ...res,
      status: "blocked",
      summary: stampKeylessOpened(summary),
      evidence: !res.evidence
        ? "reported opened but its PR could not be looked up on GitHub"
        : res.evidence.startsWith("reported opened")
          ? res.evidence
          : `reported opened but ${res.evidence}`,
    };
  }
  return { ...res, summary };
}

/** Prefix the shared keyless-`opened` marker onto a summary (idempotent). The marker is the ONE
 *  provenance channel downstream consumers key on: record-feature refuses blocked-delivery recovery for
 *  it, and record-wave / the finalizer name it instead of "blocked or skipped". */
export function stampKeylessOpened(summary: string | null): string {
  if (!summary) return KEYLESS_OPENED_SUMMARY;
  if (summary.startsWith(KEYLESS_OPENED_SUMMARY)) return summary;
  return `${KEYLESS_OPENED_SUMMARY} — ${summary}`;
}

type CoreResult = Omit<ReconcileImplementResult, "summary">;

async function reconcileImplementCore(
  input: ReconcileImplementInput,
  lookup: OpenPrLookup,
  token: string,
): Promise<CoreResult> {
  const alreadyRetried = input.retried === true;
  const escalate: CoreResult = {
    reconciled: false,
    status: str(input.status) ?? null,
    // Carry any existing PR key through unchanged — the reconcile step's `pr` output is mapped back
    // into the process variable, so returning a bare `null` here would wipe a `pr` the implement
    // harness already set. Only a successful adoption below overwrites it.
    pr: str(input.pr) ?? null,
    retry: false,
    retryNudge: null,
    retried: alreadyRetried,
    // No lookup has CONFIRMED the delivery state on any fall-through path (no lookup ran, it threw, or
    // the transport was unavailable) — the escalation reason must not assert an unverified absence
    // (#865 review). Only the successful-lookup paths below flip this to `true`.
    deliveryVerified: false,
  };
  if (!shouldReconcileImplement(input.status, input.question, input.pr)) return escalate;
  const taskId = str(input.taskId);
  // `subjectKey` shares the `owner/repo#N` shape parsePr validates; we use only its `repo` half.
  const parsed = parsePr(input.subjectKey);
  if (!taskId || !parsed) return escalate;
  const branches = reconcileBranches(taskId, input.branch);
  const base = str(input.baseBranch);
  let adopt: HeadPr | null = null;
  let ambiguous: { branch: string; prs: HeadPr[] } | null = null;
  for (const branch of branches) {
    let prs: HeadPr[] | null;
    try {
      prs = await lookup(parsed.repo, branch, token);
    } catch {
      // GitHub is unavailable — a failed lookup does NOT establish that delivery is missing, so it must
      // never consume the one automatic retry (issue #865 review). Escalate (best-effort, unchanged from
      // the pre-#865 no-result behaviour); the next reconcile pass can retry/adopt once GitHub recovers.
      return escalate;
    }
    // A `null` listing is an unavailable transport (no token), not a confirmed "no PR" — same reasoning
    // as the thrown case: escalate rather than retry on unconfirmed state.
    if (prs === null) return escalate;
    const verdict = classifyAdoptablePrs(prs, base);
    if (verdict.kind === "ambiguous") {
      ambiguous = { branch, prs: verdict.prs };
      break;
    }
    if (verdict.kind === "one") {
      adopt = verdict.pr;
      break;
    }
  }
  if (ambiguous) {
    // Several open PRs match — adopting any one could converge a stale PR. Escalate with the ambiguity
    // diagnostics (no auto-retry: a retry would not make the listing less ambiguous).
    const nums = ambiguous.prs.map((p) => `#${p.number}`).join(", ");
    return {
      ...escalate,
      evidence: `ambiguous: ${ambiguous.prs.length} open PRs (${nums}) from ${ambiguous.branch} into ${base ?? "any base"}`,
    };
  }
  if (adopt) {
    return {
      reconciled: true,
      status: "opened",
      pr: `${parsed.repo}#${adopt.number}`,
      retry: false,
      retryNudge: null,
      retried: alreadyRetried,
      // The lookup SUCCEEDED and found the adoptable PR — delivery is verified (present).
      deliveryVerified: true,
    };
  }
  // The lookup SUCCEEDED and confirmed no adoptable PR — delivery is verified (absent), so the
  // escalation reason may say "none was found"; only now may a claimed completion auto-retry.
  const verifiedAbsent: CoreResult = { ...escalate, deliveryVerified: true };
  if (isKeylessOpened(input.status, input.pr)) {
    // Issue #1011: the agent CLAIMED `opened` but no PR exists on any candidate branch — escalate with
    // the lookup evidence (never pass `pr: null` downstream, and never auto-retry a recognised status).
    verifiedAbsent.evidence = `reported opened but no PR from ${branches.join(" or ")} into ${base ?? "any base"}`;
    return verifiedAbsent;
  }
  return maybeRetry(input, alreadyRetried, verifiedAbsent);
}

/** No adoptable PR was found on a SUCCESSFUL lookup. A claimed-completion-without-delivery (an
 *  affirmative-completion alias such as `completed`) is auto-retried ONCE with a nudge (issue #865)
 *  before it escalates; everything else — a true no-result, a reported non-completion status, or a slice
 *  that has already consumed its retry — escalates as today. */
function maybeRetry(
  input: ReconcileImplementInput,
  alreadyRetried: boolean,
  escalate: CoreResult,
): CoreResult {
  const status = str(input.status);
  if (!alreadyRetried && status !== undefined && isClaimedCompletion(status)) {
    return {
      // Spread the (successful-lookup) escalate base so `deliveryVerified: true` is preserved — this
      // arm is only reached after a lookup CONFIRMED no adoptable PR.
      ...escalate,
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
