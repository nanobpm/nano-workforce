// Delivery-graph read-after-write regression net (epic #605 slice S2, issue #608).
//
// PINS the acceptance guarantee: immediately after `compileDeliveryGraph` returns a staged `digest`,
// `listStagedProposals` returns THAT digest — with NO intervening delay. In the evidence session
// (issue #608) a `compileDeliveryGraph` that returned `status:"ready"` with `digest:"ca8fb90a1b0c"`
// was followed by a `listStagedProposals` that answered `{"count":0,"proposals":[]}` — the read and
// the write had disagreed, so an agent could not confirm its own staging. The fix serves both from a
// single source of truth: the read (`listStagedProposals` / `getStagedProposal`, unified through the
// one `isLiveStaged` predicate) queries the SAME `delivery_graph_proposals` store, in the SAME scope,
// that the compile/stage write commits to — no read-model or cache in between.
//
// This case is RUNNABLE VIA THE SLICE S1 HARNESS (`e2e/support/mcp-harness.ts`): it imports
// `bootMcpHarness` and drives the REAL runtime-served `/app/mcp` surface over the client handshake —
// the exact transport an agent uses — so a regression that reintroduces the disagreement (a lagging
// projection, a divergent read filter, a supersede that drops the just-written row) fails the build.
// It does NOT re-implement the handshake (see the harness module header's EXTENSION SEAM).
//
// Run with `npm run e2e`.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { assertObjectBodyAccepted, bootMcpHarness, type McpHarness } from "./support/mcp-harness.ts";

/** A minimal side-effecting graph — `compileDeliveryGraph` STAGES it (unlike the pure `previewDelivery
 *  Graph`), which is exactly the write whose visibility we verify. Two agent nodes → two side effects. */
const STAGES_A_PROPOSAL = {
  name: "S2 read-after-write A",
  nodes: [
    { id: "open", kind: "agent", agent: { jobType: "senior:demo", prompt: "un-draft + merge #B" } },
    { id: "cut", kind: "agent", agent: { jobType: "senior:demo", prompt: "cut the release" } },
  ],
  edges: [{ from: "open", to: "cut" }],
};

/** A dedicated logical key for the supersede test, distinct from the first test's key so the case is
 *  SELF-CONTAINED — it stages BOTH its own V1 and V2 in-test and asserts per-logical-key, rather than
 *  depending on an earlier test having staged a predecessor. */
const SUPERSEDE_KEY = "S2 supersede key";

/** V1 for the supersede test — the predecessor that staging V2 must retire. */
const SUPERSEDE_V1 = {
  name: SUPERSEDE_KEY,
  nodes: [
    { id: "open", kind: "agent", agent: { jobType: "senior:demo", prompt: "un-draft + merge #B" } },
    { id: "cut", kind: "agent", agent: { jobType: "senior:demo", prompt: "cut the release" } },
  ],
  edges: [{ from: "open", to: "cut" }],
};

/** V2 — a STRUCTURALLY different graph (an extra node → different compiled BPMN → different content
 *  digest) sharing the SAME `name` (logical key) as V1, so staging it supersedes V1. The read after it
 *  must show the SECOND digest (the one the compile just returned), never the superseded first. */
const SUPERSEDE_V2 = {
  name: SUPERSEDE_KEY,
  nodes: [
    { id: "open", kind: "agent", agent: { jobType: "senior:demo", prompt: "un-draft + merge #B" } },
    { id: "notes", kind: "agent", agent: { jobType: "senior:demo", prompt: "draft the release notes" } },
    { id: "cut", kind: "agent", agent: { jobType: "senior:demo", prompt: "cut the release" } },
  ],
  edges: [
    { from: "open", to: "notes" },
    { from: "notes", to: "cut" },
  ],
};

interface StagedRow { digest: string; title: string | null }
interface ListBody { count: number; proposals: StagedRow[] }

/** Compile a graph over MCP and return the staged digest the door reports (asserting it staged). */
async function compileAndStage(h: McpHarness, graph: unknown): Promise<string> {
  const res = await h.callTool("compileDeliveryGraph", { body: graph });
  assertObjectBodyAccepted(res, "compileDeliveryGraph"); // the object body was NOT stringified
  assert.ok(!res.isError, `compileDeliveryGraph must stage a valid graph: ${res.text}`);
  const json = res.json as { status?: string; digest?: string } | undefined;
  assert.equal(json?.status, "ready", `compileDeliveryGraph must report status:"ready": ${res.text}`);
  assert.ok(typeof json?.digest === "string" && json.digest.length > 0, `a staged digest is required: ${res.text}`);
  return json.digest;
}

/** The current live staged list, read over the SAME MCP surface. */
async function listStaged(h: McpHarness): Promise<ListBody> {
  const res = await h.callTool("listStagedProposals", {});
  assert.ok(!res.isError, `listStagedProposals must not error: ${res.text}`);
  const json = res.json as ListBody | undefined;
  assert.ok(json && Array.isArray(json.proposals), `listStagedProposals must return a proposals array: ${res.text}`);
  return json;
}

describe("S2 — listStagedProposals read-after-write is trustworthy (#608)", () => {
  let h: McpHarness;
  before(async () => { h = await bootMcpHarness(); });
  after(async () => { await h.stop(); });

  test("a digest compileDeliveryGraph just returned is listed on the very next call — no delay", async () => {
    const digest = await compileAndStage(h, STAGES_A_PROPOSAL);
    // The immediate read — no sleep, no retry, no poll — must show the write.
    const list = await listStaged(h);
    const digests = list.proposals.map((p) => p.digest);
    assert.ok(
      digests.includes(digest),
      `the digest ${digest} compileDeliveryGraph just returned must appear in listStagedProposals ` +
        `immediately (got ${JSON.stringify(digests)})`,
    );
  });

  test("supersede keeps read-after-write honest: the read shows the LATEST returned digest, not the superseded one", async () => {
    // SELF-CONTAINED: stage V1 then V2 for the SAME logical key inside this test — V2 supersedes V1. The
    // read must reflect the digest THIS compile returned (the live one) and the superseded predecessor
    // must be gone, with no dependence on any other test having staged first.
    const digestV1 = await compileAndStage(h, SUPERSEDE_V1);
    const digestV2 = await compileAndStage(h, SUPERSEDE_V2);
    assert.notEqual(digestV1, digestV2, "V1 and V2 must differ in content so V2 genuinely supersedes V1");
    const list = await listStaged(h);
    const digests = list.proposals.map((p) => p.digest);
    assert.ok(
      digests.includes(digestV2),
      `after superseding, listStagedProposals must show the latest digest ${digestV2} (got ${JSON.stringify(digests)})`,
    );
    assert.ok(
      !digests.includes(digestV1),
      `the superseded predecessor digest ${digestV1} must be gone from listStagedProposals (got ${JSON.stringify(digests)})`,
    );
    // Exactly one live proposal FOR THIS logical key — filter by title so the assertion is per-logical-key
    // and does not couple to how many other proposals exist in the shared store.
    const forLogicalKey = list.proposals.filter((p) => p.title === SUPERSEDE_KEY);
    assert.equal(
      forLogicalKey.length,
      1,
      `exactly one live staged proposal must remain for the logical key ${JSON.stringify(SUPERSEDE_KEY)} (got ${JSON.stringify(forLogicalKey.map((p) => p.digest))})`,
    );
    assert.equal(forLogicalKey[0]?.digest, digestV2, "the sole remaining live proposal must be the latest digest");
  });
});
