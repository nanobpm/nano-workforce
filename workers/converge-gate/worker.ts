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
// The scope-integrity block also carries a HUMAN-OVERRIDE door (#395): before it re-blocks, it
// reads the commit now under review and consults the `escalations` answer bound to that SAME HEAD.
// An operator who answered the scope question for this exact commit ("this fully delivers the issue
// — keep the closing keyword") has explicitly overridden it, so the gate honours that answer
// (audited) instead of re-deriving `scopeBlocked` from the PR body and re-escalating the identical
// question forever. Binding to the HEAD sha keeps the override from carrying across a new push, and
// (via `PrConvergeGateOut.headSha`/`scopeBlocked`) lets `persist-escalation-blockedcomments` stamp
// the escalation with the reviewed commit so the door can open on the next round.
//
// It FAILS CLOSED: if the live GitHub state cannot be read, it blocks (escalates) rather than
// letting an unverifiable "converged" through — the opposite of the no-progress guard, because a
// merge-gating check must escalate-on-uncertainty so #770 cannot recur.
import type { AppJobHandler } from "@nanobpm/urban";
import { type ConvergeGateResult, evaluateConvergeGate } from "../../app/convergeGate.ts";
import {
  fetchLatestCopilotReviewBody,
  fetchPrHead,
  fetchPrMeta,
  fetchReviewThreads,
  parseAckedAdvisories,
  parseSuppressedAdvisories,
  type ReviewThread,
} from "../../app/github.ts";
import { evaluateScopeGuard, isScopeOverridden, type ScopeEscalationAnswer } from "../../app/scopeGuard.ts";
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
// Reads the PR's current HEAD sha (the commit under review). `null` = unreadable/no transport — the
// scope override cannot be verified or bound to a commit, so the gate keeps blocking (fail closed).
export type HeadShaReader = (repo: string, prNumber: number) => Promise<string | null>;

const defaultReadThreads: ThreadsReader = (repo, prNumber) =>
  fetchReviewThreads(repo, prNumber, process.env.GITHUB_TOKEN ?? "");
const defaultReadReviewBody: ReviewBodyReader = (repo, prNumber) =>
  fetchLatestCopilotReviewBody(repo, prNumber, process.env.GITHUB_TOKEN ?? "");
const defaultReadPrBody: PrBodyReader = async (repo, prNumber) => {
  const meta = await fetchPrMeta(repo, prNumber, process.env.GITHUB_TOKEN ?? "");
  return meta ? meta.body : null;
};
const defaultReadHeadSha: HeadShaReader = async (repo, prNumber) => {
  const head = await fetchPrHead(repo, prNumber, process.env.GITHUB_TOKEN ?? "");
  return head ? head.headSha : null;
};

const BLOCK_UNVERIFIABLE =
  "Convergence blocked: could not verify the PR's review comments against GitHub. A human must confirm every Copilot review thread is resolved and every suppressed advisory acknowledged before this PR converges (reply to resume the loop).";

const BLOCK_UNVERIFIABLE_BODY =
  "Convergence blocked: could not read the PR description from GitHub to verify scope integrity. A human must confirm this PR does not close a broader-scoped parent with an untracked deferred remainder before it converges (reply to resume the loop).";

// An `escalations` row as this worker reads it back when looking for a recorded human override.
interface EscalationRow extends Record<string, unknown> {
  id: number;
  head_sha: string | null;
  answer: string | null;
  scope_block: number | boolean | null;
}

