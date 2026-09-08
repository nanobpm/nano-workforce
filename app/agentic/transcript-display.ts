// nano-workforce — the ordered DISPLAY projection, DERIVED from its one owner (agentic #566).
//
// Sibling of `transcript-events.ts`: where that barrel re-exports the transcript EVENT grammar (the one
// parser + fold), THIS barrel re-exports the canonical ordered DISPLAY derivation — the projection that
// coalesces transport-fragmented message deltas back into logical blocks and interleaves them
// chronologically with tool cards and permission prompts (`createDisplayProjection` / `deriveDisplay`).
// The cockpit renders THIS instead of the raw per-event groups, so a split word reconstructs into one
// block and text/tool/permission order never scrambles.
//
// Why a SEPARATE barrel rather than folding these into `transcript-events.ts`: the browser bundle
// (`scripts/build-cockpit-browser.ts`) emits one generated ESM sibling per agentic source module, and
// the display projection lives in agentic's own `dist/transcript/display.js` — a self-contained,
// browser-safe module distinct from `events.js`. Keeping the display import on its own specifier lets
// the bundle rewrite it to `./transcript-display.js` (agentic's display module) while the event import
// still rewrites to `./transcript-events.js`. Both remain thin re-exports of the ONE agentic source of
// truth — there is no local display algorithm here (Derivation Over Duplication).
export { createDisplayProjection, deriveDisplay } from "@nanobpm/agentic/transcript";
