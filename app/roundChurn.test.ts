// Non-converging churn detector — unit tests for the canonical detector (app/roundChurn.ts) used by
// the pr.progress-check worker to escalate a review loop that keeps "progressing" (head advances
// every round) yet never reaches a fixed point because the findings keep landing in the same file
// (issue #870).
import { test } from "node:test";
import { assert, assertEquals, assertStringIncludes } from "#test-assert";
import { CHURN_WINDOW, type ChurnRound, churnQuestion, detectChurn, extractFiles } from "./roundChurn.ts";

// ── extractFiles ─────────────────────────────────────────────────────────────

test("extractFiles: mines backticked and bare repo-relative paths from a summary", () => {
  const files = extractFiles("Fixed `hooks/post/720-pure-zod-schemas.ts` and src/analyze.ts for the IIFE case.");
  assert(files.has("hooks/post/720-pure-zod-schemas.ts"));
  assert(files.has("src/analyze.ts"));
  assertEquals(files.size, 2);
});

test("extractFiles: strips trailing punctuation and closing brackets", () => {
  for (const s of ["see hooks/post/720.ts.", "see (hooks/post/720.ts)", "see hooks/post/720.ts,", "`hooks/post/720.ts`"]) {
    assert(extractFiles(s).has("hooks/post/720.ts"), `failed on ${JSON.stringify(s)}`);
  }
});

test("extractFiles: ignores bare words and paths without a slash or extension", () => {
  const files = extractFiles("addressed the zod concern and fail-closed on undefined (no file here) README");
  assertEquals(files.size, 0);
});

test("extractFiles: a blank/non-string summary yields an empty set", () => {
  for (const s of [null, undefined, "", "   "]) assertEquals(extractFiles(s).size, 0);
});

test("extractFiles: strips URL spans so a citation link's path is not mined as a repo file", () => {
  // A scheme URL whose path mirrors a repo path must NOT be reported — otherwise a summary that cites
  // the same link every round while fixing different real files false-escalates as churn (#870).
  const files = extractFiles(
    "Per https://github.com/o/r/blob/main/docs/guide.md I fixed src/analyze.ts for the IIFE case.",
  );
  assertEquals(files.has("github.com/o/r/blob/main/docs/guide.md"), false);
  assertEquals(files.has("docs/guide.md"), false);
  assert(files.has("src/analyze.ts"));
  // The URL is the ONLY shared token across rounds that otherwise fix different files — so once it is
  // stripped, those rounds have no common file and detectChurn must NOT escalate.
  const rounds: ChurnRound[] = Array.from({ length: CHURN_WINDOW }, (_, i) => ({
    roundNo: i + 1,
    status: "addressed",
    summary: `See https://github.com/o/r/blob/main/docs/guide.md — fixed src/f${i}.ts this round.`,
  }));
  assertEquals(detectChurn(rounds).churning, false);
});

test("extractFiles: a long unterminated path run is bounded (no quadratic stall)", () => {
  // `"a/".repeat(n)` with no closing `name.ext` is PATH_RE's quadratic worst case; the length bound
  // must keep this fast and yield no match. Guard with a wall-clock budget so a regression (removing
  // the cap) fails loudly rather than hanging the worker inside the convergence loop.
  const pathological = `${"a/".repeat(50_000)}b`;
  const start = Date.now();
  const files = extractFiles(pathological);
  const elapsedMs = Date.now() - start;
  assertEquals(files.size, 0);
  assert(elapsedMs < 2500, `extractFiles took ${elapsedMs}ms on an unterminated path run — cap regressed`);
});

// ── detectChurn ──────────────────────────────────────────────────────────────

/** A trailing run of `addressed` rounds whose summaries all name `file`. */
function sameFileRounds(count: number, file: string, startRound = 1): ChurnRound[] {
  return Array.from({ length: count }, (_, i) => ({
    roundNo: startRound + i,
    status: "addressed",
    summary: `chore: fail closed on bypass form ${i} in \`${file}\``,
  }));
}

test("detectChurn: THE REPRO — repeated addressed rounds hitting the same file escalates (#870)", () => {
  // Process 189847's shape: every round is `addressed`, pushes a commit, and the finding lands in the
  // same analyzer file. The head advances each round so the no-progress guard never fires — churn is
  // what catches it.
  const file = "hooks/post/720-pure-zod-schemas.ts";
  const res = detectChurn(sameFileRounds(CHURN_WINDOW, file));
  assertEquals(res.churning, true);
  assertEquals(res.file, file);
  assertEquals(res.rounds, CHURN_WINDOW);
  assert(res.question, "a churn verdict carries an actionable scope question");
});

test("detectChurn: does NOT escalate below the window", () => {
  const res = detectChurn(sameFileRounds(CHURN_WINDOW - 1, "hooks/post/720.ts"));
  assertEquals(res.churning, false);
});

test("detectChurn: normal convergence — findings in DIFFERENT files each round — is not escalated", () => {
  // Each round addresses a finding in a different area; no single file spans the window, so the loop
  // continues (the counter-case the issue's acceptance calls out).
  const rounds: ChurnRound[] = [
    { roundNo: 1, status: "addressed", summary: "fix src/a.ts null check" },
    { roundNo: 2, status: "addressed", summary: "fix src/b.ts off-by-one" },
    { roundNo: 3, status: "addressed", summary: "fix src/c.ts typo" },
    { roundNo: 4, status: "addressed", summary: "fix src/d.ts import" },
    { roundNo: 5, status: "addressed", summary: "docs/readme.md wording" },
  ];
  assertEquals(detectChurn(rounds).churning, false);
});

