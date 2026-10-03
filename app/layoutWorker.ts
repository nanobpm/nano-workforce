// app/layoutWorker.ts — the `node:worker_threads` entry that runs the CPU-bound BPMN autolayout
// (`layoutBpmn` → `bpmn-auto-layout`) OFF the app's main event loop (issue #854).
//
// `bpmn-auto-layout` is superlinear in node/edge count: on the 54-node merlin delivery graph it ran
// ~52s on merlin and >4min under real load, and because it ran SYNCHRONOUSLY on the event loop in
// `layoutDeliveryDiagram`, the whole app served no HTTP and ran no poll passes for that entire window
// — the operator saw a hard lock-up (#852). Hoisting the layout into this worker keeps the main loop
// free to serve pages/API/MCP and tick its poll loop while a large graph lays out; the parent bounds
// the work with a timeout and TERMINATES this worker on expiry (see `app/layoutOffThread.ts`), so a
// pathological graph fails the launch cleanly instead of hanging forever.
//
// Protocol: `workerData.semanticBpmn` carries the pre-layout semantic BPMN; we post back either the
// laid-out XML (a string) on success or `{ error }` on failure. We never `process.exit` — resolving
// the message lets the parent `terminate()` us.

import { parentPort, workerData } from "node:worker_threads";
import { layoutBpmn } from "@nanobpm/urban";

async function run(): Promise<void> {
  const port = parentPort;
  if (!port) throw new Error("layoutWorker: must be spawned as a worker_threads worker (no parentPort)");
  const { semanticBpmn } = workerData ?? {};
  if (typeof semanticBpmn !== "string") {
    throw new Error("layoutWorker: workerData.semanticBpmn must be a string");
  }
  try {
    const laidOut = await layoutBpmn(semanticBpmn);
    port.postMessage({ ok: true, laidOut });
  } catch (err) {
    port.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

void run();
