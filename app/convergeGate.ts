// Convergence comment-gate (issue: don't converge with unaddressed review comments).
//
// The review loop declares convergence on the AGENT's self-reported status. That trusts the agent
// to only say "converged" once every Copilot comment is addressed — which failed on
// Magikcraft/nano-bpm#770 (20 rounds, a suppressed advisory never applied, then auto-merged with
// the comment unaddressed). This deterministic gate runs on the converged path and blocks handoff
// while any of:
//   • any SUBSTANTIVE review THREAD is still unresolved, or
//   • any partially-completed `nano-ack:` ACK THREAD is still unresolved (blocks, but recoverable —
//     see `unresolvedAckThreadCount`), or
//   • any SUPPRESSED advisory (in the latest Copilot review body) lacks a matching
//     RESOLVED ack thread (a thread carrying a line-stable `nano-ack: <path> :: <text>` marker; the
//     bare `nano-ack: <path>:<line>` form is NOT honoured — its `path:line` key is prose-blind and
//     would false-OPEN a new advisory re-emitted at a previously-acked line).
// A blocked gate is recoverable, never a hard wedge — but the route depends on WHY it blocked: an
// ack-only block (sole cause unacked advisories and/or an unresolved `nano-ack:` thread) re-enters
// the `review-round` agent first, bounded by `ackRetryMax`, and only escalates to the human
// wait-answer task once that budget is exhausted; a substantive unresolved thread escalates to
// wait-answer immediately.

export interface ConvergeGateInput {
  /** Count of unresolved review threads that are NOT `nano-ack:` ack threads (substantive reviewer
   * findings). Any of these forces the block off the ack-only path — it needs the round agent's
   * code/reply work, so it escalates to a human. */
  unresolvedThreadCount: number;
  /** Count of unresolved threads the worker classified as `nano-ack:` ACK threads (partially-completed
   * acknowledgements: posted but not yet resolved). These NEVER silently drop out of the gate — an
   * unresolved ack thread is still a genuinely-open GitHub thread, so it BLOCKS convergence; but the
   * block stays ack-only (recoverable by the bounded #796 auto-ack retry, which re-posts/resolves).
   * Keeping this a blocking condition (rather than filtering the thread away) is what makes the
   * `isAckThread` root-marker classifier FAIL-CLOSED: even if it mis-labels a substantive thread as
   * an ack, that thread still BLOCKS (as ack-only) instead of finalizing with the finding open — and
   * the bounded retry cannot ack a non-advisory, so it escalates to a human on exhaustion. Optional
   * (defaults to 0) so the pure function stays total for callers that only track substantive threads. */
  unresolvedAckThreadCount?: number;
  /** Copilot's suppressed advisories (latest review body), each with its line-stable key + label. */
  suppressedAdvisories: { key: string; label: string }[];
  /** Acknowledged line-stable keys (`<path>#<fp>`) from RESOLVED `nano-ack:` threads. An advisory is
   * acked iff its stable key appears here. */
  acknowledgedKeys: string[];
}

export interface ConvergeGateResult {
  convergeBlocked: boolean;
  convergeBlockReason: string;
  /** True when the block is caused SOLELY by recoverable, agent-fixable state and no SUBSTANTIVE
   * (non-ack) reviewer thread is open: unacknowledged suppressed advisories and/or a
   * partially-completed (unresolved) `nano-ack:` ack thread. This is the case the loop can auto-ack:
   * re-dispatching the review-round agent posts/resolves the missing ack threads and converges, so
   * the process routes an ack-only block through a bounded agent auto-ack step BEFORE the human
   * `wait-answer` (issue #796). A block that includes any unresolved SUBSTANTIVE inline thread (which
   * needs the round agent's code/reply work) is NOT ack-only and escalates to a human as before.
   * Always false when not blocked. */
  ackOnly: boolean;
}

/** Decide whether a self-reported "converged" round may proceed to finalize. Pure; the worker
 * feeds it live GitHub state and fails CLOSED (blocks) when that state cannot be read. */
export function evaluateConvergeGate(input: ConvergeGateInput): ConvergeGateResult {
  const acked = new Set(input.acknowledgedKeys);
  // An advisory is acknowledged iff its line-stable prose key was acked — the stable key survives a
  // line drift across rounds (issue #787). The prose-blind legacy `path:line` key is intentionally
  // NOT consulted: it would let a resolved ack for one advisory silently acknowledge a genuinely new
  // advisory re-emitted at the same line (a false-OPEN this gate exists to prevent).
  const unacked = input.suppressedAdvisories.filter((a) => !acked.has(a.key));
  const unresolvedAck = input.unresolvedAckThreadCount ?? 0;
  const reasons: string[] = [];
  if (input.unresolvedThreadCount > 0) {
    const n = input.unresolvedThreadCount;
    reasons.push(`${n} unresolved review thread${n === 1 ? "" : "s"}`);
  }
  if (unresolvedAck > 0) {
    reasons.push(`${unresolvedAck} unresolved acknowledgement thread${unresolvedAck === 1 ? "" : "s"}`);
  }
  if (unacked.length > 0) {
    const noun = unacked.length === 1 ? "advisory" : "advisories";
    reasons.push(`${unacked.length} unacknowledged suppressed ${noun} (${unacked.map((a) => a.label).join(", ")})`);
  }
  if (reasons.length === 0) {
    return { convergeBlocked: false, convergeBlockReason: "", ackOnly: false };
  }
  return {
    convergeBlocked: true,
    convergeBlockReason: `Convergence blocked: ${reasons.join("; ")}. Resolve every review thread and reply-and-resolve an ack thread (nano-ack: <path> :: <verbatim advisory text>) for each suppressed advisory before converging.`,
    // Ack-only iff NO substantive (non-ack) reviewer thread is open — the only remaining causes are
    // recoverable by re-dispatching the review-round agent (#796): unacked suppressed advisories
    // and/or a partially-completed (unresolved) ack thread it can re-post and resolve. A substantive
    // unresolved thread needs the round agent's code/reply work and escalates to a human.
    ackOnly: input.unresolvedThreadCount === 0 && (unacked.length > 0 || unresolvedAck > 0),
  };
}
