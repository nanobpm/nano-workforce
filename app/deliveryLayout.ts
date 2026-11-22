// app/deliveryLayout.ts — graceful degradation of the delivery-graph diagram-interchange layout
// (issue #1005).
//
// A diagram is for humans: a graph's semantics, and whether it can run, never depend on it. Before
// this module, preview and dispatch were all-or-nothing on `bpmn-auto-layout` — a layout that hit
// `NANO_DELIVERY_LAYOUT_TIMEOUT_MS`, or a router `LayoutError` on ONE flow (e.g. `ROUTING_FAILED`),
// failed the whole operation and left the operator with no preview and nothing to launch.
//
// The ONE layout entry point (`layoutDeliveryDiagram` in the compiler) now degrades in order:
//   1. `expanded`  — the normal layout (the SDK seeds every embedded sub-process expanded).
//   2. `collapsed` — retry with sub-processes COLLAPSED onto drill-down planes (a minimal seed DI with
//                    no expanded shapes), which is far smaller to route.
//   3. `none`      — no auto-layout at all: a deterministic grid DI of the root plane is attached so the
//                    deployed model still carries DI (repo rule "BPMN models need DI"), and the preview
//                    says plainly that no diagram could be laid out, with the reason.
// The fallback NEVER doubles the timeout budget: the expanded attempt gets a share of the single
// `layoutTimeoutMs()` budget and the collapsed retry gets whatever remains.

import { layoutBpmnOffThread, layoutTimeoutMs } from "./layoutOffThread.ts";

/** Which layout produced the attached DI. */
export type DeliveryLayoutMode = "expanded" | "collapsed" | "none";

/** How the delivery diagram was laid out — surfaced by the preview and recorded on dispatch. */
export interface DeliveryLayoutInfo {
  mode: DeliveryLayoutMode;
  /** Why the expanded (and, for `none`, the collapsed) layout failed. Absent for `expanded`. */
  reason?: string;
  /** Operator-facing one-liner, e.g. "layout: collapsed (expanded layout failed: …)". */
  message: string;
}

/** The laid-out BPMN plus how it was laid out. */
export interface DeliveryLayoutResult {
  /** The semantic BPMN byte-for-byte with a `bpmndi:BPMNDiagram` grafted in (always present). */
  bpmn: string;
  layout: DeliveryLayoutInfo;
}

/** Injectable layout seam: lay out `xml` within `timeoutMs`, resolving the laid-out XML. */
export type LayoutFn = (xml: string, timeoutMs: number) => Promise<string>;

export interface LayoutWithFallbackOptions {
  layout?: LayoutFn;
  /** Total budget (ms) for ALL attempts. Default: `layoutTimeoutMs()`. */
  budgetMs?: number;
  now?: () => number;
}

/** Share of the total budget the expanded attempt may use; the collapsed retry gets the remainder. */
export const EXPANDED_BUDGET_SHARE = 0.6;

// The bound is an ABSOLUTE deadline carried through semaphore admission AND worker execution, so time
// spent queued behind other layouts is charged against this attempt's share (issue #1005 review).
const defaultLayout: LayoutFn = (xml, timeoutMs) =>
  layoutBpmnOffThread(xml, timeoutMs, undefined, { deadline: Date.now() + timeoutMs });

/** Bound one attempt with a hard timer so a never-settling layout (an injected `LayoutFn` that ignores
 * `timeoutMs`) can never hang the fallback chain. The default worker layout keeps its own timeout and
 * worker teardown; this race only guarantees the chain advances. */
function bounded(attempt: Promise<string>, ms: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`layout timed out after ${ms}ms`)), ms);
  });
  return Promise.race([attempt, guard]).finally(() => clearTimeout(timer));
}

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    const code = "code" in err ? err.code : undefined;
    return typeof code === "string" && !err.message.includes(code) ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

/** Lay out `semanticBpmn`, degrading expanded → collapsed → grid (no auto-layout). Never throws on a
 * layout failure; throws only if the semantic BPMN itself is structurally unusable (no
 * `</bpmn:definitions>` / process), which is a compiler bug, not a layout one. */
