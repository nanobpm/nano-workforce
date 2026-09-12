// No-progress guard routing — the canonical, testable mirror of the convergence-loop
// `gw-progress` exclusive gateway (see resources/processes/convergence-loop.bpmn and the
// structural guard in roundProgress.test.ts).
//
// The convergence loop trusts the agent's self-reported `addressed` status to trigger the next
// Copilot review round. But an agent can return `addressed` (or fall back to the safe `addressed`
// default) WITHOUT actually pushing a commit — nothing landed on the PR head. Copilot then
// re-reviews byte-identical code, produces the same comments, and the loop burns rounds making no
// progress until the round cap escalates. That is the trap.
//
// So a deterministic step (`pr.progress-check`, workers/progress-check/worker.ts) reads the PR's
// head SHA and compares it to the head observed at the previous round. When an `addressed` round's
// head did NOT advance, the process must NOT request another review round — it escalates to the
// human `wait-answer` task instead. This module is the single source of truth for that decision so
// the worker and the BPMN gateway can never drift apart.

/** Where a recorded round routes after the progress check:
 *  • `continue`  — request another review round (the head advanced, or the round carried an
 *                  explicit non-addressed status — e.g. `waiting` — that claims no push, or the
 *                  head could not be read so we fail OPEN rather than fabricate a no-progress
 *                  escalation).
 *  • `escalate`  — an `addressed` round whose PR head did not move: no commit was really pushed,
 *                  so re-review would loop. Escalate to a human instead of looping. */
export type ProgressRouting = "continue" | "escalate";

// The statuses that route AWAY from gw-status's `addressed`/default arm (see the explicit
// conditions on f_converged/f_waiting/f_escalate in convergence-loop.bpmn). A round carrying one of
// these legitimately claims no push and must always continue past the no-progress guard.
//
// Everything else — an explicit `addressed`, a blank/unknown/empty status, or any unrecognized
// string — takes gw-status's `addressed`/default arm, and pr.persist-round records a missing status
// as `addressed` too. That safe-default `addressed` round is EXACTLY the no-progress trap this guard
// exists for, so blank/unknown status must be treated as `addressed` here (subject to the head
// comparison), never waved through. Matching is exact (no trim) to mirror gw-status's `=status =
// "waiting"` equality: a padded `" waiting "` matches no arm there, so it defaults to `addressed`
// here as well.
const NON_ADDRESSED_STATUSES: ReadonlySet<string> = new Set([
  "waiting",
  "converged",
  "needs_input",
  "blocked",
]);

/** True when a round's status is `addressed` for no-progress purposes — i.e. NOT one of the
 * explicitly recognized non-addressed statuses. Blank/unknown/empty status is `addressed` here,
 * mirroring gw-status's default arm and pr.persist-round's missing-status default. The single
 * source of truth for both {@link routeProgress} and the pr.progress-check worker's early skip. */
export function isAddressedStatus(status: string | null | undefined): boolean {
  return !NON_ADDRESSED_STATUSES.has(status ?? "");
}

/** Decide whether a recorded round made real progress, exactly as `gw-progress` does.
 *
 * Only an `addressed` round claims the agent pushed changes, so only it can be a no-progress
 * round — and blank/unknown status counts as `addressed` (see {@link isAddressedStatus}): it is the
 * safe-default round this guard exists to catch. An explicitly recognized non-addressed status
 * (`waiting` on round 1, awaiting the first review, etc.) legitimately has no push and must always
 * continue. The check FAILS OPEN: when either head SHA is unknown — no GitHub transport, a transient
 * read error, or no baseline recorded yet (the first observed round) — we never fabricate a
 * no-progress escalation; we continue and let the round cap / review-wait timeout remain the safety
 * nets. */
export function routeProgress(
  status: string | null | undefined,
  previousHead: string | null | undefined,
  currentHead: string | null | undefined,
): ProgressRouting {
  if (!isAddressedStatus(status)) return "continue";
  if (!previousHead || !currentHead) return "continue";
  return currentHead === previousHead ? "escalate" : "continue";
}

// ── Husk classification & bounded self-heal (issue #786) ─────────────────────
//
// A no-advance `addressed` round is not one failure mode but two, and they warrant different
// handling:
//
//  • `husk` — the agent job completed reporting `addressed`, but minted NO durable work: no commit
//    was pushed AND no `review-round` agent-instance ever reached a terminal state (the producer
//    harness died mid-run, so the round is a phantom — jwulf/c8ctl-plugin-nano#230/#229). This is a
//    transient worker/harness defect, not a real design impasse, so it is *resumable onto a healthy
//    worker*: re-run the SAME round rather than parking a human. Bounded by {@link MAX_HUSK_RETRIES}
//    so a persistently-husking worker still escalates instead of looping forever.
//
//  • `no-advance` — the agent DID run to a terminal agent-instance but pushed no commit (it genuinely
//    believes nothing was needed, or is wrong about the code). Re-running would loop on identical
//    reasoning, so this escalates to a human immediately, exactly as before.
//
// The head-diff (`routeProgress`) still TRIGGERS the no-progress path; the agent-instance
// corroboration only SPLITS it into husk vs. no-advance so the auto-heal and the escalation message
// are accurate.

