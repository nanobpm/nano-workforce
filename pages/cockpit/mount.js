// Browser adapter for the SUPPLY-only agentic cockpit (H5 / #148).
//
// This is the ONE wiring both the standalone shell and the console App-View embed call — they differ
// only in the host element they pass, so the supply cockpit renders identically embedded and
// standalone. It supplies the browser capabilities the injection-based core needs: the real
// `document`, a `fetch`-based supply report source, a `WebSocket` relay socket factory, and an
// xterm.js terminal sink.
//
// The genuinely reusable, correctness-critical parts — the relay client and the resume-from-offset
// terminal session — are REUSED from `@nanobpm/agentic/cockpit` (resolved via the host page's import
// map). Only the SUPPLY projection + render + poll orchestration the package does NOT provide is
// re-expressed here in plain browser ESM (the app has no build step, so the typed core under
// `app/agentic/cockpit/` cannot be imported directly by the browser). It is kept faithful to that
// tested TypeScript core: same DOM shape (`data-worker`, `data-liveness`, `data-stream`, …), same
// liveness grading, same self-scheduling poll + persistent-terminal discipline.
//
// It renders the SUPPLY worker list ONLY — NOT the packaged demand×supply matrix / missing-agent reds
// / diversity-SLO light (deferred to enrolment epic #152).
import { RelayChannelClient, TerminalSession } from "@nanobpm/agentic/cockpit";
import { Terminal } from "@xterm/xterm";

const DEFAULT_REFRESH_MS = 2000;
const DEFAULT_STALE_AFTER_MS = 15_000;

// ── supply projection (mirrors app/agentic/cockpit/supply-view.ts) ─────────────────────────────

function liveness(worker, staleAfterMs) {
  if (!worker.live) return "down";
  return worker.staleMs >= staleAfterMs ? "stale" : "live";
}

function workerView(worker, staleAfterMs) {
  const jobKeys = [...(worker.jobKeys ?? [])].sort((a, b) => a.localeCompare(b));
  return {
    instance: worker.instance,
    identity: worker.identity,
    stream: worker.stream,
    family: worker.family ?? "\u2014",
    host: worker.host ?? "\u2014",
    jobKeys,
    jobs: jobKeys.length,
    liveness: liveness(worker, staleAfterMs),
    staleMs: worker.staleMs,
  };
}

function supplyView(report, staleAfterMs) {
  const byInstance = (a, b) => a.instance.localeCompare(b.instance);
  const leaves = (report.leaves ?? [])
    .map((leaf) => {
      const workers = leaf.workers.map((w) => workerView(w, staleAfterMs)).sort(byInstance);
      return {
        token: leaf.token,
        workers,
        liveCount: workers.filter((w) => w.liveness === "live").length,
        total: workers.length,
      };
    })
    .sort((a, b) => a.token.localeCompare(b.token));
  const workers = (report.workers ?? []).map((w) => workerView(w, staleAfterMs)).sort(byInstance);
  return { leaves, workers, count: workers.length, live: workers.filter((w) => w.liveness === "live").length };
}

// ── supply render (mirrors app/agentic/cockpit/supply-render.ts) ───────────────────────────────

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function dot(doc, live) {
  const node = el(doc, "span", "cockpit-dot");
  node.setAttribute("data-liveness", live);
  return node;
}

function workerRow(doc, worker, onDrill) {
  const row = el(doc, "tr", "cockpit-supply-worker");
  row.setAttribute("data-worker", worker.instance);
  row.setAttribute("data-liveness", worker.liveness);
  row.setAttribute("data-stream", worker.stream);

  const nameCell = el(doc, "td", "cockpit-td cockpit-supply-name");
  nameCell.appendChild(dot(doc, worker.liveness));
  const button = el(doc, "button", "cockpit-worker", worker.instance);
  button.setAttribute("type", "button");
  button.setAttribute("data-stream", worker.stream);
  if (onDrill) button.addEventListener("click", () => onDrill(worker.stream));
  nameCell.appendChild(button);
  row.appendChild(nameCell);

  row.appendChild(el(doc, "td", "cockpit-td cockpit-supply-family", worker.family));
  row.appendChild(el(doc, "td", "cockpit-td cockpit-supply-host", worker.host));
  const jobsCell = el(doc, "td", "cockpit-td cockpit-supply-jobs", worker.jobs === 0 ? "\u2014" : worker.jobKeys.join(", "));
  jobsCell.setAttribute("data-jobs", String(worker.jobs));
  row.appendChild(jobsCell);
  const livenessCell = el(doc, "td", "cockpit-td cockpit-supply-liveness", worker.liveness);
  livenessCell.setAttribute("data-liveness", worker.liveness);
  row.appendChild(livenessCell);
  return row;
}