export async function layoutWithFallback(
  semanticBpmn: string,
  options: LayoutWithFallbackOptions = {},
): Promise<DeliveryLayoutResult> {
  const layout = options.layout ?? defaultLayout;
  const budget = Math.max(1, options.budgetMs ?? layoutTimeoutMs());
  const now = options.now ?? Date.now;
  const started = now();

  let expandedReason: string;
  try {
    const share = Math.max(1, Math.floor(budget * EXPANDED_BUDGET_SHARE));
    const laidOut = await bounded(layout(semanticBpmn, share), share);
    return { bpmn: graftDiagram(semanticBpmn, laidOut), layout: { mode: "expanded", message: "layout: expanded" } };
  } catch (err) {
    expandedReason = errMessage(err);
  }

  const remaining = budget - (now() - started);
  let collapsedReason: string;
  if (remaining < 1) {
    collapsedReason = "no layout budget left for the collapsed retry";
  } else {
    try {
      const laidOut = await bounded(layout(seedCollapsedSubProcesses(semanticBpmn), remaining), remaining);
      return {
        bpmn: graftDiagram(semanticBpmn, laidOut),
        layout: {
          mode: "collapsed",
          reason: expandedReason,
          message: `layout: collapsed (expanded layout failed: ${expandedReason})`,
        },
      };
    } catch (err) {
      collapsedReason = errMessage(err);
    }
  }

  const reason = `expanded layout failed: ${expandedReason}; collapsed layout failed: ${collapsedReason}`;
  return {
    bpmn: graftDiagram(semanticBpmn, gridDiagram(semanticBpmn)),
    layout: {
      mode: "none",
      reason,
      message: `No diagram could be laid out for this graph (${reason}). The graph is still valid and can be dispatched; it deploys with a basic grid diagram.`,
    },
  };
}

/** Keep the compiler's semantic XML BYTE-FOR-BYTE and graft only the `<bpmndi:BPMNDiagram>` block(s)
 * of `laidOut` onto it (see `layoutDeliveryDiagram` for why we never return the round-tripped XML). A
 * layout that produced NO diagram is a failure (the DI-less bug of #440), so this throws — and inside
 * {@link layoutWithFallback} that throw degrades to the next mode like any other layout failure. */
export function graftDiagram(semanticBpmn: string, laidOut: string): string {
  const start = laidOut.indexOf("<bpmndi:BPMNDiagram");
  const endTag = "</bpmndi:BPMNDiagram>";
  const end = laidOut.lastIndexOf(endTag);
  if (start === -1 || end === -1) {
    throw new Error(
      "compileDeliveryGraph: layoutBpmn produced no bpmndi:BPMNDiagram, so the compiled graph would " +
        "deploy DI-less and render positionless in the process explorer (#440). This usually means the " +
        "`bpmn-auto-layout` toolkit peer is missing (the toolkit then silently no-ops layout), but it " +
        "can also indicate a change in `layoutBpmn` output (different namespace prefix/serialization) or " +
        "an internal layout failure returning semantic-only XML.",
    );
  }
  const diagram = laidOut.slice(start, end + endTag.length);
  // A diagram with no node shapes (e.g. a no-op layouter echoing the collapsed seed back) is as
  // useless as no diagram: fail so the fallback chain degrades to the grid instead of a blank plane.
  if (!diagram.includes("<bpmndi:BPMNShape")) {
    throw new Error("compileDeliveryGraph: layout produced a bpmndi:BPMNDiagram with no node shapes");
  }
  const closing = "</bpmn:definitions>";
  const insertAt = semanticBpmn.lastIndexOf(closing);
  if (insertAt === -1) {
    throw new Error("compileDeliveryGraph: compiled BPMN has no </bpmn:definitions> to graft DI into");
  }
  return `${semanticBpmn.slice(0, insertAt)}  ${diagram}\n${semanticBpmn.slice(insertAt)}`;
}

function rootProcessId(semanticBpmn: string): string {
  const m = /<bpmn:process\b[^>]*?\sid="([^"]+)"/.exec(semanticBpmn);
  if (!m?.[1]) throw new Error("compileDeliveryGraph: compiled BPMN has no bpmn:process id");
  return m[1];
}

/** Seed a minimal DI whose root plane marks NO sub-process expanded. The SDK only seeds its own
 * expanded DI into DI-less input, so this makes `bpmn-auto-layout` collapse every sub-process onto a
 * drill-down plane — a far smaller routing problem than the expanded diagram. */
export function seedCollapsedSubProcesses(semanticBpmn: string): string {
  const procId = rootProcessId(semanticBpmn);
  const closing = "</bpmn:definitions>";
  const at = semanticBpmn.lastIndexOf(closing);
  if (at === -1) throw new Error("compileDeliveryGraph: compiled BPMN has no </bpmn:definitions>");
  const seed =
    `<bpmndi:BPMNDiagram id="CollapsedSeed_diagram"><bpmndi:BPMNPlane id="CollapsedSeed_plane" ` +
    `bpmnElement="${procId}"/></bpmndi:BPMNDiagram>`;
  return `${semanticBpmn.slice(0, at)}${seed}\n${semanticBpmn.slice(at)}`;
}

