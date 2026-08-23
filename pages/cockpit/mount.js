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
const DEFAULT_PAST_FETCH_TIMEOUT_MS = 15_000;

function isPosInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

// ── supply projection (mirrors app/agentic/cockpit/supply-view.ts) ─────────────────────────────

function liveness(worker, staleAfterMs) {
  if (!worker.live) return "down";
  return worker.staleMs >= staleAfterMs ? "stale" : "live";
}

function correlationLabel(c) {
  const parts = [];
  if (c.bpmnProcessId != null) parts.push(c.bpmnProcessId);
  if (c.elementId != null) parts.push(c.elementId);
  if (c.processInstanceKey != null) parts.push(`inst ${c.processInstanceKey}`);
  if (c.planKey != null) parts.push(c.planKey);
  return parts.length > 0 ? parts.join(" \u00b7 ") : `job ${c.jobKey}`;
}

function workerView(worker, staleAfterMs, byJobKey) {
  const jobKeys = [...(worker.jobKeys ?? [])].sort((a, b) => a.localeCompare(b));
  const correlations = jobKeys
    .map((jobKey) => byJobKey.get(jobKey))
    .filter((c) => c != null)
    .map((c) => ({ jobKey: c.jobKey, stream: c.stream, label: correlationLabel(c) }));
  return {
    instance: worker.instance,
    identity: worker.identity,
    stream: worker.stream,
    family: worker.family ?? "\u2014",
    host: worker.host ?? "\u2014",
    jobKeys,
    jobs: jobKeys.length,
    correlations,
    liveness: liveness(worker, staleAfterMs),
    staleMs: worker.staleMs,
  };
}

