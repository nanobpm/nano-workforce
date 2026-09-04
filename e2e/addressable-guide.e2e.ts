// Addressable operator-guide regression net (epic #605 slice S5, issue #611).
//
// Drives the app's REAL runtime-served MCP endpoint (`/app/mcp`, ADR 0067) via the reusable
// `e2e/support/mcp-harness.ts` module (slice S1, #607) — it does NOT re-implement the handshake.
// It PINS the addressable-guide contract from a client's point of view:
//
//   • `getAgentGuide` is projected with a `$ref`-free, explicitly-typed input schema (S0 invariant);
//   • no argument → a compact table of contents listing every stable section id + summary, small
//     enough to fit a typical tool-result limit;
//   • `section=<id>` → ONLY that section, far smaller than the whole guide (the defect this fixes:
//     `getAgentInstructions` returns ~43KB that overran the limit);
//   • an unknown id → a uniform `issues[{path,message}]` validation error;
//   • the full-guide fallback door (`getAgentInstructions`) is UNCHANGED — still the whole guide.
//
// Run with `npm run e2e`.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { assertSchemaSelfContained, bootMcpHarness, type McpHarness } from "./support/mcp-harness.ts";

describe("S5 — the addressable operator guide over MCP (#611)", () => {
  let h: McpHarness;
  before(async () => {
    h = await bootMcpHarness();
  });
  after(async () => {
    await h.stop();
  });

  test("getAgentGuide is projected with a self-contained, explicitly-typed input schema", async () => {
    const tools = await h.listTools();
    const tool = tools.find((t) => t.name === "getAgentGuide");
    assert(tool, "getAgentGuide must be projected onto the MCP surface");
    assertSchemaSelfContained(tool!.inputSchema, "getAgentGuide");
    const props = (tool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    const section = props.section as { type?: string } | undefined;
    assert(section, "getAgentGuide must expose a `section` argument");
    assert.equal(section!.type, "string", "`section` must be an explicitly-typed string");
  });

  test("no argument returns a compact table of contents with every section id", async () => {
    const res = await h.callTool("getAgentGuide", {});
    assert(!res.isError, `getAgentGuide (TOC) must not error: ${res.text}`);
    const body = res.json as { kind?: string; sections?: { id: string; title: string; summary: string }[] };
    assert.equal(body.kind, "toc");
    assert(Array.isArray(body.sections) && body.sections.length > 0, "the TOC must list sections");
    const ids = body.sections!.map((s) => s.id);
    for (const id of ["orient", "submit-pr", "submit-epic", "escalations", "delivery-graphs"]) {
      assert(ids.includes(id), `the TOC must list "${id}"`);
    }
    for (const s of body.sections!) {
      assert(s.title.length > 0 && s.summary.length > 0, `TOC entry "${s.id}" needs a title + summary`);
    }
    // The whole point: the TOC is tiny relative to the ~43KB monolith.
    assert(res.text.length < 4000, "the TOC must fit comfortably under a tool-result limit");
  });

  test("section=delivery-graphs returns ONLY that section, under a typical result budget", async () => {
    const res = await h.callTool("getAgentGuide", { section: "delivery-graphs" });
    assert(!res.isError, `getAgentGuide(delivery-graphs) must not error: ${res.text}`);
    const body = res.json as { kind?: string; section?: { id: string; instructions: string } };
    assert.equal(body.kind, "section");
    assert.equal(body.section?.id, "delivery-graphs");
    assert(body.section!.instructions.length > 200, "the section must carry real content");
    assert(!body.section!.instructions.includes("__BASE__"), "placeholders must be substituted");

    // It must be smaller than the full guide the fallback door still serves — a proper subset.
    const full = await h.callTool("getAgentInstructions", {});
    assert(res.text.length < full.text.length, "one section must be smaller than the whole guide");
    assert(res.text.length < 30000, "one section must fit a typical tool-result budget in a single call");
  });

  test("section pagination: start/length pages a section and nextStart walks it to completion (#740)", async () => {
    const whole = await h.callTool("getAgentGuide", { section: "delivery-graphs" });
    const wholeSection = (whole.json as { section?: { instructions: string } }).section!;
    const wholeChars = Array.from(wholeSection.instructions);

    const PAGE = 4000;
    let start = 0;
    let assembled = "";
    let pages = 0;
    let total = -1;
    for (;;) {
      const res = await h.callTool("getAgentGuide", { section: "delivery-graphs", start, length: PAGE });
      assert(!res.isError, `a paged fetch must not error: ${res.text}`);
      const body = res.json as {
        kind?: string;
        section?: { id: string; instructions: string; start: number; length: number; totalLength: number; nextStart: number | null };
      };
      assert.equal(body.kind, "section");
      const s = body.section!;
      assert.equal(s.id, "delivery-graphs");
      assert(Array.from(s.instructions).length <= PAGE, "a page must be bounded by `length`");
      assert.equal(s.start, start);
      if (total !== -1) assert.equal(s.totalLength, total, "totalLength is stable across pages");
      total = s.totalLength;
      assembled += s.instructions;
      pages++;
      if (s.nextStart === null) break;
      start = s.nextStart;
      assert(pages < 100, "pagination must terminate");
    }
    assert(pages > 1, "a large section must span multiple pages at this window");
    assert.equal(total, wholeChars.length, "totalLength equals the full section length");
    assert.equal(assembled, wholeSection.instructions, "the reassembled pages equal the whole section");
  });

  test("section pagination: a non-integer/negative start is a uniform issues[{path,message}] 400 (#740)", async () => {
    const res = await h.callTool("getAgentGuide", { section: "delivery-graphs", start: -5 });
    assert(res.isError, "an invalid pagination arg must surface as a tool-level error");
    const body = res.json as { issues?: { path: string; message: string }[] };
    assert(Array.isArray(body.issues) && body.issues.length >= 1, "must answer with issues[]");
    assert(body.issues!.some((i) => i.path.includes("start")), "the issue must name the `start` argument");
  });

  test("an unknown section id is rejected with issues[{path,message}]", async () => {    const res = await h.callTool("getAgentGuide", { section: "no-such-section" });
    assert(res.isError, "an unknown section id must surface as a tool-level error");
    const body = res.json as { issues?: { path: string; message: string }[] };
    assert(Array.isArray(body.issues) && body.issues.length >= 1, "must answer with issues[]");
    assert.equal(body.issues![0].path, "section");
  });

  test("the full-guide fallback door is unchanged — still the whole guide", async () => {
    const res = await h.callTool("getAgentInstructions", {});
    assert(!res.isError, `getAgentInstructions must still answer: ${res.text}`);
    const body = res.json as { instructions?: string };
    assert(typeof body.instructions === "string", "getAgentInstructions still returns the full guide");
    // The monolith still contains a section the addressable tool now carves out — no content regression.
    assert(body.instructions!.includes("delivery graph"), "the full guide still contains every section");
    assert(body.instructions!.length > 10000, "the full guide door is unshrunk");
  });
});
