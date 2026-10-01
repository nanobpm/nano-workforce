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

const PROMPTS_DIR = join(import.meta.dirname, "..", "resources", "prompts");

// A single-quoted shell argument that opens a JSON object, on a line that writes the result file.
const SINGLE_QUOTED_RESULT_JSON = /'\{"[^\n]*>\s*"?\$AGENT_RESULT_FILE/;

test("no agent prompt writes $AGENT_RESULT_FILE from a single-quoted JSON string (#842)", () => {
  const offenders: string[] = [];
  for (const name of readdirSync(PROMPTS_DIR).filter((f) => f.endsWith(".md"))) {
    const lines = readFileSync(join(PROMPTS_DIR, name), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (SINGLE_QUOTED_RESULT_JSON.test(line)) offenders.push(`${name}:${i + 1}`);
    });
  }
  assert(
    offenders.length === 0,
    `use a quoted heredoc (cat > "$AGENT_RESULT_FILE" <<'EOF') instead of a single-quoted JSON string: ${offenders.join(", ")}`,
  );
});

test("the guard pattern catches the retired printf shape and accepts the heredoc shape", () => {
  assert(
    SINGLE_QUOTED_RESULT_JSON.test(`printf '%s' '{"status":"addressed","summary":"x"}' > "$AGENT_RESULT_FILE"`),
    "retired shape must be flagged",
  );
  assert(!SINGLE_QUOTED_RESULT_JSON.test(`cat > "$AGENT_RESULT_FILE" <<'EOF'`), "heredoc must pass");
});
