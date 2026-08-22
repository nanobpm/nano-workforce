// pages/delivery-graphs/mount.js — the Delivery Graphs compose → preview → STAGE view (ADR 0005,
// issues #441 + #460). The human front door for a delivery graph: author/paste a `DeliveryGraph` JSON
// and PREVIEW it — a compile that renders the plan (mermaid `diagram`, the `humanNodes[]` stop-points,
// the `sideEffects[]` a dispatch will perform) AND stages it as a proposal for dispatch.
//
// Dispatch is deliberately NOT here (issue #460): it is an OPERATOR action on the **Staged proposals**
// grid on the same page (the Dispatch row-action, which posts the proposal's `digest`). Removing the
// dispatch affordance from every agent-reachable seam closes the self-approval hole the old replayable
// approval token (a content digest handed back to the same caller) left open — this view only ever
// stages, never launches.
//
// A self-contained, dependency-free renderer in the SAME shape as the demand×supply board
// (pages/board/mount.js) and the agent cockpit: the SAME module mounts embedded in the console (App
// View) and standalone on a phone — only the host element and injected endpoint config differ. The app
// has no browser build step, so this consumes the preview door straight off the wire.
//
// It is a THIN UI over the EXISTING door — there is no parallel compile/stage path:
//   • PREVIEW & STAGE → POST previewUrl (previewDeliveryGraph) — renders the mermaid `diagram`, the
//     `humanNodes[]` stop-points, the `sideEffects[]` a dispatch will perform, and path-qualified
//     validation `errors[]` inline for a 400 (the fix-and-recompile loop); on success the compiled
//     graph is STAGED as a proposal (an operator dispatches it from the Staged proposals grid below).

const DEFAULT_PREVIEW_URL = "app/api/actions/delivery-graph/preview";

// A bounded timeout for every door request. Without it a hung preview endpoint leaves the fetch
// promise pending forever, so the busy() lock never clears and the UI is stranded (buttons disabled,
// status stuck) with no way to retry. On timeout the AbortController rejects the fetch, which surfaces
// as an error banner and re-enables the controls via the callers' finally blocks.
const REQUEST_TIMEOUT_MS = 30000;

