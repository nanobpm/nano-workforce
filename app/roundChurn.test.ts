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

// ── churnQuestion ────────────────────────────────────────────────────────────

test("churnQuestion: frames an actionable SCOPE decision naming the contested file", () => {
  const q = churnQuestion("hooks/post/720.ts", 4);
  assertStringIncludes(q, "hooks/post/720.ts");
  assertStringIncludes(q, "SCOPE"); // framed as a scope decision
  assertStringIncludes(q, "narrow or simplify");
  assertStringIncludes(q, "follow-up issue");
  assertStringIncludes(q, "non-blocking");
});
