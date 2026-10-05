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

// Matches a repository-relative file path inside free text: one or more `dir/` segments followed by a
// `name.ext`. Requiring at least one slash AND an extension keeps bare words ("addressed", "zod") and
// prose out, so only genuine file references are mined. Backticks/quotes are not in the class, so a
// `` `hooks/post/720-pure-zod-schemas.ts` `` span yields the inner path; trailing punctuation is
// trimmed below so `foo.ts,` and `foo.ts)` normalize to `foo.ts`.
const PATH_RE = /(?:[\w.@~+-]+\/)+[\w.@~+-]+\.[A-Za-z0-9]+/g;

/** Mine the set of distinct file paths referenced in a round summary. A non-string / empty summary
 * yields an empty set. Paths are normalized by stripping trailing sentence punctuation and closing
 * brackets so the same file referenced with different surrounding punctuation collapses to one key. */
export function extractFiles(summary: string | null | undefined): Set<string> {
  const files = new Set<string>();
  if (typeof summary !== "string" || summary.trim() === "") return files;
  for (const match of summary.matchAll(PATH_RE)) {
    const path = match[0].replace(/[),.;:'"`\]]+$/u, "").trim();
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
 * only ever reported on a genuinely same-file, same-surface loop. */
export function detectChurn(rounds: readonly ChurnRound[], window: number = CHURN_WINDOW): ChurnResult {
  if (window < 1 || rounds.length < window) return { churning: false };

  // Order by round number, then walk back over the trailing CONSECUTIVE `addressed` run.
  const sorted = [...rounds].sort((a, b) => a.roundNo - b.roundNo);
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
