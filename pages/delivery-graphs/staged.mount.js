// pages/delivery-graphs/staged.mount.js — the Staged proposals App-View (ADR 0005 Decision 7, issues
// #460 + #511). The OPERATOR surface for the delivery-graph proposals an agent (or the compose view)
// has staged: it lists every LIVE staged proposal and, per row, offers
//   • Preview DI  — recompile the proposal's BPMN (with diagram interchange) and hand it UP to the host
//     console's process explorer over the `nano-navigate` bridge, rendered read-only BEFORE dispatch;
//   • Dispatch    — the operator's launch action (#460): POST the proposal's `digest` — plus the
//     repository-isolation envelope (`repository` + `baseBranch`, or an explicit `repoless` opt-out,
//     #729) the operator supplies inline — to the dispatch door. Clicking Dispatch IS the approval,
//     content-addressed to exactly the graph previewed.
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

// The door defaults are anchored to THIS MODULE's url (import.meta.url), NOT the document base. The
// staged App-View shell (staged-embed.html / staged-standalone.html) — and therefore this mount.js —
// is served ONE DIRECTORY DEEP at `<appMount>/delivery-graphs/`, while the API is a sibling of that
// dir at `<appMount>/app/api/…`. A document-base-relative default (`"app/api/delivery-graph/staged"`)
// resolves against the `…/delivery-graphs/` shell base to `…/delivery-graphs/app/api/delivery-graph/
// staged` → 404 on EVERY surface (standalone, local urban-SPA App-View, and the Studio console
// App-View, which never injects window.__NANO_APP_VIEW__ so this default is what runs) — the
// "Could not load staged proposals." bug. A leading-slash absolute is worse still: through Studio it
// resolves against the console ORIGIN, not the app-view base (#279). `../app/api/…` off
// import.meta.url steps up out of `/delivery-graphs/` and lands on `<appMount>/app/api/…` on all
// three surfaces regardless of the document base — the same fix the cockpit shipped for #467.
// The read behind the list: every live staged proposal, newest first.
const DEFAULT_STAGED_URL = new URL("../app/api/delivery-graph/staged", import.meta.url).href;
// The operator dispatch door: POST { digest } → launches the staged graph engine-natively (#460).
const DEFAULT_DISPATCH_URL = new URL("../app/api/actions/delivery-graph/dispatch", import.meta.url).href;
// The operator dismiss door: POST { digest } → discards a staged proposal as noise, flipping it to the
// terminal `dismissed` status so it drops off the staged list (#520). Launches nothing.
const DEFAULT_DISMISS_URL = new URL("../app/api/actions/delivery-graph/dismiss", import.meta.url).href;
// The read-only DI preview door: recompiles a staged proposal's BPMN (with diagram interchange) so its
// generated diagram can be rendered in the host explorer BEFORE dispatch. No deploy, no dispatch.
const DEFAULT_PROPOSAL_BPMN_URL = new URL("../app/api/actions/delivery-graph/proposal-bpmn", import.meta.url).href;
// The save-to-library door: POST { name, digest } → copies this staged proposal's already-stored graph
// into the reusable library (issue #523, save-from-digest → source `from-staged`). Persists a library
// entry; it never dispatches or re-stages, so the #460 operator boundary holds.
const DEFAULT_SAVE_LIBRARY_URL = new URL("../app/api/actions/delivery-graph/library/save", import.meta.url).href;

// How often the list re-polls the read door so a freshly-staged (or just-dispatched) proposal appears
// (or drops off) without a manual refresh — mirrors the 5s cadence the old declarative grid used.
const DEFAULT_REFRESH_MS = 5000;

// A bounded timeout for every door request. Without it a hung door leaves the fetch promise pending
// forever, so the busy() lock never clears and the UI is stranded; on timeout the AbortController
// rejects the fetch, surfacing as an error banner and re-enabling the controls via the finally blocks.
const REQUEST_TIMEOUT_MS = 30000;

// The confirm shown before a dispatch — dispatching authorises every side-effecting node, so the
// operator acknowledges that the launch (and its side effects) is content-addressed to this graph.
// This is rendered as an IN-DOM inline confirmation step (NOT a native window.confirm): the console
// loads this view in a sandboxed App-View iframe with no `allow-modals`, where window.confirm is
// silently suppressed (returns false) — so a native-modal gate reads as "operator declined" and the
// button no-ops (#569). The two-step inline control keeps the #460 "the click IS the approval" UX
// without depending on a host capability the App-View iframe doesn't grant.
const DISPATCH_CONFIRM =
  "Dispatch this staged delivery graph? This launches the graph engine-natively — any side-effecting " +
  "node (it merges PRs / publishes packages) will run. Clicking Dispatch IS the approval, " +
  "content-addressed to exactly the graph you previewed.";

