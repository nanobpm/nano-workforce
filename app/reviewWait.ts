// Review-wait liveness policy, kept as a pure module (no env, no I/O) so it is trivially
// testable — mirrors app/rounds.ts. `service.ts` builds the fleet-wide REVIEW_WAIT_TIMEOUT and
// REVIEW_NUDGE_MS on top of these, and the process's timer catch is seeded with the validated
// ISO-8601 duration at submit.
//
// Two knobs govern the review-wait watchdog:
//   • the *timeout* — an ISO-8601 duration handed to the process's `wait-review-timeout` timer
//     catch (the far side of the event-based-gateway race against `readiness-ready`). If no fresh
//     review arrives within it, the loop escalates to a human instead of hanging forever.
//   • the *nudge cooldown* — how long the poller waits between automatic Copilot re-requests for
//     one waiting PR, so a re-request that Copilot dismisses is retried without hammering the API.

/** Default review-wait timeout (ISO-8601 duration): how long the loop waits for a fresh review
 * before the timer arm of the event-based gateway fires and it escalates to a human. */
export const DEFAULT_REVIEW_WAIT_TIMEOUT = "PT30M";

// A pragmatic ISO-8601 duration matcher: requires a leading `P`, at least one component, and a
// `T` before any time components (with at least one time component after it). Good enough to
// reject an obviously-malformed env value before it is baked into a timer expression the engine
// would fail to interpret; not a full grammar (we don't need fractional seconds here).
const ISO_DURATION = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/;

/** True when `raw` is a well-formed ISO-8601 duration under {@link isoDuration}'s grammar — the strict
 * predicate an operator submission door uses to REJECT a malformed duration (400) rather than silently
 * fall back to a default. Derives from the same {@link ISO_DURATION} grammar so the accept/reject
 * decision can never drift from the normalise-or-default one. Case-insensitive (`pt2h` is valid). */
export function isValidIsoDuration(raw: string): boolean {
  return ISO_DURATION.test(raw.trim().toUpperCase());
}

/** Validate an ISO-8601 duration string for a BPMN timer's `<bpmn:timeDuration>`, falling back to
 * `def` when the value is absent, blank, or malformed — a bad env value must never deploy an
 * uninterpretable timer expression into a process. Normalises to upper case (`pt20m` → `PT20M`).
 * This is the single canonical duration validator; per-timer policies (review-wait, escalation
 * SLA) derive their env-driven value from it rather than re-implementing the grammar. */
export function isoDuration(raw: string | undefined, def: string): string {
  const s = (raw ?? "").trim().toUpperCase();
  return s !== "" && ISO_DURATION.test(s) ? s : def;
}

/** Convert an ISO-8601 duration to whole milliseconds, sharing {@link isoDuration}'s validation and
 * grammar so a value's ms budget and its BPMN timer string can never derive from two parsers. `raw`
 * is validated (and normalised) through {@link isoDuration} first, falling back to `def` when it is
 * absent/blank/malformed. Calendar components carry no anchor date in a bare duration, so `Y`/`M`
 * use pragmatic fixed lengths (365d / 30d); the realistic inputs here are seconds…days. */
export function isoDurationToMs(raw: string | undefined, def: string): number {
  const m = ISO_DURATION.exec(isoDuration(raw, def));
  if (!m) return 0;
  const n = (g?: string): number => (g ? Number.parseInt(g, 10) : 0);
  return (
    n(m[1]) * 31_536_000_000 + // years (365d)
    n(m[2]) * 2_592_000_000 + // months (30d)
    n(m[3]) * 604_800_000 + // weeks
    n(m[4]) * 86_400_000 + // days
    n(m[6]) * 3_600_000 + // hours
    n(m[7]) * 60_000 + // minutes
    n(m[8]) * 1000 // seconds
  );
}

/** Validate an ISO-8601 duration for the review-wait timer, falling back to `def` when the value
 * is absent, blank, or malformed. Thin wrapper over {@link isoDuration}. */
export function reviewWaitTimeout(
  raw: string | undefined,
  def: string = DEFAULT_REVIEW_WAIT_TIMEOUT,
): string {
  return isoDuration(raw, def);
}

