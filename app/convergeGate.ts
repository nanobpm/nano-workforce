// Convergence comment-gate (issue: don't converge with unaddressed review comments).
//
// The review loop declares convergence on the AGENT's self-reported status. That trusts the agent
// to only say "converged" once every Copilot comment is addressed — which failed on
// Magikcraft/nano-bpm#770 (20 rounds, a suppressed advisory never applied, then auto-merged with
// the comment unaddressed). This deterministic gate runs on the converged path and blocks handoff
// while either:
//   • any review THREAD is still unresolved, or
//   • any SUPPRESSED advisory (in the latest Copilot review body) lacks a matching
//     RESOLVED ack thread (a thread carrying a line-stable `nano-ack: <path> :: <text>` marker; the
//     bare `nano-ack: <path>:<line>` form is NOT honoured — its `path:line` key is prose-blind and
//     would false-OPEN a new advisory re-emitted at a previously-acked line).
// A blocked gate escalates to the human wait-answer task (recoverable), never a hard wedge.

export interface ConvergeGateInput {
  /** Count of review threads with `isResolved === false`. */
  unresolvedThreadCount: number;
  /** Copilot's suppressed advisories (latest review body), each with its line-stable key + label. */
  suppressedAdvisories: { key: string; label: string }[];
  /** Acknowledged line-stable keys (`<path>#<fp>`) from RESOLVED `nano-ack:` threads. An advisory is
   * acked iff its stable key appears here. */
  acknowledgedKeys: string[];
}

export interface ConvergeGateResult {
  convergeBlocked: boolean;
  convergeBlockReason: string;
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
  const reasons: string[] = [];
  if (input.unresolvedThreadCount > 0) {
    const n = input.unresolvedThreadCount;
    reasons.push(`${n} unresolved review thread${n === 1 ? "" : "s"}`);
  }
  if (unacked.length > 0) {
    const noun = unacked.length === 1 ? "advisory" : "advisories";
    reasons.push(`${unacked.length} unacknowledged suppressed ${noun} (${unacked.map((a) => a.label).join(", ")})`);
  }
  if (reasons.length === 0) {
    return { convergeBlocked: false, convergeBlockReason: "" };
  }
  return {
    convergeBlocked: true,
    convergeBlockReason: `Convergence blocked: ${reasons.join("; ")}. Resolve every review thread and reply-and-resolve an ack thread (nano-ack: <path> :: <verbatim advisory text>) for each suppressed advisory before converging.`,
  };
}
