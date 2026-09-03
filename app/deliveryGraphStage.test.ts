// Regression coverage for the compile+stage HOT PATH (issue #716, split from #715 gap 4).
//
// THE FAILURE MODE
// ================
// `compileDeliveryGraph` and `sequenceIssues` (the agent-facing MCP tools) both route through
// `compileAndStageDeliveryGraph`, which USED to run the full compiler — including the CPU-bound
// `layoutBpmn` (`bpmn-auto-layout`) diagram-interchange pass. That layout is superlinear in
// node/edge count: on a large/dense graph (the issue cites up to 256 nodes / 1024 edges) it takes
// MINUTES, so a cold MCP `tools/call` blew past the client's per-call timeout and returned
// `-32001 Request timed out` — which (per #715) then poisoned the stateful MCP session.
//
// THE FIX
// =======
// Staging needs only the content DIGEST, the mermaid `diagram`, and the resolved model — NOT the
// laid-out `bpmn`. The digest is now taken over the deterministic SEMANTIC BPMN (the DI is derived
// from it), so `compileAndStageDeliveryGraph` uses the layout-free `compileDeliveryGraphSemantic`
// and returns in milliseconds. The expensive `layoutBpmn` is deferred to the OPERATOR's
// preview/dispatch (`previewProposalBpmn` / `dispatchDeliveryGraph`) — cockpit actions, not
// timeout-bound MCP calls.
//
// These tests pin BOTH halves of the fix so it cannot regress:
//   1. `compileDeliveryGraphSemantic` is layout-free (no `bpmn`, no `bpmndi:` in `semanticBpmn`) and
//      content-addresses IDENTICALLY to the full compile — so staging and dispatch/preview agree.
//   2. `compileAndStageDeliveryGraph` on a LARGE/DENSE graph completes fast (a bound the old
//      layout-on-the-hot-path could never meet) and stages a live proposal whose `digest` is the
//      SEMANTIC digest (not the laid-out one) — the structural signature of the fast path.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";
import { compileDeliveryGraph, compileDeliveryGraphSemantic } from "./deliveryGraphCompiler.ts";
import { getStagedProposal } from "./deliveryGraphProposals.ts";
import { compileAndStageDeliveryGraph } from "./deliveryGraphStage.ts";
import { deliveryGraphDigest } from "./deliveryRunner.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");

/** A large, DENSE delivery graph — `n` agent nodes, each edged from its `fan` predecessors. At
 * `n=256, fan=4` this is ~1020 edges: the exact class the issue names, and one `layoutBpmn` takes
 * MINUTES on. The semantic compile of the same graph is ~40ms, so the fast path clears any sane
 * timing bound by three orders of magnitude. */
function denseGraph(n: number, fan: number): { name: string; nodes: unknown[]; edges: unknown[] } {
  const nodes: unknown[] = [];
  const edges: unknown[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push({ id: `n${i}`, kind: "agent", agent: { jobType: "senior:feature", prompt: `task ${i}` } });
  }
  for (let i = 1; i < n; i++) {
    for (let f = 1; f <= fan && i - f >= 0; f++) edges.push({ from: `n${i - f}`, to: `n${i}` });
  }
  return { name: "dense bench", nodes, edges };
}

