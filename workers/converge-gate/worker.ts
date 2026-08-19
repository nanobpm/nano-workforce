// pr.converge-gate — the deterministic review-comment gate for the convergence loop.
//
// The loop declares convergence on the review-round AGENT's self-reported `status = "converged"`.
// That trusts the agent to only converge once every Copilot comment is addressed — which failed on
// Magikcraft/nano-bpm#770 (20 rounds, a suppressed advisory never applied, then auto-merged with
// the comment unaddressed). This step runs on the converged path, BEFORE pr.finalize hands off to
// the merge loop, and blocks handoff while GitHub still shows unaddressed comments:
//   • any review THREAD is still unresolved (GraphQL `isResolved = false`), or
//   • any SUPPRESSED advisory in the latest Copilot review body lacks a matching RESOLVED ack
//     thread (a `nano-ack: <path>:<line>` marker copied from Copilot's `**path:line**` header).
// A blocked gate returns `convergeBlocked = true`; the model's `gw-converge-gate` gateway routes to
// the human `wait-answer` escalation (recoverable), never a hard wedge.
//
// It ALSO enforces the scope-integrity guards (#313) over the PR description, blocking handoff when
// the PR under-delivers a broader-scoped parent:
//   • a partial delivery that `Closes/Fixes/Resolves #N` while ALSO deferring scope (a `## Scope`
//     section / "deferred" / "out of scope"), or
//   • a deferral recorded only in PR prose with no filed follow-up issue linked for the remainder.
// This is the enforcement backstop for the Magikcraft/nano-bpm#631 → PR #863 (`Closes #631`, `##
// Scope` deferral, no follow-up → re-filed by hand as #872) failure class. See app/scopeGuard.ts.
//
// It FAILS CLOSED: if the live GitHub state cannot be read, it blocks (escalates) rather than
// letting an unverifiable "converged" through — the opposite of the no-progress guard, because a
// merge-gating check must escalate-on-uncertainty so #770 cannot recur.
import type { AppJobHandler } from "@nanobpm/urban";
import { type ConvergeGateResult, evaluateConvergeGate } from "../../app/convergeGate.ts";
import {
  fetchLatestCopilotReviewBody,
  fetchPrMeta,
  fetchReviewThreads,
  parseAckedAdvisories,
  parseSuppressedAdvisories,
  type ReviewThread,
} from "../../app/github.ts";
import { evaluateScopeGuard } from "../../app/scopeGuard.ts";
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
// Reads the PR's own description body. `null` = no usable transport (unverifiable → fail closed);
// `""` = transport usable but the PR has an empty description (verified: nothing to scope-check).
export type PrBodyReader = (repo: string, prNumber: number) => Promise<string | null>;

const defaultReadThreads: ThreadsReader = (repo, prNumber) =>
  fetchReviewThreads(repo, prNumber, process.env.GITHUB_TOKEN ?? "");
const defaultReadReviewBody: ReviewBodyReader = (repo, prNumber) =>
  fetchLatestCopilotReviewBody(repo, prNumber, process.env.GITHUB_TOKEN ?? "");
const defaultReadPrBody: PrBodyReader = async (repo, prNumber) => {
  const meta = await fetchPrMeta(repo, prNumber, process.env.GITHUB_TOKEN ?? "");
  return meta ? meta.body : null;
};

const BLOCK_UNVERIFIABLE =
  "Convergence blocked: could not verify the PR's review comments against GitHub. A human must confirm every Copilot review thread is resolved and every suppressed advisory acknowledged before this PR converges (reply to resume the loop).";

const BLOCK_UNVERIFIABLE_BODY =
  "Convergence blocked: could not read the PR description from GitHub to verify scope integrity. A human must confirm this PR does not close a broader-scoped parent with an untracked deferred remainder before it converges (reply to resume the loop).";

/** Build the handler with injectable GitHub readers. The default export binds the real readers;
 * tests inject stubs. Fails CLOSED — any unreadable/errored state blocks convergence. */
export function makeHandler(deps: {
  readThreads: ThreadsReader;
  readReviewBody: ReviewBodyReader;
  readPrBody: PrBodyReader;
}): AppJobHandler<In, Out> {
  return async (job) => {
    const { prKey, repo, prNumber } = job.variables;
    // `parsePr` is total on any input (fails closed to `null` on a missing/non-string prKey), so
    // pass it straight through — a malformed prKey degrades to the fail-closed target check below.
    const parsed = parsePr(prKey);
    const ghRepo = repo ?? parsed?.repo;
    const ghNumber = typeof prNumber === "number" ? prNumber : parsed?.number;
    if (!ghRepo || typeof ghNumber !== "number") {
      return { convergeBlocked: true, convergeBlockReason: BLOCK_UNVERIFIABLE };
    }

    let result: ConvergeGateResult;
    let scopeReason: string;
    try {
      const threads = await deps.readThreads(ghRepo, ghNumber);
      // A null threads read is an unverifiable gate — fail closed. (An empty ARRAY is a verified
      // "no threads" and is fine.)
      if (threads === null) {
        return { convergeBlocked: true, convergeBlockReason: BLOCK_UNVERIFIABLE };
      }
      const reviewBody = await deps.readReviewBody(ghRepo, ghNumber);
      // A null review body is an unverifiable read (no usable transport) — fail closed, same as a
      // null threads read. (An empty STRING is a verified "no Copilot review / no advisories".)
      if (reviewBody === null) {
        return { convergeBlocked: true, convergeBlockReason: BLOCK_UNVERIFIABLE };
      }
      const unresolvedThreadCount = threads.filter((t) => !t.isResolved).length;
      result = evaluateConvergeGate({
        unresolvedThreadCount,
        suppressedKeys: parseSuppressedAdvisories(reviewBody),
        acknowledgedKeys: parseAckedAdvisories(threads),
      });
    } catch {
      return { convergeBlocked: true, convergeBlockReason: BLOCK_UNVERIFIABLE };
    }

    // The scope-integrity guard (#313) reads/parses the PR description in its OWN try — a transport
    // or parse failure here is a scope read failure, so it must surface BLOCK_UNVERIFIABLE_BODY, not
    // the review-comment BLOCK_UNVERIFIABLE above. Sharing one catch would mislabel a description
    // read failure as a review-thread verification failure and point the human escalation at the
    // wrong place.
    try {
      // The PR description drives the scope-integrity guard (#313). A null read is unverifiable —
      // fail closed with a scope-specific reason. (An empty STRING is a verified empty description:
      // no closing keyword, no deferral, so the scope guard passes.)
      const prBody = await deps.readPrBody(ghRepo, ghNumber);
      if (prBody === null) {
        return { convergeBlocked: true, convergeBlockReason: BLOCK_UNVERIFIABLE_BODY };
      }
      scopeReason = evaluateScopeGuard({ prBody }).scopeBlockReason;
    } catch {
      return { convergeBlocked: true, convergeBlockReason: BLOCK_UNVERIFIABLE_BODY };
    }

    // Both guards gate the same handoff to the merge loop: block if EITHER the review-comment gate
    // or the scope-integrity gate blocks, joining their reasons so the human sees every cause.
    const reason = [result.convergeBlockReason, scopeReason].filter((r) => r !== "").join(" ");
    return {
      convergeBlocked: result.convergeBlocked || scopeReason !== "",
      convergeBlockReason: reason,
    };
  };
}

const handler = makeHandler({
  readThreads: defaultReadThreads,
  readReviewBody: defaultReadReviewBody,
  readPrBody: defaultReadPrBody,
});
export default handler;
