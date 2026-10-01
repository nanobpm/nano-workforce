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
const SINGLE_QUOTED_JSON_OPENER = /'[ \t]*\{"/;
const RESULT_FILE_REF = /\$\{?AGENT_RESULT_FILE\}?/;
const isUnsafeResultLine = (line: string): boolean =>
  SINGLE_QUOTED_JSON_OPENER.test(line) && RESULT_FILE_REF.test(line);

// A single unsafe command need not fit on one physical line: a shell command split with `\`
// continuations, or a single-quoted JSON assignment on one line whose value is written to the
// result file on the next, has the two signals on different lines and slips past a per-line check.
// So scan LOGICAL shell blocks: join continuation lines, then test a sliding window of consecutive
// lines so a split command / assignment-then-write is still caught (the failure class is "a
// single-quoted JSON string reaches the result file", which can span lines).
const LOGICAL_WINDOW = 4;
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
function unsafeResultBlocks(lines: string[]): number[] {
  const logical = logicalLines(lines);
  const bad: number[] = [];
  for (let i = 0; i < logical.length; i++) {
    const window = logical.slice(i, i + LOGICAL_WINDOW).join("\n");
    if (SINGLE_QUOTED_JSON_OPENER.test(window) && RESULT_FILE_REF.test(window)) bad.push(i);
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
function malformedHeredocs(lines: string[]): string[] {
  const problems: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const tag of heredocOpeners(lines[i])) {
      let closed = false;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] === tag) {
          closed = true;
          break;
        }
        // Another executable opener reusing this delimiter appears BEFORE our terminator. A shell
        // folds that opener line into THIS heredoc's body (writing garbage) and credits the later
        // column-1 terminator to the first opener — so a reused delimiter would let one terminator
        // close two openers and mask an indented/missing terminator on the first. Stop here so the
        // malformed first block is reported instead of silently borrowing the reuse's terminator.
        if (heredocOpeners(lines[j]).includes(tag)) break;
      }
      if (!closed) problems.push(`line ${i + 1}: heredoc <<'${tag}' has no column-1 '${tag}' terminator`);
    }
  }
  return problems;
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
  const continuation = [`printf '%s' \\`, `'{"summary":"x"}' \\`, `> "$AGENT_RESULT_FILE"`];
  assert(unsafeResultBlocks(continuation).length > 0, "backslash-continued unsafe command must be flagged");
  const assignThenWrite = [`JSON='{"summary":"x"}'`, `printf '%s' "$JSON" > "$AGENT_RESULT_FILE"`];
  assert(unsafeResultBlocks(assignThenWrite).length > 0, "single-quoted JSON assigned then written must be flagged");
  // The safe heredoc shape spans lines but has no single-quoted JSON opener, so it must pass.
  const safeHeredoc = [`cat > "$AGENT_RESULT_FILE" <<'EOF'`, `{"summary":"x"}`, `EOF`];
  assert(unsafeResultBlocks(safeHeredoc).length === 0, "safe heredoc block must pass");
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
});