const EXAMPLE_GRAPH = JSON.stringify(
  {
    name: "example-runbook",
    nodes: [
      { id: "build", kind: "agent", agent: { jobType: "senior:feature" }, emits: [{ name: "pr", type: "url" }] },
      { id: "soak", kind: "wait", wait: { target: "checks-green" } },
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

/** Render the successful preview: the staged banner, summary chips, the human/side-effect tables, and
 * the mermaid source. Dispatch is NOT offered here — the operator dispatches the staged proposal from
 * the Staged proposals grid below (issue #460). */
function renderPreview(result) {
  const title = result.title ? `<code>${esc(result.title)}</code>` : '<span class="muted">(unnamed)</span>';
  const gate = result.sideEffecting
    ? '<span class="pill pill-connector">side-effecting</span>'
    : '<span class="pill pill-wait">no side effects</span>';
  const summary = `<section class="card card-ok">
    <h2>Staged ${gate}</h2>
    <p class="ok">Compiled and staged as a proposal. Dispatch is an operator action — review it in the <b>Staged proposals</b> grid below and click <b>Dispatch</b> on the one you approve.</p>
    <div class="chips">
      <span class="chip">Graph ${title}</span>
      <span class="chip">Nodes <b>${esc(result.nodeCount)}</b></span>
      <span class="chip">Human <b>${esc(result.humanNodeCount)}</b></span>
      <span class="chip">Side effects <b>${esc(result.sideEffectCount)}</b></span>
      <span class="chip">Digest <code>${esc(result.digest)}</code></span>
    </div>
  </section>`;
  const diagram = `<section class="card">
    <h2>Diagram <span class="muted">(mermaid flowchart source)</span></h2>
    <p class="muted">The resolved graph as a mermaid <code>flowchart</code>. Paste it into any mermaid renderer, or follow a dispatched run into the process explorer for the live laid-out model.</p>
    <pre class="diagram">${esc(result.diagram)}</pre>
  </section>`;
  return summary + renderSideEffects(result.sideEffects) + renderHumanNodes(result.humanNodes) + diagram;
}

/**
 * Mount the compose → preview → stage view into `host`.
 * @param {Element|null} host — the element to render into (or null → look up #delivery-graphs-root).
 * @param {{previewUrl?:string, hookSecret?:string}} [config]
 */
export function mountDeliveryGraphs(host, config = {}) {
  const isElement = host != null && host.nodeType === 1 && typeof host.innerHTML === "string";
  const root = isElement ? host : document.getElementById("delivery-graphs-root");
  if (!root) return () => {};

  const previewUrl = config.previewUrl ?? DEFAULT_PREVIEW_URL;
  const headers = () => ({
    "content-type": "application/json",
    ...(config.hookSecret ? { "x-hook-secret": config.hookSecret } : {}),
  });

  // The static compose shell. The <textarea> is a real element (its value must survive re-renders of
  // the output panes), so it is created once and never clobbered.
  root.innerHTML = `<div class="dg">
    <section class="card">
      <h2>1 · Compose</h2>
      <p class="muted">Paste or author a <code>DeliveryGraph</code> JSON (nodes/edges over the closed <code>agent</code>/<code>wait</code>/<code>human</code>/<code>connector</code> vocabulary).</p>
      <textarea id="dg-json" class="json" spellcheck="false" placeholder='{ "name": "…", "nodes": [ … ], "edges": [ … ] }'></textarea>
      <div class="actions">
        <button id="dg-preview" class="btn btn-primary" type="button">Preview &amp; stage</button>
        <button id="dg-example" class="btn btn-ghost" type="button">Load example</button>
        <span id="dg-status" class="status"></span>
      </div>
    </section>
    <div id="dg-output"></div>
  </div>`;

  const jsonEl = root.querySelector("#dg-json");
  const statusEl = root.querySelector("#dg-status");
  const outputEl = root.querySelector("#dg-output");
  const previewBtn = root.querySelector("#dg-preview");
  const exampleBtn = root.querySelector("#dg-example");

  function setStatus(text, tone) {
    statusEl.textContent = text || "";
    statusEl.className = "status" + (tone ? " status-" + tone : "");
  }

  function busy(on) {
    previewBtn.disabled = on;
    exampleBtn.disabled = on;
  }

  /** POST a JSON body to a door and return { status, body } (never throws on an HTTP error). Rejects
   * (AbortError) if the request outlives REQUEST_TIMEOUT_MS so a hung door can't wedge the busy lock. */
  async function post(url, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: headers(),
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

  async function doPreview() {
    if (graphJson().trim() === "") {
      setStatus("Paste a delivery-graph JSON to preview.", "err");
      return;
    }
    busy(true);
    setStatus("Compiling & staging…");
    try {
      const { status, body } = await post(previewUrl, { graphJson: graphJson() });
      if (status === 200 && body.ok) {
        outputEl.innerHTML = renderPreview(body);
        setStatus("\u2713 Staged — dispatch it from the Staged proposals grid below.", "ok");
      } else {
        outputEl.innerHTML = renderErrors(body.error, body.errors);
        setStatus("Preview failed — fix the errors and re-preview.", "err");
      }
    } catch (err) {
      outputEl.innerHTML = renderErrors(err && err.message ? err.message : String(err), []);
      setStatus("Preview request failed.", "err");
    } finally {
      busy(false);
    }
  }

  previewBtn.addEventListener("click", doPreview);
  exampleBtn.addEventListener("click", () => {
    jsonEl.value = EXAMPLE_GRAPH;
    outputEl.innerHTML = "";
    setStatus("Example loaded — Preview & stage it.", "");
  });

  return () => {
    root.innerHTML = "";
  };
}
