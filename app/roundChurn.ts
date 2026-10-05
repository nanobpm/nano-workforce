// Non-converging churn guard — the canonical, testable detector the `pr.progress-check` worker uses
// to escalate a review loop that is making head-advancing "progress" every round yet never reaches a
// fixed point (issue #870).
//
// The no-progress guard in app/roundProgress.ts catches the OTHER failure mode: an `addressed` round
// whose PR head did NOT advance (no commit pushed). Churn is the opposite shape — EVERY round pushes
// a commit, so the head advances and `routeProgress` legitimately returns `continue`, round after
// round. The trap is that the findings never end: a contested surface (e.g. a fail-closed static
// analyzer whose bypass forms are unbounded) keeps producing 1–3 new findings in the SAME file,
// the review agent patches them, the patch adds more surface for the next review, and the loop runs
// to `maxRounds` (or forever) without a human ever being asked to make the scope call.
//
// This detector reads the durable `rounds` history and reports churn when the trailing run of
// consecutive `addressed` rounds keeps landing findings in the SAME file(s) over a window of rounds.
// It is deliberately conservative — it requires the SAME file to appear in EVERY round of the window
// — so normal multi-round convergence (findings in different areas, trending down) is never escalated
// early. When it fires, the worker routes the round to the SAME human escalation path the no-advance
// guard uses (gw-husk → persist-escalation-noprogress), carrying an actionable scope question.
import { isAddressedStatus } from "./roundProgress.ts";

/** How many CONSECUTIVE `addressed` rounds must all land findings in the same file before the loop is
 * declared non-converging and escalated for a human scope decision. Four matches the issue's
 * suggested threshold (#870) — long enough that a legitimately-converging loop whose findings move
 * between areas never reaches it, short enough to catch a stuck surface well below a high `maxRounds`
 * cap. */
export const CHURN_WINDOW = 4;

/** One recorded round, projected to just the fields churn detection reads: its number (for ordering),
 * its `status` (to find the trailing consecutive `addressed` run), and its `summary` (the agent's
 * round summary, the durable free-text the contested file names are mined from). */
export interface ChurnRound {
  readonly roundNo: number;
  readonly status: string | null | undefined;
  readonly summary: string | null | undefined;
}

/** The churn verdict. `churning:false` is the common case (continue the loop). When `churning:true`,
 * `file` is the contested surface, `rounds` is how many consecutive rounds hit it, and `question` is
 * the human-facing scope decision to carry into the escalation. */
export interface ChurnResult {
  readonly churning: boolean;
  readonly file?: string;
  readonly rounds?: number;
  readonly question?: string;
}

// A maximal run of path characters (`\w`, plus `.@~+/-`). Splitting the summary into these runs
// first — a single linear scan — isolates each candidate token (a non-path char like a space, comma,
// backtick, or `:` ends a run), so the path shape below is only ever tested ANCHORED at a run's start
// and never re-tried at every offset of the whole summary. The trailing `-` keeps that metacharacter
// literal (a filename hyphen) rather than a range.
const PATH_RUN_RE = /[\w.@~+/-]+/g;

// A repository-relative file path, ANCHORED at the start of a candidate run: one or more `dir/`
// segments followed by a `name.ext`. Requiring at least one slash AND an extension keeps bare words
// ("addressed", "zod") and prose out, so only genuine file references are mined. Because it is matched
// against one bounded run (not scanned across the whole text), the inner `(?:…\/)+` backtracking on a
// long UNTERMINATED `dir/` run (e.g. `"a/".repeat(n)` with no closing `name.ext`) is paid ONCE at a
// single start position — linear in the run length — rather than the O(n²) a global re-scan would
// cost, which would otherwise let an adversarial summary (a long directory listing, minified stack
// trace, or base64/data-URI blob) stall the `pr.progress-check` worker inside the convergence loop.
const PATH_RE = /^(?:[\w.@~+-]+\/)+[\w.@~+-]+\.[A-Za-z0-9]+/;

// A whole URL span (`scheme://…host/path…`). A citation link's path (e.g.
// `github.com/o/r/blob/main/docs/guide.md`) otherwise looks exactly like a repo-relative file, so a
// summary that cites the SAME link every round while fixing DIFFERENT real files would false-escalate
// as churn naming the URL as the contested file. Strip URL spans before mining so only genuine repo
// paths remain. `\S+` is linear (no backtracking).
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/giu;

// Defensive cap on the free text scanned. The matcher above is linear, so this is belt-and-suspenders
// (bounding Set growth and any unforeseen pathological input), not the primary perf guard; real round
// summaries are far shorter, and truncating one only ever drops a churn SIGNAL (fail-open), never
// fabricates one.
const MAX_SCAN = 20000;

/** Mine the set of distinct file paths referenced in a round summary. A non-string / empty summary
 * yields an empty set. The summary is length-bounded and URL spans are stripped, then each maximal
 * path-char run is tested for the path shape anchored at its start (see MAX_SCAN / URL_RE /
 * PATH_RUN_RE / PATH_RE). Paths are normalized by stripping trailing sentence punctuation and closing
 * brackets so the same file referenced with different surrounding punctuation collapses to one key. */
