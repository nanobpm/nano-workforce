// The SUPPLY-only cockpit DOM renderer (ADR 0056, H5 / #148).
//
// Renders a {@link SupplyView} into a host element: the live worker list grouped by leaf token, each
// worker showing family, host, current jobs, and a liveness dot. Clicking a worker calls
// {@link RenderOptions.onDrill} with that worker's relay stream id, which the boot layer turns into a
// live terminal. This renders only the *volatile* part of the page (re-rendered each poll pass); the
// drill-in terminal is owned by {@link ../supply-boot.ts} in a persistent region so it survives a
// refresh.
//
// It draws a supply-only projection ON PURPOSE — NOT the packaged `renderCockpit`, which draws the
// demand×supply matrix, the missing-agent-type reds, and the diversity-SLO light. Those are deferred
// to enrolment epic #152 (see `./supply-view.ts`). The genuinely reusable, correctness-critical parts
// of the cockpit — the relay client and the resume-from-offset terminal session — ARE reused from
// `@nanobpm/agentic/cockpit` by the boot layer; only this supply projection, which the package does
// not provide, is authored here.
//
// Like the packaged renderer it builds against the structural {@link ElementLike} / {@link DocumentLike}
// subset (reused from `@nanobpm/agentic/cockpit`) rather than the global `document`, so the real DOM
// satisfies it at runtime AND a plain in-memory fake satisfies it for DOM-free Node tests (no `as`).
import type { DocumentLike, ElementLike } from "@nanobpm/agentic/cockpit";
import type { Liveness, SupplyLeafView, SupplyView, SupplyWorkerView } from "./supply-view.ts";

export interface RenderSupplyOptions {
  /** Called with a worker's relay stream id when the operator drills into it. */
  readonly onDrill?: (stream: string) => void;
  /** Called with a worker instance when the operator opens its dedicated detail page. */
  readonly onOpenWorker?: (instance: string) => void;
}

/** Handles into the rendered tree the caller may need. */
export interface SupplyDom {
  /** The freshly built root the view was rendered into. */
  readonly root: ElementLike;
}

