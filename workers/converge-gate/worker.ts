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
// A blocked gate returns `convergeBlocked = true`; the model's `gw-converge-gate` gateway routes to
// the human `wait-answer` escalation (recoverable), never a hard wedge.
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
import {
  fetchLatestCopilotReviewBody,
  fetchReviewThreads,
  isAckThread,
  parseAckedAdvisories,
  parseSuppressedAdvisories,
  type ReviewThread,
} from "../../app/github.ts";
import { parsePr } from "../../app/service.ts";
import type { WorkerInputs, WorkerOutputs } from "../../nano-generated/worker-io.d.ts";

// Input/output typed off the model data envelopes (`PrConvergeGateIn` / `PrConvergeGateOut` in
// convergence-loop.bpmn), the single source of truth for this worker's wire contract (ADR 0040).
type In = WorkerInputs["pr.converge-gate"];
type Out = WorkerOutputs["pr.converge-gate"];

// Reads a PR's review threads. `null` = no usable transport (treated as an unverifiable read →
// fail closed). Throws propagate to the fail-closed catch below.
export type ThreadsReader = (repo: string, prNumber: number) => Promise<ReviewThread[] | null>;
// Reads the latest Copilot review body. `null` = no usable transport (unverifiable → fail closed);
// `""` = transport usable but no Copilot review yet (verified: no suppressed advisories).
export type ReviewBodyReader = (repo: string, prNumber: number) => Promise<string | null>;

const defaultReadThreads: ThreadsReader = (repo, prNumber) =>
  fetchReviewThreads(repo, prNumber, process.env.GITHUB_TOKEN ?? "");
const defaultReadReviewBody: ReviewBodyReader = (repo, prNumber) =>
  fetchLatestCopilotReviewBody(repo, prNumber, process.env.GITHUB_TOKEN ?? "");

const BLOCK_UNVERIFIABLE =
  "Convergence blocked: could not verify the PR's review comments against GitHub. A human must confirm every Copilot review thread is resolved and every suppressed advisory acknowledged before this PR converges (reply to resume the loop).";

/** Build the handler with injectable GitHub readers. The default export binds the real readers;
 * tests inject stubs. Fails CLOSED — any unreadable/errored state blocks convergence. */
export function makeHandler(deps: {
  readThreads: ThreadsReader;
  readReviewBody: ReviewBodyReader;
}): AppJobHandler<In, Out> {
  return async (job) => {
    const { prKey, repo, prNumber } = job.variables;
    // `parsePr` is total on any input (fails closed to `null` on a missing/non-string prKey), so
    // pass it straight through — a malformed prKey degrades to the fail-closed target check below.
    const parsed = parsePr(prKey);
    const ghRepo = repo ?? parsed?.repo;
    const ghNumber = typeof prNumber === "number" ? prNumber : parsed?.number;
    if (!ghRepo || typeof ghNumber !== "number") {
      return { convergeBlocked: true, convergeBlockReason: BLOCK_UNVERIFIABLE, convergeAckOnly: false };
    }

    let result: ConvergeGateResult;
    try {
      const threads = await deps.readThreads(ghRepo, ghNumber);
      // A null threads read is an unverifiable gate — fail closed. (An empty ARRAY is a verified
      // "no threads" and is fine.) An unverifiable block is NOT ack-only: it needs a human to
      // confirm GitHub state, so it must not enter the bounded agent auto-ack path (#796).
      if (threads === null) {
        return { convergeBlocked: true, convergeBlockReason: BLOCK_UNVERIFIABLE, convergeAckOnly: false };
      }
      const reviewBody = await deps.readReviewBody(ghRepo, ghNumber);
      // A null review body is an unverifiable read (no usable transport) — fail closed, same as a
      // null threads read. (An empty STRING is a verified "no Copilot review / no advisories".)
      if (reviewBody === null) {
        return { convergeBlocked: true, convergeBlockReason: BLOCK_UNVERIFIABLE, convergeAckOnly: false };
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
      const unresolved = threads.filter((t) => !t.isResolved);
      const unresolvedAckThreadCount = unresolved.filter((t) => isAckThread(t)).length;
      const unresolvedThreadCount = unresolved.length - unresolvedAckThreadCount;
      const advisories = parseSuppressedAdvisories(reviewBody);
      result = evaluateConvergeGate({
        unresolvedThreadCount,
        unresolvedAckThreadCount,
        suppressedAdvisories: advisories.map((a) => ({ key: a.key, label: a.label })),
        acknowledgedKeys: parseAckedAdvisories(threads),
      });
    } catch {
      return { convergeBlocked: true, convergeBlockReason: BLOCK_UNVERIFIABLE, convergeAckOnly: false };
    }

    return {
      convergeBlocked: result.convergeBlocked,
      convergeBlockReason: result.convergeBlockReason,
      // Signals the bounded agent auto-ack path (#796): a block whose sole cause is unacked
      // suppressed advisories re-dispatches the review-round agent before escalating to a human.
      convergeAckOnly: result.ackOnly,
    };
  };
}

const handler = makeHandler({
  readThreads: defaultReadThreads,
  readReviewBody: defaultReadReviewBody,
});
export default handler;
