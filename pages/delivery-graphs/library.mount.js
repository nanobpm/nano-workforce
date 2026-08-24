// pages/delivery-graphs/library.mount.js — the reusable delivery-graph LIBRARY App-View (ADR 0005,
// issue #523, epic #519 S4). The OPERATOR surface over the S3 library backend (#522): it LISTS every
// saved library entry (the `listLibrary` door) and, per row, offers
//   • Reuse   — load the saved graph JSON back into the COMPOSE textarea (`#dg-json`) so it can be
//     edited / re-previewed / re-staged. The compose view is a SEPARATE App-View iframe, so Reuse
//     drives the compose mount's inbound fill seam over the host bridge: it posts the shared
//     `deliveryGraph.compose.fill` message (its `type` imported from ./mount.js as the ONE source of
//     truth) UP to the console, which routes it to the compose App-View, which fills `#dg-json`.
//   • Delete  — remove the entry via the `deleteLibraryEntry` door (idempotent).
//
// A self-contained, dependency-free renderer in the SAME shape as the compose view (./mount.js) and
// the staged view (./staged.mount.js): the SAME module mounts embedded in the console (App View) and
// standalone — only the host element and injected endpoint config differ. The app has no browser build
// step, so this consumes the library doors straight off the wire.

import { DG_COMPOSE_FILL_MESSAGE } from "./mount.js";

// The read behind the list: every saved library entry, newest first (base-relative — a leading-slash
// path resolves against the console iframe ORIGIN, not the app-view base, and 404s the door, #279).
const DEFAULT_LIBRARY_URL = "app/api/delivery-graph/library";

// How often the list re-polls so a freshly-saved (or just-deleted) entry appears (or drops off)
// without a manual refresh — mirrors the 5s cadence the staged list uses.
const DEFAULT_REFRESH_MS = 5000;

// A bounded timeout for every door request. Without it a hung door leaves the fetch promise pending
// forever, so the busy() lock never clears and the UI is stranded; on timeout the AbortController
// rejects the fetch, surfacing as an error banner and re-enabling the controls via the finally blocks.
const REQUEST_TIMEOUT_MS = 30000;

// The confirm shown before a delete — removing a library entry is a one-way drop (it can only be
// brought back by re-saving), so the operator acknowledges it.
const DELETE_CONFIRM = "Delete this saved library entry? It is removed from the library — to bring it back you must save it again.";

// The filename suffix for an exported delivery graph (issue #525, epic #519 S6). Export is a purely
// client-side Blob download of the entry's stored graph JSON — no backend door — so the graph a peer
// deployment (or a sibling library) later re-imports is byte-identical to what was saved.
export const DELIVERY_GRAPH_EXPORT_SUFFIX = ".deliverygraph.json";

/**
 * Build the client-side download descriptor for exporting a library entry's graph JSON (issue #525).
 * Pure and DOM-free so it is unit-testable in isolation from the mount: it returns the exact
 * { filename, mime, contents } the Export Blob download is assembled from.
 *   • `contents` is the entry's STORED graph JSON verbatim (never re-serialised, so a round-trip
 *     export→import can't drift the bytes); an entry with no stored graph yields "".
 *   • `filename` is the entry name sanitised to a safe basename with the `.deliverygraph.json` suffix,
 *     falling back to the entry id (then a constant) when the name is empty or all-unsafe characters.
 * @param {{name?:string, id?:string, graph?:string}} entry
 * @returns {{filename:string, mime:string, contents:string}}
 */
export function buildDeliveryGraphExport(entry) {
  const contents = entry && typeof entry.graph === "string" ? entry.graph : "";
  const name = String(entry && entry.name != null ? entry.name : "").trim();
  const id = String(entry && entry.id != null ? entry.id : "").trim();
  // Collapse any run of filesystem-unsafe characters to a single hyphen, then trim leading/trailing
  // separators so we never emit a hidden dotfile or a name with dangling punctuation.
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  const stem = safe || (id ? `delivery-graph-${id}` : "delivery-graph");
  return { filename: `${stem}${DELIVERY_GRAPH_EXPORT_SUFFIX}`, mime: "application/json", contents };
}

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

/** A small source pill (composed / imported / from-staged / from-dispatched). */
function sourcePill(source) {
  const s = String(source ?? "").toLowerCase();
  return `<span class="pill pill-${s === "imported" ? "wait" : s === "composed" ? "agent" : "connector"}">${esc(s || "\u2014")}</span>`;
}

/** Render one saved library entry as a card row with Reuse + Delete actions. */
function renderEntry(entry) {
  const name = entry.name ? `<code>${esc(entry.name)}</code>` : '<span class="muted">(unnamed)</span>';
  const note = entry.description ? `<p class="muted">${esc(entry.description)}</p>` : "";
  return `<section class="card">
    <h2>${name} ${sourcePill(entry.source)}</h2>
    ${note}
    <div class="chips">
      <span class="chip">Saved <b>${fmtTime(entry.createdAt)}</b></span>
      <span class="chip">Updated <b>${fmtTime(entry.updatedAt)}</b></span>
      <span class="chip">Id <code>${esc(entry.id)}</code></span>
    </div>
    <div class="actions">
      <button class="btn btn-primary" type="button" data-reuse="${esc(entry.id)}">Reuse</button>
      <button class="btn btn-ghost" type="button" data-export="${esc(entry.id)}">Export</button>
      <button class="btn btn-ghost" type="button" data-delete="${esc(entry.id)}">Delete</button>
    </div>
  </section>`;
}

