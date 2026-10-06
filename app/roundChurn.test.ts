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

test("extractFiles: mines root-level files (no directory segment) so same-root-file churn escalates (#870)", () => {
  // Root repository files are a legitimate churn surface: a loop repeatedly editing `package.json` or
  // `README.md` must escalate just like a nested path. The nested form requires a slash, so these were
  // previously missed entirely.
  for (const s of ["bumped `package.json`", "reworded README.md.", "edit tsconfig.json,", "touched nano.app.json"]) {
    const files = extractFiles(s);
    assertEquals(files.size, 1, `expected one root file in ${JSON.stringify(s)}, got ${[...files].join(",")}`);
  }
  assert(extractFiles("bumped `package.json`").has("package.json"));
  assert(extractFiles("reworded README.md.").has("README.md"));
  // A repeated-root-file loop escalates end to end.
  const rounds: ChurnRound[] = Array.from({ length: CHURN_WINDOW }, (_, i) => ({
    roundNo: i + 1,
    status: "addressed",
    summary: `chore: bump dependency ${i} in \`package.json\``,
  }));
  const res = detectChurn(rounds);
  assertEquals(res.churning, true);
  assertEquals(res.file, "package.json");
});

test("extractFiles: prose dots are NOT mined as root files (version strings, abbreviations)", () => {
  // The bare-filename form must stay conservative: version numbers and sentence abbreviations whose
  // "extension" is numeric or a single letter must not be mined as fake root files.
  for (const s of ["bumped to 4.8 today", "e.g. the loop", "i.e. a fixed point", "the U.S. team", "ran it 3.0 times"]) {
    assertEquals(extractFiles(s).size, 0, `prose should yield no file in ${JSON.stringify(s)}`);
  }
});

test("extractFiles: dotted API symbols and domains are NOT mined as root files (#870 review)", () => {
  // A permissive extension mines dotted identifiers/domains as fake root files: `z.object`'s "extension"
  // is `object`, `example.com`'s is `com`. Four rounds that each mention the same `z.object` schema
  // while fixing DIFFERENT real files would otherwise intersect on `z.object` and falsely escalate.
  // The extension allowlist rejects every one of these (their trailing word is not a file extension).
  for (const s of [
    "validated z.object while changing the schema",
    "fixed z.string and z.number",
    "used io.nanobpm.agentResult in the worker",
    "called object.keys on the result",
    "see example.com or Deno.land for docs",
  ]) {
    assertEquals(extractFiles(s).size, 0, `dotted symbol/domain should yield no file in ${JSON.stringify(s)}`);
  }
  // The real file alongside a dotted symbol is still mined; only the symbol is dropped.
  const mixed = extractFiles("validated z.object while changing src/a.ts");
  assert(mixed.has("src/a.ts"), "the real nested file is still mined");
  assertEquals(mixed.has("z.object"), false, "the dotted API symbol is not mined");
});

test("extractFiles: the allowlisted extension must be FINAL — a trailing dotted segment is not a file (#870 review)", () => {
  // Class: `(?=\b|$)` also succeeds BEFORE another dot, so an API chain whose head happens to look
  // like `name.<ext>.method` (`schema.ts.parse`, `config.json.parse`, `data.yaml.load`) was mined as
  // the truncated `name.<ext>`. Four rounds citing the same chain while fixing different real files
  // would then intersect on the fake file and falsely escalate. The extension must be the LAST dotted
  // component of the token.
  for (const s of [
    "called schema.ts.parse on the payload",
    "ran config.json.parse then merged",
    "invoked data.yaml.load in the loader",
    "used app.css.modules helper",
  ]) {
    assertEquals(extractFiles(s).size, 0, `trailing-segment chain should yield no file in ${JSON.stringify(s)}`);
  }
  // But a genuine multi-dot root file whose allowlisted extension IS final still mines whole.
  assert(extractFiles("touched foo.test.ts").has("foo.test.ts"));
  assert(extractFiles("edited nano.app.json").has("nano.app.json"));
  assert(extractFiles("regenerated lib.d.ts").has("lib.d.ts"));
});

