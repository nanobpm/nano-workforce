// pr.progress-check — the deterministic no-progress guard for the convergence loop.
//
// After a round is recorded (pr.persist-round), this step reads the PR's current head SHA and
// compares it to the head observed at the previous recorded round. An `addressed` round whose head
// did NOT advance pushed no commit, so requesting another Copilot review would loop on
// byte-identical code — the same comments, round after round, until the round cap escalates. It
// then classifies WHY (issue #786): a **husk** (no commit AND no terminal `review-round`
// agent-instance for the round — the producer harness died mid-run, jwulf/c8ctl-plugin-nano#230) is
// auto-re-run onto a healthy worker up to a bound before escalating; a **no-advance** (the agent DID
// run to a terminal instance but pushed nothing) escalates to a human straight away. The routing
// decision lives in app/roundProgress.ts, the single source of truth this worker, `gw-progress`, and
// `gw-husk` all mirror.
//
// Every other case returns `progressed:true` (continue): a `waiting` round (round 1, awaiting the
// first review) legitimately has no push; an advanced head means real work landed; and a head we
// could not read fails OPEN — the round cap and the review-wait timeout stay the safety nets so a
// transient GitHub hiccup can never fabricate a no-progress escalation.
import type { AgentInstanceSummary, AppApi, AppJobHandler } from "@nanobpm/urban";
import { fetchBranchHead, fetchPrHead } from "../../app/github.ts";
import { decideProgress, isAddressedStatus } from "../../app/roundProgress.ts";
import { parsePr } from "../../app/service.ts";
import type { WorkerInputs, WorkerOutputs } from "../../nano-generated/worker-io.d.ts";

// Input/output typed off the model data envelopes (`PrProgressCheckIn` / `PrProgressCheckOut` in
// convergence-loop.bpmn), the single source of truth for this worker's wire contract (ADR 0040).
type In = WorkerInputs["pr.progress-check"];
type Out = WorkerOutputs["pr.progress-check"];

// Reads a PR's current head SHA. Injectable so unit tests never touch git/network; the default
// binds the real GitHub reader (the shared gh | token transport) and swallows any failure to
// `null` so the guard fails OPEN. It reads the BRANCH ref (`git/ref/heads/<branch>`) — updated
// atomically with the push — in preference to the PR object's asynchronously-denormalized
// `head.sha`, so a lagging PR projection can never fabricate a stale-but-valid no-advance
// escalation (#786). Once a head ref is known this trusts ONLY its atomic ref: a failed/absent
// ref read fails OPEN (`null`), never falling back to `head.sha`. The PR head is used only when
// the PR carries NO head ref at all.
export type HeadReader = (repo: string, prNumber: number) => Promise<string | null>;

// Corroborates whether a no-advance `addressed` round produced DURABLE agent work: `true` when the
// completing `review-round` element-instance ran to a terminal agent-instance (→ `no-advance`),
// `false` when the completing attempt husked — a non-terminal `review-round` instance is present
// (→ `husk`), `null` when the read is UNAVAILABLE (the engine has no AgentInstance channel, or the
// read threw → `no-advance`, never an auto-retry). Injectable for tests; the default is
// availability-aware over the engine's AgentInstance channel (see {@link agentWorkFromEngine}). The
// `round` argument is retained for the reader contract but no longer participates in the decision —
// correlation is by the COMPLETING element-instance, not an aggregate round count (#786).
export type AgentWorkReader = (
  processInstanceKey: string | null | undefined,
  round: number,
) => Promise<boolean | null>;

