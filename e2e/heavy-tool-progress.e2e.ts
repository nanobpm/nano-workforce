// Heavy-tool timeout regression over the REAL runtime-served `/app/mcp` surface (issue #716, split
// from #715 gap 4).
//
// The agent-facing `compileDeliveryGraph` tool used to run the CPU-bound `layoutBpmn` pass inline, so
// a cold call on a large/dense graph (the issue cites up to 256 nodes / 1024 edges) blew past the
// client's per-call MCP timeout and returned `-32001 Request timed out` — poisoning the session (#715).
// The fix stages on a layout-free fast path (the digest is taken over the deterministic semantic BPMN;
// the expensive layout is deferred to the operator's preview/dispatch).
//
// This drives the exact client handshake an agent uses (via the S1 harness) and asserts a large graph
// gets an IMMEDIATE accepted `status:"ready"` staged response — not a timeout — and that the staged
// digest is immediately visible over the same surface. It does NOT re-implement the transport (see the
// harness header's EXTENSION SEAM).
//
// Run with `npm run e2e`.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { assertObjectBodyAccepted, bootMcpHarness, type McpHarness } from "./support/mcp-harness.ts";

const TOOL = "compileDeliveryGraph";

/** A large, DENSE delivery graph — `n` agent nodes, each edged from its `fan` predecessors. At
 * `n=256, fan=4` that is ~1020 edges: the exact class the issue names, and one `layoutBpmn` takes
 * MINUTES on. The layout-free stage path compiles it in tens of milliseconds. */
function denseGraph(n: number, fan: number): { name: string; nodes: unknown[]; edges: unknown[] } {
  const nodes: unknown[] = [];
  const edges: unknown[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push({ id: `n${i}`, kind: "agent", agent: { jobType: "senior:feature", prompt: `task ${i}` } });
  }
  for (let i = 1; i < n; i++) {
    for (let f = 1; f <= fan && i - f >= 0; f++) edges.push({ from: `n${i - f}`, to: `n${i}` });
  }
  return { name: "dense mcp bench", nodes, edges };
}

interface ListBody {
  count: number;
  proposals: Array<{ digest: string; title: string | null }>;
}

describe("#716 — a heavy compile/stage tool returns an accepted response (not a timeout) over MCP", () => {
  let h: McpHarness;
  before(async () => {
    h = await bootMcpHarness();
  });
  after(async () => {
    await h.stop();
  });

  test("a cold, large/dense compileDeliveryGraph call stages FAST rather than timing out", async () => {
    const graph = denseGraph(256, 4);
    assert.ok(graph.edges.length > 1000, "the fixture really is dense (the layout-heavy class)");

    const started = performance.now();
    const res = await h.callTool(TOOL, { body: graph });
    const elapsedMs = performance.now() - started;

    // The object body arrived as an object (S0 invariant) and the call SUCCEEDED (a real client would
    // have timed out with -32001 on the old layout-inline path).
    assertObjectBodyAccepted(res, TOOL);
    assert.ok(!res.isError, `${TOOL} on a large graph must stage, not error/time out: ${res.text}`);

    const json = res.json as { status?: string; digest?: string; reviewUrl?: string } | undefined;
    assert.equal(json?.status, "ready", `${TOOL} must return an accepted staged response: ${res.text}`);
    assert.ok(typeof json?.digest === "string" && json.digest.length > 0, "the staged response carries a digest");

    // The whole point of #716: the tool must not pay the layout tax (minutes on this graph). The
    // layout-free path is tens of ms; a 20s bound is a huge margin over the passing path and well under
    // the failing (layout) path, so it separates them without flaking.
    assert.ok(
      elapsedMs < 20_000,
      `a heavy tool must return promptly — took ${elapsedMs.toFixed(0)}ms (an inline layout would take minutes)`,
    );

    // The staged proposal is immediately observable over the SAME surface — the operator can find it
    // and drive the (deferred) layout at preview/dispatch time.
    const list = await h.callTool("listStagedProposals", {});
    assert.ok(!list.isError, `listStagedProposals must not error: ${list.text}`);
    const listed = list.json as ListBody | undefined;
    assert.ok(
      listed?.proposals?.some((p) => p.digest === json?.digest),
      `the staged digest ${json?.digest} must be listed: ${list.text}`,
    );
  });
});
