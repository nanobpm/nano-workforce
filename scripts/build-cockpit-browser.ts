// Build step (#660): emit the browser-consumable ESM of the typed transcript derive+render core so the
// deployed cockpit adapter (`pages/cockpit/mount.js`) can RENDER the agentic transcript from the SAME
// source of truth the Node/TypeScript core and its tests use — instead of hand-copying the derive
// logic (the drift surface that made the Worker terminal dump raw `nwfTranscriptEvent` JSON).
//
// The app has no bundler, so the browser cannot import the `.ts` core directly. Rather than duplicate
// the parse→derive→render path by hand in `mount.js` again, we DERIVE the browser bundle from the ONE
// typed source: each module is transpiled (type-strip only — no second implementation) to plain ESM
// under `pages/cockpit/generated/`, which `mount.js` imports. A drift-guard test regenerates in memory
// and asserts the committed output is byte-identical, so the generated files can never silently drift
// from their `.ts` origin (Derivation Over Duplication).
//
// Run `node --experimental-strip-types scripts/build-cockpit-browser.ts` to (re)generate, or
// `… --check` to fail if the committed output is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** One typed core module → its generated browser-ESM sibling, with any relative import specifiers rewritten. */
interface BundleModule {
  /** Source `.ts`, repo-relative. */
  readonly src: string;
  /** Emitted `.js`, repo-relative (under pages/ so the browser serves it beside mount.js). */
  readonly out: string;
  /** Literal import-specifier rewrites applied to the emitted JS (`.ts` core path → generated `.js` sibling). */
  readonly rewrites?: ReadonlyArray<readonly [from: string, to: string]>;
}

// The transcript RENDER path the browser needs is a two-module graph, both pure + DOM-agnostic:
//   transcript-events.ts   — the ONE parser + derive() fold (no runtime imports).
//   transcript-derive.ts   — renderDerivedTranscript(): message turns, tool/diff cards, permission prompts.
// Their only non-type imports are between each other; every type-only import (DocumentLike, ElementLike,
// TranscriptDataReport) is `import type` and is erased on transpile, so the emitted JS is import-clean.
const MODULES: readonly BundleModule[] = [
  { src: "app/agentic/transcript-events.ts", out: "pages/cockpit/generated/transcript-events.js" },
  {
    src: "app/agentic/cockpit/transcript-derive.ts",
    out: "pages/cockpit/generated/transcript-derive.js",
    rewrites: [["../transcript-events.ts", "./transcript-events.js"]],
  },
];

function banner(src: string): string {
  return [
    `// @generated from ${src} by scripts/build-cockpit-browser.ts — DO NOT EDIT.`,
    "//",
    "// Browser ESM derived (type-strip only) from the typed transcript core so pages/cockpit/mount.js",
    "// renders the agentic transcript from ONE source of truth (#660). Regenerate with:",
    "//   node --experimental-strip-types scripts/build-cockpit-browser.ts",
    "",
    "",
  ].join("\n");
}

function transpile(src: string): string {
  const source = readFileSync(resolve(repoRoot, src), "utf8");
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
      removeComments: false,
    },
    fileName: src,
  });
  return result.outputText;
}

/** Generate the browser bundle in memory — the single source both the writer and the drift-guard test use. */
export function cockpitBrowserBundle(): ReadonlyArray<{ readonly out: string; readonly content: string }> {
  return MODULES.map((mod) => {
    let content = transpile(mod.src);
    for (const [from, to] of mod.rewrites ?? []) {
      content = content.split(from).join(to);
    }
    return { out: mod.out, content: banner(mod.src) + content };
  });
}

function main(): void {
  const check = process.argv.includes("--check");
  let stale = false;
  for (const { out, content } of cockpitBrowserBundle()) {
    const path = resolve(repoRoot, out);
    if (check) {
      let current: string | undefined;
      try {
        current = readFileSync(path, "utf8");
      } catch {
        current = undefined;
      }
      if (current !== content) {
        stale = true;
        console.error(`✗ ${out} is stale — run: node --experimental-strip-types scripts/build-cockpit-browser.ts`);
      }
    } else {
      writeFileSync(path, content);
      console.log(`✓ wrote ${out}`);
    }
  }
  if (check && stale) process.exit(1);
  if (check) console.log("✓ cockpit browser bundle is up to date");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
