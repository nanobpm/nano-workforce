// Contract guard for the Delivery Graphs compose → preview → STAGE App View (issues #441 + #460).
//
// The rich compile preview (mermaid diagram + humanNodes[] stop-points + sideEffects[] + inline
// path-qualified errors) is surfaced by an `appView` embed (pages/delivery-graphs/) over the EXISTING
// previewDeliveryGraph door — a bare `actionForm` discards its response and so can render none of that.
// Dispatch is deliberately NOT in this view (issue #460): it is an OPERATOR row-action on the Staged
// proposals grid on the same page. This test pins the wiring so it can't silently regress: the
// sidecars exist, mount.js hits the preview door with a base-relative default (the #279 App-View
// resolution class — a leading-slash path 404s through the console iframe), it renders each preview
// facet, and it exposes NO dispatch/approval affordance (the self-approval hole #460 closes).
import { test } from "node:test";
import { assert } from "#test-assert";
import { readFileSync } from "node:fs";

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);
const DIR = `${ROOT}pages/delivery-graphs`;
const MOUNT_JS = readFileSync(`${DIR}/mount.js`, "utf8");
const EMBED_HTML = readFileSync(`${DIR}/embed.html`, "utf8");
const STANDALONE_HTML = readFileSync(`${DIR}/standalone.html`, "utf8");
const PAGE_JSON = readFileSync(`${ROOT}pages/delivery-graphs.page.json`, "utf8");

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

test("#441: mount.js wires the preview+stage door", () => {
  const previewUrl = defaultUrl("previewUrl");
  assert(previewUrl.endsWith("actions/delivery-graph/preview"), `previewUrl default "${previewUrl}" must hit the previewDeliveryGraph door`);
});

test("DI preview: mount.js wires the proposal-bpmn door (base-relative) and hands the XML to the host explorer", () => {
  const url = defaultUrl("proposalBpmnUrl");
  assert(url.endsWith("actions/delivery-graph/proposal-bpmn"), `proposalBpmnUrl default "${url}" must hit the previewProposalBpmn door`);
  assert(!url.startsWith("/"), `default proposalBpmnUrl "${url}" must be base-relative (App-View #279 resolution class)`);
  // The staged banner exposes a Preview-DI affordance, and clicking it hands the compiled XML to the
  // host console over the nano-navigate bridge with the definitionPreview target (never a dispatch).
  assert(/data-preview-di=/.test(MOUNT_JS), "mount.js must render a Preview-DI affordance carrying the proposal digest");
  assert(/target:\s*"definitionPreview"/.test(MOUNT_JS), "mount.js must post nano-navigate to the definitionPreview target");
  assert(/params:\s*\{\s*xml:/.test(MOUNT_JS), "mount.js must carry the compiled BPMN xml in the bridge message");
});

// The #279 App-View resolution class: a default endpoint must be BASE-RELATIVE (no leading slash) so
// it resolves under the console app-view base, not the console origin root (which 404s the door).
test("#441/#279: default previewUrl is base-relative (no leading slash)", () => {
  const def = defaultUrl("previewUrl");
  assert(!def.startsWith("/"), `default previewUrl "${def}" must not start with "/" — a leading-slash path resolves against the console iframe ORIGIN, not the app-view base, so the door 404s`);
});

test("#441: the preview render consumes every compile facet the door returns", () => {
  // The whole point of #441: the preview data (diagram / humanNodes / sideEffects / errors) is rich
  // but was consumed by nothing. Assert the renderer touches each facet at a CONCRETE call site (not a
  // bare word, which a comment/string could satisfy) so a renderer that stops reading a field fails.
  const facetUse: Record<string, RegExp> = {
    diagram: /esc\(result\.diagram\)/,
    humanNodes: /renderHumanNodes\(result\.humanNodes\)/,
    sideEffects: /renderSideEffects\(result\.sideEffects\)/,
    errors: /renderErrors\(body\.error,\s*body\.errors\)/,
  };
  for (const [facet, re] of Object.entries(facetUse)) {
    assert(re.test(MOUNT_JS), `mount.js must render the preview's \`${facet}\` via ${re.source}`);
  }
});

test("#460: the compose view exposes NO dispatch or approval affordance — it only previews + stages", () => {
  // Issue #460 removes the agent-reachable dispatch door. The compose view must not smuggle it back:
  // no dispatch door wiring, no approval two-step, no replayable approvalToken. Dispatch is the
  // operator's Staged-proposals row-action instead.
  assert(!/dispatchUrl/.test(MOUNT_JS), "mount.js must NOT wire a dispatch door (dispatch is an operator row-action, issue #460)");
  assert(!/delivery-graph\/dispatch/.test(MOUNT_JS), "mount.js must NOT post to the dispatch door");
  assert(!/awaiting-approval/.test(MOUNT_JS), "mount.js must NOT implement the removed awaiting-approval two-step");
  assert(!/approvalToken/.test(MOUNT_JS), "mount.js must NOT carry the removed replayable approvalToken");
});

test("#460/#511: dispatch is the operator's action on the Staged-proposals App-View", () => {
  // Dispatch is NOT in the compose view (asserted above). It lives on the Staged-proposals surface,
  // which is now an App-View (issue #511) rather than a declarative grid: a grid row-action can POST but
  // cannot hand the recompiled BPMN up to the host explorer, so a staged proposal had a Dispatch button
  // but no way to SEE the graph. The App-View carries BOTH Preview-DI and Dispatch. The wiring itself
  // (which doors staged.mount.js posts to) is pinned by delivery-graphs-staged-embed.test.ts.
  const page = JSON.parse(PAGE_JSON) as { nodes: Array<Record<string, any>> };
  const staged = page.nodes.find((n) => n.id === "delivery-graphs-staged");
  assert(staged, "the page must carry a Staged proposals surface");
  assert(staged?.type === "appView", "the Staged proposals surface is an App-View (#511), not a declarative grid");
  assert(
    staged?.props?.embed === "./delivery-graphs/staged-embed.html",
    "the Staged proposals App-View embeds ./delivery-graphs/staged-embed.html",
  );
  assert(
    staged?.props?.standalone === "./delivery-graphs/staged-standalone.html",
    "the Staged proposals App-View has a standalone shell",
  );
});
