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

// #600: the relay WebSocket default is the WS hop of the SAME #279/#467 failure class. It used to be
// derived from `location.host` — behind the Studio console that is the console origin (:8080), which
// has no `/agentic` route (404) and whose app-view proxy refuses WS upgrades (501, ADR 0057 §3), so
// the live terminal was permanently dead behind the console. The fix anchors it to import.meta.url
// exactly like the HTTP endpoints, `../agentic` off `<appMount>/cockpit/mount.js`, then swaps the
// scheme http→ws / https→wss. Unlike reportUrl/transcriptsUrl (inlined `.href`) it is BUILT from
// `new URL("<spec>", import.meta.url)` so the scheme can be swapped, so it is matched separately.

// Pull the module-relative relay spec out of `new URL("<spec>", import.meta.url);` in defaultRelayUrl()
// (the HTTP defaults are `new URL(..., import.meta.url).href`, so `)\s*;` matches only the relay one).
function relaySpec(): string {
  const m = MOUNT_JS.match(/new URL\(\s*"([^"]*)"\s*,\s*import\.meta\.url\s*\)\s*;/);
  assert(
    m,
    "mount.js defaultRelayUrl() must derive the relay default from new URL(\"<spec>\", import.meta.url), " +
      "anchored to the module's own served location, not location.host (#600)",
  );
  return m![1];
}

// Resolve the relay spec against a REAL served mount url and swap the scheme, mirroring defaultRelayUrl().
function resolveRelay(mount: string): string {
  const url = new URL(relaySpec(), mount);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

test("#600: defaultRelayUrl derives the relay target from import.meta.url, not location.host", () => {
  assert(
    !/\$\{location\.host\}/.test(MOUNT_JS),
    "the relay default must not be interpolated from location.host: behind the console that is the " +
      "console origin (:8080), which has no /agentic route (404) and refuses WS upgrades (501) (#600)",
  );
  const spec = relaySpec();
  assert(
    !spec.startsWith("/"),
    `relay spec "${spec}" must not be absolute: a leading-slash path resolves against the iframe ORIGIN ` +
      `(console :8080), not the app-view base the console proxies (#279 class)`,
  );
  assert(
    spec.startsWith("../"),
    `relay spec "${spec}" must step up out of /cockpit/ (mount.js is at <appMount>/cockpit/mount.js; the ` +
      `hub is a sibling at <appMount>/agentic) (#467 class)`,
  );
});

test("#600: relay default resolves to ws://<app-origin>/agentic standalone (behaviour unchanged)", () => {
  assertEquals(
    resolveRelay(STANDALONE_MOUNT),
    "ws://127.0.0.1:3000/agentic",
    "standalone the relay default must dial the app origin's /agentic exactly as it does today",
  );
});

test("#600: relay default resolves onto the app-view base inside the Studio console iframe", () => {
  assertEquals(
    resolveRelay(STUDIO_MOUNT),
    "ws://studio-host:8080/console/app-view/Workforce/agentic",
    "behind the console the relay must dial the app-view-prefixed /agentic the console proxies, not the " +
      "console origin root (#279 class) nor the /cockpit/ shell base (#467 class)",
  );
});

test("#600: relay default swaps https→wss on a secure surface", () => {
  assertEquals(
    resolveRelay("https://studio-host:8443/console/app-view/Workforce/cockpit/mount.js"),
    "wss://studio-host:8443/console/app-view/Workforce/agentic",
    "an https surface must yield a wss relay url",
  );
});

test("#600: an explicit relayUrl opt and injected __NANO_APP_VIEW__.relayUrl outrank the derived default", () => {
  // Precedence is pinned in source: opts.relayUrl wins over the module-relative default, and embed.html
  // forwards the console-injected cfg.relayUrl into that opt so it outranks the default behind the console.
  assert(
    /opts\.relayUrl\s*\?\?\s*defaultRelayUrl\(/.test(MOUNT_JS),
    "mount.js must honour an explicit opts.relayUrl over the derived default (opts.relayUrl ?? defaultRelayUrl(...)) (#600)",
  );
  assert(
    /relayUrl:\s*cfg\.relayUrl/.test(EMBED_HTML),
    "embed.html must forward relayUrl: cfg.relayUrl so a console-injected __NANO_APP_VIEW__.relayUrl reaches the relay (#600)",
  );
});
