// pages/delivery-graphs/mount.js — the Delivery Graphs COMPOSE → PREVIEW / STAGE view (ADR 0005,
// issues #441 + #460 + #516). The human front door for a delivery graph: author/paste a `DeliveryGraph`
// JSON, PREVIEW it (a pure compile that renders the plan — mermaid `diagram`, the `humanNodes[]`
// stop-points, the `sideEffects[]` a dispatch will perform — and the laid-out BPMN in the host
// explorer), and, as a SEPARATE deliberate action, STAGE it as a proposal for dispatch.
//
// Preview and Stage are separate (issue #516): Preview compiles WITHOUT persisting, so an operator can
// inspect and iterate on a graph before committing it to the Staged-proposals list. Dispatch is NOT
// here (issue #460): it is an OPERATOR action on the **Staged proposals** grid on the same page.
// Removing the dispatch affordance from every agent-reachable seam closes the self-approval hole the
// old replayable approval token left open — this view only ever previews/stages, never launches.
//
// A self-contained, dependency-free renderer in the SAME shape as the demand×supply board
// (pages/board/mount.js) and the agent cockpit: the SAME module mounts embedded in the console (App
// View) and standalone on a phone — only the host element and injected endpoint config differ. The app
// has no browser build step, so this consumes the preview/stage doors straight off the wire.

// Door defaults are anchored to THIS MODULE's url (import.meta.url), NOT the document base. The compose
// shell (embed.html / standalone.html) — and therefore this mount.js — is served ONE DIRECTORY DEEP at
// `<appMount>/delivery-graphs/`, while the preview/stage doors are siblings of that dir at
// `<appMount>/app/api/…`. A document-base-relative default resolves against the `…/delivery-graphs/`
// shell base → `…/delivery-graphs/app/api/…` → 404 on every surface (the Studio console App-View never
// injects window.__NANO_APP_VIEW__, so the default is what runs); a leading-slash absolute resolves
// against the console ORIGIN through Studio (#279). `../app/api/…` off import.meta.url steps up out of
// `/delivery-graphs/` onto `<appMount>/app/api/…` on all surfaces — the cockpit's #467 fix.
const DEFAULT_PREVIEW_URL = new URL("../app/api/actions/delivery-graph/preview", import.meta.url).href;
const DEFAULT_STAGE_URL = new URL("../app/api/actions/delivery-graph/stage", import.meta.url).href;

// The filesystem IMPORT door (issue #524, epic #519 S5). The Import control below reads a chosen
// `.json` file's text client-side and POSTs it here; the door validates + compiles it and persists it
// to the library with `source: imported`. Module-anchored off import.meta.url like the preview/stage
// defaults (App-View #279/#467/#536 resolution class — a document-base-relative default 404s under the
// `…/delivery-graphs/` shell base, a leading-slash absolute resolves against the console origin).
const DEFAULT_IMPORT_URL = new URL("../app/api/actions/delivery-graph/library/import", import.meta.url).href;

// The INBOUND reuse-fill seam (issue #523, epic #519 S4). Until now the compose textarea (`#dg-json`)
// had NO inbound prefill path — its value was set only by "Load example" or the operator typing. The
// Library App-View's per-row **Reuse** (this wave) loads a saved graph into the composer by posting a
// host-bridge message of this shape, which reaches this compose App-View window:
//
//     { type: DG_COMPOSE_FILL_MESSAGE, graphJson: "<a DeliveryGraph JSON string>" }
//
// It is the INBOUND twin of the OUTBOUND `nano-navigate` bridge already used for "Preview generated
// DI": a small, typed postMessage envelope across the App-View iframe boundary. The shape is declared
// once in app/contracts.ts as the `deliveryGraph.compose.fill` wire contract, and this string is the
// ONE source of truth for its `type` — the Library Reuse producer imports it from here rather than
// re-declaring a synonym. The filesystem **Import** control (#524, sequenced AFTER this) does NOT use
// this cross-frame message — it lives in THIS same mount, so it fills directly through `fillComposer()`
// below. Every fill (this message-driven bridge, or a same-mount caller like the #524 file input)
// routes through the single `fillComposer()` seam below; keep new fill sources going through it.
export const DG_COMPOSE_FILL_MESSAGE = "nano-delivery-graph-compose-fill";