function el(doc: DocumentLike, tag: string, className?: string, text?: string): ElementLike {
  const node = doc.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function dot(doc: DocumentLike, liveness: Liveness): ElementLike {
  const node = el(doc, "span", "cockpit-dot");
  node.setAttribute("data-liveness", liveness);
  return node;
}

function workerRow(doc: DocumentLike, worker: SupplyWorkerView, options: RenderSupplyOptions): ElementLike {
  const row = el(doc, "tr", "cockpit-supply-worker");
  row.setAttribute("data-worker", worker.instance);
  row.setAttribute("data-liveness", worker.liveness);
  row.setAttribute("data-stream", worker.stream);

  const nameCell = el(doc, "td", "cockpit-td cockpit-supply-name");
  nameCell.appendChild(dot(doc, worker.liveness));
  const button = el(doc, "button", "cockpit-worker", worker.instance);
  button.setAttribute("type", "button");
  button.setAttribute("data-instance", worker.instance);
  // The name button always carries `data-stream` — even for an idle (non-drillable) worker — matching
  // the row's own `data-stream` and the browser mirror (`pages/cockpit/mount.js`). Only the inline
  // drill affordance is gated by `drillable`; the stream identity of the worker is not.
  button.setAttribute("data-stream", worker.stream);
  const onOpenWorker = options.onOpenWorker;
  const onDrill = options.onDrill;
  if (onOpenWorker !== undefined) {
    button.addEventListener("click", () => onOpenWorker(worker.instance));
  }
  nameCell.appendChild(button);
  // The inline live-terminal drill — ONLY for a worker that currently holds a job. An idle worker's
  // `stream` is its bare instance id, which no producer writes to, so drilling it would open a
  // permanently blank "live" terminal (the H6 blank-terminal defect). Suppress the affordance
  // entirely when there is nothing live to stream; the operator can still open the worker's detail
  // page (and its captured past sessions) via the name button.
  if (worker.drillable) {
    const drill = el(doc, "button", "cockpit-worker-drill", "terminal");
    drill.setAttribute("type", "button");
    drill.setAttribute("data-instance", worker.instance);
    drill.setAttribute("data-stream", worker.stream);
    if (onDrill !== undefined) {
      drill.addEventListener("click", () => onDrill(worker.stream));
    }
    nameCell.appendChild(drill);
  }
  row.appendChild(nameCell);

  row.appendChild(el(doc, "td", "cockpit-td cockpit-supply-family", worker.family));
  row.appendChild(el(doc, "td", "cockpit-td cockpit-supply-host", worker.host));

  const jobsCell = el(doc, "td", "cockpit-td cockpit-supply-jobs", worker.jobs === 0 ? "—" : worker.jobKeys.join(", "));
  jobsCell.setAttribute("data-jobs", String(worker.jobs));
  row.appendChild(jobsCell);

  // The process instance / plan each current job belongs to (H6). Each correlation is a drill button
  // onto its jobKey-scoped relay stream, so the operator opens the LIVE job's terminal — not just the
  // worker's default stream. Empty → "—" so the cell always renders something stable.
  const processCell = el(doc, "td", "cockpit-td cockpit-supply-process");
  processCell.setAttribute("data-correlations", String(worker.correlations.length));
  if (worker.correlations.length === 0) {
    processCell.textContent = "—";
  } else {
    for (const correlation of worker.correlations) {
      const link = el(doc, "button", "cockpit-correlation", correlation.label);
      link.setAttribute("type", "button");
      link.setAttribute("data-job-key", correlation.jobKey);
      link.setAttribute("data-stream", correlation.stream);
      if (onDrill !== undefined) {
        link.addEventListener("click", () => onDrill(correlation.stream));
      }
      processCell.appendChild(link);
    }
  }
  row.appendChild(processCell);

  const livenessCell = el(doc, "td", "cockpit-td cockpit-supply-liveness", worker.liveness);
  livenessCell.setAttribute("data-liveness", worker.liveness);
  row.appendChild(livenessCell);

  return row;
}

function leafSection(doc: DocumentLike, leaf: SupplyLeafView, options: RenderSupplyOptions): ElementLike {
  const section = el(doc, "section", "cockpit-leaf");
  section.setAttribute("data-leaf", leaf.token);

  const header = el(doc, "div", "cockpit-leaf-head");
  header.appendChild(el(doc, "span", "cockpit-leaf-name", leaf.token));
  header.appendChild(el(doc, "span", "cockpit-leaf-count", `${leaf.liveCount}/${leaf.total} live`));
  section.appendChild(header);

  const table = el(doc, "table", "cockpit-supply-table");
  const thead = el(doc, "thead", "cockpit-supply-thead");
  const head = el(doc, "tr", "cockpit-supply-head");
  for (const label of ["worker", "family", "host", "jobs", "process / plan", "liveness"]) {
    head.appendChild(el(doc, "th", "cockpit-th", label));
  }
  thead.appendChild(head);
  table.appendChild(thead);

  const tbody = el(doc, "tbody", "cockpit-supply-tbody");
  for (const worker of leaf.workers) {
    tbody.appendChild(workerRow(doc, worker, options));
  }
  table.appendChild(tbody);
  section.appendChild(table);
  return section;
}

/**
 * Render `view` into `host`, replacing whatever was there. Idempotent: call it again on every refresh
 * to reflect the latest supply snapshot.
 */
export function renderSupply(
  host: ElementLike,
  doc: DocumentLike,
  view: SupplyView,
  options: RenderSupplyOptions = {},
): SupplyDom {
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
    return { root };
  }

  const list = el(doc, "div", "cockpit-supply-list");
  for (const leaf of view.leaves) {
    list.appendChild(leafSection(doc, leaf, options));
  }
  root.appendChild(list);

  host.appendChild(root);
  return { root };
}
