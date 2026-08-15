// Convergence comment-gate (issue: don't converge with unaddressed review comments).
//
// The review loop declares convergence on the AGENT's self-reported status. That trusts the agent
// to only say "converged" once every Copilot comment is addressed — which failed on
// Magikcraft/nano-bpm#770 (20 rounds, a suppressed advisory never applied, then auto-merged with
// the comment unaddressed). This deterministic gate runs on the converged path and blocks handoff
// while either:
//   • any review THREAD is still unresolved, or
//   • any SUPPRESSED advisory (`path:line` in the latest Copilot review body) lacks a matching
//     RESOLVED ack thread (a thread carrying a `nano-ack: <path>:<line>` marker).
// A blocked gate escalates to the human wait-answer task (recoverable), never a hard wedge.

export interface ConvergeGateInput {
  /** Count of review threads with `isResolved === false`. */
  unresolvedThreadCount: number;
  /** `path:line` keys of Copilot's suppressed advisories (latest review body). */
  suppressedKeys: string[];
  /** `path:line` keys acknowledged by RESOLVED `nano-ack:` threads. */
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
  const unacked = input.suppressedKeys.filter((k) => !acked.has(k));
  const reasons: string[] = [];
  if (input.unresolvedThreadCount > 0) {
    const n = input.unresolvedThreadCount;
    reasons.push(`${n} unresolved review thread${n === 1 ? "" : "s"}`);
  }
  if (unacked.length > 0) {
    const noun = unacked.length === 1 ? "advisory" : "advisories";
    reasons.push(`${unacked.length} unacknowledged suppressed ${noun} (${unacked.join(", ")})`);
  }
  if (reasons.length === 0) {
    return { convergeBlocked: false, convergeBlockReason: "" };
  }
  return {
    convergeBlocked: true,
    convergeBlockReason: `Convergence blocked: ${reasons.join("; ")}. Resolve every review thread and reply-and-resolve an ack thread (nano-ack: <path>:<line>) for each suppressed advisory before converging.`,
  };
}
