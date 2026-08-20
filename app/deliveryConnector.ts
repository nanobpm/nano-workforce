// nano-workforce — the delivery-graph `connector` node's execution body (ADR 0005 Decision 6/7, slice
// S4). A `connector` is the epic's one SIDE-EFFECTING node kind — it drives an outbound action against
// the connector I/O surface. That surface is FORWARD-DECLARED here (the concrete connector scheme and
// payload land in a later slice, per the ADR non-goals): `performConnectorAction` is a deliberate STUB.
// But the node is REAL — it is deployed, scheduled engine-natively, and, crucially, IDEMPOTENT, so the
// dedupe contract every side-effecting node inherits is exercised end-to-end today rather than
// retrofitted onto a live integration later.
//
// Idempotency (Decision 7). The engine delivers a service-task job AT-LEAST-ONCE: a worker/hub restart,
// a lost completion ack, or a graph resume re-activates the same job. So the dispatch is claimed in a
// durable ledger (`delivery_connector_dispatches`, migration 055) BEFORE the action fires; a redelivery
// that finds the key already claimed short-circuits to the recorded outcome (`deduped`) and never
// re-performs the side effect. The UNIQUE fence on `dedupe_key` makes the claim atomic even under a
// concurrent race — the loser is classified by the ONE canonical `isUniqueConstraintFence` (app/dbFence.ts)
// as the SAME idempotent `deduped` outcome, not a spurious failure (the durable-fence idiom, no drift).
import type { DataLayer } from "@nanobpm/urban";
import { isUniqueConstraintFence } from "./dbFence.ts";

/** The engine `taskType` a compiled `connector` node's inlined subProcess delegates to. Single source
 * of truth shared by the compiler's delegation map (`DELEGATE_TASK_TYPE.connector`), the worker
 * registration (`nano.app.json`), and any test that stubs the worker — so they can never drift. */
export const DELIVERY_CONNECTOR_TASK_TYPE = "pr.delivery-connector";

/** One durable dispatch-claim row — the at-most-once ledger entry a connector writes before it acts. */
export interface DeliveryConnectorDispatchRow extends Record<string, unknown> {
  id?: number;
  dedupe_key: string;
  target: string;
  outcome: string;
  detail: string | null;
  dispatched_at: string;
}

/** The `delivery_connector_dispatches` ledger accessor (migration 055). Access goes through the RAD
 * `Table<T>` gateway (`data.table`), never hand-written SQL — matching every other data path in the app. */
export const deliveryConnectorDispatches = (data: DataLayer) =>
  data.table<DeliveryConnectorDispatchRow>("delivery_connector_dispatches", "id");

/** A late-bound upstream fact threaded into a consuming node (the `boundFacts` list the compiler emits). */
export interface BoundFact {
  from: string;
  name: string;
  value: unknown;
}

/** The effective dedupe key for a connector dispatch: the author-supplied `connector.dedupeKey` when
 * present, else a graph-derived `<processInstanceKey>:<elementId>` — both STABLE across a re-activation
 * of the same node instance (the engine re-delivers the same job with the same identity), so an
 * at-least-once redelivery collapses onto the same ledger row. The single derivation site so the runner
 * (which may pre-seed an author key) and the worker agree on the key shape. Returns `null` only when no
 * key can be formed at all (no author key AND no engine identity) — the caller treats that as
 * un-dedupable and MUST NOT perform the side effect (fail closed rather than double-fire). */
export function connectorDedupeKey(input: {
  dedupeKey?: string | null;
  processInstanceKey?: string | null;
  elementId?: string | null;
}): string | null {
  const authored = typeof input.dedupeKey === "string" ? input.dedupeKey.trim() : "";
  if (authored) return authored;
  const pik = typeof input.processInstanceKey === "string" ? input.processInstanceKey.trim() : "";
  const el = typeof input.elementId === "string" ? input.elementId.trim() : "";
  if (pik && el) return `${pik}:${el}`;
  return null;
}

/** The forward-declared connector I/O surface (ADR non-goal — the concrete scheme is deferred). A STUB
 * that "performs" the action by returning a deterministic acknowledgement; a later slice replaces the
 * body with the real transport without touching the idempotency envelope around it. */
function performConnectorAction(_input: {
  target: string;
  payload: Record<string, unknown> | null;
  boundFacts: readonly BoundFact[];
}): { detail: string } {
  return { detail: "connector stub — I/O surface forward-declared (ADR 0005 non-goal)" };
}

/** The result of one connector dispatch attempt. `delivered` — the claim was won and the action fired
 * exactly once; `deduped` — the key was already claimed (an at-least-once redelivery), so the recorded
 * outcome is returned and NO side effect re-fired. */
export interface ConnectorDispatchResult extends Record<string, unknown> {
  connectorOutcome: "delivered" | "deduped";
  connectorDedupeKey: string;
  connectorDetail: string;
}

/** Dispatch a connector action AT-MOST-ONCE against its dedupe key. CLAIMS the ledger row FIRST (the
 * UNIQUE fence is the atomic gate that elects exactly one winner), and ONLY the claim winner performs
 * the forward-declared action — so an at-least-once redelivery, or a concurrent racer, can never
 * double-fire the side effect. A redelivery whose key is already claimed — observed by the fast-path
 * `findOne` OR the fence collision a concurrent claimer raced us to — returns `deduped` WITHOUT acting.
 * The winner records the action's outcome by updating its own claim row, so a later `deduped` replay
 * reports the ORIGINAL detail. (For the STUB action this two-step claim→act→record is already the full
 * durable envelope; a real transport later slots a resumable `applied` reconcile in, as the world-store
 * ledger does, without changing this contract.) */
export async function dispatchConnector(
  data: DataLayer,
  input: { dedupeKey: string; target: string; payload?: Record<string, unknown> | null; boundFacts?: readonly BoundFact[] | null },
  at: string,
): Promise<ConnectorDispatchResult> {
  const ledger = deliveryConnectorDispatches(data);
  const existing = await ledger.findOne({ dedupe_key: input.dedupeKey });
  if (existing) {
    return { connectorOutcome: "deduped", connectorDedupeKey: input.dedupeKey, connectorDetail: existing.detail ?? "" };
  }
  let claimId: number | bigint;
  try {
    claimId = await ledger.insert({
      dedupe_key: input.dedupeKey,
      target: input.target,
      outcome: "claimed",
      detail: null,
      dispatched_at: at,
    });
  } catch (err) {
    // A concurrent redelivery won the claim between our `findOne` and `insert`. The UNIQUE fence on
    // `dedupe_key` rejects our loser — tolerate ONLY that collision as the same idempotent `deduped`
    // outcome, and NEVER perform the action (the winner is the one that acts).
    if (!isUniqueConstraintFence(err)) throw err;
    const won = await ledger.findOne({ dedupe_key: input.dedupeKey });
    return { connectorOutcome: "deduped", connectorDedupeKey: input.dedupeKey, connectorDetail: won?.detail ?? "" };
  }
  // We alone won the claim — perform the side effect exactly once and record its outcome on our row.
  const { detail } = performConnectorAction({
    target: input.target,
    payload: input.payload ?? null,
    boundFacts: input.boundFacts ?? [],
  });
  await ledger.update(claimId, { outcome: "delivered", detail });
  return { connectorOutcome: "delivered", connectorDedupeKey: input.dedupeKey, connectorDetail: detail };
}
