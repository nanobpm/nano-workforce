// Contract guard for the Delivery Graphs compose → PREVIEW / STAGE App View (issues #441 + #460 + #516).
//
// The rich compile preview (mermaid diagram + humanNodes[] stop-points + sideEffects[] + inline
// path-qualified errors) is surfaced by an `appView` embed (pages/delivery-graphs/) over the preview /
// stage doors — a bare `actionForm` discards its response and so can render none of that. Preview and
// Stage are SEPARATE operator actions (#516): Preview compiles without persisting; Stage persists a
// proposal. Dispatch is deliberately NOT in this view (issue #460): it is an OPERATOR row-action on the
// Staged proposals grid on the same page. This test pins the wiring so it can't silently regress: the
// sidecars exist, mount.js hits the preview + stage doors with base-relative defaults (the #279
// App-View resolution class — a leading-slash path 404s), it renders each preview facet, its compose
// panel is collapsible, and it exposes NO dispatch/approval affordance (the self-approval hole #460
// closes).
import { test } from "node:test";
import { assert } from "#test-assert";
import { readFileSync } from "node:fs";
import { parseAndCompileText } from "../app/deliveryGraphTextIngress.ts";
import { EXAMPLE_GRAPH } from "../pages/delivery-graphs/mount.js";

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);
const DIR = `${ROOT}pages/delivery-graphs`;
const MOUNT_JS = readFileSync(`${DIR}/mount.js`, "utf8");
const EMBED_HTML = readFileSync(`${DIR}/embed.html`, "utf8");
const STANDALONE_HTML = readFileSync(`${DIR}/standalone.html`, "utf8");
const CSS = readFileSync(`${DIR}/delivery-graphs.css`, "utf8");
const PAGE_JSON = readFileSync(`${ROOT}pages/delivery-graphs.page.json`, "utf8");

// Pull the string default out of `const <name> = config.<name> ?? <CONST>;` (a module const).
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

test("#516: mount.js wires SEPARATE preview and stage doors (base-relative)", () => {
  const previewUrl = defaultUrl("previewUrl");
  assert(previewUrl.endsWith("actions/delivery-graph/preview"), `previewUrl default "${previewUrl}" must hit the previewDeliveryGraph door`);
  assert(!previewUrl.startsWith("/"), `default previewUrl "${previewUrl}" must be base-relative (App-View #279 resolution class)`);
  const stageUrl = defaultUrl("stageUrl");
  assert(stageUrl.endsWith("actions/delivery-graph/stage"), `stageUrl default "${stageUrl}" must hit the stageDeliveryGraph door`);
  assert(!stageUrl.startsWith("/"), `default stageUrl "${stageUrl}" must be base-relative (App-View #279 resolution class)`);
  // Preview and Stage are distinct buttons wired to distinct actions.
  assert(/id="dg-preview"/.test(MOUNT_JS) && /id="dg-stage"/.test(MOUNT_JS), "mount.js must render distinct Preview and Stage buttons");
  assert(/submit\(previewUrl,\s*false\)/.test(MOUNT_JS), "the Preview button must submit to the preview door WITHOUT staging");
  assert(/submit\(stageUrl,\s*true\)/.test(MOUNT_JS), "the Stage button must submit to the stage door");
});

test("#516: the compose panel is collapsible", () => {
  // Native <details> disclosure: keyboard-accessible, and the textarea is only hidden (never destroyed)
  // when collapsed, so its value survives.
  assert(/<details[^>]*class="[^"]*\bcompose\b/.test(MOUNT_JS), "the compose panel must be a collapsible <details class=compose>");
  assert(/<summary>/.test(MOUNT_JS), "the collapsible compose panel must have a <summary> disclosure header");
  assert(/\.compose\[open\]/.test(CSS), "the CSS must style the open/closed disclosure state");
});

test("#516 DI preview: the compose view bridges the previewed BPMN to the host explorer WITHOUT staging", () => {
  // The pure preview door returns the laid-out `bpmn`, so DI preview needs no proposal-bpmn round-trip
  // (and therefore no staging). The compose view stashes the previewed BPMN and hands it to the host
  // console over the nano-navigate bridge with the definitionPreview target (never a dispatch).
  assert(!/proposal-bpmn/.test(MOUNT_JS), "mount.js must NOT round-trip the proposal-bpmn door — the preview door returns the BPMN directly (#516)");
  assert(/lastBpmn/.test(MOUNT_JS), "mount.js must stash the previewed BPMN to bridge on demand");
  assert(/data-preview-di/.test(MOUNT_JS), "mount.js must render a Preview-DI affordance");
  assert(/target:\s*"definitionPreview"/.test(MOUNT_JS), "mount.js must post nano-navigate to the definitionPreview target");
  assert(/params:\s*\{\s*xml:\s*lastBpmn\s*\}/.test(MOUNT_JS), "mount.js must carry the previewed BPMN xml in the bridge message");
});

test("#441: the preview render consumes every compile facet the door returns", () => {
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

test("#516: the built-in 'Load example' graph compiles clean (regression: it used to fail)", async () => {
  // The example shipped a `soak` wait node missing its required `wait.kind`, so 'Load example' →
  // Preview always 400'd. Drive the EXACT string the button injects through the SAME compiler the
  // preview/stage doors use, and assert it is accepted — so a future edit to EXAMPLE_GRAPH can't
  // silently re-break the one graph an operator reaches for first.
  const result = await parseAndCompileText({ graphJson: EXAMPLE_GRAPH });
  assert(result.ok, result.ok ? "" : `the built-in example must compile, got: ${JSON.stringify(result.body)}`);
});

test("#460: the compose view exposes NO dispatch or approval affordance — it only previews + stages", () => {
  assert(!/dispatchUrl/.test(MOUNT_JS), "mount.js must NOT wire a dispatch door (dispatch is an operator row-action, issue #460)");
  assert(!/delivery-graph\/dispatch/.test(MOUNT_JS), "mount.js must NOT post to the dispatch door");
  assert(!/awaiting-approval/.test(MOUNT_JS), "mount.js must NOT implement the removed awaiting-approval two-step");
  assert(!/approvalToken/.test(MOUNT_JS), "mount.js must NOT carry the removed replayable approvalToken");
});

test("#460/#511: dispatch is the operator's action on the Staged-proposals App-View", () => {
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
