// Contract guard for the Staged proposals App-View (issues #460 + #511).
//
// A staged delivery-graph proposal (agent-authored, or staged from the compose view) must be
// PREVIEWABLE and DISPATCHABLE from the cockpit. The old declarative `dataGrid` could POST a Dispatch
// row-action but could not hand the recompiled BPMN up to the host explorer, so a staged proposal had a
// Dispatch button and NO way to see the graph. The staged App-View (pages/delivery-graphs/staged.*)
// closes that: per row it offers Preview-DI (over the nano-navigate bridge) AND Dispatch. This test
// pins the wiring so it cannot silently regress: the sidecars exist and mount the same module, the door
// defaults are MODULE-ANCHORED (`new URL("../app/api/…", import.meta.url)`, the #467 App-View
// resolution class — see below), it drives the DI-preview bridge, and it posts the dispatch by digest.
//
// #279/#467 resolution class: the staged shell (staged-embed.html / staged-standalone.html) — and thus
// staged.mount.js — is served ONE DIRECTORY DEEP at `<appMount>/delivery-graphs/`, while the API lives
// at the app root, a sibling of `/delivery-graphs/`: `<appMount>/app/api/…`. A leading-slash absolute
// default resolves against the console iframe ORIGIN, not the app-view base (#279). A document-base-
// relative default (`"app/api/…"`) resolves against the `…/delivery-graphs/` shell base to
// `…/delivery-graphs/app/api/…` → 404 on EVERY surface (the Studio console never injects
// window.__NANO_APP_VIEW__, so the default runs) — the "Could not load staged proposals." bug (#536).
// The only correct default is anchored to staged.mount.js's OWN url (import.meta.url): `../app/api/…`
// steps up out of `/delivery-graphs/` onto `<appMount>/app/api/…` on all surfaces. This test pins that
// resolution against the REAL, `/delivery-graphs/`-deep module url so neither regression can return.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { readFileSync } from "node:fs";

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);
const DIR = `${ROOT}pages/delivery-graphs`;
const MOUNT_JS = readFileSync(`${DIR}/staged.mount.js`, "utf8");
const EMBED_HTML = readFileSync(`${DIR}/staged-embed.html`, "utf8");
const STANDALONE_HTML = readFileSync(`${DIR}/staged-standalone.html`, "utf8");
const PAGE_JSON = readFileSync(`${ROOT}pages/delivery-graphs.page.json`, "utf8");

// The REAL served location of staged.mount.js on each surface: one directory deep under
// `/delivery-graphs/`.
const STANDALONE_MOUNT = "http://127.0.0.1:3000/delivery-graphs/staged.mount.js";
const STUDIO_MOUNT = "http://studio-host:8080/console/app-view/Workforce/delivery-graphs/staged.mount.js";

// Pull the module-anchored default spec out of `const <name> = config.<field> ?? <CONST>;` where the
// CONST is declared `const <CONST> = new URL("<spec>", import.meta.url).href;`.
function defaultSpec(name: string): string {
  const m = MOUNT_JS.match(new RegExp(`${name}\\s*=\\s*config\\.\\w+\\s*\\?\\?\\s*(\\w+);`));
  assert(m, `staged.mount.js must default ${name} from config with a fallback constant`);
  const constM = MOUNT_JS.match(
    new RegExp(`const ${m![1]}\\s*=\\s*new URL\\(\\s*"([^"]*)"\\s*,\\s*import\\.meta\\.url\\s*\\)\\s*\\.href`),
  );
  assert(
    constM,
    `staged.mount.js must default ${m![1]} to new URL("<spec>", import.meta.url) so the door is anchored ` +
      `to the module's own served location, not the document base (#467/#536)`,
  );
  return constM![1];
}

