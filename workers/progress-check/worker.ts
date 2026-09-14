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

/** The outcome of an agent-work corroboration, optionally carrying the ATTEMPT WATERMARK it
 * consumed. `work` is the husk verdict decideProgress routes on (`true` no-advance / `false` husk /
 * `null` unknown). `consumedKey` — when present — is the greatest `review-round` instance key this
 * read has now ACCOUNTED FOR; the handler persists it (`last_progress_agent_watermark`) so the NEXT
 * round can tell a freshly-registered attempt from a historical one (see {@link agentWorkFromEngine}
 * and Copilot PR #789). A bare `boolean | null` return (the injected test readers) carries no
 * watermark and leaves the persisted one untouched. */
export interface AgentWorkObservation {
  readonly work: boolean | null;
  readonly consumedKey?: string | null;
}

// Corroborates whether a no-advance `addressed` round produced DURABLE agent work: `true` when the
// completing `review-round` element-instance ran to a terminal agent-instance (→ `no-advance`),
// `false` when the completing attempt husked — a non-terminal `review-round` instance is present, OR
// the completing attempt registered NO instance at all on a channel-present engine (→ `husk`),
// `null` when the read is UNAVAILABLE (the engine has no AgentInstance channel, or the read threw →
// `no-advance`, never an auto-retry). May return a bare verdict or an {@link AgentWorkObservation}
// that also carries the consumed attempt watermark. Injectable for tests; the default is
// availability- and attempt-aware over the engine's AgentInstance channel (see {@link
// agentWorkFromEngine}). `priorWatermark` is the greatest `review-round` instance key an earlier
// progress-check already accounted for, so a current pre-registration husk is not masked by a prior
// round's terminal instance. The `round` argument is retained for the reader contract but no longer
// participates in the decision — correlation is by the COMPLETING element-instance, not an aggregate
// round count (#786).
export type AgentWorkReader = (
  processInstanceKey: string | null | undefined,
  round: number,
  priorWatermark?: string | null,
) => Promise<boolean | null | AgentWorkObservation>;

/** Normalize a reader's return (a bare verdict, or a full {@link AgentWorkObservation}) to the
 * observation shape the handler threads: an injected `boolean | null` carries no watermark. */
function normalizeAgentWork(raw: boolean | null | AgentWorkObservation | undefined): AgentWorkObservation {
  if (raw === true || raw === false || raw === null || raw === undefined) {
    return { work: raw ?? null };
  }
  return raw;
}

/** Build the default head reader over injected GitHub fetchers. Exported (with injectable fetchers)
 * so the branch-ref-over-stale-`head.sha` preference — the whole point of {@link fetchBranchHead}
 * here (#786) — is covered by a handler-level regression test, not only inside the private binding:
 * a change that stopped reading the branch ref, or fell back to `head.sha`, must turn a test red. */
export function makeDefaultReadHead(deps: {
  fetchPrHead: typeof fetchPrHead;
  fetchBranchHead: typeof fetchBranchHead;
}): HeadReader {
  return async (repo, prNumber) => {
    const token = process.env.GITHUB_TOKEN ?? "";
    const pr = await deps.fetchPrHead(repo, prNumber, token).catch(() => null);
    if (!pr) return null;
    // Prefer the branch ref (atomic with the push) over the PR object's denormalized head.sha (#786).
    // Once the head branch is known, trust ONLY its atomic ref: a failed/absent ref read fails OPEN
    // (`null`) rather than falling back to the PR object's asynchronously-denormalized head.sha, which
    // can still report a stale-but-valid SHA after a push and fabricate a no-advance escalation — the
    // very projection this branch-ref read exists to avoid. The ref is read in the repository the
    // head branch actually lives in (the fork for a cross-repo PR — see below), so a fork PR fails
    // open safely instead of comparing an unrelated base-repo SHA. Fall back to the PR head only when
    // there is NO head ref.
    if (pr.headRef) {
      // Resolve the head ref in the repository the head branch actually lives in — the FORK for a
      // cross-repo PR (`pr.headRepo`), else the base `repo`. Querying the base repo unconditionally
      // would, for a fork PR whose head branch shares a name with a base-repo branch, read the
      // unrelated base-branch SHA and fabricate progress/no-progress (#786). When the head repo
      // cannot be resolved (a deleted fork ⇒ `headRepo:null`) fail OPEN to `null` rather than fall
      // back to the base repo and risk that collision.
      const headRepo = pr.headRepo;
      if (!headRepo) return null;
      return await deps.fetchBranchHead(headRepo, pr.headRef, token).catch(() => null);
    }
    return pr.headSha ?? null;
  };
}