/** Why a no-advance `addressed` round made no progress — see the block comment above. */
export type NoProgressReason = "husk" | "no-advance";

/** How many times a husked round is auto-re-run onto a (hopefully healthy) worker before the loop
 * gives up and escalates to a human. The bound is what keeps the self-heal from looping forever on a
 * persistently-husking worker. */
export const MAX_HUSK_RETRIES = 2;

/** The full decision for a recorded round: whether it progressed, the running husk-retry count to
 * carry forward, and — when it did NOT progress — whether to auto-retry the same round (`huskRetry`),
 * the classified `reason`, and (when escalating) the human-facing `question`. This is the single
 * source of truth the `pr.progress-check` worker returns and `gw-progress`/`gw-husk` route on. */
export interface ProgressDecision {
  readonly progressed: boolean;
  readonly huskRetries: number;
  readonly huskRetry?: boolean;
  readonly reason?: NoProgressReason;
  readonly question?: string;
}

/** Coerce an externally-supplied husk-retry counter (a process variable that is null/blank on the
 * first husk, and could be any shape after a variable regression) to a non-negative integer. */
function normalizeRetries(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/** Build the human-facing escalation question for a no-progress round, tuned to its {@link
 * NoProgressReason} so the human sees "the agent produced no durable work (a husk)" rather than the
 * generic "no commit was pushed" when that is what actually happened. */
export function noProgressQuestion(
  round: number,
  reason: NoProgressReason,
  huskRetriesExhausted: boolean,
): string {
  if (reason === "husk") {
    const tail = huskRetriesExhausted
      ? ` and re-running the round ${MAX_HUSK_RETRIES} time(s) did not help (the worker keeps husking)`
      : "";
    return (
      `Round ${round} reported the review comments were addressed, but the agent produced no ` +
      `durable work — no commit was pushed and no completed review agent-instance was recorded for ` +
      `the round (a husked round; the worker likely died mid-run)${tail}. A human must decide how to ` +
      `proceed (reply to resume the loop).`
    );
  }
  return (
    `Round ${round} reported the review comments were addressed, but the PR head did not advance ` +
    `(no commit was pushed), so another review round would loop on identical code. A human must ` +
    `decide how to proceed (reply to resume the loop).`
  );
}

/** The canonical no-progress decision, mirroring {@link routeProgress} for the head-diff trigger and
 * then splitting a no-advance round into a bounded husk auto-retry vs. an immediate escalation.
 *
 *  • A round that progressed (head advanced, or a legitimately non-addressed status, or an
 *    unreadable head that fails OPEN) returns `{ progressed: true, huskRetries: 0 }` — real progress
 *    RESETS the husk counter so a later, unrelated husk starts fresh.
 *  • A husked round under the retry cap returns `{ progressed: false, huskRetry: true,
 *    huskRetries: n+1 }` — `gw-husk` re-enters `review-round` (the SAME round) to try a healthy
 *    worker.
 *  • A husked round at the cap, or any `no-advance` round, returns `{ progressed: false,
 *    huskRetry: false, huskRetries: 0, question }` — `gw-husk` routes to the human escalation. The
 *    counter resets so a human-answered resume gets fresh retries.
 *
 * `agentWorkObserved` is the agent-instance corroboration: `true` when a terminal `review-round`
 * agent-instance exists for the round (→ `no-advance`); `false` — a SUCCESSFUL read that found no
 * terminal instance (incl. the read-as-absence testkit, whose empty list is `false`) → `husk`; and
 * `null`/`undefined` — an UNKNOWN read (the engine channel was unavailable or threw) → `no-advance`,
 * never an auto-retry, so a transient AgentInstance read outage can never duplicate genuinely-
 * completed agent work. Only a positively-corroborated empty read is a husk. */
export function decideProgress(
  status: string | null | undefined,
  previousHead: string | null | undefined,
  currentHead: string | null | undefined,
  round: number,
  agentWorkObserved: boolean | null | undefined,
  currentHuskRetries: number | null | undefined,
  maxHuskRetries: number = MAX_HUSK_RETRIES,
): ProgressDecision {
  if (routeProgress(status, previousHead, currentHead) === "continue") {
    return { progressed: true, huskRetries: 0 };
  }
  // Only a POSITIVELY-corroborated empty read (`false` — a successful AgentInstance search that
  // found no terminal `review-round` instance) is a husk we may auto-retry. `true` (a terminal
  // instance exists) is a real no-advance; and an UNKNOWN read (`null`/`undefined` — the engine
  // channel was unavailable or threw) must NOT auto-retry, since re-running could duplicate agent
  // work that actually did run. So an unknown read fails safe to `no-advance` (escalate to a human),
  // exactly as the pre-#786 loop did — only a successful empty read means husk.
  const reason: NoProgressReason = agentWorkObserved === false ? "husk" : "no-advance";
  const retries = normalizeRetries(currentHuskRetries);
  if (reason === "husk" && retries < maxHuskRetries) {
    return { progressed: false, huskRetry: true, huskRetries: retries + 1, reason };
  }
  return {
    progressed: false,
    huskRetry: false,
    huskRetries: 0,
    reason,
    question: noProgressQuestion(round, reason, retries >= maxHuskRetries),
  };
}
