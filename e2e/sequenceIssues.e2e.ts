// `sequenceIssues` intent-door regression net (epic #605 slice S4, issue #610).
//
// PINS the acceptance guarantees over the REAL runtime-served `/app/mcp` surface:
//   • the door is PROJECTED as an MCP tool whose input schema is self-contained ($ref-free, explicit
//     type) — an agent can discover + call it from a standard client (S0 invariant);
//   • an object-body intent arrives AS AN OBJECT (not stringified), stages a delivery graph, and the
//     staged digest is immediately visible via `listStagedProposals` (compile+stage reuse, S2);
//   • the response carries NO dispatch handle — the door STAGES, never dispatches (operator-only);
//   • invalid input (empty `issues`, an unparseable ref) is rejected with `issues[{path,message}]`.
//
// It is RUNNABLE VIA THE SLICE S1 HARNESS (`e2e/support/mcp-harness.ts`): it imports `bootMcpHarness`
// and the shared assertion helpers and drives the exact client handshake an agent uses — it does NOT
// re-implement the transport (see the harness module header's EXTENSION SEAM).
//
// Run with `npm run e2e`.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  assertObjectBodyAccepted,
  assertSchemaSelfContained,
  assertValidationIssues,
  bootMcpHarness,
  type McpHarness,
} from "./support/mcp-harness.ts";

const TOOL = "sequenceIssues";

interface ListBody { count: number; proposals: Array<{ digest: string; title: string | null }> }

/** The current live staged list, read over the SAME MCP surface. */
async function listStaged(h: McpHarness): Promise<ListBody> {
  const res = await h.callTool("listStagedProposals", {});
  assert.ok(!res.isError, `listStagedProposals must not error: ${res.text}`);
  const json = res.json as ListBody | undefined;
  assert.ok(json && Array.isArray(json.proposals), `listStagedProposals must return a proposals array: ${res.text}`);
  return json;
}

describe("S4 — sequenceIssues generates + stages the canonical chain over MCP (#610)", () => {
  let h: McpHarness;
  before(async () => { h = await bootMcpHarness(); });
  after(async () => { await h.stop(); });

  test("the tool is projected with a self-contained ($ref-free, typed) input schema", async () => {
    const tools = await h.listTools();
    const tool = tools.find((t) => t.name === TOOL);
    assert.ok(tool, `${TOOL} must be projected onto the MCP surface`);
    assertSchemaSelfContained(tool.inputSchema, TOOL);
    // Dispatch is operator-only — the dispatch door must NOT be projected.
    assert.ok(!tools.some((t) => t.name === "dispatchDeliveryGraph"), "dispatch stays off the agent surface");
  });

  test("a valid intent object stages the canonical graph — the staged digest is immediately listed", async () => {
    const res = await h.callTool(TOOL, {
      body: { behind: "acme/repo#100", issues: ["acme/repo#1", "acme/repo#2", "acme/repo#3"] },
    });
    assertObjectBodyAccepted(res, TOOL); // the object argument arrived as an object, not a string
    assert.ok(!res.isError, `${TOOL} must stage a valid intent: ${res.text}`);
    const json = res.json as { status?: string; digest?: string; preview?: unknown } | undefined;
    assert.equal(json?.status, "ready", `${TOOL} must report status:"ready": ${res.text}`);
    assert.ok(typeof json?.digest === "string" && json.digest.length > 0, `a staged digest is required: ${res.text}`);
    assert.ok(json?.preview && typeof json.preview === "object", `a preview is required: ${res.text}`);

    // Read-after-write: the staged digest is visible immediately (shared compile+stage path, S2).
    const list = await listStaged(h);
    assert.ok(
      list.proposals.some((p) => p.digest === json.digest),
      `the staged digest ${json.digest} must appear in listStagedProposals immediately (got ${JSON.stringify(list.proposals.map((p) => p.digest))})`,
    );

    // The door STAGES, never dispatches — no run handle in the response.
    for (const forbidden of ["runKey", "token", "approvalToken", "processInstanceKey", "processKey", "dispatchUrl"]) {
      assert.ok(!(forbidden in (json as Record<string, unknown>)), `response must not carry a dispatch handle (${forbidden})`);
    }
  });

  test("empty issues is rejected with the uniform issues[{path,message}] contract — nothing staged", async () => {
    const before = (await listStaged(h)).proposals.length;
    const res = await h.callTool(TOOL, { body: { issues: [] } });
    // A tool-level door 4xx: the object arrived (not stringified) AND carries issues[{path,message}].
    assertValidationIssues(res, TOOL);
    assert.equal((await listStaged(h)).proposals.length, before, "a rejected intent must stage nothing");
  });

  test("an unparseable issue ref is rejected at the offending path", async () => {
    const res = await h.callTool(TOOL, { body: { issues: ["acme/repo#1", "not-an-issue"] } });
    assertValidationIssues(res, TOOL);
    const json = res.json as { issues?: Array<{ path?: string }> };
    assert.ok(
      json.issues?.some((i) => i.path === "issues[1]"),
      `the offending index must be path-qualified (got ${JSON.stringify(json.issues)})`,
    );
  });
});
