// Guard for issue #842: agent-prompt result examples must not put free-text JSON in a
// single-quoted shell string.
//
// Agents copy the prompt's `$AGENT_RESULT_FILE` example verbatim. With the old
// `printf '%s' '{"summary":"…"}' > "$AGENT_RESULT_FILE"` shape, the first apostrophe in the
// agent's own free-text summary (e.g. "review 123's finding") terminates the single-quoted
// string. The command then breaks: the nano-coder sandbox rejected it as an "unterminated
// quote" and the agent had to retry, in a live kimi-k3 review round. A quoted heredoc
// (`<<'EOF'`) disables all expansion and quoting, so any prose is safe. This guards the
// whole class across every deployed prompt, not just the one that bit.
import { test } from "node:test";
import { assert } from "#test-assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Urban deploys everything under resources/ RECURSIVELY (AGENTS.md "Deploy by convention"), so a
// nested prompt (resources/**/foo.md) ships just like a top-level one. Scan the whole deployed
// surface, not just the immediate children of resources/prompts, or a nested prompt could
// reintroduce the unsafe example past this guard.
const RESOURCES_DIR = join(import.meta.dirname, "..", "resources");

function deployedMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...deployedMarkdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

// The unsafe class is a single-quoted shell string that opens a JSON object (`'{"`) reaching the
// result file — in ANY redirection form. The retired `printf '…' > "$FILE"` shape is only one
// instance; `cat > "${AGENT_RESULT_FILE}" <<< '{"…"}'` (herestring, braced var) and
// `printf '…' | tee "$AGENT_RESULT_FILE"` break identically the moment an apostrophe appears in the
// free-text JSON. So match the two signals independently (order-free), not the printf layout:
//   (a) a single-quoted JSON opener, and (b) a reference to AGENT_RESULT_FILE (with or without braces).
// The opener's whitespace class is `\s`, not `[ \t]`: a multiline single-quoted value (`JSON='` on
// one line, `{"summary":"x"}` on the next) is one shell string, and `unsafeResultBlocks` joins those
// lines — a horizontal-only class can't cross the inserted newline, so the same apostrophe failure
// would slip past the guard (review 5387000199). `\s` matches the joined newline too. But `\s` also
// lets the CLOSING quote of a quoted-heredoc delimiter (`<<'EOF'`) pair with a JSON body line on the
// next line — the safe shape — so the lookbehind `(?<![A-Za-z0-9_])` requires the `'` to be an
// OPENING quote (not preceded by a word char), excluding a delimiter's closing quote. JSON also
// allows whitespace AFTER the opening brace (`'{ "summary":…}'`), which breaks on an apostrophe
// identically — so the brace is followed by `\s*` too, not `"` directly (review 5387091667).
const SINGLE_QUOTED_JSON_OPENER = /(?<![A-Za-z0-9_])'\s*\{\s*"/;
const RESULT_FILE_REF = /\$\{?AGENT_RESULT_FILE\}?/;
const isUnsafeResultLine = (line: string): boolean =>
  SINGLE_QUOTED_JSON_OPENER.test(line) && RESULT_FILE_REF.test(line);

// A single unsafe command need not fit on one physical line: a shell command split with `\`
// continuations, or a single-quoted JSON assignment on one line whose value is written to the
// result file on another, has the two signals on different lines and slips past a per-line check.
// And the assignment and write can be ARBITRARILY separated inside one shell example — three
// comments between them push the write past any fixed line-distance window, yet the apostrophe
// still breaks the assignment (review 5387175386). So scope the scan to the unit an agent actually
// copies and runs — the whole fenced code block — not a fixed window: join continuation lines,
// then test each fenced block as one unit so a split command / assignment-then-write is caught no
// matter how far apart the two signals sit inside the block.
function logicalLines(lines: string[]): string[] {
  const joined: string[] = [];
  let buf = "";
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    buf = buf ? `${buf}\n${line}` : line;
    if (!line.endsWith("\\")) {
      joined.push(buf);
      buf = "";
    }
  }
  if (buf) joined.push(buf);
  return joined;
}
// Extract the fenced ``` code blocks from a markdown example. Only a fenced block is a runnable
// shell example an agent copies verbatim; prose between blocks never mixes into a command, so a
// single-quoted JSON opener and a result-file write only form the unsafe shape when they share a
// block. Scoping to the block (not the whole file) is what keeps a benign single-quoted JSON in
// one block from pairing with an unrelated `$AGENT_RESULT_FILE` prose mention in another.
function fencedBlocks(lines: string[]): string[][] {
  const blocks: string[][] = [];
  let cur: string[] | null = null;
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      if (cur) {
        blocks.push(cur);
        cur = null;
      } else {
        cur = [];
      }
    } else if (cur) {
      cur.push(line);
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}
function unsafeResultBlocks(lines: string[]): number[] {
  const bad: number[] = [];
  for (const block of fencedBlocks(lines)) {
    const text = logicalLines(block).join("\n");
    if (SINGLE_QUOTED_JSON_OPENER.test(text) && RESULT_FILE_REF.test(text)) bad.push(0);
  }
  return bad;
}