// The ACK half of the reuse-fill bridge (issue #645). An optimistic "✓ Loaded…" toast printed
// synchronously after the Library posts the fill can never reflect the cross-frame OUTCOME — the fill
// message is relayed across App-Views (nano-ide #518) and could still be dropped (no relay, wrong
// origin, a compose view that isn't mounted), yet the toast claimed success regardless (the #645
// defect). So the delivery is now ACKNOWLEDGED: when THIS compose mount actually fills from a fill
// message, it posts this ack back UP to the host (relayed across to the Library sibling), echoing the
// producer's correlation `token`. The Library shows "✓ Loaded…" ONLY on that ack and a clear error on a
// short timeout — the success is earned, not assumed. The `type` is exported ONCE here as the single
// source of truth; the Library consumer imports it rather than re-declaring a synonym.
export const DG_COMPOSE_FILL_ACK_MESSAGE = "nano-delivery-graph-compose-fill-ack";

// The host acknowledgment of a `nano-navigate` (issue #645). "Preview generated DI" posts nano-navigate
// UP to the console; nano-ide #518 forwards it to the host explorer, but the host does not synchronously
// confirm, so an optimistic "✓ Opening…" toast printed right after the post claimed success even when the
// message was dropped (standalone, no relay, a console that never navigated). The compose view now treats
// Preview as fire-to-host with a bounded budget: it shows a NEUTRAL in-progress status, and only earns a
// "✓" when the host echoes this ack for the same `target`; if no host ack is observed within the budget it
// surfaces "Couldn't reach the console explorer" instead. Same-origin, from the parent (the console).
export const NANO_NAVIGATE_ACK_MESSAGE = "nano-navigate-ack";

// The bounded budget within which a cross-frame delivery (compose-fill relay, or a nano-navigate to the
// host) must be acknowledged before the producer surfaces an honest "couldn't reach …" error (#645). A
// couple of seconds is long enough for the App-View relay round-trip yet short enough that a dropped
// message fails fast instead of leaving a misleading toast up. Overridable via config for tests.
const ACK_TIMEOUT_MS = 2000;

// A bounded timeout for every door request. Without it a hung endpoint leaves the fetch promise pending
// forever, so the busy() lock never clears and the UI is stranded (buttons disabled, status stuck) with
// no way to retry. On timeout the AbortController rejects the fetch, which surfaces as an error banner
// and re-enables the controls via the callers' finally blocks.
const REQUEST_TIMEOUT_MS = 30000;

export const EXAMPLE_GRAPH = JSON.stringify(
  {
    name: "example-runbook",
    nodes: [
      { id: "build", kind: "agent", agent: { jobType: "senior:feature" }, emits: [{ name: "pr", type: "url" }] },
      { id: "soak", kind: "wait", wait: { kind: "pr", target: "owner/repo#123", match: { prState: "checks-green" } } },
      { id: "signoff", kind: "human", human: { prompt: "Review the PR and approve the release." } },
      { id: "publish", kind: "connector", connector: { target: "publish-package", dedupeKey: "example-runbook-publish" } },
    ],
    edges: [
      { from: "build.pr", to: "soak" },
      { from: "soak", to: "signoff" },
      { from: "signoff", to: "publish" },
    ],
  },
  null,
  2,
);

/** Escape untrusted strings before they touch innerHTML. */
function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}

/** A small kind pill (agent / connector / wait / human). */
function pill(kind) {
  const k = String(kind ?? "").toLowerCase();
  const cls = k === "agent" || k === "connector" || k === "wait" || k === "human" ? k : "unknown";
  return `<span class="pill pill-${cls}">${esc(k || "\u2014")}</span>`;
}

/** Render a node's emitted facts (`name:type`) as a compact inline list. */
function renderEmits(emits) {
  if (!Array.isArray(emits) || emits.length === 0) return '<span class="muted">\u2014</span>';
  return emits.map((f) => `<code>${esc(f.name)}<span class="muted">:${esc(f.type)}</span></code>`).join(" ");
}

