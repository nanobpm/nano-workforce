// Authoring guard for the curated MCP tool subset (`app/mcpToolSurface.ts`, issue #715).
//
// The curated `CURATED_MCP_TOOLS` allowlist is the tractable subset a client imports instead of
// `["*"]`. `e2e/mcp-tractability.e2e.ts` proves every entry projects onto the LIVE surface, but that
// needs a booted instance. This fast unit guard checks the same list against the SAME framework
// walker the runtime MCP projector uses (`parseSpec` + `collectOperations`) so an authoring typo —
// a curated app-tool name that is not an `openapi.yaml` operationId, or one accidentally `x-mcp`-
// excluded — fails CI in `npm test` without booting anything. Framework `urban_debug_*` tools are
// not `openapi.yaml` operations, so they are validated by their reserved prefix instead.
//
// Derivation over duplication (AGENTS.md): the exclusion/projection rule is NOT re-implemented here —
// it is read from the framework walker's `mcpExcluded` flag, the exact rule the runtime honours.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { collectOperations, parseSpec } from "@nanobpm/urban/toolkit";
import { CURATED_MCP_TOOLS, FRAMEWORK_TOOL_PREFIX } from "../app/mcpToolSurface.ts";
import { assert } from "#test-assert";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SPEC_PATH = join(REPO_ROOT, "openapi.yaml");

function projectedAppTools(): Set<string> {
  return new Set(
    collectOperations(parseSpec(readFileSync(SPEC_PATH, "utf8")))
      .filter((op) => !op.mcpExcluded)
      .map((op) => op.operationId),
  );
}

test("every curated APP tool is a projected (non-x-mcp) openapi operation", () => {
  const projected = projectedAppTools();
  for (const name of CURATED_MCP_TOOLS) {
    if (name.startsWith(FRAMEWORK_TOOL_PREFIX)) continue; // framework tool — validated by prefix below
    assert(
      projected.has(name),
      `curated tool "${name}" is not a projected openapi operation — it is missing from openapi.yaml ` +
        `or has been x-mcp-excluded. A client importing the curated allowlist would silently not get it.`,
    );
  }
});

test("every curated FRAMEWORK tool carries the reserved urban_debug_ prefix", () => {
  const projected = projectedAppTools();
  for (const name of CURATED_MCP_TOOLS) {
    if (!name.startsWith(FRAMEWORK_TOOL_PREFIX)) continue;
    // A framework name must NOT also be an app operationId (that would be a namespace collision the
    // runtime reserves against) — it is owned entirely by the runtime's engine-debug family.
    assert(
      !projected.has(name),
      `curated framework tool "${name}" unexpectedly collides with an openapi operationId.`,
    );
  }
});

test("the curated subset has no duplicate entries", () => {
  const seen = new Set<string>();
  for (const name of CURATED_MCP_TOOLS) {
    assert(!seen.has(name), `CURATED_MCP_TOOLS lists "${name}" more than once.`);
    seen.add(name);
  }
});
