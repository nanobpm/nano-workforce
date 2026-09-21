// pr.converge-gate — the deterministic review-comment gate for the convergence loop.
//
// The loop declares convergence on the review-round AGENT's self-reported `status = "converged"`.
// That trusts the agent to only converge once every Copilot comment is addressed — which failed on
// Magikcraft/nano-bpm#770 (20 rounds, a suppressed advisory never applied, then auto-merged with
// the comment unaddressed). This step runs on the converged path, BEFORE the scope classifier and
// pr.finalize hand off to the merge loop, and blocks handoff while GitHub still shows unaddressed
// comments:
//   • any SUBSTANTIVE review THREAD is still unresolved (GraphQL `isResolved = false`), or an
//     unresolved `nano-ack:` ACK thread is open — an ack thread is a partially-completed
//     acknowledgement the bounded #796 auto-ack retry can finish, so it still BLOCKS (a
//     genuinely-open GitHub thread) but the block stays ack-only (recoverable) rather than escalating
//     to a human; only a substantive open thread escalates, or
//   • any SUPPRESSED advisory in the latest Copilot review body lacks a matching RESOLVED ack
//     thread (a `nano-ack: <path> :: <verbatim advisory text>` marker whose line-stable prose
//     fingerprint matches Copilot's advisory). The bare legacy `nano-ack: <path>:<line>` form is
//     NOT honoured: keyed only on `path:line`, it is blind to the advisory prose and would let a
//     resolved ack for one advisory silently acknowledge a genuinely new advisory re-emitted at
//     that same line (a false-OPEN). Only the prose-keyed `<path> :: <text>` form acknowledges.
// A blocked gate returns `convergeBlocked = true` (recoverable, never a hard wedge); the route then
// depends on WHY it blocked. An ack-only block (`convergeAckOnly = true` — sole cause is unacked
// suppressed advisories and/or an unresolved `nano-ack:` ack thread) re-dispatches the `review-round`
// agent first, bounded by `ackRetryMax`, and only reaches the human `wait-answer` escalation once
// that budget is exhausted. A substantive unresolved thread routes to `wait-answer` immediately.
//
// STALE-REVIEW GUARD (issue #799): when the PR HEAD has advanced PAST the commit the latest Copilot
// review was submitted against, that review's body describes code the head has moved past, so the
// gate signals `reviewStale = true` (rather than blocking on the obsolete body) and the process
// re-enters the review wait for a fresh review of the current HEAD. The head read fails OPEN, so a
// transport hiccup can never fabricate a stale verdict.
//
// Scope integrity is NO LONGER judged here. A deterministic regex over the PR description could not
// read the closed issue's acceptance criteria, so it false-positived on any body that merely
// *mentioned* deferral (an ADR non-goal, a PR whose subject is scope tooling) and forced needless
// human escalations. That judgment now lives in the `classify-scope` agent task (job type
// `senior:scope-classify`, prompt `resources/prompts/scope-classify.md`), which runs immediately
// after this gate on the converged path and reads each closed issue's stated scope. This worker's
// sole responsibility is the review-comment gate.
//
// It FAILS CLOSED: if the live GitHub state cannot be read, it blocks (escalates) rather than
// letting an unverifiable "converged" through — the opposite of the no-progress guard, because a
// merge-gating check must escalate-on-uncertainty so #770 cannot recur.
import type { AppJobHandler } from "@nanobpm/urban";
import { type ConvergeGateResult, evaluateConvergeGate } from "../../app/convergeGate.ts";
import { recordConvergeShadow } from "../../app/convergeShadow.ts";
import {
  fetchBranchHead,
  fetchLatestCopilotReview,
  fetchPrHead,
  fetchReviewThreads,
  isAckThread,
  parseAckedAdvisories,
  parseSuppressedAdvisories,
  type ReviewThread,
} from "../../app/github.ts";
import { isReviewStale } from "../../app/reviewWait.ts";
import { parsePr } from "../../app/service.ts";
import type { WorkerInputs, WorkerOutputs } from "../../nano-generated/worker-io.d.ts";
import { type HeadReader, makeDefaultReadHead } from "../progress-check/worker.ts";