// A heredoc is only executable if its terminator is a bare delimiter at column 1. The defect fixed
// in #843 was an INDENTED `EOF` (list-indented markdown) that the shell never recognises, so the
// heredoc runs to EOF-of-file and the result file is garbage. Validate each deployed heredoc as a
// complete block: every `<<'TAG'` opener must be closed by a line that is exactly `TAG` at column 1.
// An opener is a real shell redirect, so ignore backtick-quoted inline-code mentions (`<<'EOF'`) and
// prose references to the syntax — only a `<<'TAG'` that is NOT inside backticks opens a heredoc.
const HEREDOC_OPENER = /<<-?\s*'([A-Za-z_][A-Za-z0-9_]*)'/;
function heredocOpeners(line: string): string[] {
  // Strip inline-code spans (`...`) so a prose mention of `<<'EOF'` is not mistaken for an opener.
  const code = line.replace(/`[^`]*`/g, "");
  if (code.trimStart().startsWith("#")) return []; // a commented-out example is not a real opener
  const tags: string[] = [];
  for (const m of code.matchAll(new RegExp(HEREDOC_OPENER.source, "g"))) tags.push(m[1]);
  return tags;
}
// Model the pending heredocs as an ordered QUEUE of expected terminators. One command line can
// stack several openers (`cat <<'A' <<'B'`), and the shell reads each body in turn, so EVERY opener
// needs its own later column-1 terminator. A single terminator line therefore closes only the FRONT
// pending heredoc — it must NOT be credited to every same-line opener that happens to share the
// delimiter: `cat <<'EOF' <<'EOF'` closed by a single `EOF` still leaves a second heredoc open, so
// it is malformed (review 5387296036). Walk the lines once: a line that exactly matches the front
// pending terminator (column-1 bare delimiter) closes it; otherwise any openers on the line are
// appended to the queue. This also subsumes the reused-delimiter case — a later block reusing a
// delimiter simply enqueues another terminator, so an earlier malformed opener can't borrow it —
// and matches the shell's rule that, once inside a body, only the front delimiter can terminate
// (a later queued tag appearing in an earlier body is literal text, not a terminator). Every opener
// still pending at EOF is an unterminated heredoc.
function malformedHeredocs(lines: string[]): string[] {
  const pending: { tag: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (pending.length > 0 && lines[i] === pending[0].tag) {
      pending.shift();
      continue;
    }
    for (const tag of heredocOpeners(lines[i])) pending.push({ tag, line: i });
  }
  return pending.map(
    (open) => `line ${open.line + 1}: heredoc <<'${open.tag}' has no column-1 '${open.tag}' terminator`,
  );
}

test("no agent prompt writes $AGENT_RESULT_FILE from a single-quoted JSON string (#842)", () => {
  const offenders: string[] = [];
  for (const file of deployedMarkdownFiles(RESOURCES_DIR)) {
    const rel = file.slice(RESOURCES_DIR.length + 1);
    const lines = readFileSync(file, "utf8").split("\n");
    for (const i of unsafeResultBlocks(lines)) offenders.push(`${rel}:${i + 1}`);
  }
  assert(
    offenders.length === 0,
    `use a quoted heredoc (cat > "$AGENT_RESULT_FILE" <<'EOF') instead of a single-quoted JSON string: ${offenders.join(", ")}`,
  );
});

test("every deployed heredoc is a complete, executable block with a column-1 terminator (#843)", () => {
  const problems: string[] = [];
  for (const file of deployedMarkdownFiles(RESOURCES_DIR)) {
    const rel = file.slice(RESOURCES_DIR.length + 1);
    const lines = readFileSync(file, "utf8").split("\n");
    for (const p of malformedHeredocs(lines)) problems.push(`${rel}: ${p}`);
  }
  assert(
    problems.length === 0,
    `every heredoc terminator must be the bare delimiter at column 1 so the example runs verbatim:\n${problems.join("\n")}`,
  );
});

test("the guard flags every unsafe result-file shape and accepts the heredoc shape", () => {
  // The printf redirection that bit, plus the equivalents a `> "$AGENT_RESULT_FILE"`-only check missed:
  assert(
    isUnsafeResultLine(`printf '%s' '{"status":"addressed","summary":"x"}' > "$AGENT_RESULT_FILE"`),
    "retired printf shape must be flagged",
  );
  assert(
    isUnsafeResultLine(`printf '%s' ' {"summary":"x"}' > "$AGENT_RESULT_FILE"`),
    "single-quoted JSON with leading whitespace before { must still be flagged",
  );
  assert(
    isUnsafeResultLine(`printf '%s' '{ "summary":"review 123's finding"}' > "$AGENT_RESULT_FILE"`),
    "single-quoted JSON with whitespace after { must still be flagged (review 5387091667)",
  );
  assert(
    isUnsafeResultLine(`cat > "\${AGENT_RESULT_FILE}" <<< '{"summary":"x"}'`),
    "herestring into a braced result var must be flagged",
  );
  assert(
    isUnsafeResultLine(`printf '%s' '{"summary":"x"}' | tee "$AGENT_RESULT_FILE"`),
    "tee pipe of single-quoted JSON must be flagged",
  );
  // The safe heredoc shape, and its dedented/body lines, must all pass:
  assert(!isUnsafeResultLine(`cat > "$AGENT_RESULT_FILE" <<'EOF'`), "heredoc opener must pass");
  assert(!isUnsafeResultLine(`{"status":"addressed","summary":"x"}`), "heredoc body line must pass");
  assert(!isUnsafeResultLine(`EOF`), "heredoc terminator must pass");
});