// A module-anchored door default must (a) not be absolute (#279), (b) step up out of /delivery-graphs/
// (#467), and (c) resolve onto <appMount>/app/api/… both standalone AND inside the Studio iframe.
function assertModuleAnchored(name: string, endpoint: string): void {
  const spec = defaultSpec(name);
  assert(
    !spec.startsWith("/"),
    `default ${name} spec "${spec}" must not be absolute: a leading-slash path resolves against the ` +
      `iframe ORIGIN (console :8080), not the app-view base, so every fetch 404s (#279)`,
  );
  assert(
    spec.startsWith("../"),
    `default ${name} spec "${spec}" must step up out of /delivery-graphs/ (import.meta.url points at ` +
      `<appMount>/delivery-graphs/staged.mount.js; the API is a sibling at <appMount>/app/api/…) (#467)`,
  );
  assert(spec.endsWith(endpoint), `default ${name} spec "${spec}" must hit the ${endpoint} door`);
  assertEquals(
    new URL(spec, STANDALONE_MOUNT).href,
    `http://127.0.0.1:3000/${endpoint}`,
    `default ${name} must resolve to the app root, not the /delivery-graphs/ shell base (#467)`,
  );
  assertEquals(
    new URL(spec, STUDIO_MOUNT).href,
    `http://studio-host:8080/console/app-view/Workforce/${endpoint}`,
    `default ${name} must resolve under the app-view base the console proxies, not the console origin ` +
      `root (#279) nor the /delivery-graphs/ shell base (#467/#536)`,
  );
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

test("#511/#279/#467: the staged list door default is module-anchored to the app root", () => {
  assertModuleAnchored("stagedUrl", "app/api/delivery-graph/staged");
});

test("#511: DI preview — the staged view wires the proposal-bpmn door and bridges the XML to the explorer", () => {
  assertModuleAnchored("proposalBpmnUrl", "app/api/actions/delivery-graph/proposal-bpmn");
  assert(/data-preview-di=/.test(MOUNT_JS), "staged.mount.js must render a per-row Preview-DI affordance carrying the digest");
  assert(/target:\s*"definitionPreview"/.test(MOUNT_JS), "staged.mount.js must post nano-navigate to the definitionPreview target");
  assert(/params:\s*\{\s*xml:/.test(MOUNT_JS), "staged.mount.js must carry the compiled BPMN xml in the bridge message");
});

test("#460/#511: Dispatch is the operator's launch — posts the digest to the dispatch door, and never compiles/stages", () => {
  assertModuleAnchored("dispatchUrl", "app/api/actions/delivery-graph/dispatch");
  assert(/data-dispatch=/.test(MOUNT_JS), "staged.mount.js must render a per-row Dispatch affordance carrying the digest");
  assert(/window\.confirm\(/.test(MOUNT_JS), "Dispatch must confirm before launching (dispatch authorises side effects)");
  // Operator-only: this surface dispatches a digest that is ALREADY staged — it must not compile or
  // stage (that is the compose view), so the #460 boundary holds and the self-approval hole stays shut.
  assert(!/delivery-graph\/preview\b/.test(MOUNT_JS), "staged.mount.js must NOT wire the compile/stage door");
  assert(!/graphJson/.test(MOUNT_JS), "staged.mount.js must NOT submit pasted graph JSON (it only lists+dispatches staged proposals)");
  assert(!/approvalToken/.test(MOUNT_JS), "staged.mount.js must NOT carry the removed replayable approvalToken");
});

test("#520: Dismiss is the operator's discard — posts the digest to the dismiss door, behind a confirm, and launches nothing", () => {
  assertModuleAnchored("dismissUrl", "app/api/actions/delivery-graph/dismiss");
  assert(/data-dismiss=/.test(MOUNT_JS), "staged.mount.js must render a per-row Dismiss affordance carrying the digest");
  // Dismiss is a one-way discard off the staged list — confirm before it drops the proposal.
  assert(/window\.confirm\(DISMISS_CONFIRM\)/.test(MOUNT_JS), "staged.mount.js must confirm before dismissing (a one-way discard off the staged list)");
});