// Input/output typed off the model data envelopes (`PrConvergeGateIn` / `PrConvergeGateOut` in
// convergence-loop.bpmn), the single source of truth for this worker's wire contract (ADR 0040).
type In = WorkerInputs["pr.converge-gate"];
type Out = WorkerOutputs["pr.converge-gate"];

// Reads a PR's review threads. `null` = no usable transport (treated as an unverifiable read →
// fail closed). Throws propagate to the fail-closed catch below.
export type ThreadsReader = (repo: string, prNumber: number) => Promise<ReviewThread[] | null>;
// Reads the latest Copilot review — body AND the commit SHA it was submitted against. `null` = no
// usable transport (unverifiable → fail closed); `{ body: "", commitId: null }` = transport usable
// but no Copilot review yet (verified: no suppressed advisories). The `commitId` drives the
// stale-review detection below (issue #799).
export type ReviewReader = (repo: string, prNumber: number) => Promise<{ body: string; commitId: string | null } | null>;

const defaultReadThreads: ThreadsReader = (repo, prNumber) =>
  fetchReviewThreads(repo, prNumber, process.env.GITHUB_TOKEN ?? "");
const defaultReadReview: ReviewReader = (repo, prNumber) =>
  fetchLatestCopilotReview(repo, prNumber, process.env.GITHUB_TOKEN ?? "");
// The PR's current HEAD SHA, read via the same branch-ref-over-stale-`head.sha` reader the
// capture-head / progress-check steps use (#786), so the gate's staleness comparison sees the exact
// head those steps do. Fails OPEN to `null` (unreadable head → not-stale, per {@link isReviewStale}).
const defaultReadHead: HeadReader = makeDefaultReadHead({ fetchPrHead, fetchBranchHead });

const BLOCK_UNVERIFIABLE =
  "Convergence blocked: could not verify the PR's review comments against GitHub. A human must confirm every Copilot review thread is resolved and every suppressed advisory acknowledged before this PR converges (reply to resume the loop).";

/** Build the handler with injectable GitHub readers. The default export binds the real readers;
 * tests inject stubs. Fails CLOSED — any unreadable/errored state blocks convergence. */