const FLOW_NODE_TAGS = new Set([
  "startEvent",
  "endEvent",
  "intermediateCatchEvent",
  "intermediateThrowEvent",
  "boundaryEvent",
  "task",
  "serviceTask",
  "userTask",
  "scriptTask",
  "sendTask",
  "receiveTask",
  "businessRuleTask",
  "manualTask",
  "callActivity",
  "subProcess",
  "exclusiveGateway",
  "parallelGateway",
  "inclusiveGateway",
  "eventBasedGateway",
  "complexGateway",
]);

/** A deterministic, layout-engine-free DI of the ROOT plane: every top-level flow node on a grid
 * (sub-processes collapsed, no drill-down planes) and every top-level sequence flow as a straight
 * centre-to-centre edge. Not pretty — it exists so a graph that defeats the auto-layout still deploys
 * WITH DI rather than refusing to run. */
export function gridDiagram(semanticBpmn: string): string {
  const procId = rootProcessId(semanticBpmn);
  const procOpen = semanticBpmn.search(/<bpmn:process\b/);
  const procClose = semanticBpmn.indexOf("</bpmn:process>", procOpen);
  const body = semanticBpmn.slice(procOpen, procClose === -1 ? undefined : procClose);
  // Strip comments/CDATA so markup-like text inside them is never read as an element.
  const scan = body.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, "");

  const nodes: { id: string; tag: string }[] = [];
  const flows: { id: string; source: string; target: string }[] = [];
  let depth = 0; // 0 = inside bpmn:process (after its own open tag)
  let first = true;
  for (const m of scan.matchAll(/<(\/?)bpmn:([A-Za-z]+)\b([^>]*?)(\/?)>/g)) {
    const [, closingSlash, tag = "", attrs = "", selfClose] = m;
    if (first) {
      first = false; // the bpmn:process open tag itself
      continue;
    }
    if (closingSlash) {
      depth--;
      continue;
    }
    if (depth === 0) {
      const id = /\sid="([^"]+)"/.exec(attrs)?.[1];
      if (id && FLOW_NODE_TAGS.has(tag)) nodes.push({ id, tag });
      if (id && tag === "sequenceFlow") {
        const source = /\ssourceRef="([^"]+)"/.exec(attrs)?.[1];
        const target = /\stargetRef="([^"]+)"/.exec(attrs)?.[1];
        if (source && target) flows.push({ id, source, target });
      }
    }
    if (!selfClose) depth++;
  }

  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const pos = new Map<string, { x: number; y: number; w: number; h: number }>();
  const shapes = nodes.map((n, i) => {
    const isEvent = n.tag.endsWith("Event");
    const isGateway = n.tag.endsWith("Gateway");
    const w = isEvent ? 36 : isGateway ? 50 : 100;
    const h = isEvent ? 36 : isGateway ? 50 : 80;
    const x = 100 + (i % cols) * 200 + (100 - w) / 2;
    const y = 100 + Math.floor(i / cols) * 160 + (80 - h) / 2;
    pos.set(n.id, { x, y, w, h });
    const expanded = n.tag === "subProcess" ? ` isExpanded="false"` : "";
    return (
      `<bpmndi:BPMNShape id="${n.id}_di" bpmnElement="${n.id}"${expanded}>` +
      `<dc:Bounds x="${x}" y="${y}" width="${w}" height="${h}"/></bpmndi:BPMNShape>`
    );
  });
  const edges = flows
    .filter((f) => pos.has(f.source) && pos.has(f.target))
    .map((f) => {
      const a = pos.get(f.source);
      const b = pos.get(f.target);
      if (!a || !b) return "";
      return (
        `<bpmndi:BPMNEdge id="${f.id}_di" bpmnElement="${f.id}">` +
        `<di:waypoint x="${a.x + a.w / 2}" y="${a.y + a.h / 2}"/>` +
        `<di:waypoint x="${b.x + b.w / 2}" y="${b.y + b.h / 2}"/></bpmndi:BPMNEdge>`
      );
    });
  return (
    `<bpmndi:BPMNDiagram id="GridDiagram_1"><bpmndi:BPMNPlane id="GridPlane_1" bpmnElement="${procId}">` +
    shapes.join("") +
    edges.join("") +
    `</bpmndi:BPMNPlane></bpmndi:BPMNDiagram>`
  );
}