const defaultReadHead: HeadReader = async (repo, prNumber) => {
  const token = process.env.GITHUB_TOKEN ?? "";
  const pr = await fetchPrHead(repo, prNumber, token).catch(() => null);
  if (!pr) return null;
  // Prefer the branch ref (atomic with the push) over the PR object's denormalized head.sha (#786).
  // Once the head branch is known, trust ONLY its atomic ref: a failed/absent ref read fails OPEN
  // (`null`) rather than falling back to the PR object's asynchronously-denormalized head.sha, which
  // can still report a stale-but-valid SHA after a push and fabricate a no-advance escalation — the
  // very projection this branch-ref read exists to avoid. This also makes a fork PR (whose head ref
  // lives in another repo, so this base-repo lookup 404s) fail open to the safe continue path rather
  // than compare a lagging denormalized SHA. Fall back to the PR head only when there is NO head ref.
  if (pr.headRef) {
    return await fetchBranchHead(repo, pr.headRef, token).catch(() => null);
  }
  return pr.headSha ?? null;
};

/** An agent-instance is "durable work" for husk purposes once it has reached a terminal state — it
 * carries a `completionDate`, or a terminal lifecycle status. A husked instance never closes (it is
 * stuck `THINKING` with null dates — jwulf/c8ctl-plugin-nano#230), so it is NOT counted. */
function isTerminalInstance(s: AgentInstanceSummary): boolean {
  if (typeof s.completionDate === "string" && s.completionDate.trim() !== "") return true;
  return /^(completed|complete|done|finished|failed|terminated)$/i.test(s.status ?? "");
}

/** Default agent-work corroboration — AVAILABILITY-AWARE and correlated to the COMPLETING
 * `review-round` element-instance (issue #786, Option 1):
 *
 *  • AVAILABILITY PROBE (ADR 0056 fail-safe): search the process instance's `review-round`
 *    agent-instances. An EMPTY list means the AgentInstance channel is ABSENT for this deployment
 *    (the testkit WASM double, or a live engine without it) — because the just-completed
 *    `review-round` element MUST have minted a Create record on a channel-present engine, so an
 *    empty list can only mean "no channel", never "this round husked". An absent channel is UNKNOWN
 *    (`null`) → `no-advance` downstream, never an auto-retry. This is what makes an advisory,
 *    read-only channel safe to consult on the husk path: on absence it forces nothing.
 *
 *  • CORRELATION (no key threading): once the channel is known present, only the CURRENT
 *    (single-threaded) `review-round` attempt can be non-terminal — every prior round already ran to
 *    a terminal instance — so a non-terminal instance present ⇔ the completing attempt husked, and
 *    all-terminal ⇔ the completing attempt is terminal (→ `no-advance`). This is round-INDEPENDENT,
 *    so a same-round human-answered resume (which mints a fresh element-instance) is classified on
 *    its OWN attempt rather than an aggregate `terminal >= round` count a prior round already
 *    satisfied (the worker.ts:75 misclassification #786 flagged).
 *
 * Any read FAILURE degrades to `null` (unknown → `no-advance`, never an auto-retry), so a transient
 * read outage can never duplicate genuinely-completed agent work. */
function agentWorkFromEngine(engine: AppApi["engine"]): AgentWorkReader {
  return async (processInstanceKey, _round) => {
    if (!processInstanceKey) return null;
    try {
      const instances = await engine.searchAgentInstances({
        processInstanceKey: String(processInstanceKey),
        elementId: "review-round",
      });
      // Availability probe: an empty list ⇒ no channel ⇒ unknown ⇒ no-advance (never husk-retry).
      if (instances.length === 0) return null;
      // Correlate to the completing attempt: all-terminal ⇒ no-advance (`true`); any non-terminal ⇒
      // the current attempt husked (`false`).
      return instances.every(isTerminalInstance);
    } catch {
      return null;
    }
  };
}

/** Build the handler with injectable readers (see {@link HeadReader} / {@link AgentWorkReader}). The
 * default export binds the real GitHub reader; the agent-work reader defaults to the engine's
 * AgentInstance channel when not injected. Tests inject stubs. */