// The confirm shown before a dismiss — dismissing is a terminal discard: the proposal drops off the
// staged list for good (it can be re-staged only by recompiling). It launches nothing, so this is a
// lighter acknowledgement than Dispatch, but still a one-way action the operator confirms. Rendered
// as the same IN-DOM inline confirmation as Dispatch (no native window.confirm), for the #569 reason.
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

// Is `pending` an open inline confirmation for `kind` on this proposal's row? `pending` is the single
// open confirmation (or null) — see mountStagedProposals. Only the matching row+kind swaps its button
// for the two-step inline control; every other row keeps its plain button.
function isPending(pending, kind, digest) {
  return pending != null && pending.kind === kind && pending.digest === digest;
}

// The Dispatch affordance for a row: normally a single button; while its inline confirmation is open,
// an in-DOM "Confirm dispatch / Cancel" pair (NOT a native window.confirm, suppressed in the sandboxed
// App-View iframe — #569). Clicking "Confirm dispatch" IS the operator approval (#460).
//
// The dispatch door (issue #729) now REQUIRES a repository-isolation envelope: the operator must supply
// BOTH `repository` (`owner/repo`) and `baseBranch`, OR explicitly opt out with `repoless` for a
// checkout-less graph — dispatching with neither would silently share the worker's launch dir across
// agents. A staged proposal carries no repository metadata, so the operator provides it HERE at
// dispatch time via the inline fields below. Ticking "checkout-less" disables the repo/base inputs.
function dispatchControl(p, pending) {
  if (isPending(pending, "dispatch", p.digest)) {
    const repository = typeof pending.repository === "string" ? pending.repository : "";
    const baseBranch = typeof pending.baseBranch === "string" ? pending.baseBranch : "";
    const repoless = pending.repoless === true;
    const provDisabled = repoless ? " disabled" : "";
    return `<span class="confirm" data-confirm="dispatch">
      <span class="confirm-msg">${esc(DISPATCH_CONFIRM)}</span>
      <label class="confirm-field">Repository <input class="confirm-input" type="text" data-dispatch-repository="${esc(p.digest)}" value="${esc(repository)}" placeholder="owner/repo" aria-label="Repository (owner/repo)"${provDisabled} /></label>
      <label class="confirm-field">Base branch <input class="confirm-input" type="text" data-dispatch-base="${esc(p.digest)}" value="${esc(baseBranch)}" placeholder="main" aria-label="Base branch"${provDisabled} /></label>
      <label class="confirm-check"><input type="checkbox" data-dispatch-repoless="${esc(p.digest)}"${repoless ? " checked" : ""} /> Dispatch checkout-less (no repository)</label>
      <button class="btn btn-primary" type="button" data-dispatch-confirm="${esc(p.digest)}">Confirm dispatch</button>
      <button class="btn btn-ghost" type="button" data-dispatch-cancel="${esc(p.digest)}">Cancel</button>
    </span>`;
  }
  return `<button class="btn btn-primary" type="button" data-dispatch="${esc(p.digest)}">Dispatch</button>`;
}

// The Dismiss affordance: a plain button, or — while open — the in-DOM "Confirm dismiss / Cancel" pair.
function dismissControl(p, pending) {
  if (isPending(pending, "dismiss", p.digest)) {
    return `<span class="confirm" data-confirm="dismiss">
      <span class="confirm-msg">${esc(DISMISS_CONFIRM)}</span>
      <button class="btn btn-danger" type="button" data-dismiss-confirm="${esc(p.digest)}">Confirm dismiss</button>
      <button class="btn btn-ghost" type="button" data-dismiss-cancel="${esc(p.digest)}">Cancel</button>
    </span>`;
  }
  return `<button class="btn btn-ghost" type="button" data-dismiss="${esc(p.digest)}">Dismiss</button>`;
}

