// pages/delivery-graphs/mount.js — the Delivery Graphs compose → preview → dispatch view (ADR 0005,
// issue #441). The human front door for a delivery graph: author/paste a `DeliveryGraph` JSON,
// PREVIEW it (a pure compile — nothing is dispatched) to SEE the rendered plan before approving it,
// then DISPATCH it through the gated two-step.
//
// A self-contained, dependency-free renderer in the SAME shape as the demand×supply board
// (pages/board/mount.js) and the agent cockpit: the SAME module mounts embedded in the console (App
// View) and standalone on a phone — only the host element and injected endpoint config differ. The app
// has no browser build step, so this consumes the preview/dispatch doors straight off the wire.
//
// It is a THIN UI over the EXISTING doors — there is no parallel compile/dispatch path:
//   • PREVIEW  → POST previewUrl  (previewDeliveryGraph)  — pure; renders the mermaid `diagram`, the
//                `humanNodes[]` stop-points, the `sideEffects[]` the operator is asked to approve, and
//                path-qualified validation `errors[]` inline for a 400 (the fix-and-recompile loop).
//   • DISPATCH → POST dispatchUrl (dispatchDeliveryGraph → startDeliveryGraph) — the gated two-step:
//                a side-effecting graph parks `awaiting-approval` (400 + `approvalToken`); the view
//                shows the side-effect summary and, on confirm, re-submits with `approve` → 202
//                running. A graph with only `wait`/`human` nodes dispatches without approval.

const DEFAULT_PREVIEW_URL = "app/api/actions/delivery-graph/preview";
const DEFAULT_DISPATCH_URL = "app/api/actions/delivery-graph/dispatch";

// A bounded timeout for every door request. Without it a hung preview/dispatch endpoint leaves the
// fetch promise pending forever, so the busy() lock never clears and the UI is stranded (buttons
// disabled, status stuck) with no way to retry. On timeout the AbortController rejects the fetch,
// which surfaces as an error banner and re-enables the controls via the callers' finally blocks.
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