// Find the newest ANSWERED scope-integrity escalation for this PR whose recorded HEAD matches the
// commit now under review (issue #395). This is the human-override door: `persist-escalation` binds
// a scope block to the HEAD it was raised against, `answer-escalation` marks the row `answered`, and
// here we honour that answer for the SAME HEAD so the gate stops re-deriving `scopeBlocked` from the
// PR body and re-escalating the identical question forever. Newest-first so a re-escalated-then-
// answered duplicate resolves to the operator's latest reply. Returns `null` on any read failure —
// the caller then keeps the block (fail closed), never fabricates an override.
async function findScopeOverride(
  app: Parameters<AppJobHandler<In, Out>>[1],
  prKey: string,
  headSha: string,
): Promise<ScopeEscalationAnswer | null> {
  try {
    // `scope_block` is a first-class column (persist-escalation writes it as 0/1), so filter on it
    // in the query rather than reading every answered escalation and filtering in memory — a PR with
    // many answered non-scope escalations no longer loads them all just to discard them.
    const rows = await app.data.table<EscalationRow>("escalations", "id").find({
      pr_key: prKey,
      status: "answered",
      scope_block: 1,
    });
    const scoped = rows
      .map((r) => ({ escalationId: Number(r.id), headSha: r.head_sha ?? null, answer: r.answer ?? null }))
      .sort((a, b) => (b.escalationId ?? 0) - (a.escalationId ?? 0));
    for (const candidate of scoped) {
      if (isScopeOverridden(headSha, candidate)) return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

/** Build the handler with injectable GitHub readers. The default export binds the real readers;
 * tests inject stubs. Fails CLOSED — any unreadable/errored state blocks convergence. */
export function makeHandler(deps: {
  readThreads: ThreadsReader;
  readReviewBody: ReviewBodyReader;
  readPrBody: PrBodyReader;
  readHeadSha: HeadShaReader;
}): AppJobHandler<In, Out> {
  return async (job, app) => {
    const { prKey, repo, prNumber } = job.variables;
    // `parsePr` is total on any input (fails closed to `null` on a missing/non-string prKey), so
    // pass it straight through — a malformed prKey degrades to the fail-closed target check below.
    const parsed = parsePr(prKey);
    const ghRepo = repo ?? parsed?.repo;
    const ghNumber = typeof prNumber === "number" ? prNumber : parsed?.number;
    if (!ghRepo || typeof ghNumber !== "number") {
      return { convergeBlocked: true, convergeBlockReason: BLOCK_UNVERIFIABLE };
    }
    // The canonical escalations key. Prefer the carried prKey; fall back to the parsed identity so
    // the override lookup still keys off `owner/repo#N` when only repo/prNumber survived.
    const escPrKey = typeof prKey === "string" && prKey !== "" ? prKey : `${ghRepo}#${ghNumber}`;

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

    // The human-override door for the scope-integrity block (issue #395). When the deterministic
    // scope guard would re-block, read the commit now under review and consult the recorded
    // escalation answer bound to that SAME HEAD: an operator who answered the scope question for
    // this exact commit has explicitly overridden it ("this fully delivers the issue — keep the
    // closing keyword"), so honour it (audited) instead of re-deriving the block from the body and
    // re-escalating forever. Binding to the HEAD sha keeps the override from carrying across a new
    // push (a different HEAD legitimately re-opens the gate); and if the human instead asked for a
    // real split, the servicing agent pushes a fix — moving the HEAD so this stale override never
    // fires. This is what turns the infinite escalation loop into a resolvable one.
    let headSha: string | null = null;
    let scopeBlocked = scopeReason !== "";
    if (scopeBlocked) {
      try {
        headSha = await deps.readHeadSha(ghRepo, ghNumber);
      } catch {
        headSha = null;
      }
      if (headSha) {
        const override = await findScopeOverride(app, escPrKey, headSha);
        if (override) {
          app.log.info("converge-gate: scope-integrity block overridden by human answer", {
            prKey: escPrKey,
            headSha,
            escalationId: override.escalationId ?? null,
            // The human answer is free-form operator input — never log it verbatim (it can carry
            // sensitive content into application logs). Record only stable identifiers plus a
            // minimal presence/length signal for debugging.
            hasAnswer: override.answer != null && override.answer !== "",
            answerLength: override.answer?.length ?? 0,
          });
          scopeReason = "";
          scopeBlocked = false;
        }
      }
    }

    // Both guards gate the same handoff to the merge loop: block if EITHER the review-comment gate
    // or the scope-integrity gate blocks, joining their reasons so the human sees every cause.
    const reason = [result.convergeBlockReason, scopeReason].filter((r) => r !== "").join(" ");
    const out: Out = {
      convergeBlocked: result.convergeBlocked || scopeBlocked,
      convergeBlockReason: reason,
    };
    // Surface the reviewed HEAD and the scope-block flag ONLY when scope actually blocks — the
    // `persist-escalation-blockedcomments` arm (which runs only on a blocked gate) binds the
    // escalation to this commit with them, opening the override door on the next round. A clean
    // converge keeps its original `{ convergeBlocked, convergeBlockReason }` shape.
    if (scopeBlocked) {
      out.scopeBlocked = true;
      out.headSha = headSha ?? undefined;
    }
    return out;
  };
}

const handler = makeHandler({
  readThreads: defaultReadThreads,
  readReviewBody: defaultReadReviewBody,
  readPrBody: defaultReadPrBody,
  readHeadSha: defaultReadHeadSha,
});
export default handler;