// The Save-to-library affordance: a plain button, or — while open — an in-DOM text input for the entry
// name plus Save/Cancel (replacing the native window.prompt, which returns null under sandbox — #569).
function saveControl(p, pending) {
  if (isPending(pending, "save", p.digest)) {
    const name = typeof pending.name === "string" ? pending.name : "";
    return `<span class="confirm" data-confirm="save">
      <input class="confirm-input" type="text" data-library-name="${esc(p.digest)}" value="${esc(name)}" placeholder="Library entry name" aria-label="Library entry name" />
      <button class="btn btn-primary" type="button" data-save-library-confirm="${esc(p.digest)}">Save</button>
      <button class="btn btn-ghost" type="button" data-save-library-cancel="${esc(p.digest)}">Cancel</button>
    </span>`;
  }
  return `<button class="btn btn-ghost" type="button" data-save-library="${esc(p.digest)}" data-title="${esc(p.title ?? "")}">Save to library</button>`;
}

/** Render one staged proposal as a card row with Preview-DI + Dispatch actions (and any open
 *  in-DOM confirmation, keyed by `pending`). */
function renderProposal(p, pending) {
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
      ${dispatchControl(p, pending)}
      ${saveControl(p, pending)}
      ${dismissControl(p, pending)}
    </div>
  </section>`;
}

/** Render the whole list (or the empty state), threading the single open in-DOM confirmation. */
function renderList(proposals, pending) {
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
  return header + proposals.map((p) => renderProposal(p, pending)).join("");
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
  // The proposals from the last successful load — kept so an in-DOM confirmation opened/closed by a
  // click can re-render the SAME list synchronously (without waiting for the next poll).
  let currentProposals = [];
  // The single open in-DOM confirmation, or null. Shape: { kind: "dispatch"|"dismiss"|"save",
  // digest: string, name?: string, repository?: string, baseBranch?: string, repoless?: boolean }. This
  // REPLACES the native window.confirm/window.prompt the console's sandboxed App-View iframe suppresses
  // (#569): the operator approval is an inline two-step control (Confirm/Cancel), an inline name input
  // (Save), or — for Dispatch — the repository/baseBranch/repoless envelope fields (#729), all rendered
  // by renderProposal from this state so a background poll re-render preserves what the operator typed.
  let pending = null;
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
  // Re-render the list from the last-known proposals, threading the open confirmation. Used by the
  // click handlers that open/close an inline confirmation so it appears/disappears immediately.
  function rerender() {
    listEl.innerHTML = renderList(currentProposals, pending);
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
        currentProposals = body.proposals;
        // If the proposal an inline confirmation is open over has since dropped off the list (dispatched
        // elsewhere, dismissed, or expired), the confirmation is stale — clear it so the poll can redraw.
        if (pending != null && !body.proposals.some((p) => p.digest === pending.digest)) pending = null;
        // While a confirmation (or its name input) is open, DON'T clobber the DOM the operator is
        // interacting with — the fetch above still runs, so an expiry is detected and cleared above.
        if (pending == null) {
          listEl.innerHTML = renderList(body.proposals, pending);
          applyDisabled();
        }
        if (loadErrorShown) {
          setStatus("");
          loadErrorShown = false;
        }
      } else {
        currentProposals = [];
        pending = null;
        listEl.innerHTML = renderList([], pending);
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

  // "Dispatch": the operator's launch (#460). The confirmation is an IN-DOM two-step control (opened by
  // the click handler, #569) — by the time we're here the operator has clicked "Confirm dispatch", so we
  // POST the digest to the dispatch door; on success the proposal flips to `dispatched` and drops off
  // the list on the next poll — refresh immediately so the operator sees it leave.
  async function doDispatch(digest, opts) {
    const staged = typeof digest === "string" ? digest.trim() : "";
    if (staged === "") return;
    const options = opts && typeof opts === "object" ? opts : {};
    const repoless = options.repoless === true;
    const repository = typeof options.repository === "string" ? options.repository.trim() : "";
    const baseBranch = typeof options.baseBranch === "string" ? options.baseBranch.trim() : "";
    // The dispatch door (issue #729) requires an isolation envelope: BOTH `repository` + `baseBranch`,
    // or an explicit `repoless: true` opt-out. Guard here so the operator gets an inline hint instead of
    // a bare 400 from the door (the confirm has already been closed by the click handler on a valid one).
    if (!repoless && (repository === "" || baseBranch === "")) {
      setStatus("Provide both a repository (owner/repo) and a base branch, or tick “Dispatch checkout-less”.", "err");
      return;
    }
    // Mirror the door's mutual-exclusivity contract: pass EITHER the repo envelope OR `repoless`, never both.
    const payload = repoless ? { digest: staged, repoless: true } : { digest: staged, repository, baseBranch };
    busy(true);
    setStatus("Dispatching…");
    try {
      const { status, body } = await post(dispatchUrl, payload);
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

  // "Dismiss": the operator's discard (#520). Confirmed via the same IN-DOM two-step control as Dispatch
  // (#569); on the confirm we POST the digest to the dismiss door; on success the proposal flips to
  // `dismissed` and drops off the list on the next poll — refresh immediately so the operator sees it
  // leave. Launches nothing.
  async function doDismiss(digest) {
    const staged = typeof digest === "string" ? digest.trim() : "";
    if (staged === "") return;
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
  // (issue #523, save-from-digest → source `from-staged`). The entry name comes from an IN-DOM inline
  // text input (defaulting to the proposal title — its slug/short-hash derive the library id, so
  // re-saving the same name upserts), NOT a native window.prompt (suppressed under the App-View sandbox,
  // #569). We POST { name, digest } to the save door. This persists a library entry only — it never
  // dispatches or re-stages, so the operator boundary the staged view enforces (#460) is untouched.
  async function doSaveToLibrary(digest, rawName) {
    const staged = typeof digest === "string" ? digest.trim() : "";
    if (staged === "") return;
    const name = typeof rawName === "string" ? rawName : "";
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

  // Open an inline confirmation for `kind` on `digest` (Dispatch/Dismiss) or the inline name input
  // (Save) — replacing the native modal the sandboxed App-View iframe suppresses (#569).
  function openConfirm(kind, digest, name) {
    const staged = typeof digest === "string" ? digest.trim() : "";
    if (staged === "") return;
    pending = { kind, digest: staged, name: typeof name === "string" ? name : "", repository: "", baseBranch: "", repoless: false };
    rerender();
    // Move focus into the name input so the operator can type immediately (best-effort; not all hosts
    // implement focus()).
    if (kind === "save") {
      const input = listEl.querySelector(`[data-library-name="${cssAttr(staged)}"]`);
      if (input && typeof input.focus === "function") input.focus();
    }
  }

  // Close any open inline confirmation and redraw the plain buttons.
  function closeConfirm() {
    pending = null;
    rerender();
  }

  // The digest values are content-address hex (safe for a CSS attribute-selector), but escape a double
  // quote defensively so a crafted value can't break out of the [data-library-name="…"] selector.
  function cssAttr(value) {
    return String(value).replace(/["\\]/g, "\\$&");
  }

  // Read the current text of the inline library-name input for `digest` (empty string if it's gone).
  function readLibraryName(digest) {
    const input = listEl.querySelector(`[data-library-name="${cssAttr(digest)}"]`);
    return input && typeof input.value === "string" ? input.value : "";
  }

  // Read the current text of an inline Dispatch envelope field (`repository`/`base`) for `digest`.
  function readDispatchField(digest, which) {
    const attr = which === "repository" ? "data-dispatch-repository" : "data-dispatch-base";
    const input = listEl.querySelector(`[${attr}="${cssAttr(digest)}"]`);
    return input && typeof input.value === "string" ? input.value : "";
  }

  // Read the current state of the inline "Dispatch checkout-less" checkbox for `digest`.
  function readRepoless(digest) {
    const box = listEl.querySelector(`[data-dispatch-repoless="${cssAttr(digest)}"]`);
    return !!(box && box.checked);
  }

  // Keep pending in sync as the operator types, so a background poll re-render (or a later confirm)
  // preserves what they've entered — the library name (Save) and the repo/base envelope fields (Dispatch).
  listEl.addEventListener("input", (ev) => {
    const target = ev.target && ev.target.closest ? ev.target : null;
    if (target == null || pending == null) return;
    if (pending.kind === "save") {
      const input = target.closest("[data-library-name]");
      if (input) pending.name = typeof input.value === "string" ? input.value : "";
      return;
    }
    if (pending.kind === "dispatch") {
      const repoInput = target.closest("[data-dispatch-repository]");
      if (repoInput) {
        pending.repository = typeof repoInput.value === "string" ? repoInput.value : "";
        return;
      }
      const baseInput = target.closest("[data-dispatch-base]");
      if (baseInput) pending.baseBranch = typeof baseInput.value === "string" ? baseInput.value : "";
    }
  });

  // The "Dispatch checkout-less" checkbox toggles the repo/base inputs (disabled when checkout-less), so
  // re-render on change — first hoisting the live text values into pending so the toggle doesn't drop them.
  listEl.addEventListener("change", (ev) => {
    const box = ev.target && ev.target.closest ? ev.target.closest("[data-dispatch-repoless]") : null;
    if (box && pending != null && pending.kind === "dispatch") {
      pending.repository = readDispatchField(pending.digest, "repository");
      pending.baseBranch = readDispatchField(pending.digest, "base");
      pending.repoless = !!box.checked;
      rerender();
    }
  });

  listEl.addEventListener("click", (ev) => {
    const closest = (sel) => (ev.target && ev.target.closest ? ev.target.closest(sel) : null);

    const previewBtn = closest("[data-preview-di]");
    if (previewBtn) {
      ev.preventDefault();
      doPreviewDi(previewBtn.getAttribute("data-preview-di"));
      return;
    }

    // Dispatch: click opens the inline confirmation; "Confirm dispatch" performs the POST; "Cancel"
    // closes it. The click IS the approval (#460), now gated on an in-DOM step, not window.confirm (#569).
    const dispatchBtn = closest("[data-dispatch]");
    if (dispatchBtn) {
      ev.preventDefault();
      openConfirm("dispatch", dispatchBtn.getAttribute("data-dispatch"));
      return;
    }
    const dispatchConfirmBtn = closest("[data-dispatch-confirm]");
    if (dispatchConfirmBtn) {
      ev.preventDefault();
      const digest = dispatchConfirmBtn.getAttribute("data-dispatch-confirm");
      const isThisPending = pending != null && pending.kind === "dispatch" && pending.digest === digest;
      // `pending.repoless` is the durable source of truth (synced on the checkbox `change`); fall back to
      // the live DOM checkbox so a confirm without a prior toggle still reads correctly.
      const repoless = readRepoless(digest) || (isThisPending && pending.repoless === true);
      const repository = readDispatchField(digest, "repository").trim();
      const baseBranch = readDispatchField(digest, "base").trim();
      // Keep the inline confirmation OPEN on an incomplete envelope so the operator can fix it in place
      // (issue #729) — closing it would drop the fields they'd started filling.
      if (!repoless && (repository === "" || baseBranch === "")) {
        setStatus("Provide both a repository (owner/repo) and a base branch, or tick “Dispatch checkout-less”.", "err");
        return;
      }
      closeConfirm();
      doDispatch(digest, { repository, baseBranch, repoless });
      return;
    }
    const dispatchCancelBtn = closest("[data-dispatch-cancel]");
    if (dispatchCancelBtn) {
      ev.preventDefault();
      closeConfirm();
      return;
    }

    // Dismiss: same two-step inline confirmation.
    const dismissBtn = closest("[data-dismiss]");
    if (dismissBtn) {
      ev.preventDefault();
      openConfirm("dismiss", dismissBtn.getAttribute("data-dismiss"));
      return;
    }
    const dismissConfirmBtn = closest("[data-dismiss-confirm]");
    if (dismissConfirmBtn) {
      ev.preventDefault();
      const digest = dismissConfirmBtn.getAttribute("data-dismiss-confirm");
      closeConfirm();
      doDismiss(digest);
      return;
    }
    const dismissCancelBtn = closest("[data-dismiss-cancel]");
    if (dismissCancelBtn) {
      ev.preventDefault();
      closeConfirm();
      return;
    }

    // Save to library: the button opens an inline name input; "Save" reads it and POSTs; "Cancel" closes.
    const saveLibraryBtn = closest("[data-save-library]");
    if (saveLibraryBtn) {
      ev.preventDefault();
      openConfirm("save", saveLibraryBtn.getAttribute("data-save-library"), saveLibraryBtn.getAttribute("data-title"));
      return;
    }
    const saveConfirmBtn = closest("[data-save-library-confirm]");
    if (saveConfirmBtn) {
      ev.preventDefault();
      const digest = saveConfirmBtn.getAttribute("data-save-library-confirm");
      const name = readLibraryName(digest);
      closeConfirm();
      doSaveToLibrary(digest, name);
      return;
    }
    const saveCancelBtn = closest("[data-save-library-cancel]");
    if (saveCancelBtn) {
      ev.preventDefault();
      closeConfirm();
    }
  });

  refresh();
  // Skip a scheduled poll while a Preview/Dispatch request is in flight: re-rendering the list mid-
  // request would drop the in-flight button (and its disabled state) out from under the user. The
  // dispatch path drives its own refresh() on completion, so nothing is missed. While an inline
  // confirmation is open the poll still fetches (so an expiry is detected) but refresh() leaves the DOM
  // the operator is interacting with untouched (see refresh).
  const timer = setInterval(() => {
    if (busyCount === 0) refresh();
  }, refreshMs);

  return () => {
    disposed = true;
    clearInterval(timer);
    root.innerHTML = "";
  };
}