export function extractFiles(summary: string | null | undefined): Set<string> {
  const files = new Set<string>();
  if (typeof summary !== "string" || summary.trim() === "") return files;
  const scanned = summary.slice(0, MAX_SCAN).replace(URL_RE, " ");
  for (const run of scanned.matchAll(PATH_RUN_RE)) {
    const hit = run[0].match(PATH_RE);
    if (hit === null) continue;
    const path = hit[0].replace(/[),.;:'"`\]]+$/u, "").trim();
    if (path !== "") files.add(path);
  }
  return files;
}

/** Build the human-facing escalation question for a churning loop, framed — per the issue — as a
 * SCOPE decision, not a request to keep looping. The answer the human gives is threaded into the next
 * round's context (the `answer` variable), so it must offer concrete, actionable choices. */
export function churnQuestion(file: string, rounds: number): string {
  return (
    `Convergence is not converging: the last ${rounds} review rounds all reported the comments were ` +
    `addressed, yet the findings keep landing in the same file (\`${file}\`) with no fixed point in ` +
    `sight — a contested surface whose findings never end (e.g. a fail-closed analyzer whose bypass ` +
    `forms are unbounded). Rather than burn more rounds, this needs a human SCOPE decision: ` +
    `(a) narrow or simplify the contested surface in \`${file}\`; (b) defer the remaining findings ` +
    `to a follow-up issue and accept the current state as non-blocking; or (c) accept the residual ` +
    `findings as non-blocking and let the loop converge. Reply with the decision to resume the loop.`
  );
}

/** Detect non-converging churn over a PR's recorded rounds.
 *
 * Churn = the trailing run of CONSECUTIVE `addressed` rounds is at least `window` long AND some single
 * file appears in the summary of EVERY round of the most recent `window`. Requiring the same file in
 * all `window` rounds is what keeps normal convergence (findings that move between areas and trend
 * down) from escalating: a loop whose findings are in different files each round has no file common to
 * the whole window, so it continues. A non-`addressed` round (a `waiting` round, or a prior human
 * escalation recorded as `needs_input`/`blocked`) BREAKS the consecutive run — a human already made a
 * call, so the churn clock restarts after it.
 *
 * The verdict is conservative by construction: a round with NO extractable file path in its summary
 * also breaks the signal (the intersection can't include a file absent from one round), so churn is
 * only ever reported on a genuinely same-file, same-surface loop.
 *
 * `resetAfterRound` is the run-scoped churn-reset watermark (issue #870): the round number at which a
 * churn escalation was last raised AND answered by a human for THIS run. A churn escalation routes
 * through `persist-escalation-noprogress` with `recordRound=false`, so it writes NO `blocked` round —
 * and the human-answer resume re-enters the SAME numeric round (the round counter only advances at the
 * review-wait gateway). Without this watermark `detectChurn` would therefore see the identical trailing
 * `addressed` window the instant the resumed round is recorded and re-raise the SAME question forever
 * (which durable adjudication may auto-resume repeatedly). Dropping every round at or before the
 * watermark makes the human's scope decision restart the churn clock exactly as a recorded
 * `needs_input`/`blocked` round would: churn can only fire again after a fresh `window` of same-file
 * rounds ACCUMULATES past the decision. */
export function detectChurn(
  rounds: readonly ChurnRound[],
  window: number = CHURN_WINDOW,
  resetAfterRound = 0,
): ChurnResult {
  // Drop rounds at or before the churn-reset watermark so a human scope decision restarts the clock.
  const live = resetAfterRound > 0 ? rounds.filter((r) => r.roundNo > resetAfterRound) : rounds;
  if (window < 1 || live.length < window) return { churning: false };

  // Order by round number, then walk back over the trailing CONSECUTIVE `addressed` run.
  const sorted = [...live].sort((a, b) => a.roundNo - b.roundNo);
  const trailing: ChurnRound[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const r = sorted[i];
    if (r === undefined || !isAddressedStatus(r.status)) break;
    trailing.unshift(r);
  }
  if (trailing.length < window) return { churning: false };

  // Intersect the file sets of the most-recent `window` addressed rounds. A single empty set means no
  // same-file signal — bail immediately.
  const recent = trailing.slice(-window);
  const fileSets = recent.map((r) => extractFiles(r.summary));
  if (fileSets.some((s) => s.size === 0)) return { churning: false };
  let common = fileSets[0] ?? new Set<string>();
  for (let i = 1; i < fileSets.length && common.size > 0; i++) {
    const next = fileSets[i] ?? new Set<string>();
    common = new Set([...common].filter((f) => next.has(f)));
  }
  if (common.size === 0) return { churning: false };

  // Deterministic choice when several files are common to the whole window: the lexicographically
  // smallest, so the escalation question is stable across redeliveries of the same round.
  const [file] = [...common].sort();
  if (file === undefined) return { churning: false };
  return { churning: true, file, rounds: recent.length, question: churnQuestion(file, recent.length) };
}