describe("compileDeliveryGraphSemantic — the layout-free compile", () => {
  test("produces a DI-less semantic BPMN and NO laid-out bpmn", async () => {
    const g = denseGraph(8, 2);
    const semantic = await compileDeliveryGraphSemantic(g);
    assert(semantic.ok, "a well-formed graph compiles semantically");
    assert(!("bpmn" in semantic), "the layout-free result carries no laid-out `bpmn`");
    assert(
      !semantic.semanticBpmn.includes("bpmndi:"),
      "the semantic BPMN carries no diagram interchange (that is the layout the fast path skips)",
    );
    assert(semantic.semanticBpmn.includes("<bpmn:process"), "it is still a real BPMN process definition");
  });

  test("content-addresses IDENTICALLY to the full compile (staging and dispatch agree)", async () => {
    const g = denseGraph(6, 2);
    const semantic = await compileDeliveryGraphSemantic(g);
    const full = await compileDeliveryGraph(g);
    assert(semantic.ok && full.ok, "both compiles succeed");
    // The full compile exposes the SAME semanticBpmn (it layers DI on top), and the digest is taken
    // over that — so the fast (stage) path and the full (preview/dispatch) path never drift on how a
    // graph is addressed.
    assert.equal(full.semanticBpmn, semantic.semanticBpmn, "full compile reuses the semantic BPMN verbatim");
    assert.equal(
      deliveryGraphDigest(semantic.semanticBpmn),
      deliveryGraphDigest(full.semanticBpmn),
      "the content digest matches across the fast and full paths",
    );
    // Sanity: the laid-out bytes genuinely differ from the semantic bytes (DI was attached), so a
    // digest taken over the laid-out `bpmn` would be a DIFFERENT value — the thing the fix moves away
    // from.
    assert.notEqual(full.bpmn, full.semanticBpmn, "the laid-out bpmn differs from the semantic bpmn");
    assert.notEqual(
      deliveryGraphDigest(full.bpmn),
      deliveryGraphDigest(full.semanticBpmn),
      "the semantic digest is distinct from the (old) laid-out digest",
    );
  });
});

describe("compileAndStageDeliveryGraph — the agent-facing hot path does not run layout", () => {
  const dirs: string[] = [];
  const apps: TestApp[] = [];
  let app: TestApp;
  before(async () => {
    const d = mkdtempSync(join(tmpdir(), "nwf-stage-hotpath-"));
    dirs.push(d);
    app = await bootTestApp(APP_ROOT, {
      env: { NANO_PR_GITHUB_TRANSPORT: "token", GITHUB_TOKEN: "", NANO_APP_DB_URL: `file:${join(d, "app.db")}` },
    });
    apps.push(app);
  });
  after(async () => {
    for (const a of apps) await a.stop?.();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  test("stages a 256-node / ~1020-edge graph FAST and content-addresses it by its SEMANTIC digest", async () => {
    const g = denseGraph(256, 4);
    assert(g.edges.length > 1000, "the fixture really is dense (the layout-heavy class)");

    const graphJson = JSON.stringify(g);
    const started = performance.now();
    const staged = await compileAndStageDeliveryGraph(app.db, g, graphJson, "http://example.test");
    const elapsedMs = performance.now() - started;

    assert(staged.ok, "the dense graph stages successfully");
    assert.equal(staged.status, 200);
    // The whole point of #716: the hot path must NOT run `layoutBpmn` (minutes on this graph). The
    // layout-free semantic compile is ~40ms; a 20s bound is a 500x margin over the passing path and a
    // 6x margin UNDER the failing (layout) path, so it separates them without flaking.
    assert(
      elapsedMs < 20_000,
      `staging a dense graph must not pay the layout tax — took ${elapsedMs.toFixed(0)}ms (a layout would take minutes)`,
    );

    // The staged proposal is content-addressed by the SEMANTIC digest — the structural signature of
    // the fast path. Before the fix it was the laid-out-bpmn digest (a different value), so this
    // assertion is red on the old behaviour and green on the new one.
    const semantic = await compileDeliveryGraphSemantic(g);
    assert(semantic.ok);
    const semanticDigest = deliveryGraphDigest(semantic.semanticBpmn);
    assert.equal(staged.digest, semanticDigest, "staged proposal is addressed by its semantic digest");

    // …and it is actually persisted as a live, dispatchable staged proposal (the operator can find it
    // and drive the — deferred — layout at preview/dispatch time).
    const live = await getStagedProposal(app.db, staged.digest);
    assert(live, "the staged proposal is live in the store");
    assert.equal(live.node_count, 256);
  });
});
