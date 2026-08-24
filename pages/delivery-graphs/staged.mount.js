// pages/delivery-graphs/staged.mount.js — the Staged proposals App-View (ADR 0005 Decision 7, issues
// #460 + #511). The OPERATOR surface for the delivery-graph proposals an agent (or the compose view)
// has staged: it lists every LIVE staged proposal and, per row, offers
//   • Preview DI  — recompile the proposal's BPMN (with diagram interchange) and hand it UP to the host
//     console's process explorer over the `nano-navigate` bridge, rendered read-only BEFORE dispatch;
//   • Dispatch    — the operator's launch action (#460): POST the proposal's `digest` to the dispatch
//     door. Clicking Dispatch IS the approval, content-addressed to exactly the graph previewed.
//
// It REPLACES the old declarative `dataGrid` (a grid row-action can POST but cannot take the recompiled
// BPMN and `postMessage` it to the explorer — so a staged proposal had a Dispatch button but no way to
// SEE the graph, #511). This is a THIN UI over EXISTING doors — the list read (`listStagedProposals`),
// the DI recompile (`previewProposalBpmn`), and the dispatch (`dispatchDeliveryGraph`) — with no
// parallel logic. Dispatch stays OPERATOR-ONLY: this surface only ever posts a `digest` that is already
// staged; it never compiles or stages (that is the compose view), so the #460 boundary holds.
//
// A self-contained, dependency-free renderer in the SAME shape as the compose view (./mount.js) and the
// demand×supply board (pages/board/mount.js): the SAME module mounts embedded in the console (App View)
// and standalone — only the host element and injected endpoint config differ.

// The read behind the list: every live staged proposal, newest first (base-relative — a leading-slash
// path resolves against the console iframe ORIGIN, not the app-view base, and 404s the door, #279).
const DEFAULT_STAGED_URL = "app/api/delivery-graph/staged";
// The operator dispatch door: POST { digest } → launches the staged graph engine-natively (#460).
const DEFAULT_DISPATCH_URL = "app/api/actions/delivery-graph/dispatch";
// The operator dismiss door: POST { digest } → discards a staged proposal as noise, flipping it to the
// terminal `dismissed` status so it drops off the staged list (#520). Launches nothing.
const DEFAULT_DISMISS_URL = "app/api/actions/delivery-graph/dismiss";
// The read-only DI preview door: recompiles a staged proposal's BPMN (with diagram interchange) so its
// generated diagram can be rendered in the host explorer BEFORE dispatch. No deploy, no dispatch.
const DEFAULT_PROPOSAL_BPMN_URL = "app/api/actions/delivery-graph/proposal-bpmn";
// The save-to-library door: POST { name, digest } → copies this staged proposal's already-stored graph
// into the reusable library (issue #523, save-from-digest → source `from-staged`). Persists a library
// entry; it never dispatches or re-stages, so the #460 operator boundary holds.
const DEFAULT_SAVE_LIBRARY_URL = "app/api/actions/delivery-graph/library/save";

// How often the list re-polls the read door so a freshly-staged (or just-dispatched) proposal appears
// (or drops off) without a manual refresh — mirrors the 5s cadence the old declarative grid used.
const DEFAULT_REFRESH_MS = 5000;

// A bounded timeout for every door request. Without it a hung door leaves the fetch promise pending
// forever, so the busy() lock never clears and the UI is stranded; on timeout the AbortController
// rejects the fetch, surfacing as an error banner and re-enabling the controls via the finally blocks.
const REQUEST_TIMEOUT_MS = 30000;

// The confirm shown before a dispatch — dispatching authorises every side-effecting node, so the
// operator acknowledges that the launch (and its side effects) is content-addressed to this graph.
const DISPATCH_CONFIRM =
  "Dispatch this staged delivery graph? This launches the graph engine-natively — any side-effecting " +
  "node (it merges PRs / publishes packages) will run. Clicking Dispatch IS the approval, " +
  "content-addressed to exactly the graph you previewed.";

// The confirm shown before a dismiss — dismissing is a terminal discard: the proposal drops off the
// staged list for good (it can be re-staged only by recompiling). It launches nothing, so this is a
// lighter acknowledgement than Dispatch, but still a one-way action the operator confirms.
const DISMISS_CONFIRM =
  "Dismiss this staged delivery graph? It is discarded as noise and drops off the staged list — this " +
  "launches nothing, but to bring it back you must recompile/re-stage it.";

/** Escape untrusted strings before they touch innerHTML. */
function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}

