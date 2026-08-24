// Contract guard for the reusable delivery-graph LIBRARY App-View (issue #523, epic #519 S4).
//
// The Library surface (pages/delivery-graphs/library.*) LISTS saved library entries (the `listLibrary`
// door) and, per row, offers Reuse (load the saved graph back into the compose textarea `#dg-json`) and
// Delete (the `deleteLibraryEntry` door). Reuse crosses the App-View iframe boundary: it drives the
// compose mount's NEW inbound fill seam over the shared `deliveryGraph.compose.fill` host-bridge
// message. Plus a Save-to-library affordance on the staged App-View (save-from-digest) and a
// Save-to-library row action on the dispatched/history grid. This test pins that wiring so it cannot
// silently regress: the sidecars mount the same module, the door defaults are base-relative (the #279
// App-View resolution class), Reuse posts the ONE shared fill message, Delete hits the per-entry door,
// the compose mount adds the inbound fill listener, and the page carries the new Library App-View node.
import { test } from "node:test";
import { assert } from "#test-assert";
import { readFileSync } from "node:fs";
import { DG_COMPOSE_FILL_MESSAGE } from "../pages/delivery-graphs/mount.js";

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);
const DIR = `${ROOT}pages/delivery-graphs`;
const LIBRARY_JS = readFileSync(`${DIR}/library.mount.js`, "utf8");
const COMPOSE_JS = readFileSync(`${DIR}/mount.js`, "utf8");
const STAGED_JS = readFileSync(`${DIR}/staged.mount.js`, "utf8");
const EMBED_HTML = readFileSync(`${DIR}/library-embed.html`, "utf8");
const STANDALONE_HTML = readFileSync(`${DIR}/library-standalone.html`, "utf8");
const PAGE_JSON = readFileSync(`${ROOT}pages/delivery-graphs.page.json`, "utf8");

// Pull the string default out of `const <name> = config.<field> ?? <CONST>;` (or a module const).
function defaultUrl(src: string, name: string): string {
  const m = src.match(new RegExp(`${name}\\s*=\\s*config\\.\\w+\\s*\\?\\?\\s*(\\w+);`));
  assert(m, `mount must default ${name} from config with a fallback constant`);
  const constM = src.match(new RegExp(`const ${m![1]}\\s*=\\s*"([^"]*)"`));
  assert(constM, `mount must declare the ${m![1]} fallback as a string literal`);
  return constM![1];
}