test("extractFiles: a SLASH-qualified dotted symbol is NOT mined as a nested file (#870 review)", () => {
  // Class: the nested matcher required only `name.<anything>` as the final segment, so a slash-qualified
  // API chain (`src/schema.ts.parse`, `lib/config.json.parse`) was mined WHOLE as a fake repo file —
  // the sibling of the root-path false positive above, which the root allowlist already closes. Four
  // rounds citing the same qualified symbol while fixing different real files would intersect on it and
  // falsely escalate. The nested final component must now also be an allowlisted, FINAL extension.
  for (const s of [
    "called src/schema.ts.parse on the payload",
    "ran lib/config.json.parse then merged",
    "invoked data/opts.yaml.load in the loader",
    "used ui/app.css.modules helper",
  ]) {
    assertEquals(extractFiles(s).size, 0, `nested trailing-segment chain should yield no file in ${JSON.stringify(s)}`);
  }
  // But genuine nested files — including multi-dot basenames whose allowlisted extension IS final —
  // still mine whole.
  assert(extractFiles("fixed src/schema.ts").has("src/schema.ts"));
  assert(extractFiles("touched dir/foo.test.ts").has("dir/foo.test.ts"));
  assert(extractFiles("edited pkg/nano.app.json").has("pkg/nano.app.json"));
  assert(extractFiles("regenerated types/lib.d.ts").has("types/lib.d.ts"));
});

test("extractFiles: a repeated SLASH-qualified dotted-symbol loop does NOT escalate as churn (#870 review)", () => {
  // Acceptance counter-case for the nested class: four rounds that all cite the SAME slash-qualified
  // API symbol (src/schema.ts.parse) while fixing DIFFERENT real files must NOT be churn — the shared
  // token is a qualified symbol, not a contested file.
  const rounds: ChurnRound[] = Array.from({ length: CHURN_WINDOW }, (_, i) => ({
    roundNo: i + 1,
    status: "addressed",
    summary: `re-checked src/schema.ts.parse again; fixed src/f${i}.ts this round`,
  }));
  assertEquals(detectChurn(rounds).churning, false);
});

test("extractFiles: mines supported dotfiles and extensionless root files (#870 review)", () => {
  // Class: the allowlist/comment name `.gitignore`, `.env`, `Dockerfile`, `Makefile` as churn
  // surfaces, but the `name.ext` matcher can never match a leading-dot dotfile or an extensionless
  // basename, so genuine churn on those surfaces was silently missed. A dedicated conservative
  // basename matcher closes that gap.
  const cases: Array<[string, string]> = [
    ["reworked .gitignore again", ".gitignore"],
    ["tweaked the .env file", ".env"],
    ["adjusted .gitattributes", ".gitattributes"],
    ["fixed .editorconfig rules", ".editorconfig"],
    ["rebuilt the Dockerfile layer", "Dockerfile"],
    ["edited the Makefile target", "Makefile"],
  ];
  for (const [summary, want] of cases) {
    assert(extractFiles(summary).has(want), `expected ${want} mined from ${JSON.stringify(summary)}`);
  }
  // Prose that merely contains the word (no leading dot / wrong form) is NOT mined.
  for (const s of ["the environment was fine", "docker build ran", "make the change"]) {
    assertEquals(extractFiles(s).size, 0, `prose should yield no file in ${JSON.stringify(s)}`);
  }
  // A repeated-dotfile loop escalates end to end.
  const rounds: ChurnRound[] = Array.from({ length: CHURN_WINDOW }, (_, i) => ({
    roundNo: i + 1,
    status: "addressed",
    summary: `round ${i}: re-ignored another build artifact in .gitignore`,
  }));
  const res = detectChurn(rounds);
  assertEquals(res.churning, true);
  assertEquals(res.file, ".gitignore");
});