/** Format an ISO timestamp for the operator, falling back to the raw value if unparseable. */
function fmtTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return esc(iso);
  return esc(new Date(t).toLocaleString());
}

/** Render one staged proposal as a card row with Preview-DI + Dispatch actions. */
function renderProposal(p) {
  const title = p.title ? `<code>${esc(p.title)}</code>` : '<span class="muted">(unnamed)</span>';
  const gate = p.sideEffecting
    ? '<span class="pill pill-connector">side-effecting</span>'
    : '<span class="pill pill-wait">no side effects</span>';
  return `<section class="card">
    <h2>${title} ${gate}</h2>
    <div class="chips">
      <span class="chip">Nodes <b>${esc(p.nodeCount)}</b></span>
      <span class="chip">Human <b>${esc(p.humanNodeCount)}</b></span>
      <span class="chip">Side effects <b>${esc(p.sideEffectCount)}</b></span>
      <span class="chip">Staged <b>${fmtTime(p.createdAt)}</b></span>
      <span class="chip">Expires <b>${fmtTime(p.expiresAt)}</b></span>
      <span class="chip">Digest <code>${esc(p.digest)}</code></span>
    </div>
    <div class="actions">
      <button class="btn btn-ghost" type="button" data-preview-di="${esc(p.digest)}">Preview generated DI</button>
      <button class="btn btn-primary" type="button" data-dispatch="${esc(p.digest)}">Dispatch</button>
      <button class="btn btn-ghost" type="button" data-save-library="${esc(p.digest)}" data-title="${esc(p.title ?? "")}">Save to library</button>
      <button class="btn btn-ghost" type="button" data-dismiss="${esc(p.digest)}">Dismiss</button>
    </div>
  </section>`;
}

/** Render the whole list (or the empty state). */
function renderList(proposals) {
  if (!Array.isArray(proposals) || proposals.length === 0) {
    return `<section class="card">
      <h2>Staged proposals <span class="count">0</span></h2>
      <p class="muted">No staged proposals awaiting dispatch. Compile a graph (as an agent) or preview + stage one in the compose view above, then Preview &amp; Dispatch it here.</p>
    </section>`;
  }
  const header = `<section class="card card-ok">
    <h2>Staged proposals <span class="count">${proposals.length}</span></h2>
    <p class="ok">Awaiting an operator. <b>Preview generated DI</b> renders the laid-out BPMN in the process explorer; <b>Dispatch</b> launches it (dispatch is the approval, #460).</p>
  </section>`;
  return header + proposals.map(renderProposal).join("");
}

// Only attach the guard secret when the resolved door URL is SAME-ORIGIN. The staged/dispatch/dismiss/
// proposal-bpmn/save-library door URLs can be overridden (e.g. via the standalone `?staged=` /
// `?dispatch=` / `?proposal-bpmn=` query params) to a full `https://…` URL on a foreign origin; sending
// `x-hook-secret` there would exfiltrate the shared guard secret to an arbitrary host. A cross-origin
// (or unparseable, or non-browser) target therefore gets no secret.
function isSameOrigin(url) {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch (_e) {
    return false;
  }
}

/**
 * Mount the staged-proposals list into `host`.
 * @param {Element|null} host — the element to render into (or null → look up #delivery-graphs-staged-root).
 * @param {{stagedUrl?:string, dispatchUrl?:string, dismissUrl?:string, proposalBpmnUrl?:string, saveLibraryUrl?:string, hookSecret?:string, refreshMs?:number}} [config]
 */