const defaultReadHead: HeadReader = makeDefaultReadHead({ fetchPrHead, fetchBranchHead });

/** An agent-instance is "durable work" for husk purposes once it has reached a terminal state — it
 * carries a `completionDate`, or a terminal lifecycle status. A husked instance never closes (it is
 * stuck `THINKING` with null dates — jwulf/c8ctl-plugin-nano#230), so it is NOT counted. */
function isTerminalInstance(s: AgentInstanceSummary): boolean {
  if (typeof s.completionDate === "string" && s.completionDate.trim() !== "") return true;
  return /^(completed|complete|done|finished|failed|terminated)$/i.test(s.status ?? "");
}

/** Parse a 64-bit engine key string to a `BigInt` for monotonic ordering; an absent/blank/malformed
 * key sorts oldest (`0n`). Engine keys are 64-bit, so a numeric `parseInt`/`Number` compare would
 * lose precision — `BigInt` compares them exactly. */
function engineKey(s: string | undefined | null): bigint {
  if (typeof s !== "string" || s.trim() === "") return 0n;
  try {
    return BigInt(s.trim());
  } catch {
    return 0n;
  }
}

/** The monotonic recency key that orders an AgentInstance by creation: the GREATEST of its occupancy
 * `elementInstanceKeys` (the `review-round` element-instance keys the engine mints per attempt),
 * falling back to its `agentInstanceKey`. Engine keys increase with creation, so the instance with
 * the greatest recency key is the most-recently-created — the COMPLETING attempt in the
 * single-threaded review-round loop. */
function recencyKey(s: AgentInstanceSummary): bigint {
  let max = engineKey(s.agentInstanceKey);
  for (const k of s.elementInstanceKeys ?? []) {
    const v = engineKey(k);
    if (v > max) max = v;
  }
  return max;
}

/** Default agent-work corroboration — AVAILABILITY-AWARE and correlated to the COMPLETING
 * `review-round` element-instance (issue #786, Option 1):
 *
 *  • AVAILABILITY PROBE (ADR 0056 fail-safe) — TWO-TIER, because an empty `review-round` search is
 *    AMBIGUOUS. `review-round` is an external-agent `serviceTask`: the engine creates an ORDINARY
 *    job and the WORKER registers its AgentInstance via `CreateAgentInstance` (nanobpmn engine-core
 *    `bpmn.rs`; a husked round is "a COMPLETED job that minted no AgentInstance", `event.rs`). So a
 *    completing review-round job that HUSKED *before the worker registered* mints NO instance — an
 *    empty scoped search is then a genuine husk, NOT proof of an absent channel. Distinguish the two
 *    with a process-instance-WIDE probe: (a) scoped `review-round` search non-empty → classify it
 *    (below); (b) scoped empty BUT the process instance has ANY agent instance at all (e.g.
 *    `classify-scope`, or an earlier round) → the channel is provably PRESENT, so a review-round
 *    that minted nothing is a genuine HUSK (`false`, auto-retry under the cap); (c) scoped empty AND
 *    the whole process instance has NO agent instance → the channel is UNKNOWN/ABSENT (the testkit
 *    WASM double, or a non-agentic engine) → `null` → `no-advance`, never an auto-retry, so a
 *    channel-absent engine can't loop. (The irreducible residual: the VERY FIRST agent task in a
 *    process husking before registering, with zero prior instances anywhere, is indistinguishable
 *    from an absent channel and fails safe to `no-advance` — a human resume, not a wedge.)
 *
 *  • CORRELATION to the COMPLETING attempt via an ATTEMPT WATERMARK (Copilot PR #789). Once the
 *    channel is known present, the newest `review-round` instance is NOT necessarily the completing
 *    attempt: because a pre-registration husk mints NOTHING, a current attempt that husks before
 *    registering leaves the newest instance pointing at an EARLIER, terminal attempt — which, read
 *    naively, would classify as `no-advance` and bypass the bounded husk retry. So the completing
 *    attempt is correlated against `priorWatermark`: the greatest `review-round` instance key an
 *    earlier progress-check already accounted for. (a) A `review-round` instance NEWER than the
 *    watermark exists ⇒ the current attempt DID register ⇒ classify that newest instance — terminal
 *    ⇒ `no-advance` (`true`), non-terminal ⇒ the completing attempt husked (`false`) — and consume
 *    it (advance the watermark to its key). (b) NO instance newer than the watermark ⇒ the current
 *    attempt registered nothing new ⇒ it husked pre-registration ⇒ `husk` (`false`, auto-retry),
 *    leaving the watermark where it is. Each attempt (initial, review-loop, answer-loop resume, husk
 *    retry) re-enters `review-round` as a FRESH element-instance with a strictly greater monotonic
 *    key (its `elementInstanceKeys`, else its `agentInstanceKey`; see {@link recencyKey}), so "newer
 *    than the watermark" is exactly "a not-yet-accounted-for attempt". A stale terminal instance
 *    from an earlier attempt can therefore neither fabricate nor mask a current husk. The watermark
 *    is maintained on EVERY addressed round with a readable head (including progressing rounds), so a
 *    progressing round's fresh instance is consumed and can't be mistaken for the next round's
 *    completing attempt.
 *
 * Any read FAILURE degrades to `null` (unknown → `no-advance`, never an auto-retry), so a transient
 * read outage can never duplicate genuinely-completed agent work. */