/** Render the whole list (or the empty state). */
function renderList(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return `<section class="card">
      <h2>Library <span class="count">0</span></h2>
      <p class="muted">No saved delivery graphs yet. Save one from the compose or staged views, then Reuse it here.</p>
    </section>`;
  }
  const header = `<section class="card card-ok">
    <h2>Library <span class="count">${entries.length}</span></h2>
    <p class="ok">Saved, reusable delivery graphs. <b>Reuse</b> loads one back into the composer above to edit / re-stage; <b>Export</b> downloads its graph JSON; <b>Delete</b> removes it.</p>
  </section>`;
  return header + entries.map(renderEntry).join("");
}

// Only attach the guard secret when the resolved door URL is SAME-ORIGIN. `libraryUrl` can be
// overridden (e.g. via the standalone `?library=` query param) to a full `https://…` URL on a foreign
// origin; sending `x-hook-secret` there would exfiltrate the shared guard secret to an arbitrary host.
// A cross-origin (or unparseable, or non-browser) target therefore gets no secret.
function isSameOrigin(url) {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch (_e) {
    return false;
  }
}

/**
 * Mount the library list into `host`.
 * @param {Element|null} host — the element to render into (or null → look up #delivery-graphs-library-root).
 * @param {{libraryUrl?:string, hookSecret?:string, refreshMs?:number}} [config]
 */
