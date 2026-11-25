// Materialise shared agent-prompt fragments into every `resources/prompts/*.md` (issue #1101).
//
// The friction-notes paragraph is authored ONCE in app/frictionNotes.ts and written between its
// markers into each prompt (the deployed prompts are standalone linked resources, so the text must be
// IN each file). `scripts/sync-prompt-fragments.test.ts` (under `npm test`) is the drift guard.
//
//   node --experimental-strip-types scripts/sync-prompt-fragments.ts          # write prompts
//   node --experimental-strip-types scripts/sync-prompt-fragments.ts --check  # verify (CI)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { withFrictionNotes } from "../app/frictionNotes.ts";

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);
export const PROMPTS_DIR = `${ROOT}resources/prompts`;

/** Every prompt file whose materialised text differs from its current text. */
export function staleFragmentFiles(): { file: string; next: string }[] {
  const out: { file: string; next: string }[] = [];
  for (const name of readdirSync(PROMPTS_DIR).filter((f) => f.endsWith(".md")).sort()) {
    const file = `${PROMPTS_DIR}/${name}`;
    const cur = readFileSync(file, "utf8");
    const next = withFrictionNotes(cur);
    if (next !== cur) out.push({ file, next });
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stale = staleFragmentFiles();
  if (process.argv.includes("--check")) {
    if (stale.length > 0) {
      console.error(`prompt fragments out of date (run \`npm run sync:prompt-fragments\`):\n${stale.map((s) => `  ${s.file}`).join("\n")}`);
      process.exit(1);
    }
    console.log("prompt fragments: in sync");
  } else {
    for (const s of stale) writeFileSync(s.file, s.next);
    console.log(`prompt fragments: updated ${stale.length} file(s)`);
  }
}