function agentWorkFromEngine(engine: AppApi["engine"]): AgentWorkReader {
  return async (processInstanceKey, _round, priorWatermark): Promise<AgentWorkObservation> => {
    if (!processInstanceKey) return { work: null };
    try {
      const instances = await engine.searchAgentInstances({
        processInstanceKey: String(processInstanceKey),
        elementId: "review-round",
      });
      if (instances.length === 0) {
        // Two-tier availability probe (Copilot #789): the scoped search is empty, which is
        // AMBIGUOUS for an external-agent task (a pre-registration husk mints no instance). Probe
        // the process instance WIDE: if it holds ANY agent instance the channel is provably PRESENT,
        // so a review-round that minted nothing genuinely HUSKED (`false`); if it holds NONE the
        // channel is UNKNOWN/ABSENT → `null` (no-advance, never an auto-retry).
        const anyInProcess = await engine.searchAgentInstances({
          processInstanceKey: String(processInstanceKey),
        });
        return { work: anyInProcess.length === 0 ? null : false };
      }
      // Find the newest `review-round` instance (greatest monotonic engine key).
      let newest = instances[0];
      let newestKey = recencyKey(newest);
      for (const inst of instances) {
        const k = recencyKey(inst);
        if (k > newestKey) {
          newest = inst;
          newestKey = k;
        }
      }
      // ATTEMPT-WATERMARK correlation (Copilot #789): only an instance NEWER than the watermark is
      // the current, not-yet-accounted-for attempt. If none is newer, the completing attempt
      // registered nothing new — it husked before registering — even though a stale terminal instance
      // from an earlier attempt is still present. That is a genuine husk (auto-retry), NOT a
      // no-advance; classifying `newest` naively here would wrongly escalate it.
      const prior = engineKey(priorWatermark);
      if (newestKey <= prior) {
        return { work: false, consumedKey: priorWatermark ?? null };
      }
      // A fresh attempt registered: classify it (terminal ⇒ no-advance, non-terminal ⇒ husk) and
      // consume it so the next round can distinguish the attempt AFTER it from this one.
      return { work: isTerminalInstance(newest), consumedKey: newestKey.toString() };
    } catch {
      return { work: null };
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
    const jobKey = job.jobKey;

    const prs = app.data.table<{
      pr_key: string;
      process_key: string | null;
      last_round_head: string | null;
      status: string | null;
      updated_at: string | null;
      last_progress_job_key: string | null;
      last_progress_result: string | null;
      last_progress_agent_watermark: string | null;
    }>("pull_requests", "pr_key");
    const row = await prs.get(prKey);

    // REDELIVERY REPLAY GUARD (Copilot #789 / engine at-least-once delivery). A job whose
    // side-effects landed but whose completion-ack was lost is redelivered with the SAME job key.
    // Replaying the recorded outcome — instead of re-deriving against the now-advanced
    // `last_round_head` baseline — stops a redelivered PROGRESSED round from reading its own
    // just-written head as "no advance" and mis-escalating an already-progressed round. A husk
    // auto-retry re-enters `review-round` as a NEW job key, so it is never mistaken for a redelivery.
    // The stamp and the baseline advance are written in ONE atomic row update (see `commit` below),
    // so this guard can never disagree with the baseline it replays against.
    if (jobKey && row?.last_progress_job_key === jobKey && typeof row.last_progress_result === "string") {
      // biome-ignore lint/plugin: replay a worker outcome persisted as JSON in the idempotency stamp.
      return JSON.parse(row.last_progress_result) as Out;
    }

    // The SINGLE atomic terminal write for this delivery. It advances the head baseline (when a head
    // was read), applies the resting status effect, and stamps the idempotency key + serialized
    // outcome. Folding all three into one row update is what makes the observation and the decision
    // atomic (Copilot #789): a redelivery either sees the whole record (→ replay above) or none of
    // it (→ recompute from the un-advanced baseline → same decision), never a half-state. It is also
    // the single writer of the review-wait park (#786) — persist-round no longer sets
    // `waiting_review`, so the row rests on its running `converging` status until exactly one write
    // here resolves it, and the poller never sees a transient `waiting_review` for a husk-retry round.
    const commit = async (
      out: Out,
      opts: { head?: string | null; status?: "waiting_review" | "converging"; agentWatermark?: string | null },
    ): Promise<Out> => {
      const ts = new Date().toISOString();
      // PROCESS-INSTANCE FENCE (Copilot #789). A straggler progress-check from a SUPERSEDED
      // convergence instance can slip past the replay guard (its idempotency stamp was cleared when
      // `submitPr` re-opened the PR) and reach here AFTER `submitPr` has reset the per-run fields and
      // started a NEW convergence instance. Its stale baseline / status / watermark / result must not
      // clobber the fresh run (which could be parked on `waiting_review` or replay stale output).
      // Re-read the row's CURRENT owner immediately before the write and drop the write when this
      // job's own `processInstanceKey` no longer owns the row — the straggler's token lives in a
      // terminated instance, so acking without persisting is correct. Fail open when either key is
      // absent (an older instance, or a row whose `process_key` is not yet seeded) so normal
      // single-run behaviour is untouched. Compare as strings — `process_key` is persisted via
      // `String(processInstanceKey)`, and a job key can arrive numeric.
      const currentOwner = (await prs.get(prKey))?.process_key ?? null;
      const jobOwner = job.processInstanceKey ?? null;
      if (currentOwner && jobOwner && String(currentOwner) !== String(jobOwner)) {
        return out;
      }
      await prs.update(prKey, {
        // Only overwrite the baseline when we actually read a head, so a null (unreadable) head
        // never clobbers a good `last_round_head`.
        ...(opts.head ? { last_round_head: opts.head } : {}),
        ...(opts.status === "waiting_review" ? { status: "waiting_review", waiting_since: ts } : {}),
        ...(opts.status === "converging" ? { status: "converging" } : {}),
        // Advance the attempt watermark ONLY when an agent-work read consumed a `review-round`
        // instance (Copilot #789); `undefined` leaves the persisted watermark untouched (an
        // unreadable head, a non-addressed round, or an injected bare-verdict reader), so the next
        // round still correlates against the last real attempt.
        ...(opts.agentWatermark !== undefined ? { last_progress_agent_watermark: opts.agentWatermark } : {}),
        ...(jobKey ? { last_progress_job_key: jobKey, last_progress_result: JSON.stringify(out) } : {}),
        updated_at: ts,
      });
      return out;
    };

    // Prefer the carried repo/prNumber; fall back to parsing the canonical `owner/repo#N` prKey so
    // an older in-flight instance (or a process-variable regression) still resolves a target. If
    // neither yields one, fail open rather than guess — but still park for review, since the loop
    // proceeds to wait-review and the poller must watch this PR.
    const parsed = parsePr(prKey);
    const ghRepo = repo ?? parsed?.repo;
    const ghNumber = typeof prNumber === "number" ? prNumber : parsed?.number;
    if (!ghRepo || typeof ghNumber !== "number") {
      return commit({ progressed: true, huskRetries: 0 }, { status: "waiting_review" });
    }

    // Read the head and record the baseline on EVERY round — including a non-addressed `waiting`
    // round — BEFORE the addressed-only escalation logic. A `waiting` round pushes nothing, but
    // recording its head establishes the baseline the FIRST `addressed` round compares against, so a
    // first-addressed-round husk is classifiable instead of silently failing open for want of a
    // baseline (the worker.ts:142 gap #786 flagged).
    const currentHead = await deps.readHead(ghRepo, ghNumber).catch(() => null);
    const previousHead = row?.last_round_head ?? null;

    // Round numbers are 1-based; coerce a missing/invalid `round` to a positive 1. The round no
    // longer gates the agent-work corroboration (correlation is by the completing element-instance,
    // not an aggregate round count — #786); it only tunes the human-facing escalation question.
    const roundNo = typeof round === "number" && round > 0 ? Math.floor(round) : 1;
    // Corroborate durable agent work on EVERY round with a READABLE head — the addressed rounds AND
    // the non-addressed `waiting` round — not only the no-advance path. The husk verdict itself is
    // only consulted when the head did not advance (or on a no-baseline round — the #786
    // first-round-husk gap), but the read must ALSO run to MAINTAIN THE ATTEMPT WATERMARK (Copilot
    // #789): every round runs `review-round` BEFORE this progress-check
    // (`…→review-round→gw-status→…→check-progress`), registering a fresh `review-round` instance that
    // must be CONSUMED into the watermark, else the NEXT round's pre-registration husk would see that
    // stale terminal instance as "newer than the watermark" and mis-escalate as no-advance. This
    // includes the `waiting` round (Copilot #789 worker.ts:329): a `waiting` round's own review runs
    // and can leave a terminal instance, so if its progress-check returned early WITHOUT consuming it,
    // the first addressed round's pre-registration husk would inherit that unconsumed terminal
    // instance and bypass the bounded husk retry. An unreadable current head skips the read (the
    // decision fails open regardless and there is nothing to correlate).
    const readAgentWork = deps.readAgentWork ?? agentWorkFromEngine(app.engine);
    const priorWatermark = row?.last_progress_agent_watermark ?? null;
    const observation = currentHead
      ? normalizeAgentWork(await readAgentWork(job.processInstanceKey, roundNo, priorWatermark).catch(() => null))
      : normalizeAgentWork(null);
    const agentWorkObserved = observation.work;
    // The watermark to persist: the key this read consumed (a fresh attempt), else undefined so the
    // stored one is left untouched (an unreadable head or an injected bare-verdict reader).
    const agentWatermark = observation.consumedKey;

    // Only an `addressed` round claims a push, so only it can be a no-progress round — and a
    // blank/unknown status counts as `addressed` here (gw-status defaults it down the addressed arm
    // and pr.persist-round records a missing status as `addressed`), so it is the safe-default trap
    // this guard exists for. An explicitly recognized non-addressed status (`waiting`, etc.)
    // legitimately has no push and always continues to the review wait — after the baseline write.
    // Park it for review (persist-round no longer does), but still advance the attempt watermark so a
    // following addressed husk isn't masked by this round's own review instance (Copilot #789).
    if (!isAddressedStatus(status)) {
      return commit(
        { progressed: true, huskRetries: 0 },
        { head: currentHead, status: "waiting_review", agentWatermark },
      );
    }

    const decision = decideProgress(
      status,
      previousHead,
      currentHead,
      roundNo,
      agentWorkObserved,
      typeof huskRetries === "number" ? huskRetries : null,
    );

    const out: Out = {
      progressed: decision.progressed,
      huskRetries: decision.huskRetries,
      ...(decision.huskRetry !== undefined ? { huskRetry: decision.huskRetry } : {}),
      ...(decision.reason !== undefined ? { noProgressReason: decision.reason } : {}),
      ...(decision.question !== undefined ? { noProgressQuestion: decision.question } : {}),
    };

    // Resolve the row's resting status with the single atomic `commit`, now that the husk decision
    // is known — closing the persist-round→progress-check race (#786).
    if (decision.huskRetry === true) {
      // Husk auto-retry re-enters `review-round` immediately (it does NOT wait for a new review), so
      // keep the PR on the running `converging` aggregate: the poller must see an in-flight round,
      // not a `waiting_review` it would solicit a spurious Copilot review for (and pollJobActivation
      // treats only `converging` as live).
      return commit(out, { head: currentHead, status: "converging", agentWatermark });
    }
    if (decision.progressed) {
      // Genuine progress → the loop parks at wait-review. THIS is the review-wait park, written only
      // once the husk retry has been ruled out, so a husk-retry round never transits `waiting_review`.
      return commit(out, { head: currentHead, status: "waiting_review", agentWatermark });
    }
    // The remaining outcome (progressed:false, huskRetry:false) escalates to a human; the
    // persist-escalation-noprogress worker owns the status, so leave it unset — but still advance the
    // baseline and stamp the idempotency record so a redelivered escalation replays instead of
    // recomputing.
    return commit(out, { head: currentHead, agentWatermark });
  };
}

const handler = makeHandler({ readHead: defaultReadHead });
export default handler;
