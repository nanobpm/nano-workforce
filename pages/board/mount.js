// pages/board/mount.js — the demand×supply board (enrolment epic #152 / N2 #153, ADR 0056 §8–10,
// ADR 0057 App View).
//
// A self-contained, dependency-free renderer: it polls the app's `GET /app/api/agentic/registry`
// report and paints the demand×supply matrix by network, the missing-agent-type reds, and the
// diversity-SLO lights. The SAME module renders embedded in the console (App View) and standalone on
// a phone — only the host element and the injected endpoint config differ. Read-only and advisory;
// it never gates a BPMN flow.
//
// The app has no browser build step, so the report projection is consumed straight off the wire
// (the typed core that produces it lives app-side in `app/agentic/vocab/demand-report.ts`); this
// module only renders it.

const DEFAULT_REPORT_URL = "/app/api/agentic/registry";
const POLL_MS = 5000;

/** Escape untrusted report strings before they touch innerHTML. */
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

/** A status pill (green / amber / red) with a label. */
function pill(status, label) {
  const s = status === "green" || status === "amber" || status === "red" ? status : "unknown";
  return `<span class="pill pill-${s}">${esc(label ?? s)}</span>`;
}

function renderDiversity(diversity) {
  if (!diversity) return "";
  const rows = (diversity.roles ?? [])
    .map((role) => {
      const seats = (role.assignments ?? [])
        .map((a) => `<code>${esc(a.seat)}</code>=${esc(a.family)}${a.instance ? ` <span class="muted">(${esc(a.instance)})</span>` : ""}`)
        .join(" · ");
      const strict = role.seatsDistinctFamily ? '<span class="muted">strict</span>' : '<span class="muted">warn</span>';
      const collide = (role.collidingFamilies ?? []).length ? ` — <span class="red">collision: ${esc(role.collidingFamilies.join(", "))}</span>` : "";
      return `<tr>
        <td>${pill(role.status)}</td>
        <td><code>${esc(role.token)}</code> ${strict}</td>
        <td>${seats || '<span class="muted">no seated workers</span>'}${collide}</td>
      </tr>`;
    })
    .join("");
  return `<section class="card">
    <h2>Diversity SLO ${pill(diversity.status)}</h2>
    <p class="muted">Seat families per role — the red/blue seats want distinct families (ADR 0056 §10). A same-family collision on a strict role is a violation (red).</p>
    ${rows ? `<table class="grid"><thead><tr><th>SLO</th><th>Role</th><th>Seats</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">No gradeable roles are seated yet.</p>'}
  </section>`;
}

function renderNetwork(network) {
  const rows = (network.tokens ?? [])
    .map((token) => {
      const status = token.satisfied ? "green" : "red";
      const instances = (token.instances ?? []).length ? esc(token.instances.join(", ")) : '<span class="muted">—</span>';
      return `<tr class="${token.satisfied ? "" : "row-missing"}">
        <td>${pill(status, token.satisfied ? "supplied" : "missing")}</td>
        <td><code>${esc(token.token)}</code></td>
        <td class="num">${esc(token.supply)}</td>
        <td>${instances}</td>
      </tr>`;
    })
    .join("");
  const missing = (network.missing ?? []).length
    ? `<p class="red">Missing agent types: ${network.missing.map((m) => `<code>${esc(m)}</code>`).join(", ")}</p>`
    : '<p class="muted">All demanded tokens supplied.</p>';
  return `<section class="card">
    <h2><code>${esc(network.network)}</code></h2>
    <table class="grid"><thead><tr><th>Supply</th><th>Token</th><th class="num">#</th><th>Instances</th></tr></thead><tbody>${rows}</tbody></table>
    ${missing}
  </section>`;
}

function render(root, report) {
  const networks = report.networks ?? [];
  const overall = pill(report.status, `overall: ${report.status}`);
  const demandNote = report.demandUnavailable
    ? '<p class="red">Demand unavailable — the deployed models could not be read from the engine, so this reflects live supply only.</p>'
    : "";
  const missingAll = (report.missing ?? []).length
    ? `<p class="red">Missing across all networks: ${report.missing.map((m) => `<code>${esc(m)}</code>`).join(", ")}</p>`
    : '<p class="muted">No missing agent types.</p>';
  const body = networks.length
    ? networks.map(renderNetwork).join("")
    : '<section class="card"><p class="muted">No demand to show.</p></section>';
  root.innerHTML = `<div class="board">
    <header class="board-head">
      <div>${overall} <span class="muted">vocab v${esc(report.version)} · ${esc(report.generatedAt)}</span></div>
      ${missingAll}
      ${demandNote}
    </header>
    ${renderDiversity(report.diversity)}
    <div class="networks">${body}</div>
  </div>`;
}

function renderError(root, message) {
  root.innerHTML = `<div class="board"><section class="card"><p class="red">Failed to load the demand×supply report: ${esc(message)}</p></section></div>`;
}

/**
 * Mount the board into `host`, polling the registry report. `config.reportUrl` overrides the default
 * endpoint; `config.hookSecret` is sent as `x-hook-secret` for a secured deployment.
 */
export function mountBoard(host, config = {}) {
  const isElement = host != null && host.nodeType === 1 && typeof host.innerHTML === "string";
  const root = isElement ? host : document.getElementById("board-root");
  if (!root) return () => {};
  const reportUrl = config.reportUrl ?? DEFAULT_REPORT_URL;
  const headers = config.hookSecret ? { "x-hook-secret": config.hookSecret } : {};
  let stopped = false;
  let timer = null;

  async function tick() {
    try {
      const res = await fetch(reportUrl, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const report = await res.json();
      if (!stopped) render(root, report);
    } catch (err) {
      if (!stopped) renderError(root, err && err.message ? err.message : String(err));
    }
    if (!stopped) timer = setTimeout(tick, POLL_MS);
  }
  tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
