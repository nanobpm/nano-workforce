// Contract guard for the Delivery Graphs compose → preview → dispatch App View (issue #441).
//
// The rich compile preview (mermaid diagram + humanNodes[] stop-points + sideEffects[] + inline
// path-qualified errors) and the gated approve → dispatch two-step are surfaced by an `appView` embed
// (pages/delivery-graphs/) over the EXISTING previewDeliveryGraph / dispatchDeliveryGraph doors — a
// bare `actionForm` discards its response and so can render none of that. This test pins the wiring so
// it can't silently regress: the sidecars exist, mount.js hits BOTH doors with base-relative defaults
// (the #279 App-View resolution class — a leading-slash path 404s through the console iframe), it
// renders each preview facet, and it implements the awaiting-approval → approve re-submit.
import { test } from "node:test";
import { assert } from "#test-assert";
import { readFileSync } from "node:fs";

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);
const DIR = `${ROOT}pages/delivery-graphs`;
const MOUNT_JS = readFileSync(`${DIR}/mount.js`, "utf8");
const EMBED_HTML = readFileSync(`${DIR}/embed.html`, "utf8");
const STANDALONE_HTML = readFileSync(`${DIR}/standalone.html`, "utf8");

// Pull the string default out of `const <name> = config.<name> ?? "<default>";` (or a module const).
function defaultUrl(name: string): string {
  const m = MOUNT_JS.match(new RegExp(`${name}\\s*=\\s*config\\.\\w+\\s*\\?\\?\\s*(\\w+);`));
  assert(m, `mount.js must default ${name} from config with a fallback constant`);
  const constM = MOUNT_JS.match(new RegExp(`const ${m![1]}\\s*=\\s*"([^"]*)"`));
  assert(constM, `mount.js must declare the ${m![1]} fallback as a string literal`);
  return constM![1];
}

test("#441: the delivery-graphs App View mounts the same module standalone and embedded", () => {
  assert(/mountDeliveryGraphs/.test(MOUNT_JS), "mount.js must export mountDeliveryGraphs");
  for (const [file, html] of [["embed.html", EMBED_HTML], ["standalone.html", STANDALONE_HTML]] as const) {
    assert(/import \{ mountDeliveryGraphs \} from "\.\/mount\.js"/.test(html), `${file} must import mountDeliveryGraphs from ./mount.js`);
    assert(/mountDeliveryGraphs\(/.test(html), `${file} must call mountDeliveryGraphs`);
  }
});

test("#441: mount.js wires BOTH the preview and dispatch doors", () => {
  const previewUrl = defaultUrl("previewUrl");
  const dispatchUrl = defaultUrl("dispatchUrl");
  assert(previewUrl.endsWith("actions/delivery-graph/preview"), `previewUrl default "${previewUrl}" must hit the previewDeliveryGraph door`);
  assert(dispatchUrl.endsWith("actions/delivery-graph/dispatch"), `dispatchUrl default "${dispatchUrl}" must hit the dispatchDeliveryGraph door`);
});

// The #279 App-View resolution class: a default endpoint must be BASE-RELATIVE (no leading slash) so
// it resolves under the console app-view base, not the console origin root (which 404s the door).
for (const name of ["previewUrl", "dispatchUrl"] as const) {
  test(`#441/#279: default ${name} is base-relative (no leading slash)`, () => {
    const def = defaultUrl(name);
    assert(!def.startsWith("/"), `default ${name} "${def}" must not start with "/" — a leading-slash path resolves against the console iframe ORIGIN, not the app-view base, so the door 404s`);
  });
}

test("#441: the preview render consumes every compile facet the door returns", () => {
  // The whole point of the issue: the preview data (diagram / humanNodes / sideEffects / errors) is
  // rich but was consumed by nothing. Assert the renderer touches each facet.
  for (const facet of ["diagram", "humanNodes", "sideEffects", "errors"]) {
    assert(new RegExp(`\\b${facet}\\b`).test(MOUNT_JS), `mount.js must render the preview's \`${facet}\``);
  }
});

test("#441: dispatch implements the gated awaiting-approval → approve two-step", () => {
  assert(/awaiting-approval/.test(MOUNT_JS), "mount.js must recognise the awaiting-approval park from the dispatch door");
  assert(/approve/.test(MOUNT_JS), "mount.js must re-submit with approve on the operator's confirm");
});

test("#441: approval binds to the frozen previewed graph, not the live (editable) textarea", () => {
  // The server derives the approval digest from whatever body it receives, so an operator who edits
  // the textarea after parking would silently approve+dispatch a DIFFERENT graph than the one
  // previewed. mount.js must (a) capture the exact graph at park time and dispatch THAT on confirm,
  // and (b) lock the compose inputs while approval is pending so they can't drift.
  assert(/frozen/.test(MOUNT_JS), "doDispatch must thread the frozen (park-time) graph into the approve re-submit");
  assert(/lockCompose/.test(MOUNT_JS), "mount.js must lock the compose inputs while a graph is parked awaiting approval");
  assert(/readOnly/.test(MOUNT_JS), "lockCompose must make the graph/idempotency inputs read-only while approval is pending");
});