function leafSection(doc, leaf, onDrill) {
  const section = el(doc, "section", "cockpit-leaf");
  section.setAttribute("data-leaf", leaf.token);
  const header = el(doc, "div", "cockpit-leaf-head");
  header.appendChild(el(doc, "span", "cockpit-leaf-name", leaf.token));
  header.appendChild(el(doc, "span", "cockpit-leaf-count", `${leaf.liveCount}/${leaf.total} live`));
  section.appendChild(header);
  const table = el(doc, "table", "cockpit-supply-table");
  const thead = el(doc, "thead", "cockpit-supply-thead");
  const head = el(doc, "tr", "cockpit-supply-head");
  for (const label of ["worker", "family", "host", "jobs", "liveness"]) head.appendChild(el(doc, "th", "cockpit-th", label));
  thead.appendChild(head);
  table.appendChild(thead);
  const tbody = el(doc, "tbody", "cockpit-supply-tbody");
  for (const worker of leaf.workers) tbody.appendChild(workerRow(doc, worker, onDrill));
  table.appendChild(tbody);
  section.appendChild(table);
  return section;
}

function renderSupply(host, doc, view, onDrill) {
  host.replaceChildren();
  const root = el(doc, "div", "cockpit-supply");
  root.setAttribute("data-worker-count", String(view.count));
  root.setAttribute("data-live-count", String(view.live));
  const header = el(doc, "header", "cockpit-header");
  header.appendChild(el(doc, "h1", "cockpit-title", "Workers — supply"));
  const summary = el(doc, "span", "cockpit-supply-summary", `${view.live}/${view.count} live`);
  summary.setAttribute("data-summary", "supply");
  header.appendChild(summary);
  root.appendChild(header);
  if (view.count === 0) {
    const empty = el(doc, "div", "cockpit-supply-empty", "No workers connected.");
    empty.setAttribute("data-empty", "true");
    root.appendChild(empty);
    host.appendChild(root);
    return;
  }
  const list = el(doc, "div", "cockpit-supply-list");
  for (const leaf of view.leaves) list.appendChild(leafSection(doc, leaf, onDrill));
  root.appendChild(list);
  host.appendChild(root);
}

// ── boot orchestration (mirrors app/agentic/cockpit/supply-boot.ts) ────────────────────────────

/** An xterm.js-backed terminal sink mounted into `host`. */
function xtermSink(host) {
  const term = new Terminal({ convertEol: true, fontFamily: "ui-monospace, monospace", fontSize: 13 });
  term.open(host);
  return { write: (chunk) => term.write(chunk), dispose: () => term.dispose() };
}

/** A WebSocket relay socket factory for the agentic channel at `url`. */
function relaySocketFactory(url) {
  return () => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    return {
      send: (bytes) => ws.send(bytes),
      close: () => ws.close(),
      onMessage: (cb) => ws.addEventListener("message", (event) => cb(new Uint8Array(event.data))),
      onOpen: (cb) => ws.addEventListener("open", () => cb()),
      onClose: (cb) => ws.addEventListener("close", () => cb()),
    };
  };
}

/**
 * Mount the SUPPLY cockpit into `host` and start polling.
 *
 * @param {Element} host — where the cockpit renders (standalone: document.body; embedded: the App-View host).
 * @param {object} [opts]
 * @param {string} [opts.reportUrl] — the supply JSON endpoint the app serves.
 * @param {string} [opts.relayUrl]  — the agentic channel WebSocket URL (with auth token + capability query).
 * @param {string} [opts.hookSecret] — shared secret sent as `x-hook-secret` on the report fetch when the
 *   app's supply endpoint is guarded by NANO_PR_WEBHOOK_SECRET (omit for open deployments).
 * @param {string} [opts.relayToken] — identity token appended to the default relay URL as `?token=…`.
 * @param {string} [opts.relayCapability] — capability credential appended to the default relay URL as `&capability=…`.
 * @param {number} [opts.refreshMs] — poll interval (default 2000).
 * @returns a handle with `.dispose()`.
 */