export function mountStagedProposals(host, config = {}) {
  const isElement = host != null && host.nodeType === 1 && typeof host.innerHTML === "string";
  const root = isElement ? host : document.getElementById("delivery-graphs-staged-root");
  if (!root) return () => {};

  const stagedUrl = config.stagedUrl ?? DEFAULT_STAGED_URL;
  const dispatchUrl = config.dispatchUrl ?? DEFAULT_DISPATCH_URL;
  const dismissUrl = config.dismissUrl ?? DEFAULT_DISMISS_URL;
  const proposalBpmnUrl = config.proposalBpmnUrl ?? DEFAULT_PROPOSAL_BPMN_URL;
  const saveLibraryUrl = config.saveLibraryUrl ?? DEFAULT_SAVE_LIBRARY_URL;
  const refreshMs = typeof config.refreshMs === "number" && config.refreshMs > 0 ? config.refreshMs : DEFAULT_REFRESH_MS;
  const headers = (url) => ({
    "content-type": "application/json",
    ...(config.hookSecret && isSameOrigin(url) ? { "x-hook-secret": config.hookSecret } : {}),
  });

  root.innerHTML = `<div class="dg">
    <div class="actions">
      <span id="dg-staged-status" class="status"></span>
    </div>
    <div id="dg-staged-list"></div>
  </div>`;

  const statusEl = root.querySelector("#dg-staged-status");
  const listEl = root.querySelector("#dg-staged-list");

  function setStatus(text, tone) {
    statusEl.textContent = text || "";
    statusEl.className = "status" + (tone ? " status-" + tone : "");
  }

  let busyCount = 0;
  // A re-render (renderList → new buttons) resets every button to enabled, so the disabled state is
  // NOT stored on the elements — it is derived from busyCount and re-applied after each render (below)
  // and on every busy()/idle() transition. That keeps a poll or dispatch-driven refresh from silently
  // re-enabling the buttons while a Preview/Dispatch request is still in flight.
  function applyDisabled() {
    const disabled = busyCount > 0;
    for (const btn of listEl.querySelectorAll("button")) btn.disabled = disabled;
  }
  function busy(on) {
    busyCount += on ? 1 : -1;
    applyDisabled();
  }

  /** Fetch JSON from a door and return { status, body } (never throws on an HTTP error). Rejects
   * (AbortError) if the request outlives REQUEST_TIMEOUT_MS so a hung door can't wedge the busy lock. */
  async function request(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, headers: headers(url), signal: controller.signal });
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

  const get = (url) => request(url, { method: "GET" });
  const post = (url, payload) => request(url, { method: "POST", body: JSON.stringify(payload) });

  let disposed = false;
  // True while the last completed load failed — so a subsequent successful load knows to clear its own
  // stale error banner, WITHOUT clobbering a transient action toast (Preview/Dispatch ok/err message).
  let loadErrorShown = false;

  async function refresh() {
    try {
      const { status, body } = await get(stagedUrl);
      if (disposed) return;
      if (status === 200 && Array.isArray(body.proposals)) {
        listEl.innerHTML = renderList(body.proposals);
        applyDisabled();
        if (loadErrorShown) {
          setStatus("");
          loadErrorShown = false;
        }
      } else {
        listEl.innerHTML = renderList([]);
        applyDisabled();
        setStatus(body && body.error ? body.error : "Could not load staged proposals.", "err");
        loadErrorShown = true;
      }
    } catch (err) {
      if (disposed) return;
      setStatus(err && err.message ? err.message : "Staged-proposals request failed.", "err");
      loadErrorShown = true;
    }
  }

  // "Preview generated DI": recompile the proposal's BPMN (with diagram interchange) and hand it to the
  // host console's process explorer, which renders it read-only in a definition-preview view. We run
  // inside the console App-View iframe, so we fetch from our OWN nwf door (same origin as this app) and
  // pass the XML UP to the console over the nano-navigate bridge — the XML is far larger than a URL
  // budget, so it travels in the message, not the path. Standalone (not embedded) there is no host
  // explorer to drive, so we say so instead of failing silently.
  const isEmbedded = typeof window !== "undefined" && window.parent && window.parent !== window;
  async function doPreviewDi(digest) {
    const staged = typeof digest === "string" ? digest.trim() : "";
    if (staged === "") return;
    if (!isEmbedded) {
      setStatus("Open this page inside the console cockpit to preview the generated DI.", "err");
      return;
    }
    busy(true);
    setStatus("Compiling DI…");
    try {
      const { status, body } = await post(proposalBpmnUrl, { digest: staged });
      if (status === 200 && body.ok && typeof body.bpmn === "string" && body.bpmn.trim() !== "") {
        window.parent.postMessage(
          { type: "nano-navigate", target: "definitionPreview", params: { xml: body.bpmn } },
          window.location.origin,
        );
        setStatus("\u2713 Opening the generated DI in the process explorer…", "ok");
      } else {
        setStatus(body && body.error ? body.error : "Could not compile the DI for this proposal.", "err");
      }
    } catch (err) {
      setStatus(err && err.message ? err.message : "DI preview request failed.", "err");
    } finally {
      busy(false);
    }
  }

  // "Dispatch": the operator's launch (#460). Confirm (dispatch authorises every side-effecting node),
  // then POST the digest to the dispatch door; on success the proposal flips to `dispatched` and drops
  // off the list on the next poll — refresh immediately so the operator sees it leave.
  async function doDispatch(digest) {
    const staged = typeof digest === "string" ? digest.trim() : "";
    if (staged === "") return;
    if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(DISPATCH_CONFIRM)) {
      return;
    }
    busy(true);
    setStatus("Dispatching…");
    try {
      const { status, body } = await post(dispatchUrl, { digest: staged });
      if ((status === 202 || status === 200) && body.ok) {
        setStatus("\u2713 Dispatched — the run is now in flight.", "ok");
        await refresh();
      } else {
        setStatus(body && body.error ? body.error : "Dispatch failed.", "err");
      }
    } catch (err) {
      setStatus(err && err.message ? err.message : "Dispatch request failed.", "err");
    } finally {
      busy(false);
    }
  }

  // "Dismiss": the operator's discard (#520). Confirm (dismiss is a one-way drop off the staged list),
  // then POST the digest to the dismiss door; on success the proposal flips to `dismissed` and drops off
  // the list on the next poll — refresh immediately so the operator sees it leave. Launches nothing.
  async function doDismiss(digest) {
    const staged = typeof digest === "string" ? digest.trim() : "";
    if (staged === "") return;
    if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(DISMISS_CONFIRM)) {
      return;
    }
    busy(true);
    setStatus("Dismissing…");
    try {
      const { status, body } = await post(dismissUrl, { digest: staged });
      if ((status === 200 || status === 202) && body.ok) {
        setStatus("\u2713 Dismissed — the proposal is off the staged list.", "ok");
        await refresh();
      } else {
        setStatus(body && body.error ? body.error : "Dismiss failed.", "err");
      }
    } catch (err) {
      setStatus(err && err.message ? err.message : "Dismiss request failed.", "err");
    } finally {
      busy(false);
    }
  }

  // "Save to library": copy this staged proposal's already-stored graph into the reusable library
  // (issue #523, save-from-digest → source `from-staged`). Prompt the operator for the entry name
  // (defaulting to the proposal title — its slug/short-hash derive the library id, so re-saving the
  // same name upserts), then POST { name, digest } to the save door. This persists a library entry
  // only — it never dispatches or re-stages, so the operator boundary the staged view enforces (#460)
  // is untouched.
  async function doSaveToLibrary(digest, defaultName) {
    const staged = typeof digest === "string" ? digest.trim() : "";
    if (staged === "") return;
    let name = defaultName ? String(defaultName) : "";
    if (typeof window !== "undefined" && typeof window.prompt === "function") {
      const entered = window.prompt("Save to library as (name):", name);
      if (entered === null) return; // operator cancelled
      name = entered;
    }
    if (name.trim() === "") {
      setStatus("A library entry needs a non-blank name.", "err");
      return;
    }
    busy(true);
    setStatus("Saving to library…");
    try {
      const { status, body } = await post(saveLibraryUrl, { name: name.trim(), digest: staged });
      if (status === 200 && body.ok) {
        setStatus("\u2713 Saved to the library \u2014 reuse it from the Library view.", "ok");
      } else {
        setStatus(body && body.error ? body.error : "Save to library failed.", "err");
      }
    } catch (err) {
      setStatus(err && err.message ? err.message : "Save-to-library request failed.", "err");
    } finally {
      busy(false);
    }
  }

  listEl.addEventListener("click", (ev) => {
    const previewBtn = ev.target && ev.target.closest ? ev.target.closest("[data-preview-di]") : null;
    if (previewBtn) {
      ev.preventDefault();
      doPreviewDi(previewBtn.getAttribute("data-preview-di"));
      return;
    }
    const dispatchBtn = ev.target && ev.target.closest ? ev.target.closest("[data-dispatch]") : null;
    if (dispatchBtn) {
      ev.preventDefault();
      doDispatch(dispatchBtn.getAttribute("data-dispatch"));
      return;
    }
    const saveLibraryBtn = ev.target && ev.target.closest ? ev.target.closest("[data-save-library]") : null;
    if (saveLibraryBtn) {
      ev.preventDefault();
      doSaveToLibrary(saveLibraryBtn.getAttribute("data-save-library"), saveLibraryBtn.getAttribute("data-title"));
      return;
    }
    const dismissBtn = ev.target && ev.target.closest ? ev.target.closest("[data-dismiss]") : null;
    if (dismissBtn) {
      ev.preventDefault();
      doDismiss(dismissBtn.getAttribute("data-dismiss"));
    }
  });

  refresh();
  // Skip a scheduled poll while a Preview/Dispatch request is in flight: re-rendering the list mid-
  // request would drop the in-flight button (and its disabled state) out from under the user. The
  // dispatch path drives its own refresh() on completion, so nothing is missed.
  const timer = setInterval(() => {
    if (busyCount === 0) refresh();
  }, refreshMs);

  return () => {
    disposed = true;
    clearInterval(timer);
    root.innerHTML = "";
  };
}