/** Default cooldown (minutes) between automatic Copilot re-request nudges for one waiting PR.
 * Kept comfortably below the review-wait timeout default so several nudges are attempted before
 * the loop escalates. */
export const DEFAULT_REVIEW_NUDGE_MINUTES = 5;

/** Upper bound on the nudge cooldown — a runaway value could park a genuinely-stalled PR for days
 * with no re-request. Mirrors the ceiling discipline in rounds.ts. */
export const MAX_REVIEW_NUDGE_MINUTES = 24 * 60;

/** Coerce the operator-supplied nudge cooldown (env `NANO_PR_REVIEW_NUDGE_MINUTES`, minutes) into
 * a sane positive integer. Absent / blank / non-numeric / zero / negative / NaN fall back to
 * `fallback`; values above the ceiling are clamped down (and so is an oversized `fallback`, so it
 * can never bypass the ceiling). */
export function clampNudgeMinutes(
  value: unknown,
  fallback: number = DEFAULT_REVIEW_NUDGE_MINUTES,
): number {
  const safeFallback = Number.isFinite(fallback)
    ? Math.min(Math.max(Math.trunc(fallback), 1), MAX_REVIEW_NUDGE_MINUTES)
    : DEFAULT_REVIEW_NUDGE_MINUTES;
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(n)) return safeFallback;
  const i = Math.trunc(n);
  if (i < 1) return safeFallback;
  return Math.min(i, MAX_REVIEW_NUDGE_MINUTES);
}

/** Is the latest Copilot review STALE relative to the PR's current HEAD? (issue #799)
 *
 * A review is stale when it was submitted against a commit the head has since moved past — its
 * advisories describe code that no longer exists, so the convergence gate must NOT block/escalate
 * against it and the poller must NOT unpark the loop on it; instead a fresh review of the current
 * HEAD must be solicited and gated on. Staleness is a plain SHA inequality.
 *
 * Fails SAFE to "not stale" when either SHA is unknown (`null`/`undefined`/blank): GitHub did not
 * carry a `commit_id` for the review, or the head could not be read. Without both SHAs we cannot
 * prove the review predates the head, so we must not fabricate a stale verdict that would loop the
 * loop re-soliciting forever — the review-wait timeout and the round cap remain the safety nets. */
export function isReviewStale(
  reviewCommitId: string | null | undefined,
  headSha: string | null | undefined,
): boolean {
  const rev = (reviewCommitId ?? "").trim();
  const head = (headSha ?? "").trim();
  if (rev === "" || head === "") return false;
  return rev !== head;
}

/** Is there NO head-current Copilot review to gate on? (issue #923) — the CONVERGENCE-GATE /
 * merge-backstop variant of {@link isReviewStale}.
 *
 * `isReviewStale` intentionally fails safe to "not stale" on a missing review `commit_id` — for
 * the POLLER, a review GitHub carried no `commit_id` for must not fabricate a re-solicit loop. But
 * the gate's consumer is different: `fetchLatestCopilotReview` returns `commitId: null` both when
 * no Copilot review exists AT ALL and when the newest one lacks a `commit_id`, and the gate's
 * precondition is a HEAD-CURRENT reviewer verdict. Treating "no review" as "a verified clean
 * review" is the fail-open that merged nano-bpm#1443 with ZERO reviews — so for the GATE, a
 * missing review commit is stale/missing, not current.
 *
 * The head-side fail-safe is kept: with an UNREADABLE head we can prove nothing, so we must not
 * fabricate a re-solicit loop on a transport hiccup (the review-wait timeout remains the
 * backstop). Only a READABLE head + a missing/mismatched review commit routes to the review wait. */
export function isReviewMissingOrStale(
  reviewCommitId: string | null | undefined,
  headSha: string | null | undefined,
): boolean {
  const head = (headSha ?? "").trim();
  if (head === "") return false; // unverifiable head → fail safe, exactly as isReviewStale
  const rev = (reviewCommitId ?? "").trim();
  // A missing review commit with a readable head = NO head-current verdict → stale/missing.
  if (rev === "") return true;
  return rev !== head;
}

// ── Review-wait reason (issue #1034) ─────────────────────────────────────────
// A merge loop waiting on a head-current Copilot review used to read `waiting_merge` in /status —
// indistinguishable from "waiting for CI". The merge backstop stamps the head it found unreviewed
// onto its `merges` audit row (one canonical token, written and parsed only here), and /status
// derives `waitReason: "waiting_review(<sha7>)"` from the PR's newest merge-audit rows.