export function mountCockpit(host, opts = {}) {
  if (host == null || typeof host.replaceChildren !== "function") {
    throw new Error(
      `mountCockpit(host): host must be a mounted DOM element (got ${host === null ? "null" : typeof host}).`,
    );
  }
  const doc = document;
  const reportUrl = opts.reportUrl ?? "/app/api/agentic/supply";
  const hookSecret = opts.hookSecret;
  const relayUrl = opts.relayUrl ?? defaultRelayUrl(opts.relayToken, opts.relayCapability);
  const refreshMs = opts.refreshMs ?? DEFAULT_REFRESH_MS;
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const connectRelay = relaySocketFactory(relayUrl);
  const onError = (err) => console.error("[cockpit]", err);

  // Stable skeleton: a volatile list region the poll re-renders + a PERSISTENT terminal region a
  // refresh never touches (so a drilled-in terminal survives a list refresh).
  host.replaceChildren();
  const shell = el(doc, "div", "cockpit-shell");
  const listRegion = el(doc, "div", "cockpit-supply-region");
  const terminalPanel = el(doc, "section", "cockpit-terminal");
  terminalPanel.appendChild(el(doc, "h2", "cockpit-panel-title", "Worker terminal"));
  const terminalHost = el(doc, "div", "cockpit-terminal-host");
  terminalHost.setAttribute("data-terminal", "host");
  terminalPanel.appendChild(terminalHost);
  shell.appendChild(listRegion);
  shell.appendChild(terminalPanel);
  host.appendChild(shell);

  let running = false;
  let disposed = false;
  let timer;
  let generation = 0;
  let drill; // { stream, client }
  let terminal; // the current xterm sink

  function drillInto(stream) {
    if (disposed || drill?.stream === stream) return;
    drill?.client.close();
    drill = undefined;
    terminal?.dispose?.();
    terminal = undefined;
    try {
      terminalHost.replaceChildren();
      const sink = xtermSink(terminalHost);
      terminal = sink;
      let session;
      const client = new RelayChannelClient({
        connect: connectRelay,
        onRelay: (message) => session?.handle(message),
        onOpen: () => session?.attach(),
        onError,
      });
      session = new TerminalSession({ stream, sink, send: (message) => client.sendRelay(message) });
      client.open();
      drill = { stream, client };
    } catch (err) {
      onError(err);
    }
  }

  async function refresh() {
    if (disposed) return;
    let report;
    try {
      const headers = { accept: "application/json" };
      if (hookSecret) headers["x-hook-secret"] = hookSecret;
      const res = await fetch(reportUrl, { headers });
      if (!res.ok) throw new Error(`supply fetch failed: ${res.status}`);
      report = await res.json();
    } catch (err) {
      onError(err);
      return;
    }
    if (disposed) return;
    try {
      renderSupply(listRegion, doc, supplyView(report, staleAfterMs), drillInto);
    } catch (err) {
      onError(err);
    }
  }

  function tick(gen) {
    void refresh().finally(() => {
      if (gen !== generation || !running || disposed) return;
      timer = setTimeout(() => tick(gen), refreshMs);
    });
  }

  function start() {
    if (disposed || running) return;
    running = true;
    tick(++generation);
  }
  function stop() {
    running = false;
    generation++;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    stop();
    drill?.client.close();
    drill = undefined;
    terminal?.dispose?.();
    terminal = undefined;
  }

  start();
  return { start, stop, dispose, refresh, drill: drillInto };
}

/**
 * Derive the channel WebSocket URL from the current origin (path `/agentic`).
 *
 * The agentic hub authenticates upgrades with `sharedSecretAuthenticator({ requireCredential: true })`,
 * so a bare `ws(s)://host/agentic` is rejected (4401/4403). When a `token` (and optional `capability`)
 * are supplied, they are appended as the `?token=…&capability=…` query the hub requires; without them
 * the default URL cannot authenticate and drill-in will be refused — pass credentials (or an explicit
 * `relayUrl`) for secured deployments.
 */
function defaultRelayUrl(token, capability) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${proto}//${location.host}/agentic`;
  if (!token) return base;
  const query = new URLSearchParams({ token });
  if (capability) query.set("capability", capability);
  return `${base}?${query}`;
}
