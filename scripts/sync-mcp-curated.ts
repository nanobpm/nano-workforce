// Render the curated MCP tool allowlist (`CURATED_MCP_TOOLS`, app/mcpToolSurface.ts) into the runbook
// (docs/mcp-runbook.md) between its `curated-tools` sentinels (issue #715).
//
// The curated `"tools"` allowlist an MCP client imports instead of `["*"]` (the tractable-surface
// subset) is authored ONCE in `app/mcpToolSurface.ts`. The runbook shows it as a copyable JSON block;
// this script derives that block from the source so the two can never drift (AGENTS.md "no drift
// surfaces"), mirroring the repo's other derive/verify pairs (sync-nav, inline-mcp-bodies, layout-bpmn).
//
//   node --experimental-strip-types scripts/sync-mcp-curated.ts          # write the runbook block
//   node --experimental-strip-types scripts/sync-mcp-curated.ts --check  # verify (CI) — non-zero on drift
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { CURATED_MCP_TOOLS } from "../app/mcpToolSurface.ts";

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);
export const RUNBOOK_PATH = `${ROOT}docs/mcp-runbook.md`;

const BEGIN = "<!-- BEGIN GENERATED: curated-tools (npm run sync:mcp-curated) -->";
const END = "<!-- END GENERATED: curated-tools -->";

/** The generated block: a fenced JSON `"tools"` array, one tool per line, in authored order. */
export function renderBlock(): string {
  const lines = CURATED_MCP_TOOLS.map((name, i) => {
    const comma = i === CURATED_MCP_TOOLS.length - 1 ? "" : ",";
    return `  ${JSON.stringify(name)}${comma}`;
  });
  return ["```json", '"tools": [', ...lines, "]", "```"].join("\n");
}

export function replaceBetweenSentinels(source: string, block: string): string {
  const begin = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      `docs/mcp-runbook.md is missing the curated-tools sentinels (${BEGIN} … ${END}). ` +
        "Restore them so the generated block has a home.",
    );
  }
  const before = source.slice(0, begin + BEGIN.length);
  const after = source.slice(end);
  return `${before}\n${block}\n${after}`;
}

/** The runbook content the generator WOULD write given its current on-disk state. */
export function reconciledRunbook(): { current: string; next: string } {
  const current = readFileSync(RUNBOOK_PATH, "utf8");
  return { current, next: replaceBetweenSentinels(current, renderBlock()) };
}

function main(): void {
  const check = process.argv.includes("--check");
  const { current, next } = reconciledRunbook();

  if (check) {
    if (current !== next) {
      console.error(
        "docs/mcp-runbook.md curated-tools block is STALE vs app/mcpToolSurface.ts. " +
          "Run `npm run sync:mcp-curated` and commit the result.",
      );
      process.exit(1);
    }
    console.log("sync:mcp-curated: runbook curated-tools block is up to date.");
    return;
  }
  if (current !== next) {
    writeFileSync(RUNBOOK_PATH, next);
    console.log("sync:mcp-curated: wrote curated-tools block into docs/mcp-runbook.md.");
  } else {
    console.log("sync:mcp-curated: runbook curated-tools block already up to date.");
  }
}

// Run as a CLI only when invoked directly (not when imported by the drift test).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
