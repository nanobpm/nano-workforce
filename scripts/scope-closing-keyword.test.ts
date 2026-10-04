// Guard for issue #858: a planner must not scope an agent node to PART of an issue while still
// telling it to CLOSE that issue, and the scope gate + agent contract must cover COMMIT bodies.
//
// Field case (merlin, delivery graph `5e36636255ab`): node `i12`'s prompt said "implement
// nano-supervisor#12 and open a PR … that closes it", but the body only described one of #12's
// three acceptance criteria. The agent did exactly that and wrote `Closes #12` in BOTH the PR body
// and the commit body. The convergence scope gate blocked, but a human still had to file the
// follow-up and rewrite the PR. The defect was in planning: a node scoped narrower than its issue
// must not be told to close it. The repo squash-merges with `COMMIT_MESSAGES`, so a `Closes #N` in a
// commit body closes the issue on merge even after the PR body is corrected — so the agent contract,
// the planner, and the scope gate must all reason about commit bodies, not just the PR body.
//
// These are prompt CONTRACTS (not code paths): the planner (`plan.md`), the implementation agent
// (`feature.md`), and the scope gate (`scope-classify.md`) are all prompt-driven. This test pins the
// guidance so a future prompt edit cannot silently drop the guard that closes this failure class.
import { test } from "node:test";
import { assert } from "#test-assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROMPTS_DIR = join(import.meta.dirname, "..", "resources", "prompts");
const read = (name: string): string => readFileSync(join(PROMPTS_DIR, name), "utf8");

// The GitHub closing keywords, as the gate/agent must recognise them. A "closing keyword" in prose
// is any of these; a non-closing ref (`Part of`, `Refs`, `Follow-up`) is explicitly NOT.
const CLOSING_KEYWORDS = ["close", "fix", "resolve"];

// The closing-keyword SYNTAX each prompt must document for EVERY verb family — the canonical
// instruction triplet `Closes/Fixes/Resolves` (or the inflected `close/closes/closed …
// fix/fixes/fixed … resolve/resolves/resolved` listing). Asserting the syntax (not a bare
// `includes("fix")`, which passes for unrelated reasons) means dropping a family from a contract —
// e.g. removing `Fixes` — turns the test red instead of leaving it green.
const CLOSING_SYNTAX = [
  /closes?\/fixes?\/resolves?/i,
  /close\/closes\/closed[\s\S]*fix\/fixes\/fixed[\s\S]*resolve\/resolves\/resolved/i,
];

test("feature.md: the closing-keyword rule covers COMMIT MESSAGES, not just the PR body", () => {
  const feature = read("feature.md").toLowerCase();
  // The agent contract must tell the agent a closing keyword in a commit body closes the issue on
  // merge (the COMMIT_MESSAGES squash concern), so a partial slice must write `Part of #N` in both.
  assert(
    feature.includes("commit messages") || feature.includes("commit body") || feature.includes("commit bodies"),
    "feature.md must tie the closing-keyword rule to commit messages/bodies",
  );
  assert(feature.includes("commit_messages"), "feature.md must name the COMMIT_MESSAGES squash behaviour");
});

test("plan.md: a partial slice must not be told to close its broader-scoped parent issue", () => {
  const plan = read("plan.md");
  const lower = plan.toLowerCase();
  // The decomposition step must carry explicit closing-keyword guidance for split issues.
  assert(lower.includes("closing keyword"), "plan.md must discuss closing keywords for slices");
  // A full-scope requirement must gate a closing keyword, and a partial slice must use `Part of #N`.
  assert(lower.includes("full"), "plan.md must require FULL scope before a slice closes an issue");
  assert(plan.includes("Part of #N"), "plan.md must steer a partial slice to `Part of #N`");
  // The planner guidance must also reach commit messages (the COMMIT_MESSAGES squash concern).
  assert(lower.includes("commit_messages") || lower.includes("commit bod"), "plan.md must cover commit bodies");
});

test("scope-classify.md: the scope gate scans COMMIT bodies for closing keywords too", () => {
  const gate = read("scope-classify.md");
  const lower = gate.toLowerCase();
  // The gate must read the PR's commits (not only its body) for closing keywords.
  assert(lower.includes("commit"), "scope-classify.md must mention commits");
  assert(
    lower.includes("--json commits") || lower.includes("git log") || lower.includes("commit bod") || lower.includes("commit message"),
    "scope-classify.md must instruct reading commit bodies/messages",
  );
  // It must explain WHY: the COMMIT_MESSAGES squash carries a commit-body closing keyword to merge.
  assert(lower.includes("commit_messages"), "scope-classify.md must name the COMMIT_MESSAGES squash behaviour");
});

test("all three prompts recognise the full set of GitHub closing keywords", () => {
  for (const name of ["feature.md", "plan.md", "scope-classify.md"]) {
    const lower = read(name).toLowerCase();
    for (const kw of CLOSING_KEYWORDS) {
      assert(lower.includes(kw), `${name} must reference the closing keyword family "${kw}"`);
    }
  }
});

// Stronger than the substring check above: pin the closing-keyword SYNTAX in each prompt, so a future
// edit that drops a verb family from the contract (e.g. `Closes/Resolves` with `Fixes` removed) fails
// loudly instead of staying green because the word "fix" still appears somewhere unrelated.
test("all three prompts document the closing-keyword SYNTAX for every verb family (close/fix/resolve)", () => {
  for (const name of ["feature.md", "plan.md", "scope-classify.md"]) {
    const text = read(name);
    assert(
      CLOSING_SYNTAX.some((re) => re.test(text)),
      `${name} must document the Closes/Fixes/Resolves closing-keyword triplet (or the inflected ` +
        `close/closes/closed … listing), not merely the bare substrings`,
    );
    assert(
      /\bcloses?\s+#(?:n|\d)/i.test(text),
      `${name} must show the actionable \`Closes #N\` instruction form`,
    );
  }
});
