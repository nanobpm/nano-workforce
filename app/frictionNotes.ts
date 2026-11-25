// The ONE shared friction-notes prompt paragraph (issue #1101). Every agent prompt carries it: the
// hand-authored `resources/prompts/*.md` get it materialised between the FRICTION_NOTES markers by
// `npm run sync:prompt-fragments` (drift-guarded by scripts/sync-prompt-fragments.test.ts, like the nav),
// and every compiled delivery-graph agent cell (prompt-less) gets it via its runtime `appendPrompt`
// (app/deliveryRunner.ts). Edit it HERE only — never in a prompt file.
//
// The shape it describes is `AgentFrictionNote` in app/friction.ts; `surface` is one of FIX_SURFACES.
import { FIX_SURFACES } from "./friction.ts";

export const FRICTION_NOTES_BEGIN = "<!-- friction-notes:begin -->";
export const FRICTION_NOTES_END = "<!-- friction-notes:end -->";

/** The paragraph body (markdown), without markers. */
export const FRICTION_NOTES_PROMPT = [
  "## Friction notes (optional result field)",
  "",
  "Keep brief friction notes as you go; report them in `friction`. Friction = time lost fighting the",
  "environment, docs or tooling, not the task's inherent difficulty. Empty is fine.",
  "",
  "Add them to the SAME result JSON you already write (no extra turn) as an optional top-level array:",
  "`\"friction\": [{ \"what\": \"…\", \"turnsLost\": 3, \"surface\": \"AGENTS.md\", \"suggestedFix\": \"…\", \"targetRepo\": \"owner/repo\" }]`",
  `— \`what\` and \`surface\` are required; \`surface\` is one of ${FIX_SURFACES.map((s) => `\`${s}\``).join(", ")}.`,
  "Be honest and concrete (a misleading doc you followed, a missing instruction you had to work out, a",
  "tool that fought you); omit `friction` entirely when there was none. Never put secrets in it.",
].join("\n");

/** The marked block as materialised into a prompt file. */
export function frictionNotesBlock(): string {
  return `${FRICTION_NOTES_BEGIN}\n${FRICTION_NOTES_PROMPT}\n${FRICTION_NOTES_END}`;
}

/** Materialise the block into one prompt's text: replace an existing marked block in place, or append
 *  it at the end. Idempotent. */
export function withFrictionNotes(md: string): string {
  const block = frictionNotesBlock();
  const b = md.indexOf(FRICTION_NOTES_BEGIN);
  const e = md.indexOf(FRICTION_NOTES_END);
  if (b >= 0 && e > b) return md.slice(0, b) + block + md.slice(e + FRICTION_NOTES_END.length);
  return `${md.replace(/\s*$/, "")}\n\n${block}\n`;
}

/** The runtime-`appendPrompt` form (owns its leading rule; `appendPrompt` injects no separator). */
export function renderFrictionNotes(): string {
  return `\n\n---\n\n${FRICTION_NOTES_PROMPT}\n`;
}