test("detectChurn: a non-addressed round (a prior human escalation) BREAKS the consecutive run", () => {
  // A `needs_input` escalation in the middle restarts the churn clock: only one addressed round
  // trails it, far short of the window.
  const file = "hooks/post/720.ts";
  const rounds: ChurnRound[] = [
    ...sameFileRounds(3, file, 1),
    { roundNo: 4, status: "needs_input", summary: `human asked about \`${file}\`` },
    { roundNo: 5, status: "addressed", summary: `chore: fail closed again in \`${file}\`` },
  ];
  assertEquals(detectChurn(rounds).churning, false);
});

test("detectChurn: a window round with no extractable file breaks the same-file signal", () => {
  const file = "hooks/post/720.ts";
  const rounds = sameFileRounds(CHURN_WINDOW, file);
  // Blank out one window round's file reference.
  const mutated = [...rounds];
  mutated[mutated.length - 2] = { roundNo: mutated[mutated.length - 2]!.roundNo, status: "addressed", summary: "addressed the finding" };
  assertEquals(detectChurn(mutated).churning, false);
});

test("detectChurn: only the MOST RECENT window matters — an earlier same-file streak that moved on continues", () => {
  // Rounds 1-4 all hit file A, but the loop then moved to file B for the latest rounds and is
  // converging there — the trailing window is mixed, so no churn.
  const rounds: ChurnRound[] = [
    ...sameFileRounds(3, "a.ts/x.ts", 1),
    { roundNo: 4, status: "addressed", summary: "fix dir/b.ts" },
    { roundNo: 5, status: "addressed", summary: "fix dir/c.ts" },
    { roundNo: 6, status: "addressed", summary: "fix dir/d.ts" },
  ];
  assertEquals(detectChurn(rounds).churning, false);
});

test("detectChurn: unsorted input is ordered by round number before windowing", () => {
  const file = "dir/file.ts";
  const rounds = sameFileRounds(CHURN_WINDOW, file);
  const shuffled = [rounds[2]!, rounds[0]!, rounds[3]!, rounds[1]!];
  assertEquals(detectChurn(shuffled).churning, true);
});

test("detectChurn: picks a deterministic (lexicographically smallest) file when several are common", () => {
  const rounds: ChurnRound[] = Array.from({ length: CHURN_WINDOW }, (_, i) => ({
    roundNo: i + 1,
    status: "addressed",
    summary: "touched `dir/zeta.ts` and `dir/alpha.ts`",
  }));
  const res = detectChurn(rounds);
  assertEquals(res.churning, true);
  assertEquals(res.file, "dir/alpha.ts", "the stable choice is the smallest common path");
});

test("detectChurn: THE RESET REPRO — a run-scoped churn-reset watermark restarts the clock after a human answers (#870)", () => {
  // A churn escalation at round N writes NO `blocked` round (persist-escalation-noprogress sets
  // recordRound=false) and the human-answer resume re-enters the SAME numeric round N, so WITHOUT the
  // watermark the resumed round's history is the identical same-file window — and churn would re-fire
  // forever. Passing `resetAfterRound=N` drops every round at or before N, so the clock restarts.
  const file = "hooks/post/720-pure-zod-schemas.ts";
  const window = sameFileRounds(CHURN_WINDOW, file);
  // Red without the fix: this is exactly the window that escalated at round CHURN_WINDOW.
  assertEquals(detectChurn(window).churning, true, "baseline: the window escalates");
  // After the human answered the escalation raised at round CHURN_WINDOW, the resumed round re-enters
  // round CHURN_WINDOW and re-runs detection with the watermark set — no new rounds past it yet.
  assertEquals(
    detectChurn(window, CHURN_WINDOW, CHURN_WINDOW).churning,
    false,
    "the human's scope decision restarts the churn clock — the answered window never re-escalates",
  );
});

test("detectChurn: churn can fire AGAIN only after a fresh window accumulates past the reset watermark (#870)", () => {
  // Rounds 1-4 escalated and were answered (watermark=4). Four MORE same-file rounds (5-8) then
  // accumulate — a genuinely still-contested surface the human's decision did not resolve — so churn
  // re-escalates on the post-decision window, not on the already-answered one.
  const file = "hooks/post/720.ts";
  const rounds = sameFileRounds(CHURN_WINDOW * 2, file); // rounds 1..8
  assertEquals(detectChurn(rounds, CHURN_WINDOW, CHURN_WINDOW).churning, true, "a fresh post-reset window re-escalates");
  // One short of a fresh window (only rounds 5-7 past the watermark) does NOT re-escalate yet.
  assertEquals(
    detectChurn(rounds.slice(0, CHURN_WINDOW + CHURN_WINDOW - 1), CHURN_WINDOW, CHURN_WINDOW).churning,
    false,
    "below a fresh window past the watermark, the loop continues",
  );
});

// ── churnQuestion ────────────────────────────────────────────────────────────

test("churnQuestion: frames an actionable SCOPE decision naming the contested file", () => {
  const q = churnQuestion("hooks/post/720.ts", 4);
  assertStringIncludes(q, "hooks/post/720.ts");
  assertStringIncludes(q, "SCOPE"); // framed as a scope decision
  assertStringIncludes(q, "narrow or simplify");
  assertStringIncludes(q, "follow-up issue");
  assertStringIncludes(q, "non-blocking");
});
