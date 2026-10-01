// #840 — selectable themes: `pages/app.js` (theme registry + picker) and `pages/app.css` (the rules),
// shipped by urban's app-asset convention (nano-ide#578).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Comments stripped: rules only (the header comment describes the attribute generically).
const css = readFileSync("pages/app.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

async function themes() {
  return await import("../pages/app.js");
}

test("#840: the theme registry offers classic (default), soft and cartoon", async () => {
  const { THEMES, DEFAULT_THEME } = await themes();
  assert.deepEqual(
    THEMES.map((t: { id: string }) => t.id),
    ["classic", "soft", "cartoon"],
  );
  assert.equal(DEFAULT_THEME, "classic");
});

test("#840: every non-default theme in the registry has rules in app.css (no phantom theme)", async () => {
  const { THEMES, DEFAULT_THEME } = await themes();
  for (const t of THEMES) {
    if (t.id === DEFAULT_THEME) continue;
    assert.ok(css.includes(`[data-nwf-theme="${t.id}"]`), `app.css has no rules for theme "${t.id}"`);
  }
});

test("#840: app.css only styles themes the registry knows (no orphan rules)", async () => {
  const { THEMES } = await themes();
  const known = new Set(THEMES.map((t: { id: string }) => t.id));
  for (const m of css.matchAll(/data-nwf-theme="([^"]+)"/g)) {
    assert.ok(known.has(m[1]), `app.css styles unknown theme "${m[1]}"`);
  }
});

test("#840: theme token overrides are !important so they survive the console's inline :root tokens", () => {
  for (const decl of css.matchAll(/(--nano-[a-z0-9-]+):\s*([^;]+);/g)) {
    assert.match(decl[2], /!important\s*$/, `${decl[1]} override must be !important`);
  }
});

test("#840: resolveTheme falls back to the default for unknown/blank values", async () => {
  const { resolveTheme } = await themes();
  assert.equal(resolveTheme("cartoon"), "cartoon");
  assert.equal(resolveTheme("soft"), "soft");
  assert.equal(resolveTheme("nope"), "classic");
  assert.equal(resolveTheme(null), "classic");
});

test("#840: applyTheme stamps <html data-nwf-theme> and loads the theme's font once", async () => {
  const { applyTheme } = await themes();
  const appended: Array<{ id: string; href: string }> = [];
  const byId = new Map<string, unknown>();
  const doc = {
    documentElement: { dataset: {} as Record<string, string> },
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: () => ({ id: "", rel: "", href: "" }),
    head: {
      appendChild: (n: { id: string; href: string }) => {
        appended.push(n);
        byId.set(n.id, n);
      },
    },
  };
  assert.equal(applyTheme(doc, "cartoon"), "cartoon");
  assert.equal(doc.documentElement.dataset.nwfTheme, "cartoon");
  applyTheme(doc, "cartoon");
  assert.equal(appended.length, 1, "font link is added once");
  assert.match(appended[0].href, /Fredoka/);
  assert.equal(applyTheme(doc, "bogus"), "classic");
  assert.equal(doc.documentElement.dataset.nwfTheme, "classic");
});