export function makeHandler(deps: {
  readThreads: ThreadsReader;
  readReview: ReviewReader;
  readHeadSha?: HeadReader;
}): AppJobHandler<In, Out> {
  const readHeadSha = deps.readHeadSha ?? defaultReadHead;
  return async (job, app) => {
    const { prKey, repo, prNumber } = job.variables;
    // `parsePr` is total on any input (fails closed to `null` on a missing/non-string prKey), so
    // pass it straight through — a malformed prKey degrades to the fail-closed target check below.
    const parsed = parsePr(prKey);
    const ghRepo = repo ?? parsed?.repo;
    const ghNumber = typeof prNumber === "number" ? prNumber : parsed?.number;
    if (!ghRepo || typeof ghNumber !== "number") {
      return { convergeBlocked: true, convergeBlockReason: BLOCK_UNVERIFIABLE, convergeAckOnly: false, reviewStale: false };
    }

    let result: ConvergeGateResult;
    try {
      const threadsRead = await deps.readThreads(ghRepo, ghNumber);
      // A null threads read is an unverifiable gate — fail closed. (An empty ARRAY is a verified
      // "no threads" and is fine.) An unverifiable block is NOT ack-only: it needs a human to
      // confirm GitHub state, so it must not enter the bounded agent auto-ack path (#796).
      if (threadsRead === null) {
        return { convergeBlocked: true, convergeBlockReason: BLOCK_UNVERIFIABLE, convergeAckOnly: false, reviewStale: false };
      }
      const review = await deps.readReview(ghRepo, ghNumber);
      // A null review read is an unverifiable read (no usable transport) — fail closed, same as a
      // null threads read. (A `{ body: "", commitId: null }` result is a verified "no Copilot
      // review / no advisories".)
      if (review === null) {
        return { convergeBlocked: true, convergeBlockReason: BLOCK_UNVERIFIABLE, convergeAckOnly: false, reviewStale: false };
      }
      // STALE-REVIEW GUARD (issue #799). When the PR HEAD has advanced PAST the commit the latest
      // Copilot review was submitted against, that review's suppressed advisories describe code the
      // head has moved past — e.g. an advisory the agent already FIXED IN CODE (but did not ack) is
      // still re-listed in the obsolete body. Blocking/escalating on it re-escalates a human
      // indefinitely (PR #789). Instead of gating on the stale body, signal `reviewStale` so the
      // process re-enters the review wait and the poller re-solicits a fresh review of the current
      // HEAD to gate on. The head read fails OPEN (null → not stale), so a transport hiccup can never
      // fabricate a stale verdict; the ordinary gate below still runs on a HEAD-current review.
      const headSha = await readHeadSha(ghRepo, ghNumber).catch(() => null);
      if (isReviewStale(review.commitId, headSha)) {
        return { convergeBlocked: false, convergeBlockReason: "", convergeAckOnly: false, reviewStale: true };
      }
      // Split the unresolved threads into SUBSTANTIVE reviewer findings vs partially-completed
      // `nano-ack:` ACK threads (root carries a canonical `nano-ack: <path> :: <text>` marker — see
      // `isAckThread`). Neither is ever dropped from the gate: a substantive unresolved thread blocks
      // and escalates to a human; an unresolved ack thread ALSO blocks (it is a genuinely-open GitHub
      // thread), but the block stays ack-only (recoverable by the bounded #796 auto-ack retry, which
      // re-posts/resolves it). Keeping the ack thread a BLOCKING condition — rather than filtering it
      // away — is what makes the root-marker classifier fail-CLOSED: a mislabelled substantive thread
      // still blocks (as ack-only) instead of finalizing with the finding open, and the bounded retry
      // cannot ack a non-advisory, so it escalates to a human on exhaustion.
      const unresolved = threadsRead.filter((t) => !t.isResolved);
      const unresolvedAckThreadCount = unresolved.filter((t) => isAckThread(t)).length;
      const unresolvedThreadCount = unresolved.length - unresolvedAckThreadCount;
      const advisories = parseSuppressedAdvisories(review.body);
      const gateInput = {
        unresolvedThreadCount,
        unresolvedAckThreadCount,
        suppressedAdvisories: advisories.map((a) => ({ key: a.key, label: a.label })),
        acknowledgedKeys: parseAckedAdvisories(threadsRead),
      };
      result = evaluateConvergeGate(gateInput);
      // NON-GATING shadow pass (#811): score this same decision with the tier-3a fixed-answer model
      // and persist both the gate's verdict (ground truth) and the scored one for calibration. It is
      // best-effort — `recordConvergeShadow` swallows every error — so the gate verdict below is
      // never perturbed. Only runs on the fully-computed path (where we have the real gate inputs).
      //
      // Dispatched FIRE-AND-FORGET, never awaited (#812): a locked/stalled SQLite write does not
      // reject — it simply never settles — so awaiting it would hold this converge-gate job open and
      // let the engine retry/incident the gate, delaying convergence despite the shadow being
      // non-gating. Keeping it off the critical path guarantees the gate returns on the gate's own
      // clock. The synchronous prefix (feature/label derivation) still runs inline; only the DB write
      // is detached. `.catch` guards against an unhandled rejection (recordConvergeShadow already
      // swallows internally, so this only ever fires on a truly unexpected throw).
      if (app?.data) void recordConvergeShadow(app.data, { prKey }, gateInput, result).catch(() => {});
    } catch {
      return { convergeBlocked: true, convergeBlockReason: BLOCK_UNVERIFIABLE, convergeAckOnly: false, reviewStale: false };
    }

    return {
      convergeBlocked: result.convergeBlocked,
      convergeBlockReason: result.convergeBlockReason,
      // Signals the bounded agent auto-ack path (#796): a block whose sole cause is recoverable —
      // unacked suppressed advisories AND/OR a lone unresolved `nano-ack:` ack thread (a
      // partially-completed acknowledgement), with NO substantive unresolved thread — re-dispatches
      // the review-round agent before escalating to a human.
      convergeAckOnly: result.ackOnly,
      reviewStale: false,
    };
  };
}

const handler = makeHandler({
  readThreads: defaultReadThreads,
  readReview: defaultReadReview,
  readHeadSha: defaultReadHead,
});
export default handler;