test("#523: the Library App-View mounts the same module standalone and embedded", () => {
  assert(/mountDeliveryGraphLibrary/.test(LIBRARY_JS), "library.mount.js must export mountDeliveryGraphLibrary");
  for (const [file, html] of [["library-embed.html", EMBED_HTML], ["library-standalone.html", STANDALONE_HTML]] as const) {
    assert(
      /import \{ mountDeliveryGraphLibrary \} from "\.\/library\.mount\.js"/.test(html),
      `${file} must import mountDeliveryGraphLibrary from ./library.mount.js`,
    );
    assert(/mountDeliveryGraphLibrary\(/.test(html), `${file} must call mountDeliveryGraphLibrary`);
  }
});

test("#523: the page binds the Library node to the library App-View sidecars", () => {
  const page = JSON.parse(PAGE_JSON) as { nodes: Array<Record<string, any>> };
  const library = page.nodes.find((n) => n.id === "delivery-graphs-library");
  assert(library, "the page must carry the delivery-graphs-library node");
  assert(library?.type === "appView", "delivery-graphs-library must be an appView (#523)");
  assert(library?.props?.embed === "./delivery-graphs/library-embed.html", "it embeds the library embed sidecar");
  assert(library?.props?.standalone === "./delivery-graphs/library-standalone.html", "it has the library standalone sidecar");
});

test("#523/#279: the Library list door default is base-relative and hits the listLibrary door", () => {
  const url = defaultUrl(LIBRARY_JS, "libraryUrl");
  assert(url.endsWith("delivery-graph/library"), `libraryUrl default "${url}" must hit the listLibrary door`);
  assert(!url.startsWith("/"), `default libraryUrl "${url}" must be base-relative (App-View #279 resolution class)`);
  // The list read consumes the door's `entries` array (one row per saved entry).
  assert(/body\.entries/.test(LIBRARY_JS), "library.mount.js must render one row per `entries[]` item the listLibrary door returns");
});

test("#523: Reuse drives the compose fill seam over the shared host-bridge message", () => {
  // Reuse loads the saved graph back into the SEPARATE compose App-View, so it posts the ONE shared
  // fill message (its type imported from ./mount.js, never re-declared) UP over the App-View boundary.
  assert(
    /import \{ DG_COMPOSE_FILL_MESSAGE \} from "\.\/mount\.js"/.test(LIBRARY_JS),
    "library.mount.js must import DG_COMPOSE_FILL_MESSAGE from ./mount.js (the ONE source of truth for the fill message type)",
  );
  assert(/data-reuse=/.test(LIBRARY_JS), "library.mount.js must render a per-row Reuse affordance carrying the entry id");
  assert(/postMessage\(/.test(LIBRARY_JS), "Reuse must post the fill message across the App-View boundary");
  assert(/type:\s*DG_COMPOSE_FILL_MESSAGE/.test(LIBRARY_JS), "the Reuse message must carry the shared DG_COMPOSE_FILL_MESSAGE type");
  assert(/graphJson:\s*entry\.graph/.test(LIBRARY_JS), "the Reuse message must carry the saved entry's graph JSON");
});

test("#523: Delete hits the per-entry deleteLibraryEntry door", () => {
  assert(/data-delete=/.test(LIBRARY_JS), "library.mount.js must render a per-row Delete affordance carrying the entry id");
  // The delete door is the per-entry path under the list door: DELETE .../delivery-graph/library/<id>.
  assert(/method:\s*"DELETE"/.test(LIBRARY_JS), "Delete must issue an HTTP DELETE to the deleteLibraryEntry door");
  assert(/encodeURIComponent\(/.test(LIBRARY_JS), "the delete path must URL-encode the entry id it appends to the library door");
});

test("#523: the compose mount exposes an INBOUND reuse-fill seam (message → #dg-json)", () => {
  // The compose mount previously had NO inbound prefill — its #dg-json was set only by Load-example /
  // typing. S4 adds a same-origin message listener that fills #dg-json through a single fillComposer seam.
  assert(/export const DG_COMPOSE_FILL_MESSAGE\s*=/.test(COMPOSE_JS), "mount.js must export the DG_COMPOSE_FILL_MESSAGE fill-message type");
  assert(/function fillComposer\(/.test(COMPOSE_JS), "mount.js must define the single fillComposer seam every fill routes through");
  assert(/addEventListener\("message"/.test(COMPOSE_JS), "mount.js must register an inbound `message` listener for the fill seam");
  assert(/data\.type !== DG_COMPOSE_FILL_MESSAGE/.test(COMPOSE_JS), "the listener must gate on the shared fill-message type");
  assert(/jsonEl\.value = graphJson/.test(COMPOSE_JS), "fillComposer must load the graph JSON into the #dg-json textarea");
  // Same-origin guard: a foreign origin must not be able to drive the fill.
  assert(/ev\.origin !== window\.location\.origin/.test(COMPOSE_JS), "the fill listener must reject cross-origin messages");
});

test("#523: Save-to-library on the staged App-View posts save-from-digest", () => {
  const url = defaultUrl(STAGED_JS, "saveLibraryUrl");
  assert(url.endsWith("actions/delivery-graph/library/save"), `saveLibraryUrl default "${url}" must hit the saveToLibrary door`);
  assert(!url.startsWith("/"), `default saveLibraryUrl "${url}" must be base-relative (App-View #279 resolution class)`);
  assert(/data-save-library=/.test(STAGED_JS), "staged.mount.js must render a per-row Save-to-library affordance carrying the digest");
  // Save-from-digest: it posts { name, digest } — it must NOT compile or stage a raw graph (the #460
  // operator boundary the staged view enforces stays intact).
  assert(/post\(saveLibraryUrl,\s*\{\s*name:[^}]*digest:/.test(STAGED_JS), "Save-to-library must POST { name, digest } (save-from-digest) to the save door");
});

test("#523: Save-to-library is offered on a dispatched/history grid row (save-from-dispatched)", () => {
  const page = JSON.parse(PAGE_JSON) as { nodes: Array<Record<string, any>> };
  const grid = page.nodes.find((n) => n.id === "delivery-graphs-inflight");
  assert(grid, "the page must carry the delivery-graphs-inflight grid");
  const action = (grid?.props?.rowActions ?? []).find((a: Record<string, any>) => a.label === "Save to library");
  assert(action, "the in-flight grid must offer a `Save to library` row action");
  assert(
    action?.action?.path === "/app/api/actions/delivery-graph/library/save",
    "the Save-to-library row action must post to the saveToLibrary door",
  );
  assert(
    action?.action?.body?.digest === "{{row.digest}}" && action?.action?.body?.name === "{{row.title}}",
    "the Save-to-library row action must save-from-digest, naming the entry from the run title",
  );
});