function supplyView(report, staleAfterMs) {
  const byInstance = (a, b) => a.instance.localeCompare(b.instance);
  const byJobKey = new Map();
  for (const c of report.correlations ?? []) byJobKey.set(c.jobKey, c);
  const leaves = (report.leaves ?? [])
    .map((leaf) => {
      const workers = leaf.workers.map((w) => workerView(w, staleAfterMs, byJobKey)).sort(byInstance);
      return {
        token: leaf.token,
        workers,
        liveCount: workers.filter((w) => w.liveness === "live").length,
        total: workers.length,
      };
    })
    .sort((a, b) => a.token.localeCompare(b.token));
  const workers = (report.workers ?? []).map((w) => workerView(w, staleAfterMs, byJobKey)).sort(byInstance);
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
  const processCell = el(doc, "td", "cockpit-td cockpit-supply-process");
  processCell.setAttribute("data-correlations", String(worker.correlations.length));
  if (worker.correlations.length === 0) {
    processCell.textContent = "\u2014";
  } else {
    for (const correlation of worker.correlations) {
      const link = el(doc, "button", "cockpit-correlation", correlation.label);
      link.setAttribute("type", "button");
      link.setAttribute("data-job-key", correlation.jobKey);
      link.setAttribute("data-stream", correlation.stream);
      if (onDrill) link.addEventListener("click", () => onDrill(correlation.stream));
      processCell.appendChild(link);
    }
  }
  row.appendChild(processCell);
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
  for (const label of ["worker", "family", "host", "jobs", "process / plan", "liveness"]) head.appendChild(el(doc, "th", "cockpit-th", label));
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

// ── past-sessions projection + render (mirrors app/agentic/cockpit/transcript-view.ts + -render.ts) ──

function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function humanDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return undefined;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function sessionLabel(t) {
  const parts = [];
  if (t.bpmnProcessId != null) parts.push(t.bpmnProcessId);
  if (t.elementId != null) parts.push(t.elementId);
  if (t.processInstanceKey != null) parts.push(`inst ${t.processInstanceKey}`);
  if (t.planKey != null) parts.push(t.planKey);
  if (parts.length > 0) return parts.join(" \u00b7 ");
  if (t.jobKey != null) return `job ${t.jobKey}`;
  return t.stream;
}

function transcriptsView(report) {
  const sessions = (report.transcripts ?? [])
    .map((t) => ({
      stream: t.stream,
      label: sessionLabel(t),
      jobKey: t.jobKey,
      status: t.status,
      lifecycle: t.lifecycle,
      size: humanBytes(t.byteLength),
      byteLength: t.byteLength,
      capturedAt: t.completedAt ?? t.createdAt,
    }))
    .sort((a, b) => {
      const byTime = String(b.capturedAt).localeCompare(String(a.capturedAt));
      return byTime !== 0 ? byTime : a.stream.localeCompare(b.stream);
    });
  return { sessions, count: sessions.length, retention: humanDuration(report.retentionMs) };
}

function sessionRow(doc, session, onReplay, activeStream) {
  const row = el(doc, "tr", "cockpit-past-session");
  row.setAttribute("data-stream", session.stream);
  row.setAttribute("data-status", session.status);
  if (session.jobKey != null) row.setAttribute("data-job-key", session.jobKey);
  if (activeStream === session.stream) row.setAttribute("data-active", "true");
  const nameCell = el(doc, "td", "cockpit-td cockpit-past-name");
  const button = el(doc, "button", "cockpit-past-replay", session.label);
  button.setAttribute("type", "button");
  button.setAttribute("data-stream", session.stream);
  if (onReplay) button.addEventListener("click", () => onReplay(session.stream));
  nameCell.appendChild(button);
  row.appendChild(nameCell);
  row.appendChild(el(doc, "td", "cockpit-td cockpit-past-status", session.status));
  row.appendChild(el(doc, "td", "cockpit-td cockpit-past-size", session.size));
  row.appendChild(el(doc, "td", "cockpit-td cockpit-past-captured", session.capturedAt));
  return row;
}

function renderTranscripts(host, doc, view, onReplay, activeStream) {
  host.replaceChildren();
  const root = el(doc, "div", "cockpit-past");
  root.setAttribute("data-session-count", String(view.count));
  const header = el(doc, "header", "cockpit-past-header");
  header.appendChild(el(doc, "h2", "cockpit-past-title", "Past sessions"));
  const summary = el(doc, "span", "cockpit-past-summary", view.retention != null ? `${view.count} \u00b7 kept ${view.retention}` : `${view.count}`);
  summary.setAttribute("data-summary", "past");
  header.appendChild(summary);
  root.appendChild(header);
  if (view.count === 0) {
    const empty = el(doc, "div", "cockpit-past-empty", "No captured sessions yet.");
    empty.setAttribute("data-empty", "true");
    root.appendChild(empty);
    host.appendChild(root);
    return;
  }
  const table = el(doc, "table", "cockpit-past-table");
  const thead = el(doc, "thead", "cockpit-past-thead");
  const head = el(doc, "tr", "cockpit-past-head");
  for (const label of ["session", "status", "size", "captured"]) head.appendChild(el(doc, "th", "cockpit-th", label));
  thead.appendChild(head);
  table.appendChild(thead);
  const tbody = el(doc, "tbody", "cockpit-past-tbody");
  for (const session of view.sessions) tbody.appendChild(sessionRow(doc, session, onReplay, activeStream));
  table.appendChild(tbody);
  root.appendChild(table);
  host.appendChild(root);
}

/** Feed a fetched transcript's stored chunks through a resume-from-offset TerminalSession (static playback). */
function replayTranscript(session, data) {
  session.handle({ op: "subscribed", stream: data.stream, gap: data.gap, nextOffset: data.nextOffset });
  for (const entry of data.entries ?? []) {
    session.handle({ stream: data.stream, offset: entry.offset, chunk: entry.chunk });
  }
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
 * @param {string} [opts.reportUrl] — the supply JSON endpoint the app serves (default
 *   `"app/api/agentic/supply"`, base-relative).
 * @param {string} [opts.relayUrl]  — the agentic channel WebSocket URL (with auth token + capability query).
 * @param {string} [opts.hookSecret] — shared secret sent as `x-hook-secret` on the report fetch when the
 *   app's supply endpoint is guarded by NANO_PR_WEBHOOK_SECRET (omit for open deployments).
 * @param {string} [opts.relayToken] — identity token appended to the default relay URL as `?token=…`.
 * @param {string} [opts.relayCapability] — capability credential appended to the default relay URL as `&capability=…`.
 * @param {number} [opts.refreshMs] — poll interval (default 2000).
 * @param {number} [opts.staleAfterMs] — a worker is rendered "stale" once its last heartbeat is at
 *   least this many ms old (default 15000).
 * @param {number} [opts.pastFetchTimeoutMs] — upper bound (ms) on a single past-sessions transcripts
 *   fetch; the fetch is aborted past this so a hung endpoint can't wedge the past panel (default 15000).
 * @param {string} [opts.transcriptsUrl] — the captured-session list endpoint backing the always-on
 *   "past sessions" history + replay (default `"app/api/agentic/transcripts"`, base-relative).
 * @returns a handle with `.dispose()`.
 */
export function mountCockpit(host, opts = {}) {
  if (host == null || typeof host.replaceChildren !== "function") {
    throw new Error(
      `mountCockpit(host): host must be a mounted DOM element (got ${host === null ? "null" : typeof host}).`,
    );
  }
  const doc = document;
  // Default endpoints are anchored to THIS MODULE's URL (import.meta.url), NOT the document base.
  // The API is served at the app root (`<appMount>/app/api/agentic/…`), but the cockpit shell
  // (embed.html / standalone.html) — and therefore this mount.js — is served one directory deep at
  // `<appMount>/cockpit/`. A document-base-relative default (`"app/api/agentic/supply"`) resolves
  // against that `…/cockpit/` base to `…/cockpit/app/api/agentic/supply` → 404 on EVERY surface
  // (standalone, local urban-SPA App-View embed, and the Studio console App-View, which serves the
  // shell at `<app-view-base>/cockpit/…`), leaving the cockpit empty (#467). An absolute leading-slash
  // path is worse still — through Studio it resolves against the console ORIGIN (:8080), not the
  // app-view base that proxies the API (#279). mount.js is ALWAYS at `<appMount>/cockpit/mount.js`
  // while the API is ALWAYS at `<appMount>/app/api/…`, so `../app/api/…` off import.meta.url lands on
  // the right endpoint on all three surfaces regardless of the document base — the console never
  // injects window.__NANO_APP_VIEW__, so this default is what actually runs there too.
  const reportUrl = opts.reportUrl ?? new URL("../app/api/agentic/supply", import.meta.url).href;
  const transcriptsUrl = opts.transcriptsUrl ?? new URL("../app/api/agentic/transcripts", import.meta.url).href;
  const hookSecret = opts.hookSecret;
  const relayUrl = opts.relayUrl ?? defaultRelayUrl(opts.relayToken, opts.relayCapability);
  const refreshMs = opts.refreshMs ?? DEFAULT_REFRESH_MS;
  // refreshMs feeds setTimeout as a poll delay. A negative/NaN/fractional/unsafe value silently
  // collapses to a ~0ms delay, turning the poll into a hot loop that hammers the supply endpoint.
  // Require a positive safe integer up-front (mirroring the TS boot layer) so a bad opt fails loudly.
  if (!isPosInt(refreshMs)) {
    throw new RangeError(`mountCockpit(opts.refreshMs): must be a positive safe integer, got ${refreshMs}.`);
  }
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  // Upper bound on a single "past sessions" transcripts fetch. refreshPast() is single-flight, so a
  // fetch that HANGS (never settles) would otherwise leave `pastRefreshing` stuck true forever and
  // permanently disable the past panel; a bounded (aborting) fetch clears the flag so the next poll retries.
  const pastFetchTimeoutMs = opts.pastFetchTimeoutMs ?? DEFAULT_PAST_FETCH_TIMEOUT_MS;
  if (!isPosInt(pastFetchTimeoutMs)) {
    throw new RangeError(
      `mountCockpit(opts.pastFetchTimeoutMs): must be a positive safe integer, got ${pastFetchTimeoutMs}.`,
    );
  }
  const connectRelay = relaySocketFactory(relayUrl);
  const onError = (err) => console.error("[cockpit]", err);

  const jsonHeaders = () => {
    const headers = { accept: "application/json" };
    if (hookSecret) headers["x-hook-secret"] = hookSecret;
    return headers;
  };

  // Stable skeleton: a volatile supply-list region + a volatile "past sessions" region the poll
  // re-renders, and a PERSISTENT terminal region a refresh never touches (so a drilled-in/replayed
  // terminal survives a list refresh). The terminal panel title distinguishes live vs replayed.
  host.replaceChildren();
  const shell = el(doc, "div", "cockpit-shell");
  const listRegion = el(doc, "div", "cockpit-supply-region");
  const pastRegion = el(doc, "div", "cockpit-past-region");
  const terminalPanel = el(doc, "section", "cockpit-terminal");
  terminalPanel.setAttribute("data-terminal-mode", "idle");
  const terminalTitle = el(doc, "h2", "cockpit-panel-title", "Worker terminal");
  terminalPanel.appendChild(terminalTitle);
  const terminalHost = el(doc, "div", "cockpit-terminal-host");
  terminalHost.setAttribute("data-terminal", "host");
  terminalPanel.appendChild(terminalHost);
  shell.appendChild(listRegion);
  shell.appendChild(pastRegion);
  shell.appendChild(terminalPanel);
  host.appendChild(shell);

  let running = false;
  let disposed = false;
  let timer;
  let generation = 0;
  let drill; // { stream, client }
  let terminal; // the current xterm sink
  let mode; // "live" | "replay" | undefined
  let shownStream;
  // Bumped by every drillInto()/replayInto()/dispose() that claims the terminal region, so a slow
  // replay fetch that resolves after a newer selection drops its result instead of clobbering it.
  let opToken = 0;
  // True while a refreshPast() fetch is outstanding, so the supply poll never stacks past-fetches
  // against a slow/hung transcripts endpoint.
  let pastRefreshing = false;

  function setMode(next, stream) {
    mode = next;
    shownStream = stream;
    terminalPanel.setAttribute("data-terminal-mode", next ?? "idle");
    if (next === "live") terminalTitle.textContent = "Worker terminal — live";
    else if (next === "replay") terminalTitle.textContent = "Worker terminal — replay (past session)";
    else terminalTitle.textContent = "Worker terminal";
  }

  function teardownTerminal() {
    drill?.client.close();
    drill = undefined;
    terminal?.dispose?.();
    terminal = undefined;
  }

  function drillInto(stream) {
    if (disposed || (mode === "live" && drill?.stream === stream)) return;
    // Claim the terminal region: bump the op token so an in-flight replay drops its stale result.
    opToken++;
    teardownTerminal();
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
      setMode("live", stream);
    } catch (err) {
      // The new terminal failed to build after the prior one was torn down: reset the region to idle
      // (and drop any partially-built terminal) so the UI never shows a stale "live"/"replay"
      // indicator with nothing behind it — symmetric with replayInto(), which clears mode up-front.
      teardownTerminal();
      setMode(undefined, undefined);
      onError(err);
    }
  }

  async function replayInto(stream) {
    if (disposed) return;
    // Claim the terminal region under a fresh op token, captured for the post-fetch re-check below.
    const token = ++opToken;
    // Drop any live drill + prior terminal before fetching so replay never overlaps a live stream.
    teardownTerminal();
    setMode(undefined, undefined);
    let data;
    try {
      // Bound the fetch: a transcript endpoint that never responds would otherwise leave replay() pending
      // forever with an in-flight request and the terminal wedged out of live mode. Abort after
      // pastFetchTimeoutMs so the fetch always settles (here, rejects) and this catch leaves mode idle.
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), pastFetchTimeoutMs);
      abortTimer.unref?.();
      let res;
      try {
        res = await fetch(`${transcriptsUrl}/${encodeURIComponent(stream)}`, { headers: jsonHeaders(), signal: controller.signal });
      } finally {
        clearTimeout(abortTimer);
      }
      if (!res.ok) throw new Error(`transcript fetch failed: ${res.status}`);
      data = await res.json();
    } catch (err) {
      onError(err);
      return;
    }
    // A newer drill/replay (or dispose) claimed the terminal while this fetch was outstanding — drop
    // the stale result rather than overwrite the newer selection with an out-of-date replay.
    if (disposed || token !== opToken) return;
    try {
      terminalHost.replaceChildren();
      const sink = xtermSink(terminalHost);
      terminal = sink;
      const session = new TerminalSession({ stream, sink, send: () => {}, from: data.from ?? 0 });
      replayTranscript(session, data);
      setMode("replay", stream);
      void refreshPast();
    } catch (err) {
      onError(err);
    }
  }

  async function refreshPast() {
    // Single-flight: while one past-fetch is outstanding (including a hung one), skip starting another
    // so the supply poll can't stack pending fetches against a slow/unresponsive transcripts endpoint.
    if (pastRefreshing) return;
    pastRefreshing = true;
    try {
      let report;
      try {
        // Bound the fetch: refreshPast() is single-flight, so a transcripts endpoint that never responds
        // would otherwise wedge `pastRefreshing` true forever. Abort after pastFetchTimeoutMs so the fetch
        // always settles (here, rejects), the finally clears the flag, and the next poll can retry.
        const controller = new AbortController();
        const abortTimer = setTimeout(() => controller.abort(), pastFetchTimeoutMs);
        abortTimer.unref?.();
        let res;
        try {
          res = await fetch(transcriptsUrl, { headers: jsonHeaders(), signal: controller.signal });
        } finally {
          clearTimeout(abortTimer);
        }
        if (!res.ok) throw new Error(`transcripts fetch failed: ${res.status}`);
        report = await res.json();
      } catch (err) {
        onError(err);
        return;
      }
      if (disposed) return;
      try {
        renderTranscripts(pastRegion, doc, transcriptsView(report), replayInto, mode === "replay" ? shownStream : undefined);
      } catch (err) {
        onError(err);
      }
    } finally {
      pastRefreshing = false;
    }
  }

  async function refresh() {
    if (disposed) return;
    let report;
    try {
      const res = await fetch(reportUrl, { headers: jsonHeaders() });
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
    // Fire-and-forget: a hung transcripts endpoint must never stall the supply poll's next tick.
    void refreshPast();
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
    opToken++;
    stop();
    teardownTerminal();
    setMode(undefined, undefined);
  }

  start();
  return { start, stop, dispose, refresh, drill: drillInto, replay: replayInto };
}

/**
 * Derive the channel WebSocket URL from the current origin (path `/agentic`).
 *
 * The agentic hub authenticates upgrades with an identity token only
 * (`sharedSecretAuthenticator({ requireCredential: false })`) — no capability credential is required.
 * In SECURE mode a bare `ws(s)://host/agentic` is rejected (4401) until a valid `token` is supplied;
 * in LOCAL mode the hub still requires a `token` query param, but it is a well-known, non-secret
 * value the hub accepts from any origin. Auth is token-only — a `capability` is legacy and ignored
 * by the current hub (`requireCredential: false`); it is still appended to the query when supplied
 * (`?token=…&capability=…`) for backward compatibility but plays no part in authenticating the
 * upgrade. Without a token neither mode can authenticate and drill-in will be refused — pass a
 * token (or an explicit `relayUrl`) for secured deployments.
 */
function defaultRelayUrl(token, capability) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${proto}//${location.host}/agentic`;
  if (!token) return base;
  const query = new URLSearchParams({ token });
  if (capability) query.set("capability", capability);
  return `${base}?${query}`;
}
