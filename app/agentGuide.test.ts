// Tests for the addressable operator guide (epic #605 slice S5, issue #611): the stable section
// registry, the fence-aware markdown splitter, the table of contents, and per-section rendering.
// The drift guard here is the load-bearing test — it fails the build if the authored guide
// (`docs/agent-guide.md`) grows/loses a `## ` section without a matching `GUIDE_SECTIONS` entry, so
// the addressable surface can never silently diverge from the prose.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import {
  GUIDE_SECTIONS,
  guideToc,
  renderAgentGuide,
  renderGuideSection,
  splitGuideSections,
} from "./agentGuide.ts";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RAW_GUIDE = readFileSync(join(REPO_ROOT, "docs", "agent-guide.md"), "utf8");

test("DRIFT GUARD: every `## ` section in docs/agent-guide.md has exactly one registry entry", () => {
  const { sections } = splitGuideSections(RAW_GUIDE);
  assertEquals(
    sections.length,
    GUIDE_SECTIONS.length,
    `docs/agent-guide.md has ${sections.length} top-level sections but GUIDE_SECTIONS lists ` +
      `${GUIDE_SECTIONS.length}. Add/remove a { id, summary } entry so the addressable surface ` +
      "matches the prose.",
  );
});

test("section ids are unique and non-empty; summaries are non-empty", () => {
  const ids = new Set<string>();
  for (const s of GUIDE_SECTIONS) {
    assert(s.id.length > 0, "section id must be non-empty");
    assert(!ids.has(s.id), `duplicate section id "${s.id}"`);
    ids.add(s.id);
    assert(s.summary.trim().length > 0, `section "${s.id}" needs a one-line summary`);
  }
});

test("the fence-aware splitter ignores `## ` inside fenced code blocks", () => {
  const raw = [
    "# Title",
    "",
    "## 0. Real heading",
    "body",
    "```",
    "## not a heading (inside a fence)",
    "```",
    "more body",
    "## 1. Second heading",
    "tail",
  ].join("\n");
  const { sections } = splitGuideSections(raw);
  assertEquals(sections.length, 2);
  assertEquals(sections[0].title, "0. Real heading");
  assert(sections[0].body.includes("## not a heading"), "fenced content stays in its section body");
  assertEquals(sections[1].title, "1. Second heading");
});

test("guideToc lists every registry id with a derived title and its summary", () => {
  const toc = guideToc();
  assertEquals(toc.length, GUIDE_SECTIONS.length);
  for (let i = 0; i < toc.length; i++) {
    assertEquals(toc[i].id, GUIDE_SECTIONS[i].id);
    assertEquals(toc[i].summary, GUIDE_SECTIONS[i].summary);
    assert(toc[i].title.length > 0, `toc[${i}] must carry the derived heading title`);
  }
  // The TOC is compact by construction — comfortably under any tool-result limit.
  assert(JSON.stringify(toc).length < 4000, "the table of contents must stay small");
});

test("delivery-graphs is addressable, smaller than the full guide, and base-keyed", () => {
  const base = "https://example.test/app/api";
  const section = renderGuideSection("delivery-graphs", base);
  assert(section !== undefined, "delivery-graphs must resolve");
  const full = renderAgentGuide(base);
  assert(section!.length > 0);
  assert(section!.length < full.length, "a single section must be smaller than the whole guide");
  assert(section!.length < 30000, "the delivery-graphs section must fit a typical tool-result budget");
  assert(!section!.includes("__BASE__"), "placeholders must be substituted in a section render");
  assert(!section!.includes("__ENGINE__"), "engine placeholder must be substituted too");
});

test("a compact section is a small fraction of the whole guide", () => {
  const base = "https://example.test/app/api";
  const orient = renderGuideSection("orient", base)!;
  const full = renderAgentGuide(base);
  assert(orient.length < full.length / 10, "the orient section must be a small fraction of the guide");
});

test("every registry id resolves to a non-empty section whose heading matches its title", () => {
  const base = "https://example.test/app/api";
  const toc = guideToc();
  for (const { id, title } of toc) {
    const md = renderGuideSection(id, base);
    assert(md !== undefined, `section "${id}" must resolve`);
    assert(md!.startsWith(`## ${title}`), `section "${id}" body must open with its heading`);
  }
});

test("an unknown section id resolves to undefined (the op turns that into a 400)", () => {
  assertEquals(renderGuideSection("does-not-exist", "https://x/app/api"), undefined);
});

test("no content regression: each section body is a verbatim slice of the raw guide", () => {
  // Rendering keys examples to an instance; the UN-substituted section bodies must be exact
  // substrings of the authored doc, so the addressable surface never rewrites guide content.
  const { sections } = splitGuideSections(RAW_GUIDE);
  for (const s of sections) {
    assert(RAW_GUIDE.includes(s.body), `section "${s.title}" must be a verbatim slice of the guide`);
  }
});
