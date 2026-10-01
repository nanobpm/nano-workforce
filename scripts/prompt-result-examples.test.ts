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

// The unsafe class is a single-quoted shell string that opens a JSON object (`'{"`) on any line
// that also targets the result file — in ANY redirection form. The retired `printf '…' > "$FILE"`
// shape is only one instance; `cat > "${AGENT_RESULT_FILE}" <<< '{"…"}'` (herestring, braced var)
// and `printf '…' | tee "$AGENT_RESULT_FILE"` break identically the moment an apostrophe appears in
// the free-text JSON. So match the two signals independently (order-free), not the printf layout:
//   (a) a single-quoted JSON opener, and (b) a reference to AGENT_RESULT_FILE (with or without braces).
const SINGLE_QUOTED_JSON_OPENER = /'\{"/;
const RESULT_FILE_REF = /\$\{?AGENT_RESULT_FILE\}?/;
const isUnsafeResultLine = (line: string): boolean =>
  SINGLE_QUOTED_JSON_OPENER.test(line) && RESULT_FILE_REF.test(line);

test("no agent prompt writes $AGENT_RESULT_FILE from a single-quoted JSON string (#842)", () => {
  const offenders: string[] = [];
  for (const file of deployedMarkdownFiles(RESOURCES_DIR)) {
    const rel = file.slice(RESOURCES_DIR.length + 1);
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (isUnsafeResultLine(line)) offenders.push(`${rel}:${i + 1}`);
    });
  }
  assert(
    offenders.length === 0,
    `use a quoted heredoc (cat > "$AGENT_RESULT_FILE" <<'EOF') instead of a single-quoted JSON string: ${offenders.join(", ")}`,
  );
});

test("the guard flags every unsafe result-file shape and accepts the heredoc shape", () => {
  // The printf redirection that bit, plus the equivalents a `> "$AGENT_RESULT_FILE"`-only check missed:
  assert(
    isUnsafeResultLine(`printf '%s' '{"status":"addressed","summary":"x"}' > "$AGENT_RESULT_FILE"`),
    "retired printf shape must be flagged",
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
