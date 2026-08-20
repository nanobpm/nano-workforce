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
// that finds the key already `delivered` short-circuits to the recorded outcome (`deduped`) and never
// re-performs the side effect, while one that finds a still-`claimed` (crashed mid-flight) row RESUMES
// it. The UNIQUE fence on `dedupe_key` makes the claim atomic even under a concurrent race — the loser
// is classified by the ONE canonical `isUniqueConstraintFence` (app/dbFence.ts) as a fence collision,
// not a spurious failure, then dedupes-or-resumes the winning row exactly as a sequential redelivery
// would (the durable-fence idiom, no drift).
import type { DataLayer } from "@nanobpm/urban";
import { isUniqueConstraintFence } from "./dbFence.ts";

/** The engine `taskType` a compiled `connector` node's inlined subProcess delegates to. The canonical
 * source the compiler's delegation map (`DELEGATE_TASK_TYPE.connector` imports and uses this constant),
 * so the compiled BPMN's task type is DERIVED here, not re-typed. The worker registration
 * (`nano.app.json`) and the compiler tests pin the same literal by value — a manifest is JSON and a
 * value assertion cannot import a TS const — so they read as verification of this constant, not a
 * parallel source of truth. */
export const DELIVERY_CONNECTOR_TASK_TYPE = "pr.delivery-connector";

/** The connector ledger's two-step claim lifecycle. `claimed` — the row was fenced but the action has
 * not yet been recorded as done (an in-flight or crashed attempt, which `dispatchConnector` RESUMES);
 * `delivered` — the action completed and the row is terminally deduped. Named constants so the claim,
 * the resume check, and the delivered short-circuit can never drift on a bare string. */
