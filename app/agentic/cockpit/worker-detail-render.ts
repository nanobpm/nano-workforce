import type { DocumentLike, ElementLike } from "@nanobpm/agentic/cockpit";
import type { WorkerDetailView } from "./worker-detail-view.ts";

export interface RenderWorkerDetailOptions {
  readonly onBack?: () => void;
  readonly onDrill?: (stream: string) => void;
}

export interface WorkerDetailDom {
  readonly root: ElementLike;
}

function el(doc: DocumentLike, tag: string, className?: string, text?: string): ElementLike {
  const node = doc.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function backButton(doc: DocumentLike, onBack: (() => void) | undefined): ElementLike {
  const button = el(doc, "button", "cockpit-worker-detail-back", "← Workers");
  button.setAttribute("type", "button");
  if (onBack !== undefined) button.addEventListener("click", onBack);
  return button;
}

export function renderWorkerDetail(
  host: ElementLike,
  doc: DocumentLike,
  view: WorkerDetailView,
  options: RenderWorkerDetailOptions = {},
): WorkerDetailDom {
  host.replaceChildren();
  const root = el(doc, "section", "cockpit-worker-detail");
  root.appendChild(backButton(doc, options.onBack));

  if (view.kind === "missing") {
    root.setAttribute("data-worker-missing", view.instance);
    root.appendChild(el(doc, "h1", "cockpit-title", `Worker ${view.instance}`));
    root.appendChild(el(doc, "div", "cockpit-worker-detail-empty", `Worker ${view.instance} is not in the current supply report.`));
    host.appendChild(root);
    return { root };
  }

  const worker = view.worker;
  root.setAttribute("data-worker-detail", worker.instance);
  root.setAttribute("data-liveness", worker.liveness);

  const header = el(doc, "header", "cockpit-worker-detail-header");
  const title = el(doc, "h1", "cockpit-title", worker.instance);
  header.appendChild(title);
  const meta = el(doc, "dl", "cockpit-worker-detail-meta");
  for (const [klass, label, value] of [
    ["identity", "identity", worker.identity],
    ["host", "host", worker.host],
    ["family", "family", worker.family],
    ["liveness", "liveness", worker.liveness],
  ] as const) {
    const item = el(doc, "div", "cockpit-worker-detail-meta-item");
    item.setAttribute("data-field", klass);
    item.appendChild(el(doc, "dt", undefined, label));
    const dd = el(doc, "dd", `cockpit-worker-detail-${klass}`, value);
    if (klass === "liveness") dd.setAttribute("data-liveness", worker.liveness);
    item.appendChild(dd);
    meta.appendChild(item);
  }
  header.appendChild(meta);
  root.appendChild(header);

  const current = el(doc, "section", "cockpit-worker-current");
  current.appendChild(el(doc, "h2", "cockpit-panel-title", "Current job"));
  if (view.currentJob === undefined) {
    current.appendChild(el(doc, "div", "cockpit-worker-current-empty", "No active job."));
  } else {
    const currentJob = view.currentJob;
    const button = el(doc, "button", "cockpit-worker-current-job", currentJob.label);
    button.setAttribute("type", "button");
    button.setAttribute("data-job-key", currentJob.jobKey);
    button.setAttribute("data-stream", currentJob.stream);
    const onDrill = options.onDrill;
    if (onDrill !== undefined) button.addEventListener("click", () => onDrill(currentJob.stream));
    current.appendChild(button);
  }
  root.appendChild(current);

  host.appendChild(root);
  return { root };
}