/** Render the side-effects table — WHAT the graph will do (what approval authorises, Decision 7). */
function renderSideEffects(sideEffects) {
  const rows = Array.isArray(sideEffects) ? sideEffects : [];
  if (rows.length === 0) {
    return '<section class="card"><h2>Side effects <span class="count">0</span></h2><p class="ok">No side effects — this graph has only <code>wait</code>/<code>human</code> nodes, so it dispatches without approval.</p></section>';
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
    <p class="warn">These actions the graph WILL perform once dispatched — approving the preview authorises them.</p>
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

/** Render the successful preview: summary chips, the human/side-effect tables, and the mermaid source. */
function renderPreview(result) {
  const title = result.title ? `<code>${esc(result.title)}</code>` : '<span class="muted">(unnamed)</span>';
  const gate = result.sideEffecting
    ? '<span class="pill pill-connector">requires approval</span>'
    : '<span class="pill pill-wait">no approval needed</span>';
  const summary = `<section class="card">
    <h2>Preview ${gate}</h2>
    <p class="muted">Pure compile — nothing was dispatched. Review the plan below, then Dispatch it.</p>
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

/** Render the dispatch outcome banner (running / already-running). */
function renderDispatched(result) {
  const already = result.alreadyRunning
    ? ' <span class="muted">(re-dispatch short-circuited onto the already-running run)</span>'
    : "";
  return `<section class="card card-ok">
    <h2>Dispatched — ${esc(result.status || "running")}${already}</h2>
    <p class="ok">Watch it advance in the in-flight grid below.</p>
    <div class="chips">
      ${result.runKey ? `<span class="chip">Run <code>${esc(result.runKey)}</code></span>` : ""}
      ${result.processInstanceKey ? `<span class="chip">Instance <code>${esc(result.processInstanceKey)}</code></span>` : ""}
      ${result.processDefinitionId ? `<span class="chip">Definition <code>${esc(result.processDefinitionId)}</code></span>` : ""}
    </div>
  </section>`;
}

/**
 * Mount the compose → preview → dispatch view into `host`.
 * @param {Element|null} host — the element to render into (or null → look up #delivery-graphs-root).
 * @param {{previewUrl?:string, dispatchUrl?:string, hookSecret?:string}} [config]
 */
export function mountDeliveryGraphs(host, config = {}) {
  const isElement = host != null && host.nodeType === 1 && typeof host.innerHTML === "string";
  const root = isElement ? host : document.getElementById("delivery-graphs-root");
  if (!root) return () => {};

  const previewUrl = config.previewUrl ?? DEFAULT_PREVIEW_URL;
  const dispatchUrl = config.dispatchUrl ?? DEFAULT_DISPATCH_URL;
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
      <label class="idem"><span>Idempotency key <span class="muted">(optional — a re-dispatch with the same key won't double-launch)</span></span><input id="dg-idem" class="input" type="text" placeholder="(optional)" /></label>
      <div class="actions">
        <button id="dg-preview" class="btn btn-primary" type="button">Preview</button>
        <button id="dg-dispatch" class="btn" type="button">Dispatch</button>
        <button id="dg-example" class="btn btn-ghost" type="button">Load example</button>
        <span id="dg-status" class="status"></span>
      </div>
    </section>
    <div id="dg-approval"></div>
    <div id="dg-output"></div>
  </div>`;

  const jsonEl = root.querySelector("#dg-json");
  const idemEl = root.querySelector("#dg-idem");
  const statusEl = root.querySelector("#dg-status");
  const outputEl = root.querySelector("#dg-output");
  const approvalEl = root.querySelector("#dg-approval");
  const previewBtn = root.querySelector("#dg-preview");
  const dispatchBtn = root.querySelector("#dg-dispatch");
  const exampleBtn = root.querySelector("#dg-example");

  function setStatus(text, tone) {
    statusEl.textContent = text || "";
    statusEl.className = "status" + (tone ? " status-" + tone : "");
  }

  function busy(on) {
    previewBtn.disabled = on;
    dispatchBtn.disabled = on;
  }

  // While a side-effecting graph is parked awaiting approval, LOCK the compose inputs so the operator
  // cannot edit `graphJson`/idempotency key out from under the token they are about to approve — the
  // approval must bind to the exact graph that was previewed and parked (the server derives the
  // approval digest from whatever body it receives, so an edited textarea would silently approve a
  // DIFFERENT graph). `doApprove` dispatches the FROZEN graph captured at park time, not the live field.
  function lockCompose(on) {
    jsonEl.readOnly = on;
    idemEl.readOnly = on;
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

  function idempotencyKey() {
    const v = idemEl.value.trim();
    return v === "" ? undefined : v;
  }

  async function doPreview() {
    approvalEl.innerHTML = "";
    lockCompose(false);
    if (graphJson().trim() === "") {
      setStatus("Paste a delivery-graph JSON to preview.", "err");
      return;
    }
    busy(true);
    setStatus("Compiling preview…");
    try {
      const { status, body } = await post(previewUrl, { graphJson: graphJson() });
      if (status === 200 && body.ok) {
        outputEl.innerHTML = renderPreview(body);
        setStatus("\u2713 Compiled — nothing was dispatched.", "ok");
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

  /** Show the approval confirmation panel for a side-effecting graph parked awaiting-approval. The
   * `frozen` graph/idempotency key are the EXACT values that produced this park — on confirm we
   * dispatch those, never the (now-locked) live fields, so approval binds to the previewed graph. */
  function showApproval(parked, frozen) {
    approvalEl.innerHTML = `<section class="card card-warn">
      <h2>Approval required</h2>
      <p class="warn">${esc(parked.message || "This graph performs side effects and needs explicit approval to dispatch.")}</p>
      <p class="muted">Approval token <code>${esc(parked.approvalToken || parked.digest || "")}</code>. Approving confirms the side effects rendered in the preview above.</p>
      <div class="actions">
        <button id="dg-approve" class="btn btn-primary" type="button">Approve &amp; dispatch</button>
        <button id="dg-cancel" class="btn btn-ghost" type="button">Cancel</button>
      </div>
    </section>`;
    approvalEl.querySelector("#dg-cancel").addEventListener("click", () => {
      approvalEl.innerHTML = "";
      lockCompose(false);
      setStatus("Dispatch cancelled — the graph was not approved.", "");
    });
    approvalEl.querySelector("#dg-approve").addEventListener("click", () => doDispatch(true, frozen));
  }

  async function doDispatch(approve, frozen) {
    // On approve, dispatch the graph FROZEN at park time; otherwise read the live compose fields.
    const graph = frozen ? frozen.graphJson : graphJson();
    if (graph.trim() === "") {
      setStatus("Paste a delivery-graph JSON to dispatch.", "err");
      return;
    }
    busy(true);
    setStatus(approve ? "Approving & dispatching…" : "Dispatching…");
    try {
      const payload = { graphJson: graph, approve: approve === true };
      const idem = frozen ? frozen.idempotencyKey : idempotencyKey();
      if (idem !== undefined) payload.idempotencyKey = idem;
      const { status, body } = await post(dispatchUrl, payload);
      if (status === 202 && body.ok) {
        approvalEl.innerHTML = "";
        lockCompose(false);
        outputEl.innerHTML = renderDispatched(body);
        setStatus("\u2713 Dispatched.", "ok");
      } else if (status === 400 && body.status === "awaiting-approval") {
        // The gated two-step: a side-effecting graph parked at approval. Freeze the exact graph +
        // idempotency key that parked and lock the compose inputs, then surface the confirm panel; the
        // operator's confirm re-submits THAT frozen graph with approve=true → 202 running.
        lockCompose(true);
        showApproval(body, { graphJson: graph, idempotencyKey: idem });
        setStatus("Approval required before this side-effecting graph can dispatch.", "warn");
      } else {
        approvalEl.innerHTML = "";
        lockCompose(false);
        outputEl.innerHTML = renderErrors(body.error, body.errors);
        setStatus("Dispatch refused — fix the errors and try again.", "err");
      }
    } catch (err) {
      outputEl.innerHTML = renderErrors(err && err.message ? err.message : String(err), []);
      setStatus("Dispatch request failed.", "err");
    } finally {
      busy(false);
    }
  }

  previewBtn.addEventListener("click", doPreview);
  dispatchBtn.addEventListener("click", () => doDispatch(false));
  exampleBtn.addEventListener("click", () => {
    jsonEl.value = EXAMPLE_GRAPH;
    approvalEl.innerHTML = "";
    outputEl.innerHTML = "";
    setStatus("Example loaded — Preview it.", "");
  });

  return () => {
    root.innerHTML = "";
  };
}