/** Render the human stop-points table — WHERE the graph parks on a person. */
function renderHumanNodes(humanNodes) {
  const rows = Array.isArray(humanNodes) ? humanNodes : [];
  if (rows.length === 0) {
    return '<section class="card"><h2>Human stop-points <span class="count">0</span></h2><p class="muted">This graph never parks on a person — it runs to completion unattended.</p></section>';
  }
  const body = rows
    .map(
      (h) => `<tr>
        <td><code>${esc(h.nodeId)}</code></td>
        <td>${h.prompt ? esc(h.prompt) : '<span class="muted">(click-done stop)</span>'}</td>
        <td>${h.formKey ? `<code>${esc(h.formKey)}</code>` : '<span class="muted">\u2014</span>'}</td>
        <td>${renderEmits(h.emits)}</td>
      </tr>`,
    )
    .join("");
  return `<section class="card">
    <h2>Human stop-points <span class="count">${rows.length}</span></h2>
    <p class="muted">Where the graph STOPS for a person (or an agent answering on their behalf).</p>
    <table class="grid"><thead><tr><th>Node</th><th>Prompt</th><th>Form</th><th>Emits</th></tr></thead><tbody>${body}</tbody></table>
  </section>`;
}

/** Render the side-effects table — WHAT the graph will do once an operator dispatches it (Decision 7). */
function renderSideEffects(sideEffects) {
  const rows = Array.isArray(sideEffects) ? sideEffects : [];
  if (rows.length === 0) {
    return '<section class="card"><h2>Side effects <span class="count">0</span></h2><p class="ok">No side effects — this graph has only <code>wait</code>/<code>human</code> nodes.</p></section>';
  }
  const body = rows
    .map(
      (s) => `<tr>
        <td><code>${esc(s.nodeId)}</code></td>
        <td>${pill(s.kind)}</td>
        <td>${esc(s.description)}</td>
        <td>${s.dedupeKey ? `<code>${esc(s.dedupeKey)}</code>` : '<span class="muted">\u2014</span>'}</td>
      </tr>`,
    )
    .join("");
  return `<section class="card card-warn">
    <h2>Side effects <span class="count">${rows.length}</span></h2>
    <p class="warn">These actions the graph WILL perform once an operator dispatches it — dispatching authorises them.</p>
    <table class="grid"><thead><tr><th>Node</th><th>Kind</th><th>Effect</th><th>Dedupe key</th></tr></thead><tbody>${body}</tbody></table>
  </section>`;
}

/** Render the path-qualified validation/compile errors inline for the fix-and-recompile loop. */
function renderErrors(message, errors) {
  const list = Array.isArray(errors) ? errors : [];
  const items = list.map((e) => `<li><code>${esc(e.path)}</code> — ${esc(e.message)}</li>`).join("");
  return `<section class="card card-err">
    <h2>Validation failed</h2>
    <p class="red">${esc(message || "The graph could not be compiled.")}</p>
    ${items ? `<ul class="errors">${items}</ul>` : ""}
  </section>`;
}

/** Render the successful result: the preview/staged banner, summary chips, the human/side-effect
 * tables, and the mermaid source. When `staged` is false (a pure Preview, #516) the banner offers
 * "Preview generated DI" (the door returns the laid-out BPMN, so it renders WITHOUT staging) and a
 * reminder that nothing is staged yet. When `staged` is true the banner points the operator at the
 * Staged proposals grid below, where the per-row Dispatch (and DI preview) live (#460 + #513). */