export function makeHandler(deps: {
  readHead: HeadReader;
  readAgentWork?: AgentWorkReader;
}): AppJobHandler<In, Out> {
  return async (job, app) => {
    const { prKey, status, repo, prNumber, round, huskRetries } = job.variables;

    // Prefer the carried repo/prNumber; fall back to parsing the canonical `owner/repo#N` prKey so
    // an older in-flight instance (or a process-variable regression) still resolves a target. If
    // neither yields one, fail open rather than guess.
    const parsed = parsePr(prKey);
    const ghRepo = repo ?? parsed?.repo;
    const ghNumber = typeof prNumber === "number" ? prNumber : parsed?.number;
    if (!ghRepo || typeof ghNumber !== "number") return { progressed: true, huskRetries: 0 };

    // Read the head and record the baseline on EVERY round — including a non-addressed `waiting`
    // round — BEFORE the addressed-only escalation logic. A `waiting` round pushes nothing, but
    // recording its head establishes the baseline the FIRST `addressed` round compares against, so a
    // first-addressed-round husk is classifiable instead of silently failing open for want of a
    // baseline (the worker.ts:142 gap #786 flagged). The baseline is only overwritten when we
    // actually read a head, so a null (unreadable) head never clobbers a good baseline.
    const currentHead = await deps.readHead(ghRepo, ghNumber).catch(() => null);
    const prs = app.data.table<{
      pr_key: string;
      last_round_head: string | null;
      status: string | null;
      updated_at: string | null;
    }>("pull_requests", "pr_key");
    const row = await prs.get(prKey);
    const previousHead = row?.last_round_head ?? null;
    if (currentHead) {
      await prs.update(prKey, { last_round_head: currentHead });
    }

    // Only an `addressed` round claims a push, so only it can be a no-progress round — and a
    // blank/unknown status counts as `addressed` here (gw-status defaults it down the addressed arm
    // and pr.persist-round records a missing status as `addressed`), so it is the safe-default trap
    // this guard exists for. An explicitly recognized non-addressed status (`waiting`, etc.)
    // legitimately has no push and always continues — after the baseline write above.
    if (!isAddressedStatus(status)) return { progressed: true, huskRetries: 0 };

    // Round numbers are 1-based; coerce a missing/invalid `round` to a positive 1. The round no
    // longer gates the agent-work corroboration (correlation is by the completing element-instance,
    // not an aggregate round count — #786); it only tunes the human-facing escalation question.
    const roundNo = typeof round === "number" && round > 0 ? Math.floor(round) : 1;
    // Corroborate durable agent work only when we are actually on the no-progress path (an
    // addressed round whose head did not advance) — otherwise the engine read is wasted.
    const readAgentWork = deps.readAgentWork ?? agentWorkFromEngine(app.engine);
    const agentWorkObserved =
      previousHead && currentHead && currentHead === previousHead
        ? await readAgentWork(job.processInstanceKey, roundNo).catch(() => null)
        : null;

    const decision = decideProgress(
      status,
      previousHead,
      currentHead,
      roundNo,
      agentWorkObserved,
      typeof huskRetries === "number" ? huskRetries : null,
    );

    // Poller non-interference during a husk auto-retry (#786): pr.persist-round parked the PR in
    // `waiting_review`, but a husk retry re-enters `review-round` immediately (it does NOT wait for a
    // new review), so leaving the PR `waiting_review` would let pollReviews solicit a spurious
    // Copilot review and make pollJobActivation (which treats only `converging` as live) hide the
    // re-running job. Flip the status back to the running `converging` aggregate BEFORE the retry
    // re-enters review-round so the poller correctly sees an in-flight round, not a stalled wait.
    if (decision.huskRetry === true) {
      await prs.update(prKey, { status: "converging", updated_at: new Date().toISOString() });
    }

    return {
      progressed: decision.progressed,
      huskRetries: decision.huskRetries,
      ...(decision.huskRetry !== undefined ? { huskRetry: decision.huskRetry } : {}),
      ...(decision.reason !== undefined ? { noProgressReason: decision.reason } : {}),
      ...(decision.question !== undefined ? { noProgressQuestion: decision.question } : {}),
    };
  };
}

const handler = makeHandler({ readHead: defaultReadHead });
export default handler;
