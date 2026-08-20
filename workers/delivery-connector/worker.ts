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

/** A plain (non-array, non-null) object — the only shape a connector `payload` may take. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate + normalise the untyped job variables into the shape the connector surface accepts. Job
 * variables are untyped at runtime, so a misconfigured node (or a hand-seeded instance) could hand us a
 * blank `target`, a scalar `payload`, or a non-array `boundFacts`. Fail CLOSED on a blank `target` (a
 * connector with no destination is meaningless and would write a junk ledger row); coerce a wrong-shaped
 * `payload`/`boundFacts` to `null` (they are optional) and surface the coercion via `warnings` so the
 * caller can log it rather than silently pass garbage into the I/O surface. */
export function readConnectorInput(vars: In): {
  target: string;
  payload: Record<string, unknown> | null;
  boundFacts: BoundFact[] | null;
  warnings: string[];
} {
  const target = typeof vars.target === "string" ? vars.target.trim() : "";
  if (!target) throw new Error("delivery-connector: 'target' is required (blank connector target)");
  const warnings: string[] = [];
  let payload: Record<string, unknown> | null = null;
  if (vars.payload != null) {
    if (isPlainObject(vars.payload)) payload = vars.payload;
    else warnings.push("payload is not a plain object — coerced to null");
  }
  let boundFacts: BoundFact[] | null = null;
  if (vars.boundFacts != null) {
    if (Array.isArray(vars.boundFacts)) boundFacts = vars.boundFacts;
    else warnings.push("boundFacts is not an array — coerced to null");
  }
  return { target, payload, boundFacts, warnings };
}

const handler: AppJobHandler<In, ConnectorDispatchResult> = async (job, app) => {
  const { target, payload, boundFacts, warnings } = readConnectorInput(job.variables);
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
  for (const w of warnings) app.log.info("delivery-connector: input coerced", { target, dedupeKey, warning: w });
  const result = await dispatchConnector(
    app.data,
    { dedupeKey, target, payload, boundFacts },
    new Date().toISOString(),
  );
  app.log.info("delivery-connector", { target, dedupeKey, outcome: result.connectorOutcome });
  return result;
};

export default handler;
