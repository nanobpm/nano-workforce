// Tests for GET /app/api/agent/guide → operation `getAgentGuide` (epic #605 slice S5, issue #611):
// the addressable operator guide. No `section` → a compact table of contents; `section=<id>` → just
// that section; an unknown id → 400 with `issues[{path,message}]`. Mirrors the getAgentInstructions
// test's request shape and shared-secret guard pattern.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import { GUIDE_SECTIONS } from "../app/agentGuide.ts";
import handler from "./getAgentGuide.ts";

const app = { log: noopLog() } as any as AppApi;

function input(query: Record<string, string> = {}, headers: Record<string, string> = {}) {
  return {
    req: {
      method: "GET",
      path: "/app/api/agent/guide",
      query: new URLSearchParams(query),
      headers: new Headers(headers),
      text: async () => "",
    } as any,
    params: {},
    query,
    body: undefined,
  };
}

test("no section → the table of contents, one entry per registry section", async () => {
  const r = (await handler(input(), app)) as any;
  assertEquals(r.status, 200);
  assertEquals(r.body.kind, "toc");
  assert(typeof r.body.baseUrl === "string" && r.body.baseUrl.length > 0);
  assert(Array.isArray(r.body.sections));
  assertEquals(r.body.sections.length, GUIDE_SECTIONS.length);
  const ids = r.body.sections.map((s: any) => s.id);
  for (const s of GUIDE_SECTIONS) assert(ids.includes(s.id), `TOC must list "${s.id}"`);
  for (const s of r.body.sections) {
    assert(typeof s.title === "string" && s.title.length > 0);
    assert(typeof s.summary === "string" && s.summary.length > 0);
  }
});

test("the TOC is far smaller than the full guide (fits a tool-result limit)", async () => {
  const r = (await handler(input(), app)) as any;
  assert(JSON.stringify(r.body).length < 4000, "the TOC response must stay compact");
});

test("section=delivery-graphs → just that section's markdown, base-keyed", async () => {
  const r = (await handler(input({ section: "delivery-graphs" }), app)) as any;
  assertEquals(r.status, 200);
  assertEquals(r.body.kind, "section");
  assertEquals(r.body.section.id, "delivery-graphs");
  assertEquals(r.body.section.format, "markdown");
  assert(r.body.section.instructions.length > 200);
  assert(!r.body.section.instructions.includes("__BASE__"), "placeholders must be substituted");
  assert(typeof r.body.engineBase === "string" && r.body.engineBase.length > 0);
});

test("a section is much smaller than the whole guide", async () => {
  const toc = (await handler(input(), app)) as any;
  const section = (await handler(input({ section: "orient" }), app)) as any;
  assert(
    JSON.stringify(section.body).length < 30000,
    "a single section must comfortably fit a typical tool-result limit",
  );
  assertEquals(toc.body.kind, "toc");
});

test("an unknown section id → 400 with issues[{path,message}] listing valid ids", async () => {
  const r = (await handler(input({ section: "nope" }), app)) as any;
  assertEquals(r.status, 400);
  assert(typeof r.body.error === "string");
  assert(Array.isArray(r.body.issues) && r.body.issues.length === 1);
  assertEquals(r.body.issues[0].path, "section");
  assert(r.body.issues[0].message.includes("delivery-graphs"), "the 400 must name the valid ids");
});

test("blank/whitespace section is treated as no section (TOC)", async () => {
  const r = (await handler(input({ section: "  " }), app)) as any;
  assertEquals(r.status, 200);
  assertEquals(r.body.kind, "toc");
});

test("a pagination cursor beyond MAX_SAFE_INTEGER → 400 (unsafe integers lose precision)", async () => {
  // 9007199254740993 === 9007199254740992 in IEEE-754 double, so `Number.isInteger` accepts it
  // while it no longer represents the caller's requested character offset. It must be rejected.
  const unsafe = "9007199254740993";
  const rStart = (await handler(input({ section: "delivery-graphs", start: unsafe }), app)) as any;
  assertEquals(rStart.status, 400);
  assert(Array.isArray(rStart.body.issues) && rStart.body.issues.some((i: any) => i.path === "start"));

  const rLength = (await handler(input({ section: "delivery-graphs", length: unsafe }), app)) as any;
  assertEquals(rLength.status, 400);
  assert(Array.isArray(rLength.body.issues) && rLength.body.issues.some((i: any) => i.path === "length"));
});

test("shared-secret guard: rejects when the secret is set and header is wrong", async () => {
  const prev = process.env.NANO_PR_WEBHOOK_SECRET;
  process.env.NANO_PR_WEBHOOK_SECRET = "s3cr3t";
  try {
    // Re-import with the secret set so the module-level SECRET picks it up.
    const mod = await import(`./getAgentGuide.ts?secret=${Date.now()}`);
    const guarded = mod.default;
    const rejected = (await guarded(input({}, {}), app)) as any;
    assertEquals(rejected.status, 401);
    const ok = (await guarded(input({}, { "x-hook-secret": "s3cr3t" }), app)) as any;
    assertEquals(ok.status, 200);
  } finally {
    if (prev === undefined) delete process.env.NANO_PR_WEBHOOK_SECRET;
    else process.env.NANO_PR_WEBHOOK_SECRET = prev;
  }
});
