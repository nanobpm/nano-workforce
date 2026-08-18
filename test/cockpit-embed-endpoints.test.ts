// Regression guard for issue #279: the cockpit renders empty when viewed through the Studio console
// App-View because its default supply/transcript endpoints were ABSOLUTE (leading-slash) paths.
//
// Studio frames the app in an iframe whose document base is the app-view path
// (`/console/app-view/<AppName>/`) but whose ORIGIN is the console (`:8080`). A leading-slash fetch
// therefore resolves against the console origin root — `:8080/app/api/agentic/supply` → 404 — instead
// of the app-view base that actually serves the API. The console does NOT inject
// `window.__NANO_APP_VIEW__`, so `mount.js` falls back to its default; the default must be
// BASE-RELATIVE (no leading slash) so the browser resolves it against `document.baseURI` and it lands
// on the app-view base standalone AND embedded alike. This test pins that resolution behaviour so the
// absolute-path regression can't return.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { readFileSync } from "node:fs";

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);
const MOUNT_JS = readFileSync(`${ROOT}pages/cockpit/mount.js`, "utf8");
const EMBED_HTML = readFileSync(`${ROOT}pages/cockpit/embed.html`, "utf8");

// Pull the string default out of `const <name> = opts.<name> ?? "<default>";` in mount.js.
function defaultEndpoint(name: string): string {
  const m = MOUNT_JS.match(new RegExp(`opts\\.${name}\\s*\\?\\?\\s*"([^"]*)"`));
  assert(m, `mount.js must default opts.${name} to a string literal`);
  return m![1];
}

// The two surfaces mount.js serves, per the issue's URL table:
const APP_VIEW_BASE = "http://studio-host:8080/console/app-view/Workforce/"; // Studio iframe base
const STANDALONE_BASE = "http://127.0.0.1:3000/"; // standalone shell served at the app root

for (const name of ["reportUrl", "transcriptsUrl"] as const) {
  test(`#279: mount.js default ${name} is base-relative (no leading slash)`, () => {
    const def = defaultEndpoint(name);
    assert(
      !def.startsWith("/"),
      `default ${name} "${def}" must not start with "/": a leading-slash path resolves against the ` +
        `iframe ORIGIN (console :8080), not the app-view base, so every fetch 404s through Studio (#279)`,
    );
  });

  test(`#279: default ${name} resolves onto the app-view base inside the Studio iframe`, () => {
    const def = defaultEndpoint(name);
    // The bug: the default resolved to the console origin root (dropping /console/app-view/Workforce/).
    // The fix: it must resolve UNDER the app-view base so it hits the endpoint the console proxies.
    assertEquals(
      new URL(def, APP_VIEW_BASE).href,
      `http://studio-host:8080/console/app-view/Workforce/${def}`,
      `default ${name} must resolve under the app-view base, not the console origin root (#279)`,
    );
  });

  test(`#279: default ${name} still resolves to the origin root standalone`, () => {
    const def = defaultEndpoint(name);
    assertEquals(
      new URL(def, STANDALONE_BASE).href,
      `http://127.0.0.1:3000/${def}`,
      `default ${name} must keep working for the standalone shell at the app root`,
    );
  });
}

test("#279: embed.html forwards BOTH reportUrl and transcriptsUrl from the injected config", () => {
  // embed.html previously forwarded only reportUrl, so even if the console injected endpoint config
  // the transcripts panel kept its (formerly absolute) default. Both must be forwarded.
  assert(
    /transcriptsUrl:\s*cfg\.transcriptsUrl/.test(EMBED_HTML),
    "embed.html must forward transcriptsUrl: cfg.transcriptsUrl so the injected config reaches the past-sessions panel (#279)",
  );
  assert(
    /reportUrl:\s*cfg\.reportUrl/.test(EMBED_HTML),
    "embed.html must forward reportUrl: cfg.reportUrl",
  );
});
