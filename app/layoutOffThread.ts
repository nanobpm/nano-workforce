// app/layoutOffThread.ts — the ONE canonical off-main-thread bridge to the CPU-bound BPMN autolayout
// (`layoutBpmn` → `bpmn-auto-layout`), issue #854.
//
// WHY: `layoutBpmn` is superlinear in node/edge count and, run inline on the event loop, blocked the
// whole app (no HTTP, no poll passes) for the entire layout — ~52s on merlin, >4min under load on a
// 54-node delivery graph, a hard lock-up the operator had to kill mid-launch (#852). This module runs
// the layout in a `node:worker_threads` worker so the main loop keeps ticking, and BOUNDS it with a
// timeout that TERMINATES the worker on expiry so a pathological graph fails the launch CLEANLY
// instead of hanging forever.
//
// `layoutDeliveryDiagram` (app/deliveryGraphCompiler.ts) — the single layout entry point BOTH the
// dispatch path (`dispatchDeliveryGraphRun` → `compileDeliveryGraph`) and the preview path
// (`previewProposalBpmn` → `compileDeliveryGraph`) funnel through — calls `layoutBpmnOffThread` here,
// so there is exactly ONE place the autolayout runs and exactly ONE timeout/termination policy.

import { Worker } from "node:worker_threads";
import { readEnvOr } from "./contracts.ts";

/** Node's `setTimeout` delay ceiling (a signed 32-bit ms value). A delay above this silently wraps to
 * 1ms (emitting `TimeoutOverflowWarning`), so an over-large override would abort layouts IMMEDIATELY
 * instead of extending the bound — a value that large is treated as garbage and degrades to the
 * registered default. */
const MAX_TIMER_MS = 2_147_483_647;

/** The registered default, resolved once from the schema (empty env ⇒ registry `default`) so the
 * invalid-override fallback and the timeout message stay single-sourced — not a literal `300000`
 * duplicated here that would drift from `ENV_CONTRACTS`. Mirrors `cloneTimeoutMs` in
 * `app/repoEnvelope.ts`. */
const envDefaultLayoutTimeoutMs = Number(readEnvOr("NANO_DELIVERY_LAYOUT_TIMEOUT_MS", "300000", {}));

/** Resolve the layout timeout (ms) from `NANO_DELIVERY_LAYOUT_TIMEOUT_MS` (registered default 300000
 * = 5 min), degrading to the registered default for any value that is non-positive, garbage, or above
 * Node's timer ceiling ({@link MAX_TIMER_MS} — an overflow would wrap to 1ms and abort every layout).
 * Read per call so an operator can retune it without a restart; the layout is rare (dispatch/preview),
 * so the lookup cost is irrelevant. */
export function layoutTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(readEnvOr("NANO_DELIVERY_LAYOUT_TIMEOUT_MS", "300000", env));
  return Number.isFinite(raw) && raw > 0 && raw <= MAX_TIMER_MS ? raw : envDefaultLayoutTimeoutMs;
}

/** The worker message shape: a laid-out XML payload on success, or a server-side error string. */
type LayoutWorkerMessage = { ok: true; laidOut: string } | { ok: false; error: string };

/** Run `layoutBpmn(semanticBpmn)` in a dedicated `worker_threads` worker, OFF the main event loop,
 * bounded by `timeoutMs`. Resolves with the laid-out XML; rejects (and TERMINATES the worker — the
 * bound that stops a runaway layout) on timeout, a worker error, an early exit, or a layout failure
 * reported by the worker. The worker is always torn down before this resolves/rejects, so no isolate
 * leaks across calls. */
export async function layoutBpmnOffThread(
  semanticBpmn: string,
  timeoutMs: number = layoutTimeoutMs(),
): Promise<string> {
  const worker = new Worker(new URL("./layoutWorker.ts", import.meta.url), { workerData: { semanticBpmn } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn();
      };
      timer = setTimeout(() => {
        settle(() =>
          reject(
            new Error(
              `layoutDeliveryDiagram: BPMN autolayout exceeded its ${timeoutMs}ms bound and was aborted — the ` +
                "delivery graph is too large/dense to lay out within the timeout (bpmn-auto-layout is superlinear in " +
                "node/edge count, issue #854). The launch was failed cleanly rather than hung; retune " +
                `\`NANO_DELIVERY_LAYOUT_TIMEOUT_MS\` (default ${envDefaultLayoutTimeoutMs}) or shrink the graph.`,
            ),
          ),
        );
      }, timeoutMs);
      // A setTimeout in a hot dispatch path should not itself keep a draining process alive.
      timer.unref?.();
      worker.once("message", (msg: LayoutWorkerMessage) => {
        settle(() => {
          if (msg.ok) resolve(msg.laidOut);
          else reject(new Error(msg.error));
        });
      });
      worker.once("error", (err) => settle(() => reject(err)));
      worker.once("exit", (code) => {
        if (code === 0) return; // a clean exit after a delivered message is expected on teardown
        settle(() => reject(new Error(`layoutDeliveryDiagram: layout worker exited early with code ${code}`)));
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
    await worker.terminate();
  }
}