/** The merge-audit outcomes that mean "the loop is waiting for a head-current review". */
export const REVIEW_WAIT_OUTCOMES: readonly string[] = ["review-pending", "review-requested"];

/** The merge-audit outcome `pr.arm-merge` records when it re-arms a loop whose newest audit row is a
 *  review wait: the wait has ENDED (a clean review landed, or the timer fired), so /status must stop
 *  reporting `waiting_review` even when no later merge attempt writes another row (e.g. CI pending). */
export const REVIEW_WAIT_ENDED_OUTCOME = "review-wait-ended";

/** The PR statuses during which the merge stage's review wait can be live (read-only derivation;
 *  the stored status is never changed). `merging` covers the timer race after `flipToMergingThenPublish`. */
export const REVIEW_WAIT_STATUSES: readonly string[] = ["waiting_merge", "merging", "escalated"];

/** The merge-audit outcome recorded when a head parks on a human assessment of a 🔵 "Needs a closer
 *  look" verdict (issue #1037) — /status derives `waiting_human_assessment(<sha7>)` from it. Re-exported as
 *  `HUMAN_ASSESSMENT_OUTCOME` by app/humanAssessment.ts (one source). */
export const HUMAN_ASSESSMENT_WAIT_OUTCOME = "human-assessment";

/** Pure: the /status wait reason for an ESCALATED PR, derived from its CURRENT open user-task
 *  question(s) — never the merge-audit history, which can name a historical assessment from an
 *  unrelated earlier escalation (and a converge-gate assessment writes no merge row at all).
 *  `headFromQuestion` is the canonical builder-controlled head reader (app/humanAssessment.ts). */
export function escalatedWaitReason(
  questions: readonly (string | null | undefined)[],
  headFromQuestion: (q: string | null | undefined) => string | null,
): string | null {
  for (const q of questions) {
    const head = headFromQuestion(q);
    if (head) return `waiting_human_assessment(${head.slice(0, 7)})`;
  }
  return null;
}

/** Pure: is the newest audit row (highest id) a review-wait outcome? */
export function isReviewWaitOpen(rows: readonly { id?: number | null; outcome: string }[]): boolean {
  if (rows.length === 0) return false;
  const newest = rows.reduce((a, b) => ((b.id ?? 0) > (a.id ?? 0) ? b : a));
  return REVIEW_WAIT_OUTCOMES.includes(newest.outcome) || newest.outcome === HUMAN_ASSESSMENT_WAIT_OUTCOME;
}

/** The canonical head token appended to a `review-pending` audit row's detail. */
export function reviewHeadToken(head: string): string {
  return `[head ${head}]`;
}

/** Pure: parse the head out of an audit detail carrying {@link reviewHeadToken}; null when absent. */
export function parseReviewHead(detail: string | null | undefined): string | null {
  const m = /\[head ([0-9a-fA-F]{7,64})\]/.exec(detail ?? "");
  return m ? m[1] : null;
}

/** Pure: the /status wait reason for a PR from its `merges` audit rows (any order; `id` ascending =
 *  oldest first). `waiting_review(<sha7>)` when the NEWEST row is a review-wait outcome (the head is
 *  taken from the newest `review-pending` row), `waiting_review` when no head was recorded, else null. */
export function reviewWaitReason(
  rows: readonly { id?: number | null; outcome: string; detail?: string | null }[],
): string | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
  if (sorted[0].outcome === HUMAN_ASSESSMENT_WAIT_OUTCOME) {
    const head = parseReviewHead(sorted[0].detail);
    return head ? `waiting_human_assessment(${head.slice(0, 7)})` : "waiting_human_assessment";
  }
  if (!REVIEW_WAIT_OUTCOMES.includes(sorted[0].outcome)) return null;
  for (const r of sorted) {
    if (!REVIEW_WAIT_OUTCOMES.includes(r.outcome)) break;
    const head = r.outcome === "review-pending" ? parseReviewHead(r.detail) : null;
    if (head) return `waiting_review(${head.slice(0, 7)})`;
  }
  return "waiting_review";
}