test("the guard flags unsafe shapes split across lines (continuations and assignment-then-write)", () => {
  // A single-quoted JSON and the result-file write on DIFFERENT physical lines must still be caught.
  // Each fixture is a fenced ``` block — the unit an agent copies and runs.
  const continuation = ["```sh", `printf '%s' \\`, `'{"summary":"x"}' \\`, `> "$AGENT_RESULT_FILE"`, "```"];
  assert(unsafeResultBlocks(continuation).length > 0, "backslash-continued unsafe command must be flagged");
  const assignThenWrite = ["```sh", `JSON='{"summary":"x"}'`, `printf '%s' "$JSON" > "$AGENT_RESULT_FILE"`, "```"];
  assert(unsafeResultBlocks(assignThenWrite).length > 0, "single-quoted JSON assigned then written must be flagged");
  // A MULTILINE single-quoted value — `JSON='` opens on one line and the JSON object starts on the
  // next — is one shell string. The joined block inserts a newline between `'` and `{"`, which a
  // horizontal-only whitespace class cannot cross (review 5387000199): this shape must be flagged.
  const multilineSingleQuoted = ["```sh", `JSON='`, `{"summary":"x"}'`, `printf '%s' "$JSON" > "$AGENT_RESULT_FILE"`, "```"];
  assert(
    unsafeResultBlocks(multilineSingleQuoted).length > 0,
    "multiline single-quoted JSON value reaching the result file must be flagged",
  );
  // The safe heredoc shape spans lines but has no single-quoted JSON opener, so it must pass.
  const safeHeredoc = ["```sh", `cat > "$AGENT_RESULT_FILE" <<'EOF'`, `{"summary":"x"}`, `EOF`, "```"];
  assert(unsafeResultBlocks(safeHeredoc).length === 0, "safe heredoc block must pass");
  // A benign single-quoted JSON in one fenced block must NOT pair with a `$AGENT_RESULT_FILE` prose
  // mention in a DIFFERENT block — scoping to the block (not the whole file) prevents that false
  // positive.
  const separateBlocks = [
    "```sh",
    `echo '{"status":"ok"}'`,
    "```",
    "Write the result to `$AGENT_RESULT_FILE` as shown above.",
  ];
  assert(
    unsafeResultBlocks(separateBlocks).length === 0,
    "a benign single-quoted JSON in one block and a result-file mention in another must not be flagged",
  );
  // An assignment and its write can be arbitrarily separated inside one shell example. Three
  // comments between them push the write past a fixed four-line window, yet the apostrophe still
  // breaks the assignment — so the scan is scoped to the whole fenced code block, not a fixed
  // line distance (review 5387175386).
  const beyondWindow = [
    "```sh",
    `JSON='{"summary":"review 123's finding"}'`,
    `# comment one`,
    `# comment two`,
    `# comment three`,
    `printf '%s' "$JSON" > "$AGENT_RESULT_FILE"`,
    "```",
  ];
  assert(
    unsafeResultBlocks(beyondWindow).length > 0,
    "single-quoted JSON assigned then written beyond a fixed four-line window must be flagged",
  );
});