export const OUTCOME_CLAIMED = "claimed";
export const OUTCOME_DELIVERED = "delivered";

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
  processInstanceKey?: string | number | null;
  elementId?: string | null;
}): string | null {
  const authored = typeof input.dedupeKey === "string" ? input.dedupeKey.trim() : "";
  if (authored) return authored;
  // The engine can hand back a NUMERIC processInstanceKey — coerce (codebase-wide `String(...)` pattern)
  // so a connector node without an authored dedupeKey stays dedupable instead of failing closed.
  const pik = input.processInstanceKey == null ? "" : String(input.processInstanceKey).trim();
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

/** Decide the outcome for a ledger row that ALREADY claims `dedupeKey`: DEDUPE it when it is terminally
 * `delivered` (report the recorded detail, never re-act), or RESUME it when it is still `claimed` (its
 * action never recorded delivery — perform the idempotent action now and record delivery on THIS row).
 * The ONE place that decides resume-vs-dedupe for a rediscovered row, so the sequential-redelivery path
 * and the concurrent-race fence-loser path can never drift on whether a still-`claimed` winner is
 * resumed (AGENTS.md: "no drift surfaces"). */
async function resumeOrDedupe(
  ledger: ReturnType<typeof deliveryConnectorDispatches>,
  row: DeliveryConnectorDispatchRow,
  input: { dedupeKey: string; target: string; payload?: Record<string, unknown> | null; boundFacts?: readonly BoundFact[] | null },
): Promise<ConnectorDispatchResult> {
  if (row.outcome === OUTCOME_DELIVERED) {
    return { connectorOutcome: "deduped", connectorDedupeKey: input.dedupeKey, connectorDetail: row.detail ?? "" };
  }
  // Still `claimed` — a prior attempt (sequential or the concurrent-race winner) claimed the key but
  // never recorded delivery. Resume on the existing row rather than dedupe forever on an un-acted claim.
  const { detail } = performConnectorAction({
    target: input.target,
    payload: input.payload ?? null,
    boundFacts: input.boundFacts ?? [],
  });
  if (row.id !== undefined) await ledger.update(row.id, { outcome: OUTCOME_DELIVERED, detail });
  return { connectorOutcome: "delivered", connectorDedupeKey: input.dedupeKey, connectorDetail: detail };
}

/** Dispatch a connector action AT-MOST-ONCE against its dedupe key. CLAIMS the ledger row FIRST (the
 * UNIQUE fence is the atomic gate that elects exactly one winner), and ONLY the claim winner performs
 * the forward-declared action — so an at-least-once redelivery, or a concurrent racer, can never
 * double-fire a SETTLED side effect. A redelivery whose key is already recorded `delivered` returns
 * `deduped` WITHOUT acting, reporting the ORIGINAL detail.
 *
 * Resumability (the crash window). A claim is a two-step `claimed`→act→`delivered`. If a worker dies
 * AFTER claiming but BEFORE recording delivery, the action never completed — so ANY dispatch that
 * rediscovers a still-`claimed` (not yet `delivered`) row must RESUME it: perform the action and record
 * delivery, rather than treating the un-acted claim as `deduped` and wedging the node on a side effect
 * that never fires. Only a `delivered` row is terminally deduped. This rule is uniform across BOTH ways
 * a row is rediscovered — the sequential `findOne` redelivery AND the concurrent-race fence LOSER below
 * — routed through the ONE `resumeOrDedupe` decision so they can never drift. The fence loser MUST NOT
 * dedupe a still-`claimed` winner: it would complete the job on the loser's ack, and the engine — having
 * taken that ack — would never redeliver, so a winner that then crashed would strand the side effect
 * forever (no later redelivery can recover it). Resuming instead may re-perform an action the winner is
 * still delivering, but the STUB action is idempotent so a concurrent double-resume is free — exactly as
 * the sequential resume already is; a real transport later slots a resumable `applied` reconcile in — as
 * the world-store ledger does — to make the resume itself at-most-once, without changing this contract.
 *
 * Target drift (fail closed). The ledger keys only by `dedupeKey`; a key reused with a DIFFERENT
 * `target` than its recorded row is a contract violation (a legitimate redelivery always repeats the
 * same target), so this throws rather than deliver/resume/report against the wrong destination. */
export async function dispatchConnector(
  data: DataLayer,
  input: { dedupeKey: string; target: string; payload?: Record<string, unknown> | null; boundFacts?: readonly BoundFact[] | null },
  at: string,
): Promise<ConnectorDispatchResult> {
  const ledger = deliveryConnectorDispatches(data);
  const existing = await ledger.findOne({ dedupe_key: input.dedupeKey });
  if (existing && existing.target !== input.target) {
    // FAIL CLOSED on target drift. The ledger keys only by `dedupeKey`; if the same key is ever reused
    // (accidentally or maliciously) with a DIFFERENT target, both the `delivered` short-circuit and the
    // `claimed` resume below would act on / report the recorded row — delivering to, or attributing the
    // outcome of, the WRONG destination and leaving the persisted `target` describing neither action.
    // Refuse rather than corrupt the at-most-once ledger; a legitimate redelivery always carries the
    // same target for a given key.
    throw new Error(
      `connector dedupe key "${input.dedupeKey}" reused with a different target ` +
        `(ledger="${existing.target}", input="${input.target}") — refusing to dispatch`,
    );
  }
  if (existing) {
    // A prior attempt recorded (`delivered`) or claimed-but-crashed (`claimed`) this key. Dedupe or
    // resume it on the existing row — the ONE decision shared with the fence-loser path below.
    return resumeOrDedupe(ledger, existing, input);
  }
  let claimId: number | bigint;
  try {
    claimId = await ledger.insert({
      dedupe_key: input.dedupeKey,
      target: input.target,
      outcome: OUTCOME_CLAIMED,
      detail: null,
      dispatched_at: at,
    });
  } catch (err) {
    // A concurrent redelivery won the claim between our `findOne` and `insert`. The UNIQUE fence on
    // `dedupe_key` rejects our loser — tolerate ONLY that collision as the same idempotent `deduped`
    // outcome, and NEVER perform the action (the winner is the one that acts).
    if (!isUniqueConstraintFence(err)) throw err;
    const won = await ledger.findOne({ dedupe_key: input.dedupeKey });
    if (won && won.target !== input.target) {
      // Same target-drift anomaly as above, surfaced via a concurrent racer that won the claim with a
      // different target — fail closed rather than report the wrong destination's outcome as ours.
      throw new Error(
        `connector dedupe key "${input.dedupeKey}" reused with a different target ` +
          `(ledger="${won.target}", input="${input.target}") — refusing to dispatch`,
      );
    }
    // Dedupe (winner `delivered`) OR resume (winner still `claimed`) the winning row — the SAME decision
    // as the sequential path. Deduping a still-`claimed` winner here would complete the job on our ack,
    // so a winner that then crashed would strand the side effect forever (the engine won't redeliver an
    // acked job); resuming closes that gap and is safe because the action is idempotent.
    if (won) return resumeOrDedupe(ledger, won, input);
    return { connectorOutcome: "deduped", connectorDedupeKey: input.dedupeKey, connectorDetail: "" };
  }
  // We alone won the claim — perform the side effect exactly once and record its outcome on our row.
  const { detail } = performConnectorAction({
    target: input.target,
    payload: input.payload ?? null,
    boundFacts: input.boundFacts ?? [],
  });
  await ledger.update(claimId, { outcome: OUTCOME_DELIVERED, detail });
  return { connectorOutcome: "delivered", connectorDedupeKey: input.dedupeKey, connectorDetail: detail };
}
