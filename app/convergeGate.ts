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
//     legacy `nano-ack: <path>:<line>` form is still honoured for back-compat).
// A blocked gate escalates to the human wait-answer task (recoverable), never a hard wedge.

export interface ConvergeGateInput {
  /** Count of review threads with `isResolved === false`. */
  unresolvedThreadCount: number;
  /** Copilot's suppressed advisories (latest review body), each with its line-stable + legacy key. */
  suppressedAdvisories: { key: string; legacyKey: string; label: string }[];
  /** Acknowledged keys from RESOLVED `nano-ack:` threads — line-stable (`<path>#<fp>`) and/or legacy
   * (`path:line`). An advisory is acked iff its stable key OR its legacy key appears here. */
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
  // An advisory is acknowledged if EITHER its line-stable key or its legacy `path:line` key was
  // acked — the stable key survives a line drift across rounds (issue #787), the legacy key keeps
  // pre-#787 acks converging within a round.
  const unacked = input.suppressedAdvisories.filter((a) => !acked.has(a.key) && !acked.has(a.legacyKey));
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