function renderPreview(result, staged) {
  const title = result.title ? `<code>${esc(result.title)}</code>` : '<span class="muted">(unnamed)</span>';
  const gate = result.sideEffecting
    ? '<span class="pill pill-connector">side-effecting</span>'
    : '<span class="pill pill-wait">no side effects</span>';
  const canPreviewDi = typeof result.bpmn === "string" && result.bpmn.trim() !== "";
  const summary = staged
    ? `<section class="card card-ok">
    <h2>Staged ${gate}</h2>
    <p class="ok">Compiled and staged as a proposal. Dispatch is an operator action — review it in the <b>Staged proposals</b> grid below and click <b>Dispatch</b> on the one you approve.</p>
    <div class="chips">
      <span class="chip">Graph ${title}</span>
      <span class="chip">Nodes <b>${esc(result.nodeCount)}</b></span>
      <span class="chip">Human <b>${esc(result.humanNodeCount)}</b></span>
      <span class="chip">Side effects <b>${esc(result.sideEffectCount)}</b></span>
      <span class="chip">Digest <code>${esc(result.digest)}</code></span>
    </div>
  </section>`
    : `<section class="card card-ok">
    <h2>Previewed ${gate}</h2>
    <p class="ok">Compiled — <b>not staged yet</b>. Review the plan below, then click <b>Stage</b> to add it to the Staged proposals for dispatch.</p>
    <div class="chips">
      <span class="chip">Graph ${title}</span>
      <span class="chip">Nodes <b>${esc(result.nodeCount)}</b></span>
      <span class="chip">Human <b>${esc(result.humanNodeCount)}</b></span>
      <span class="chip">Side effects <b>${esc(result.sideEffectCount)}</b></span>
      <span class="chip">Digest <code>${esc(result.digest)}</code></span>
    </div>
    ${
      canPreviewDi
        ? `<div class="actions">
      <button class="btn btn-ghost" type="button" data-preview-di>Preview generated DI</button>
      <span class="muted">the real laid-out BPMN, exactly as a dispatch would run it</span>
    </div>`
        : ""
    }
  </section>`;
  const diagram = `<section class="card">
    <h2>Diagram <span class="muted">(mermaid flowchart source)</span></h2>
    <p class="muted">The resolved graph as a mermaid <code>flowchart</code>. Paste it into any mermaid renderer${staged ? "" : ", or click <b>Preview generated DI</b> above to render the laid-out BPMN in the process explorer"}.</p>
    <pre class="diagram">${esc(result.diagram)}</pre>
  </section>`;
  return summary + renderSideEffects(result.sideEffects) + renderHumanNodes(result.humanNodes) + diagram;
}

// Only attach the guard secret when the resolved door URL is SAME-ORIGIN. The preview/stage/import door
// URLs can be overridden (e.g. via the standalone `?preview=` / `?stage=` / `?import=` query params) to a
// full `https://…`
// URL on a foreign origin; sending `x-hook-secret` there would exfiltrate the shared guard secret to an
// arbitrary host. A cross-origin (or unparseable, or non-browser) target therefore gets no secret.
function isSameOrigin(url) {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch (_e) {
    return false;
  }
}

/**
 * Mount the compose → preview / stage view into `host`.
 * @param {Element|null} host — the element to render into (or null → look up #delivery-graphs-root).
 * @param {{previewUrl?:string, stageUrl?:string, importUrl?:string, hookSecret?:string}} [config]
 */
