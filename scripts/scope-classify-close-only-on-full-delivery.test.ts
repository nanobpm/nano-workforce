// Prompt contract for issue #1108: the scope classifier must not let a linked follow-up excuse a
// closing keyword on a partial delivery, must honour only an OPERATOR's escalation answer, and must
// not pass an uncertain verdict when the PR auto-merges with no human approval.
//
// Field case: nanobpm/nano-bpm PR 1984 delivered ~1/4 of nanobpm/nano-bpm#1960, linked
// `Follow-up: #1983`, said `Closes #1960`, claimed "MVP scope agreed on escalation" (answered by an
// agent), and auto-merged. Each of the three rules below was an exemption the classifier followed.
// These assertions pin the rule text so a future prompt edit cannot silently bring the exemption back.
import { test } from "node:test";
import { assert } from "#test-assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const prompt = readFileSync(join(import.meta.dirname, "..", "resources", "prompts", "scope-classify.md"), "utf8");
const flat = prompt.replace(/\s+/g, " ");

test("#1108: a tracked follow-up does not exempt a closing keyword on a partial delivery", () => {
  assert(/close only on full delivery/i.test(flat), "the prompt must state 'close only on full delivery'");
  assert(
    /EVEN WHEN the remainder is tracked by a filed, linked follow-up/.test(flat),
    "the block rule must apply even when the remainder is tracked",
  );
  assert(flat.includes("`Closes #N` → `Part of #N`"), "the block reason must ask for Closes → Part of");
  // The old blanket exemption ("The deferred remainder **is** tracked") must be gone.
  assert(!/The deferred remainder \*\*is\*\* tracked/.test(flat), "the tracked-remainder exemption must not come back");
  assert(!/Block \*\*only\*\* when/.test(flat), "the old 'block only when untracked' rule must not come back");
});

test("#1108: the real exemptions survive (full delivery, non-goals, scope tooling as subject)", () => {
  assert(/\*\*fully delivers\*\* the closed issue/.test(flat), "full delivery + mentions of future work passes");
  assert(/explicit non-goal/.test(flat), "explicit non-goals stay exempt");
  assert(/mentions or describes\*\* deferral\/scope as its subject matter/.test(flat), "scope tooling as subject stays exempt");
});

test("#1108: a rewordable block is routed to the fix loop (scopeRewordable)", () => {
  assert(flat.includes("`scopeRewordable: true`"), "the prompt must define scopeRewordable");
  assert(/routes this back to the fix loop/.test(flat), "a rewordable block goes back to the fix agent, not a human");
});

test("#1108: only an operator-answered escalation is authoritative (scopeAnsweredBy)", () => {
  assert(flat.includes("`scopeAnsweredBy`"), "the classifier must read scopeAnsweredBy");
  assert(/only an operator's/i.test(flat), "the honour rule must be restricted to operators");
  assert(/\*\*not an operator decision\*\*/.test(flat), "an agent/unknown answer must be called out as not an operator decision");
  assert(/must still require `Part of #N` \(not `Closes #N`\)/.test(flat), "an agent answer still requires Part of");
  assert(!/a human already ruled/i.test(flat), "the old 'any answer is a human ruling' text must not come back");
});

test("#1108: no pass-when-unsure under autoMerge", () => {
  assert(/No pass-when-unsure under autoMerge/.test(flat), "the rule heading must be present");
  assert(flat.includes("`scopeUncertain: true`"), "an uncertain verdict must be flagged scopeUncertain");
  assert(!/prefer \*\*`scopeBlocked: false`\*\* with a `scopeBlockReason` explaining the uncertainty/i.test(flat), "the old prefer-pass-when-unsure rule must not come back");
  assert(!/a human still reviews the merge\)/.test(flat), "the false 'a human still reviews the merge' rationale must not come back");
});
