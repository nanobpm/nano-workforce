// Contract guard for the Staged proposals App-View (issues #460 + #511).
//
// A staged delivery-graph proposal (agent-authored, or staged from the compose view) must be
// PREVIEWABLE and DISPATCHABLE from the cockpit. The old declarative `dataGrid` could POST a Dispatch
// row-action but could not hand the recompiled BPMN up to the host explorer, so a staged proposal had a
// Dispatch button and NO way to see the graph. The staged App-View (pages/delivery-graphs/staged.*)
// closes that: per row it offers Preview-DI (over the nano-navigate bridge) AND Dispatch. This test
// pins the wiring so it cannot silently regress: the sidecars exist and mount the same module, the door
// defaults are base-relative (the #279 App-View resolution class — a leading-slash path 404s through the
// console iframe), it drives the DI-preview bridge, and it posts the dispatch by digest.
import { test } from "node:test";
import { assert } from "#test-assert";
import { readFileSync } from "node:fs";

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);
const DIR = `${ROOT}pages/delivery-graphs`;
const MOUNT_JS = readFileSync(`${DIR}/staged.mount.js`, "utf8");
const EMBED_HTML = readFileSync(`${DIR}/staged-embed.html`, "utf8");
const STANDALONE_HTML = readFileSync(`${DIR}/staged-standalone.html`, "utf8");
const PAGE_JSON = readFileSync(`${ROOT}pages/delivery-graphs.page.json`, "utf8");

// Pull the string default out of `const <name> = config.<field> ?? <CONST>;` (or a module const).
function defaultUrl(name: string): string {
  const m = MOUNT_JS.match(new RegExp(`${name}\\s*=\\s*config\\.\\w+\\s*\\?\\?\\s*(\\w+);`));
  assert(m, `staged.mount.js must default ${name} from config with a fallback constant`);
  const constM = MOUNT_JS.match(new RegExp(`const ${m![1]}\\s*=\\s*"([^"]*)"`));
  assert(constM, `staged.mount.js must declare the ${m![1]} fallback as a string literal`);
  return constM![1];
}

test("#511: the staged App-View mounts the same module standalone and embedded", () => {
  assert(/mountStagedProposals/.test(MOUNT_JS), "staged.mount.js must export mountStagedProposals");
  for (const [file, html] of [["staged-embed.html", EMBED_HTML], ["staged-standalone.html", STANDALONE_HTML]] as const) {
    assert(
      /import \{ mountStagedProposals \} from "\.\/staged\.mount\.js"/.test(html),
      `${file} must import mountStagedProposals from ./staged.mount.js`,
    );
    assert(/mountStagedProposals\(/.test(html), `${file} must call mountStagedProposals`);
  }
});

test("#511: the page binds the Staged proposals node to the staged App-View sidecars", () => {
  const page = JSON.parse(PAGE_JSON) as { nodes: Array<Record<string, any>> };
  const staged = page.nodes.find((n) => n.id === "delivery-graphs-staged");
  assert(staged, "the page must carry the delivery-graphs-staged node");
  assert(staged?.type === "appView", "delivery-graphs-staged must be an appView (#511)");
  assert(staged?.props?.embed === "./delivery-graphs/staged-embed.html", "it embeds the staged embed sidecar");
  assert(staged?.props?.standalone === "./delivery-graphs/staged-standalone.html", "it has the staged standalone sidecar");
});

test("#511/#279: the staged list door default is base-relative", () => {
  const url = defaultUrl("stagedUrl");
  assert(url.endsWith("delivery-graph/staged"), `stagedUrl default "${url}" must hit the listStagedProposals door`);
  assert(!url.startsWith("/"), `default stagedUrl "${url}" must be base-relative (App-View #279 resolution class)`);
});

test("#511: DI preview — the staged view wires the proposal-bpmn door and bridges the XML to the explorer", () => {
  const url = defaultUrl("proposalBpmnUrl");
  assert(url.endsWith("actions/delivery-graph/proposal-bpmn"), `proposalBpmnUrl default "${url}" must hit the previewProposalBpmn door`);
  assert(!url.startsWith("/"), `default proposalBpmnUrl "${url}" must be base-relative`);
  assert(/data-preview-di=/.test(MOUNT_JS), "staged.mount.js must render a per-row Preview-DI affordance carrying the digest");
  assert(/target:\s*"definitionPreview"/.test(MOUNT_JS), "staged.mount.js must post nano-navigate to the definitionPreview target");
  assert(/params:\s*\{\s*xml:/.test(MOUNT_JS), "staged.mount.js must carry the compiled BPMN xml in the bridge message");
});

test("#460/#511: Dispatch is the operator's launch — posts the digest to the dispatch door, and never compiles/stages", () => {
  const url = defaultUrl("dispatchUrl");
  assert(url.endsWith("actions/delivery-graph/dispatch"), `dispatchUrl default "${url}" must hit the dispatchDeliveryGraph door`);
  assert(!url.startsWith("/"), `default dispatchUrl "${url}" must be base-relative`);
  assert(/data-dispatch=/.test(MOUNT_JS), "staged.mount.js must render a per-row Dispatch affordance carrying the digest");
  assert(/window\.confirm\(/.test(MOUNT_JS), "Dispatch must confirm before launching (dispatch authorises side effects)");
  // Operator-only: this surface dispatches a digest that is ALREADY staged — it must not compile or
  // stage (that is the compose view), so the #460 boundary holds and the self-approval hole stays shut.
  assert(!/delivery-graph\/preview\b/.test(MOUNT_JS), "staged.mount.js must NOT wire the compile/stage door");
  assert(!/graphJson/.test(MOUNT_JS), "staged.mount.js must NOT submit pasted graph JSON (it only lists+dispatches staged proposals)");
  assert(!/approvalToken/.test(MOUNT_JS), "staged.mount.js must NOT carry the removed replayable approvalToken");
});

test("#520: Dismiss is the operator's discard — posts the digest to the dismiss door, behind a confirm, and launches nothing", () => {
  const url = defaultUrl("dismissUrl");
  assert(url.endsWith("actions/delivery-graph/dismiss"), `dismissUrl default "${url}" must hit the dismissProposal door`);
  assert(!url.startsWith("/"), `default dismissUrl "${url}" must be base-relative (App-View #279 resolution class)`);
  assert(/data-dismiss=/.test(MOUNT_JS), "staged.mount.js must render a per-row Dismiss affordance carrying the digest");
  // Dismiss is a one-way discard off the staged list — confirm before it drops the proposal.
  assert(/window\.confirm\(DISMISS_CONFIRM\)/.test(MOUNT_JS), "staged.mount.js must confirm before dismissing (a one-way discard off the staged list)");
});