export function mountDeliveryGraphs(host, config = {}) {
  const isElement = host != null && host.nodeType === 1 && typeof host.innerHTML === "string";
  const root = isElement ? host : document.getElementById("delivery-graphs-root");
  if (!root) return () => {};

  const previewUrl = config.previewUrl ?? DEFAULT_PREVIEW_URL;
  const stageUrl = config.stageUrl ?? DEFAULT_STAGE_URL;
  const importUrl = config.importUrl ?? DEFAULT_IMPORT_URL;
  const ackTimeoutMs =
    typeof config.ackTimeoutMs === "number" && config.ackTimeoutMs > 0 ? config.ackTimeoutMs : ACK_TIMEOUT_MS;
  const headers = (url) => ({
    "content-type": "application/json",
    ...(config.hookSecret && isSameOrigin(url) ? { "x-hook-secret": config.hookSecret } : {}),
  });

  // The static compose shell. The compose card is a native <details> so an operator can COLLAPSE the
  // large paste panel (#516) and focus on the Staged / in-flight grids, expanding it only to author.
  // The <textarea> is a real element (its value must survive re-renders of the output panes, and it is
  // only HIDDEN — never destroyed — when the panel collapses), so it is created once and never clobbered.
  root.innerHTML = `<div class="dg">
    <details id="dg-compose" class="compose card" open>
      <summary><span class="step">1 · Compose</span><span class="hint muted">paste a DeliveryGraph, then Preview or Stage</span></summary>
      <div class="compose-body">
        <p class="muted">Paste or author a <code>DeliveryGraph</code> JSON (nodes/edges over the closed <code>agent</code>/<code>wait</code>/<code>human</code>/<code>connector</code> vocabulary).</p>
        <textarea id="dg-json" class="json" spellcheck="false" placeholder='{ "name": "…", "nodes": [ … ], "edges": [ … ] }'></textarea>
        <div class="actions">
          <button id="dg-preview" class="btn btn-primary" type="button">Preview</button>
          <button id="dg-stage" class="btn" type="button">Stage</button>
          <button id="dg-example" class="btn btn-ghost" type="button">Load example</button>
          <label class="btn btn-ghost dg-import" title="Import a delivery-graph .json file into the library">
            Import file
            <input id="dg-import" class="dg-import-input" type="file" accept=".json,application/json" />
          </label>
          <span id="dg-status" class="status"></span>
        </div>
      </div>
    </details>
    <div id="dg-output"></div>
  </div>`;

  const jsonEl = root.querySelector("#dg-json");
  const statusEl = root.querySelector("#dg-status");
  const outputEl = root.querySelector("#dg-output");
  const previewBtn = root.querySelector("#dg-preview");
  const stageBtn = root.querySelector("#dg-stage");
  const exampleBtn = root.querySelector("#dg-example");
  const importInput = root.querySelector("#dg-import");
  const composeDetails = root.querySelector("#dg-compose");

  // The most recent successful PREVIEW's laid-out BPMN — bridged to the host explorer on demand (the
  // preview door returns it, so DI preview needs no staging, #516). Cleared whenever the composed graph
  // changes so a stale diagram can never be shown against edited JSON.
  let lastBpmn = "";

  function setStatus(text, tone) {
    statusEl.textContent = text || "";
    statusEl.className = "status" + (tone ? " status-" + tone : "");
  }

  function busy(on) {
    previewBtn.disabled = on;
    stageBtn.disabled = on;
    exampleBtn.disabled = on;
    if (importInput) importInput.disabled = on;
    // Lock the textarea too: an in-flight import awaits file.text() + the POST, and on success
    // fillComposer() overwrites #dg-json unconditionally — leaving it editable would let a slow import
    // silently clobber edits the operator made during the delay.
    jsonEl.disabled = on;
  }

  // The SINGLE inbound fill seam (issue #523): load a graph JSON into the composer as if the operator
  // had pasted it. It is driven by the Library Reuse host-bridge message (below) and — same-mount, no
  // bridge — by the #524 filesystem import that lands after this. It resets the previewed BPMN (so
  // "Preview generated DI" can never show a stale diagram against freshly-filled JSON), clears the old
  // output, and expands the (possibly collapsed) compose panel so the loaded graph is visible. Returns
  // true when it filled, false for a blank/non-string payload (nothing is clobbered on a bad fill).
  function fillComposer(graphJson, opts = {}) {
    if (typeof graphJson !== "string" || graphJson.trim() === "") return false;
    jsonEl.value = graphJson;
    lastBpmn = "";
    outputEl.innerHTML = "";
    if (composeDetails && !composeDetails.open) composeDetails.open = true;
    setStatus(opts.status || "Loaded into the composer \u2014 Preview or Stage it.", "ok");
    return true;
  }

  // The inbound half of the App-View bridge: fill the composer from a Library Reuse (or import)
  // message. Only a SAME-ORIGIN message of the agreed `deliveryGraph.compose.fill` shape fills — a
  // foreign origin or a mismatched shape is ignored, so this listener can't be driven by an unrelated
  // page. Registered on `window` (the message arrives on this App-View's own window) and torn down by
  // the disposer below.
  function onFillMessage(ev) {
    if (!ev || typeof window === "undefined") return;
    // Same-origin host-bridge seam: require an EXACT origin match. A missing/empty/foreign `ev.origin`
    // (a malformed or forged event, or a future browser edge case) is rejected outright — never fall
    // through to the fill just because the origin was absent.
    if (ev.origin !== window.location.origin) return;
    // The fill message is routed UP to the console and back down when embedded, so accept it only from
    // the parent frame in that case — a missing/falsy `ev.source` is rejected too, never allowed to fall
    // through; standalone, there is no parent and the import path fills directly.
    const embedded = typeof window.parent !== "undefined" && window.parent !== window;
    if (embedded && ev.source !== window.parent) return;
    const data = ev.data;
    if (!data || data.type !== DG_COMPOSE_FILL_MESSAGE || typeof data.graphJson !== "string") return;
    const filled = fillComposer(data.graphJson, { status: "Reused a saved graph \u2014 Preview or Stage it." });
    // ACK the fill back to the producer (issue #645): the Library shows "✓ Loaded…" ONLY on this ack,
    // never optimistically. Post UP to the host, which nano-ide #518 relays across to the Library
    // sibling App-View; echo the correlation `token` so a stale ack from a prior Reuse can't complete a
    // newer one. Only when actually embedded (there is a parent to relay through) and only when the fill
    // truly happened — a blank/bad payload earns no ack.
    if (
      filled &&
      embedded &&
      window.parent &&
      typeof window.parent.postMessage === "function"
    ) {
      window.parent.postMessage(
        { type: DG_COMPOSE_FILL_ACK_MESSAGE, token: typeof data.token === "string" ? data.token : null },
        window.location.origin,
      );
    }
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("message", onFillMessage);
  }

  /** POST a JSON body to a door and return { status, body } (never throws on an HTTP error). Rejects
   * (AbortError) if the request outlives REQUEST_TIMEOUT_MS so a hung door can't wedge the busy lock. */
  async function post(url, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: headers(url),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      let body = {};
      try {
        body = await res.json();
      } catch (_e) {
        body = {};
      }
      return { status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  function graphJson() {
    return jsonEl.value;
  }

  /** Shared compile driver for both Preview (stage=false) and Stage (stage=true). Both POST the pasted
   * JSON to their door and render the SAME summary; only the banner and whether a proposal was
   * persisted differ. */
  async function submit(url, staged) {
    if (graphJson().trim() === "") {
      setStatus(`Paste a delivery-graph JSON to ${staged ? "stage" : "preview"}.`, "err");
      return;
    }
    busy(true);
    setStatus(staged ? "Compiling & staging…" : "Compiling…");
    try {
      const { status, body } = await post(url, { graphJson: graphJson() });
      if (status === 200 && body.ok) {
        lastBpmn = !staged && typeof body.bpmn === "string" ? body.bpmn : lastBpmn;
        outputEl.innerHTML = renderPreview(body, staged);
        setStatus(
          staged ? "\u2713 Staged — dispatch it from the Staged proposals grid below." : "\u2713 Previewed — Stage it when you're ready.",
          "ok",
        );
      } else {
        outputEl.innerHTML = renderErrors(body.error, body.errors);
        setStatus(`${staged ? "Stage" : "Preview"} failed — fix the errors and retry.`, "err");
      }
    } catch (err) {
      outputEl.innerHTML = renderErrors(err && err.message ? err.message : String(err), []);
      setStatus(`${staged ? "Stage" : "Preview"} request failed.`, "err");
    } finally {
      busy(false);
    }
  }

  previewBtn.addEventListener("click", () => submit(previewUrl, false));
  stageBtn.addEventListener("click", () => submit(stageUrl, true));
  exampleBtn.addEventListener("click", () => {
    jsonEl.value = EXAMPLE_GRAPH;
    lastBpmn = "";
    outputEl.innerHTML = "";
    setStatus("Example loaded — Preview or Stage it.", "");
  });

  // The filesystem IMPORT control (issue #524, epic #519 S5). Read the chosen `.json` file's text
  // CLIENT-SIDE, then POST it to the importToLibrary door, which validates + compiles it and (on
  // success) persists it to the library with `source: imported`. A file that is not valid JSON, or a
  // graph that will not compile, is a clean 400 whose path-qualified errors render inline — nothing is
  // persisted. On a successful import we route the file text through the SAME `fillComposer()` seam
  // #523 introduced (no reshaping — one inbound fill path), so the imported graph appears in the
  // composer ready to Preview/Stage. The input is reset after each pick so re-choosing the same file
  // still fires `change`.
  async function importFile(file) {
    if (!file) return;
    busy(true);
    setStatus(`Importing ${file.name}\u2026`);
    try {
      const text = await file.text();
      const { status, body } = await post(importUrl, { graphJson: text });
      if (status === 200 && body.ok) {
        outputEl.innerHTML = "";
        fillComposer(text, { status: `\u2713 Imported \u201c${body.entry.name}\u201d into the library — Preview or Stage it.` });
      } else {
        outputEl.innerHTML = renderErrors(body.error, body.errors);
        setStatus("Import failed — see the details below.", "err");
      }
    } catch (err) {
      outputEl.innerHTML = renderErrors(err && err.message ? err.message : String(err), []);
      setStatus("Import request failed.", "err");
    } finally {
      busy(false);
    }
  }
  if (importInput) {
    importInput.addEventListener("change", () => {
      const file = importInput.files && importInput.files[0];
      importFile(file);
      importInput.value = "";
    });
  }
  // Any edit invalidates the previewed BPMN so "Preview generated DI" can't show a stale diagram.
  jsonEl.addEventListener("input", () => {
    lastBpmn = "";
  });

  // "Preview generated DI": hand the previewed proposal's laid-out BPMN (returned by the preview door,
  // #516) to the host console's process explorer, which renders it read-only in a definition-preview
  // view. We run inside the console App-View iframe, so we pass the XML UP to the console over the
  // nano-navigate bridge — the XML is far larger than a URL budget, so it travels in the message, not
  // the path. Standalone (not embedded) there is no host explorer to drive, so we say so instead of
  // failing silently.
  const isEmbedded = typeof window !== "undefined" && window.parent && window.parent !== window;
  // A single in-flight Preview→host handshake (issue #645). Posting nano-navigate is fire-to-host: the
  // console does not synchronously confirm it navigated, so we must not claim success up front. We hold
  // the pending target + its timeout timer here; a host ack for that target resolves it to "✓ Opened…",
  // and the timeout resolves it to an honest "Couldn't reach the console explorer". A fresh Preview
  // supersedes any pending one (its timer is cleared) so only the latest attempt is ever resolved.
  const DEFINITION_PREVIEW_TARGET = "definitionPreview";
  let pendingPreview = null;
  function clearPendingPreview() {
    if (pendingPreview && pendingPreview.timer) clearTimeout(pendingPreview.timer);
    pendingPreview = null;
  }
  function doPreviewDi() {
    if (lastBpmn.trim() === "") {
      setStatus("Preview a graph first — the laid-out BPMN comes from the preview.", "err");
      return;
    }
    if (!isEmbedded) {
      setStatus("Open this page inside the console cockpit to preview the generated DI.", "err");
      return;
    }
    clearPendingPreview();
    window.parent.postMessage(
      { type: "nano-navigate", target: "definitionPreview", params: { xml: lastBpmn } },
      window.location.origin,
    );
    // NEUTRAL in-progress status (no "✓") — the success is only earned on the host ack below (#645).
    setStatus("Opening the generated DI in the process explorer…", "");
    const timer = setTimeout(() => {
      if (!pendingPreview || pendingPreview.target !== DEFINITION_PREVIEW_TARGET) return;
      pendingPreview = null;
      setStatus("Couldn't reach the console explorer — is this page open inside the console?", "err");
    }, ackTimeoutMs);
    pendingPreview = { target: DEFINITION_PREVIEW_TARGET, timer };
  }
  // The host's acknowledgment of a Preview nano-navigate (#645): a same-origin `nano-navigate-ack` from
  // the parent (the console) for the target we're awaiting resolves the pending Preview to success. A
  // foreign origin, a non-parent source, or an ack for a different/absent target is ignored — an
  // unrelated page can't forge a success toast.
  function onNavAck(ev) {
    if (!ev || typeof window === "undefined") return;
    if (ev.origin !== window.location.origin) return;
    if (ev.source !== window.parent) return;
    const data = ev.data;
    if (!data || data.type !== NANO_NAVIGATE_ACK_MESSAGE) return;
    // Require a string `target` that exactly matches the pending preview. A target-less (or
    // mismatched) ack must NOT resolve the Preview — otherwise any same-origin parent ack could
    // forge a "✓ Opened…" toast the target never actually rendered (#645).
    if (!pendingPreview || typeof data.target !== "string" || data.target !== pendingPreview.target)
      return;
    clearPendingPreview();
    setStatus("\u2713 Opened the generated DI in the process explorer.", "ok");
  }
  if (isEmbedded && typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("message", onNavAck);
  }
  outputEl.addEventListener("click", (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest("[data-preview-di]") : null;
    if (!btn) return;
    ev.preventDefault();
    doPreviewDi();
  });

  return () => {
    clearPendingPreview();
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("message", onFillMessage);
      window.removeEventListener("message", onNavAck);
    }
    root.innerHTML = "";
  };
}
