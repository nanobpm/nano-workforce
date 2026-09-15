// pr.capture-head — captures the PR's head SHA at the START of a convergence round, BEFORE the
// `review-round` agent runs.
//
// Every entry into `review-round` (the first round from Start, a review-loop re-enter, a human-answer
// resume, and a husk auto-retry) now routes through this step first. It reads the head as it stands
// immediately before the agent acts and publishes it as the `roundEntryHead` process variable, which
// `pr.progress-check` (workers/progress-check/worker.ts) then reads as the round's baseline.
//
// WHY this exists (issue #786 / Copilot #789 — closing both sides of the no-baseline husk problem):
// progress-check classifies a no-advance `addressed` round by diffing the head against a baseline. It
// previously used the PREVIOUS round's recorded head (`last_round_head`), which is null on the FIRST
// addressed round (a fresh submission clears it), leaving two opposing failure modes:
//   • fail-open on no baseline → a first-round HUSK is waved through as progress (bypasses gw-husk);
//   • special-case husk on no baseline → a real commit an agent pushed just before dying non-terminal
//     is mis-routed into gw-husk.
// Capturing the entry head structurally eliminates the no-baseline case: a real push advances the head
// WITHIN the round (→ progress, never a false husk), and a husk that pushed nothing leaves the head at
// the captured entry (→ a genuine no-advance the agent-instance corroboration splits into husk vs.
// no-advance). The special no-baseline branch is gone.
//
// `roundEntryHead` is an INSTANCE-SCOPED process variable, not a persisted column, so a straggler from
// a superseded convergence instance can never contaminate a re-opened run's baseline. It is captured
// fresh on every round entry (including husk retries), so it never carries a stale prior-round value.
// The read fails OPEN to `null` (a transient GitHub hiccup must never fabricate a no-progress verdict);
// progress-check then falls back to the persisted `last_round_head`.
import type { AppJobHandler } from "@nanobpm/urban";
import { fetchBranchHead, fetchPrHead } from "../../app/github.ts";
import { parsePr } from "../../app/service.ts";
import type { WorkerInputs, WorkerOutputs } from "../../nano-generated/worker-io.d.ts";
import { type HeadReader, makeDefaultReadHead } from "../progress-check/worker.ts";

// Input/output typed off the model data envelopes (`PrCaptureHeadIn` / `PrCaptureHeadOut` in
// convergence-loop.bpmn), the single source of truth for this worker's wire contract (ADR 0040).
type In = WorkerInputs["pr.capture-head"];
type Out = WorkerOutputs["pr.capture-head"];

const defaultReadHead: HeadReader = makeDefaultReadHead({ fetchPrHead, fetchBranchHead });

/** Injectable head reader so unit tests never touch git/network; the default binds the same
 * branch-ref-over-stale-`head.sha` reader progress-check uses (#786), keeping the entry-head and the
 * exit-head reads byte-for-byte comparable. */
export function makeHandler(deps: { readHead: HeadReader }): AppJobHandler<In, Out> {
  return async (job) => {
    const { prKey, repo, prNumber } = job.variables;
    // Prefer the carried repo/prNumber; fall back to parsing the canonical `owner/repo#N` prKey so an
    // older in-flight instance still resolves a target. If neither yields one, publish a null baseline
    // — progress-check then falls back to `last_round_head` and, absent that, fails open.
    const parsed = parsePr(prKey);
    const ghRepo = repo ?? parsed?.repo;
    const ghNumber = typeof prNumber === "number" ? prNumber : parsed?.number;
    if (!ghRepo || typeof ghNumber !== "number") {
      return { roundEntryHead: "" };
    }
    // ALWAYS publish the variable so a husk retry / new round OVERWRITES any prior round's captured
    // head — it must never carry a stale entry SHA forward. An unreadable head yields the empty
    // string (the "unknown" sentinel), which progress-check treats as no round-entry baseline and
    // falls back to the persisted `last_round_head`; a non-empty string is the fresh entry baseline.
    const roundEntryHead = (await deps.readHead(ghRepo, ghNumber).catch(() => null)) ?? "";
    return { roundEntryHead };
  };
}

const handler = makeHandler({ readHead: defaultReadHead });
export default handler;