test("the heredoc block validator flags an indented terminator and accepts a column-1 one", () => {
  // The concrete defect fixed in #843: an indented `EOF` is not a terminator.
  assert(
    malformedHeredocs([`cat > "$F" <<'EOF'`, `{"a":1}`, `   EOF`]).length > 0,
    "indented terminator must be flagged as an unterminated heredoc",
  );
  assert(
    malformedHeredocs([`cat > "$F" <<'EOF'`, `{"a":1}`, `EOF`]).length === 0,
    "column-1 terminator must pass",
  );
  // A commented-out example opener is not a real heredoc and must not be flagged.
  assert(
    malformedHeredocs([`    #   BODY=$(cat <<'EOF'`, `    #   EOF`]).length === 0,
    "commented-out example must be ignored",
  );
  // A prose / inline-code mention of `<<'EOF'` is not an opener and must not be flagged.
  assert(
    malformedHeredocs(["   Use the **quoted heredoc** shown above (`<<'EOF'`), never a single-quoted"]).length === 0,
    "inline-code mention of <<'EOF' in prose must not be treated as an opener",
  );
  // A later block REUSING the same delimiter must not lend its terminator to an earlier malformed
  // opener: the first `EOF` is indented, so a shell would swallow the second opener and write
  // garbage. The first block must be flagged, not credited the reuse's column-1 terminator.
  assert(
    malformedHeredocs([`cat <<'EOF'`, `  EOF`, `cat <<'EOF'`, `body`, `EOF`]).length > 0,
    "a reused delimiter must not credit a later terminator to an earlier malformed opener",
  );
  // Two correctly-terminated blocks reusing the same delimiter must still pass.
  assert(
    malformedHeredocs([`cat <<'EOF'`, `a`, `EOF`, `cat <<'EOF'`, `b`, `EOF`]).length === 0,
    "two well-formed blocks reusing one delimiter must pass",
  );
  // Several heredocs STACKED on one line (`cat <<'EOF' <<'EOF'`) each need their own terminator: the
  // shell reads each body in turn, so one `EOF` closes only the first and leaves the second open.
  // A single terminator must not be credited to every same-line opener sharing the delimiter
  // (review 5387296036).
  assert(
    malformedHeredocs([`cat <<'EOF' <<'EOF'`, `body`, `EOF`]).length > 0,
    "one terminator must not close two same-line heredocs sharing a delimiter",
  );
  // The same stacked pair with BOTH terminators present is well-formed and must pass.
  assert(
    malformedHeredocs([`cat <<'EOF' <<'EOF'`, `a`, `EOF`, `b`, `EOF`]).length === 0,
    "two same-line heredocs each with their own column-1 terminator must pass",
  );
});