export function mountDeliveryGraphLibrary(host, config = {}) {
  const isElement = host != null && host.nodeType === 1 && typeof host.innerHTML === "string";
  const root = isElement ? host : document.getElementById("delivery-graphs-library-root");
  if (!root) return () => {};

  const libraryUrl = config.libraryUrl ?? DEFAULT_LIBRARY_URL;
  const refreshMs = typeof config.refreshMs === "number" && config.refreshMs > 0 ? config.refreshMs : DEFAULT_REFRESH_MS;
  const headers = (url) => ({
    "content-type": "application/json",
    ...(config.hookSecret && isSameOrigin(url) ? { "x-hook-secret": config.hookSecret } : {}),
  });

  // The delete door is the per-entry path under the list door: DELETE app/api/delivery-graph/library/<id>.
  // Append the id to the path only, preserving any query/hash on the configured door so a
  // `?library=` override carrying a search string or fragment still resolves the per-entry URL.
  // Kept base-relative (no `new URL`) to preserve the App-View resolution class (#279).
  const entryUrl = (id) => {
    const [beforeHash, hash = ""] = libraryUrl.split("#");
    const [path, search = ""] = beforeHash.split("?");
    return `${path.replace(/\/+$/, "")}/${encodeURIComponent(id)}${search ? `?${search}` : ""}${hash ? `#${hash}` : ""}`;
  };

  root.innerHTML = `<div class="dg">
    <div class="actions">
      <span id="dg-library-status" class="status"></span>
    </div>
    <div id="dg-library-list"></div>
  </div>`;

  const statusEl = root.querySelector("#dg-library-status");
  const listEl = root.querySelector("#dg-library-list");

  function setStatus(text, tone) {
    statusEl.textContent = text || "";
    statusEl.className = "status" + (tone ? " status-" + tone : "");
  }

  // The last loaded entries, kept so Reuse/Delete can resolve an entry (its full `graph` JSON) by id
  // without a second fetch — the list door carries `graph` inline for exactly this.
  let entries = [];

  let busyCount = 0;
  // A re-render (renderList → new buttons) resets every button to enabled, so the disabled state is
  // derived from busyCount and re-applied after each render and on every busy() transition — a poll
  // can't silently re-enable the buttons while a Reuse/Delete request is in flight.
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
  const del = (url) => request(url, { method: "DELETE" });

  let disposed = false;
  // True while the last completed load failed — so a subsequent successful load clears its own stale
  // error banner WITHOUT clobbering a transient action toast (Reuse/Delete ok/err message).
  let loadErrorShown = false;

  async function refresh() {
    try {
      const { status, body } = await get(libraryUrl);
      if (disposed) return;
      if (status === 200 && Array.isArray(body.entries)) {
        entries = body.entries;
        listEl.innerHTML = renderList(entries);
        applyDisabled();
        if (loadErrorShown) {
          setStatus("");
          loadErrorShown = false;
        }
      } else {
        entries = [];
        listEl.innerHTML = renderList([]);
        applyDisabled();
        setStatus(body && body.error ? body.error : "Could not load the library.", "err");
        loadErrorShown = true;
      }
    } catch (err) {
      if (disposed) return;
      setStatus(err && err.message ? err.message : "Library request failed.", "err");
      loadErrorShown = true;
    }
  }

  // "Reuse": load a saved graph back into the compose textarea (`#dg-json`). The compose view is a
  // SEPARATE App-View iframe, so we can't touch its DOM directly — we drive its inbound fill seam over
  // the host bridge, posting the shared `deliveryGraph.compose.fill` message UP to the console (the
  // INBOUND twin of the outbound `nano-navigate` DI-preview bridge). Standalone (not embedded) there is
  // no console to route it and no compose view to fill, so we say so instead of failing silently.
  const isEmbedded = typeof window !== "undefined" && window.parent && window.parent !== window;
  function doReuse(id) {
    const entry = entries.find((e) => e && e.id === id);
    if (!entry) {
      setStatus("That entry is no longer in the library \u2014 refresh and try again.", "err");
      return;
    }
    if (typeof entry.graph !== "string" || entry.graph.trim() === "") {
      setStatus("That entry has no stored graph to reuse.", "err");
      return;
    }
    if (!isEmbedded) {
      setStatus("Open this page inside the console to reuse a saved graph in the composer.", "err");
      return;
    }
    window.parent.postMessage(
      { type: DG_COMPOSE_FILL_MESSAGE, graphJson: entry.graph },
      window.location.origin,
    );
    setStatus("\u2713 Loaded into the composer above \u2014 edit, Preview or Stage it.", "ok");
  }

  // "Export": a purely client-side download of a saved entry's graph JSON as `<name>.deliverygraph.json`
  // (issue #525). No backend door — the list door already carries each entry's `graph` inline (the same
  // field Reuse uses), so we assemble a Blob from it and drive an anchor download. The bytes written are
  // the STORED graph verbatim (buildDeliveryGraphExport never re-serialises), so an export→import
  // round-trip is byte-stable. Runs in any context (embedded or standalone) — unlike Reuse it needs no
  // console to route it.
  function doExport(id) {
    const entry = entries.find((e) => e && e.id === id);
    if (!entry) {
      setStatus("That entry is no longer in the library \u2014 refresh and try again.", "err");
      return;
    }
    const { filename, mime, contents } = buildDeliveryGraphExport(entry);
    if (typeof contents !== "string" || contents.trim() === "") {
      setStatus("That entry has no stored graph to export.", "err");
      return;
    }
    let url = null;
    let a = null;
    try {
      const blob = new Blob([contents], { type: mime });
      url = URL.createObjectURL(blob);
      a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setStatus(`\u2713 Downloaded ${filename}`, "ok");
    } catch (err) {
      setStatus(err && err.message ? err.message : "Export failed.", "err");
    } finally {
      if (a) a.remove();
      // Defer revoke to the next tick so the download can start reliably before the URL is freed.
      if (url) setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }

  // "Delete": remove a saved library entry via the deleteLibraryEntry door (idempotent). Confirm (it is
  // a one-way drop off the library), then DELETE the per-entry path; refresh so the row leaves at once.
  async function doDelete(id) {
    if (typeof id !== "string" || id.trim() === "") return;
    if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(DELETE_CONFIRM)) {
      return;
    }
    busy(true);
    setStatus("Deleting…");
    try {
      const { status, body } = await del(entryUrl(id));
      if (status === 200 && body.ok) {
        setStatus(body.deleted ? "\u2713 Deleted \u2014 the entry is off the library." : "\u2713 Already gone \u2014 nothing to delete.", "ok");
        await refresh();
      } else {
        setStatus(body && body.error ? body.error : "Delete failed.", "err");
      }
    } catch (err) {
      setStatus(err && err.message ? err.message : "Delete request failed.", "err");
    } finally {
      busy(false);
    }
  }

  listEl.addEventListener("click", (ev) => {
    const reuseBtn = ev.target && ev.target.closest ? ev.target.closest("[data-reuse]") : null;
    if (reuseBtn) {
      ev.preventDefault();
      doReuse(reuseBtn.getAttribute("data-reuse"));
      return;
    }
    const exportBtn = ev.target && ev.target.closest ? ev.target.closest("[data-export]") : null;
    if (exportBtn) {
      ev.preventDefault();
      doExport(exportBtn.getAttribute("data-export"));
      return;
    }
    const deleteBtn = ev.target && ev.target.closest ? ev.target.closest("[data-delete]") : null;
    if (deleteBtn) {
      ev.preventDefault();
      doDelete(deleteBtn.getAttribute("data-delete"));
    }
  });

  refresh();
  // Skip a scheduled poll while a Reuse/Delete request is in flight: re-rendering the list mid-request
  // would drop the in-flight button (and its disabled state) out from under the user. The delete path
  // drives its own refresh() on completion, so nothing is missed.
  const timer = setInterval(() => {
    if (busyCount === 0) refresh();
  }, refreshMs);

  return () => {
    disposed = true;
    clearInterval(timer);
    root.innerHTML = "";
  };
}
