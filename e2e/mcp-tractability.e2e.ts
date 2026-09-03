// Tractable-surface + heavy-tool budget guards (#715 gaps 2 & 4).
//
// WHAT THIS PINS
// ==============
// Gap 2 — the projected `/app/mcp` `tools/list` surface measures 56 tools / ~79 KB against the
// deployed instance (issue #715): large enough that an agent harness DEFERS the whole set behind a
// tool-search gate, and a client `"tools": ["*"]` imports all of it eagerly. Two workforce-visible
// guards keep it tractable, both derived from the ONE source of truth (`app/mcpToolSurface.ts`):
//
//   • a BUDGET on the full surface (count + serialized bytes) so it can only shrink below the pinned
//     ceilings — a fat new door that re-inflates it fails the build here;
//   • a CURATED subset (`CURATED_MCP_TOOLS`) a client imports instead of `["*"]` — asserted to be
//     materially smaller than the full surface AND to consist only of names that actually project,
//     so the recommended allowlist can never point at a dead/renamed tool.
//
// Gap 4 — a cold heavy tool (synchronous BPMN layout: `previewDeliveryGraph` / `compileDeliveryGraph`)
// must complete well within a typical MCP client's per-call timeout, so a cold `tools/call` no longer
// `-32001`s (which then trips gap 1 by poisoning the session). Asserted against `HEAVY_TOOL_BUDGET_MS`.
//
// The full object-body / schema-self-containment contract (gap 3, nano-ide#501/#503) is pinned by the
// sibling `e2e/mcp-surface.e2e.ts`; this file adds only the tractability + latency dimensions.
//
// Run with `npm run e2e`.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  CURATED_MCP_TOOLS,
  CURATED_MCP_TOOLS_BUDGET,
  HEAVY_TOOL_BUDGET_MS,
  MCP_SURFACE_BYTES_BUDGET,
  MCP_TOOL_COUNT_BUDGET,
} from "../app/mcpToolSurface.ts";
import { bootMcpHarness, type McpHarness, type McpTool } from "./support/mcp-harness.ts";

describe("#715 gaps 2 & 4 — tractable MCP surface + heavy-tool latency budget", () => {
  let h: McpHarness;
  let tools: McpTool[];
  before(async () => {
    h = await bootMcpHarness();
    tools = await h.listTools();
  });
  after(async () => {
    await h.stop();
  });

  test("the full tools/list stays within the pinned count budget", () => {
    assert(
      tools.length <= MCP_TOOL_COUNT_BUDGET,
      `projected MCP tool count ${tools.length} exceeds the budget ${MCP_TOOL_COUNT_BUDGET} — the ` +
        `surface must not grow past the harness deferral point (issue #715). Either curate a door off ` +
        `the surface (x-mcp) or, if this growth is intended, raise MCP_TOOL_COUNT_BUDGET deliberately ` +
        `in app/mcpToolSurface.ts. Tools: ${tools.map((t) => t.name).sort().join(", ")}`,
    );
  });

  test("the full tools/list stays within the pinned byte budget", () => {
    const bytes = Buffer.byteLength(JSON.stringify(tools), "utf8");
    assert(
      bytes <= MCP_SURFACE_BYTES_BUDGET,
      `serialized tools/list is ${bytes} bytes, over the budget ${MCP_SURFACE_BYTES_BUDGET} — a fat ` +
        `new schema is re-inflating the surface (issue #715). Trim the schema, curate the door off, or ` +
        `raise MCP_SURFACE_BYTES_BUDGET deliberately in app/mcpToolSurface.ts.`,
    );
  });

  test("every curated tool actually projects onto the live surface (no dead allowlist entries)", () => {
    const live = new Set(tools.map((t) => t.name));
    const dead = CURATED_MCP_TOOLS.filter((name) => !live.has(name));
    assert.deepEqual(
      dead,
      [],
      `CURATED_MCP_TOOLS names ${JSON.stringify(dead)} do not project onto the live /app/mcp surface — ` +
        `the recommended allowlist has drifted from the real tool set. Fix app/mcpToolSurface.ts.`,
    );
  });

  test("the curated subset is materially smaller than the full surface (tractable import)", () => {
    assert(
      CURATED_MCP_TOOLS.length <= CURATED_MCP_TOOLS_BUDGET,
      `the curated subset (${CURATED_MCP_TOOLS.length}) exceeds its budget ${CURATED_MCP_TOOLS_BUDGET} — ` +
        `it is creeping back toward "*". Keep it to the tools an agent actually drives/reads.`,
    );
    assert(
      CURATED_MCP_TOOLS.length < tools.length,
      `the curated subset (${CURATED_MCP_TOOLS.length}) must be smaller than the full surface ` +
        `(${tools.length}); otherwise importing it buys nothing over "*".`,
    );
  });

  test("curated entries carry no duplicates", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const name of CURATED_MCP_TOOLS) {
      if (seen.has(name)) dupes.push(name);
      seen.add(name);
    }
    assert.deepEqual(dupes, [], `CURATED_MCP_TOOLS has duplicate entries: ${JSON.stringify(dupes)}`);
  });

  test("a cold heavy tool (previewDeliveryGraph) completes within the client budget — no -32001", async () => {
    // A minimal valid graph → real synchronous BPMN layout, the exact heavy path issue #715 saw
    // time out cold. Pure door (nothing staged), so this is safe and repeatable.
    const graphJson = JSON.stringify({ nodes: [{ id: "h", kind: "human" }] });
    const t0 = Date.now();
    const res = await h.callTool("previewDeliveryGraph", { body: { graphJson } });
    const elapsed = Date.now() - t0;
    assert(!res.isError, `previewDeliveryGraph should succeed on a valid graph: ${res.text}`);
    assert(
      elapsed <= HEAVY_TOOL_BUDGET_MS,
      `cold previewDeliveryGraph took ${elapsed}ms, over the client budget ${HEAVY_TOOL_BUDGET_MS}ms — ` +
        `a heavy synchronous door this slow risks the client -32001 that poisons the session (issue #715).`,
    );
  });
});
