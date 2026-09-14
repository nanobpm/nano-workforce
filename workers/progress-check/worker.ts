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
 *  • AVAILABILITY PROBE (ADR 0056 fail-safe): search the process instance's `review-round`
 *    agent-instances. An EMPTY list means the AgentInstance channel is ABSENT for this deployment
 *    (the testkit WASM double, or a live engine without it) — because the just-completed
 *    `review-round` element MUST have minted a Create record on a channel-present engine, so an
 *    empty list can only mean "no channel", never "this round husked". An absent channel is UNKNOWN
 *    (`null`) → `no-advance` downstream, never an auto-retry. This is what makes an advisory,
 *    read-only channel safe to consult on the husk path: on absence it forces nothing.
 *
 *  • CORRELATION to the COMPLETING element-instance: once the channel is known present, classify
 *    ONLY the most-recently-created `review-round` instance — the one with the greatest monotonic
 *    engine key (its `elementInstanceKeys`, else its `agentInstanceKey`; see {@link recencyKey}).
 *    Each attempt (initial, review-loop, answer-loop resume, husk retry) re-enters `review-round` as
 *    a FRESH element-instance, so the newest instance IS the completing attempt. Classifying only it
 *    — rather than aggregating `.every(isTerminalInstance)` over ALL historical instances — is what
 *    correlates the verdict to the completing invocation: a stale non-terminal instance left by an
 *    EARLIER husked attempt can no longer drag an otherwise-terminal current attempt into a false
 *    husk, and a terminal earlier attempt in the same round can no longer mask a current husk. The
 *    newest terminal ⇒ `no-advance` (`true`); the newest non-terminal ⇒ the completing attempt
 *    husked (`false`). Round-INDEPENDENT, so a same-round human-answered resume is classified on its
 *    OWN fresh attempt (the worker.ts:105 correlation defect #786 flagged).
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
      // Correlate to the COMPLETING attempt: the most-recently-created instance (greatest monotonic
      // engine key). Its terminality is the verdict — newest terminal ⇒ no-advance (`true`); newest
      // non-terminal ⇒ the completing attempt husked (`false`). Older instances are ignored so a
      // stale prior attempt can neither fabricate nor mask a husk.
      let newest = instances[0];
      let newestKey = recencyKey(newest);
      for (const inst of instances) {
        const k = recencyKey(inst);
        if (k > newestKey) {
          newest = inst;
          newestKey = k;
        }
      }
      return isTerminalInstance(newest);
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

    // The single writer of the review-wait park (#786): persist-round no longer sets
    // `waiting_review` — it runs before the husk decision — so progress-check records the park ONLY
    // on a path that genuinely waits for a review, once a husk auto-retry has been ruled out. This
    // is what closes the persist-round→progress-check race: the row stays on its running
    // `converging` status until exactly one terminal write here resolves it to `waiting_review`
    // (park) or leaves it `converging` (husk retry / escalation), so the poller never sees a
    // transient `waiting_review` for a round that is really re-entering review-round.
    const parkForReview = async () => {
      const ts = new Date().toISOString();
      await app.data.table("pull_requests", "pr_key").update(prKey, {
        status: "waiting_review",
        waiting_since: ts,
        updated_at: ts,
      });
    };

    // Prefer the carried repo/prNumber; fall back to parsing the canonical `owner/repo#N` prKey so
    // an older in-flight instance (or a process-variable regression) still resolves a target. If
    // neither yields one, fail open rather than guess — but still park for review, since the loop
    // proceeds to wait-review and the poller must watch this PR.
    const parsed = parsePr(prKey);
    const ghRepo = repo ?? parsed?.repo;
    const ghNumber = typeof prNumber === "number" ? prNumber : parsed?.number;
    if (!ghRepo || typeof ghNumber !== "number") {
      await parkForReview();
      return { progressed: true, huskRetries: 0 };
    }

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
    // legitimately has no push and always continues to the review wait — after the baseline write
    // above. Park it for review (persist-round no longer does).
    if (!isAddressedStatus(status)) {
      await parkForReview();
      return { progressed: true, huskRetries: 0 };
    }

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

    // Resolve the row's resting status with exactly ONE terminal write, now that the husk decision
    // is known — closing the persist-round→progress-check race (#786): persist-round left the PR on
    // its running `converging` status, and this is the first and only place a post-round wait status
    // is written.
    if (decision.huskRetry === true) {
      // Husk auto-retry re-enters `review-round` immediately (it does NOT wait for a new review), so
      // keep the PR on the running `converging` aggregate: the poller must see an in-flight round,
      // not a `waiting_review` it would solicit a spurious Copilot review for (and pollJobActivation
      // treats only `converging` as live). persist-round already left it `converging`; assert it.
      await prs.update(prKey, { status: "converging", updated_at: new Date().toISOString() });
    } else if (decision.progressed) {
      // Genuine progress → the loop parks at wait-review. THIS is the review-wait park, written only
      // once the husk retry has been ruled out, so a husk-retry round never transits `waiting_review`.
      await parkForReview();
    }
    // The remaining outcome (progressed:false, huskRetry:false) escalates to a human; the
    // persist-escalation-noprogress worker owns that status, so progress-check leaves the row as-is.

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
