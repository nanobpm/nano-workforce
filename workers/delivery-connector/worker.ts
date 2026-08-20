// pr.delivery-connector — the delivery-graph `connector` node's engine-native execution body (ADR 0005
// slice S4). The service-task half of a compiled `connector` subProcess: it drives the forward-declared
// connector I/O surface AT-MOST-ONCE per dedupe key, so the engine's at-least-once job delivery (a
// worker/hub restart, a lost ack, a graph resume) can never double-fire the side effect (Decision 7).
//
// All the idempotency logic lives in `app/deliveryConnector.ts` (the durable-fence ledger + claim→act
// envelope) so it is unit-testable without the engine and shares ONE implementation with any other
// caller; this worker is the thin engine adapter that resolves the effective dedupe key from the job's
// author-supplied `dedupeKey` or its stable engine identity (`processInstanceKey:elementId`).
import type { AppJobHandler } from "@nanobpm/urban";
import {
  type BoundFact,
  type ConnectorDispatchResult,
  connectorDedupeKey,
  dispatchConnector,
} from "../../app/deliveryConnector.ts";

// Typed off the compiled `connector` subProcess ioMapping (a RUNTIME-generated definition, so there is
// no static data-envelope to derive from): `target`/`dedupeKey`/`payload` are seeded from the node's
// config, `boundFacts` is the late-bound list of upstream producers' emitted facts.
interface In extends Record<string, unknown> {
  target?: string;
  dedupeKey?: string | null;
  payload?: Record<string, unknown> | null;
  boundFacts?: BoundFact[] | null;
}

const handler: AppJobHandler<In, ConnectorDispatchResult> = async (job, app) => {
  const target = typeof job.variables.target === "string" ? job.variables.target : "";
  const dedupeKey = connectorDedupeKey({
    dedupeKey: job.variables.dedupeKey ?? null,
    processInstanceKey: job.processInstanceKey ?? null,
    elementId: job.elementId ?? null,
  });
  if (!dedupeKey) {
    // No author key AND no engine identity to derive one — un-dedupable. Fail closed rather than
    // perform a side effect we could not make idempotent (never double-fire).
    throw new Error("delivery-connector: no dedupe key (author-supplied or graph-derived) available");
  }
  const result = await dispatchConnector(
    app.data,
    { dedupeKey, target, payload: job.variables.payload ?? null, boundFacts: job.variables.boundFacts ?? null },
    new Date().toISOString(),
  );
  app.log.info("delivery-connector", { target, dedupeKey, outcome: result.connectorOutcome });
  return result;
};

export default handler;