test("extractFiles: a repeated dotted-symbol loop does NOT escalate as churn (#870 review)", () => {
  // The acceptance counter-case: four rounds that all mention the SAME dotted API symbol (z.object)
  // while fixing DIFFERENT real files must NOT be declared churn — the shared token is prose, not a
  // contested file. With the symbol correctly un-mined, the rounds have no common file and the loop
  // continues.
  const rounds: ChurnRound[] = Array.from({ length: CHURN_WINDOW }, (_, i) => ({
    roundNo: i + 1,
    status: "addressed",
    summary: `validated z.object again; fixed src/f${i}.ts this round`,
  }));
  assertEquals(detectChurn(rounds).churning, false);
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

test("extractFiles: rejects scheme-less citation links so their path is not mined as a repo file", () => {
  // A citation link WITHOUT a scheme (`github.com/o/r/blob/main/docs/guide.md`) survives the
  // scheme-required URL strip, yet its host+path looks exactly like a nested repo file — so it must be
  // rejected too, or four summaries citing the same bare link while fixing different files
  // false-escalate as churn (#870, Copilot "Previously missed" review of #875). Sweep the whole class:
  // bare-host, `www.`, and multi-label-host forms.
  const schemeless = extractFiles(
    "Per github.com/o/r/blob/main/docs/guide.md I fixed src/analyze.ts for the IIFE case.",
  );
  assertEquals(schemeless.has("github.com/o/r/blob/main/docs/guide.md"), false);
  assertEquals(schemeless.has("docs/guide.md"), false);
  assert(schemeless.has("src/analyze.ts"));
  // `www.`-prefixed and deep-subdomain hosts are the same class.
  assertEquals(extractFiles("see www.example.com/a/b/c.md").has("www.example.com/a/b/c.md"), false);
  assertEquals(
    extractFiles("raw.githubusercontent.com/o/r/main/pkg/x.ts here").has(
      "raw.githubusercontent.com/o/r/main/pkg/x.ts",
    ),
    false,
  );
  // A genuine nested repo file (no dotted host segment) must still be mined — the reject is surgical.
  assert(extractFiles("fixed docs/guide.md this round").has("docs/guide.md"));
  assert(extractFiles("fixed src/foo.ts this round").has("src/foo.ts"));
  // A leading-dot dotfile directory is NOT a host (no label before the dot), so it is still mined.
  assert(extractFiles("edited .github/workflows/ci.yml").has(".github/workflows/ci.yml"));
  // The URL is the ONLY shared token across rounds that otherwise fix different files — once it is
  // rejected, detectChurn must NOT escalate.
  const rounds: ChurnRound[] = Array.from({ length: CHURN_WINDOW }, (_, i) => ({
    roundNo: i + 1,
    status: "addressed",
    summary: `See github.com/o/r/blob/main/docs/guide.md — fixed src/g${i}.ts this round.`,
  }));
  assertEquals(detectChurn(rounds).churning, false);
});

test("extractFiles: the scan is structurally capped at MAX_SCAN (no wall-clock dependence)", () => {
  // Structural cap check — deterministic regardless of machine speed (AGENTS.md:21-29 forbids a
  // nondeterministic wall-clock assertion). A valid path placed JUST PAST the 20,000-char MAX_SCAN
  // boundary must be dropped; a path within it is still mined. Removing the `slice(0, MAX_SCAN)` cap
  // would make the beyond-cap path extractable and fail this test on EVERY run.
  const MAX_SCAN = 20000;
  const filler = "x ".repeat(MAX_SCAN); // 40,000 chars — safely past the cap
  const beyond = `${filler} src/beyond-cap.ts`;
  assert(beyond.length > MAX_SCAN, "fixture must exceed the cap");
  assertEquals(extractFiles(beyond).has("src/beyond-cap.ts"), false, "a path past MAX_SCAN is not mined");
  assert(extractFiles(`src/within-cap.ts ${filler}`).has("src/within-cap.ts"), "a path within the cap IS mined");
});

test("extractFiles: a long unterminated path run yields no match (bounded, no quadratic stall)", () => {
  // `"a/".repeat(n)` with no closing `name.ext` is the nested form's quadratic worst case; the length
  // bound keeps it linear and yields no match. Asserted structurally (no timing).
  const pathological = `${"a/".repeat(50_000)}b`;
  assertEquals(extractFiles(pathological).size, 0);
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
