// Regression guard for issues #279 and #467: the cockpit renders empty when its default supply /
// transcript endpoints don't resolve to the app's `/app/api/agentic/…` root.
//
// The cockpit shell (embed.html / standalone.html) — and therefore mount.js — is served ONE DIRECTORY
// DEEP under `/cockpit/` on every surface:
//   • standalone / local urban-SPA App-View: `<origin>/cockpit/mount.js`
//   • Studio console App-View (proxied):      `<console>/console/app-view/<AppName>/cockpit/mount.js`
// while the API is served at the app root, a sibling of `/cockpit/`: `<appMount>/app/api/agentic/…`.
//
// #279 (first attempt) used ABSOLUTE (leading-slash) defaults, which through Studio resolved against
// the console ORIGIN (:8080) not the app-view base → 404. The base-relative fix that followed traded
// that for a subtler bug (#467): a document-base-relative default resolves against the `…/cockpit/`
// shell base to `…/cockpit/app/api/agentic/supply` → 404 on ALL surfaces. The earlier guard hid this
// by resolving against the app-view/app ROOT (dropping the real `/cockpit/` segment the shell is
// served under), so it validated a base the browser never actually uses.
//
// The correct default is anchored to mount.js's OWN url (import.meta.url), i.e. `../app/api/agentic/…`
// relative to `<appMount>/cockpit/mount.js`, which resolves to `<appMount>/app/api/agentic/…` on every
// surface regardless of the document base. This test pins that resolution against the REAL, `/cockpit/`
// -deep module url so neither the absolute-path (#279) nor the base-relative (#467) regression can return.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { readFileSync } from "node:fs";

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);
const MOUNT_JS = readFileSync(`${ROOT}pages/cockpit/mount.js`, "utf8");
const EMBED_HTML = readFileSync(`${ROOT}pages/cockpit/embed.html`, "utf8");

// Pull the module-relative default spec out of
// `const <name> = opts.<name> ?? new URL("<spec>", import.meta.url).href;` in mount.js.
function defaultSpec(name: string): string {
  const m = MOUNT_JS.match(
    new RegExp(`opts\\.${name}\\s*\\?\\?\\s*new URL\\(\\s*"([^"]*)"\\s*,\\s*import\\.meta\\.url\\s*\\)\\s*\\.href`),
  );
  assert(
    m,
    `mount.js must default opts.${name} to new URL("<spec>", import.meta.url) so the endpoint is ` +
      `anchored to the module's own served location, not the document base (#467)`,
  );
  return m![1];
}

// The REAL served location of mount.js on each surface: one directory deep under `/cockpit/`.
const STANDALONE_MOUNT = "http://127.0.0.1:3000/cockpit/mount.js";
const STUDIO_MOUNT = "http://studio-host:8080/console/app-view/Workforce/cockpit/mount.js";

for (const [name, endpoint] of [
  ["reportUrl", "app/api/agentic/supply"],
  ["transcriptsUrl", "app/api/agentic/transcripts"],
] as const) {
  test(`#467: default ${name} is module-anchored (relative to import.meta.url, not the document base)`, () => {
    const spec = defaultSpec(name);
    assert(
      !spec.startsWith("/"),
      `default ${name} spec "${spec}" must not be absolute: a leading-slash path resolves against ` +
        `the iframe ORIGIN (console :8080), not the app-view base, so every fetch 404s (#279)`,
    );
    assert(
      spec.startsWith("../"),
      `default ${name} spec "${spec}" must step up out of /cockpit/ (import.meta.url points at ` +
        `<appMount>/cockpit/mount.js; the API is a sibling at <appMount>/app/api/…) (#467)`,
    );
  });

  test(`#467: default ${name} resolves to the app root standalone (not under /cockpit/)`, () => {
    const spec = defaultSpec(name);
    assertEquals(
      new URL(spec, STANDALONE_MOUNT).href,
      `http://127.0.0.1:3000/${endpoint}`,
      `default ${name} must resolve to the app root, not the /cockpit/ shell base (#467)`,
    );
  });

  test(`#467: default ${name} resolves onto the app-view base inside the Studio iframe`, () => {
    const spec = defaultSpec(name);
    assertEquals(
      new URL(spec, STUDIO_MOUNT).href,
      `http://studio-host:8080/console/app-view/Workforce/${endpoint}`,
      `default ${name} must resolve under the app-view base the console proxies, not the console ` +
        `origin root (#279) nor the /cockpit/ shell base (#467)`,
    );
  });
}

test("#279: embed.html forwards BOTH reportUrl and transcriptsUrl from the injected config", () => {
  // embed.html previously forwarded only reportUrl, so even if the console injected endpoint config
  // the transcripts panel kept its default. Both must be forwarded.
  assert(
    /transcriptsUrl:\s*cfg\.transcriptsUrl/.test(EMBED_HTML),
    "embed.html must forward transcriptsUrl: cfg.transcriptsUrl so the injected config reaches the past-sessions panel (#279)",
  );
  assert(
    /reportUrl:\s*cfg\.reportUrl/.test(EMBED_HTML),
    "embed.html must forward reportUrl: cfg.reportUrl",
  );
});
