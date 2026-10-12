// pr.delivery-connector — the delivery-graph `connector` node's engine-native execution body (ADR 0005
// slice S4). The service-task half of a compiled `connector` subProcess: it drives the forward-declared
// connector I/O surface AT-MOST-ONCE per dedupe key, so the engine's at-least-once job delivery (a
// worker/hub restart, a lost ack, a graph resume) can never double-fire the side effect (Decision 7).
//
// All the idempotency logic lives in `app/deliveryConnector.ts` (the durable-fence ledger + claim→act
// envelope) so it is unit-testable without the engine and shares ONE implementation with any other
// caller; this worker is the thin engine adapter that resolves the effective dedupe key from the job's
// author-supplied `dedupeKey` or its stable engine identity (`processInstanceKey:elementId`).
import type { AppJobHandler, DataLayer } from "@nanobpm/urban";
import {
  type BoundFact,
  type ConnectorDispatchResult,
  connectorDedupeKey,
  convergeOnlyForTarget,
  dispatchConnector,
  isConvergeTarget,
  resolveConvergePr,
} from "../../app/deliveryConnector.ts";
import { deliveryGraphRuns } from "../../app/deliveryGraphRun.ts";
import { isPrSettled, MAX_ROUNDS, type ParsedPr, parsePr, submitPr } from "../../app/service.ts";

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

/** Resolve the escalation-steward opt-in for THIS delivery run from the DURABLE
 *  `delivery_graph_runs.auto_resolve_escalations` flag (keyed by the run's `process_key`), NOT the
 *  inherited `autoResolveEscalations` process variable (issue #889 review). The process variable is
 *  clobberable: an upstream agent node that completes with `autoResolveEscalations: false` in its
 *  output overwrites the run-root variable downstream, so reading it here would enroll the PR with the
 *  WRONG opt-in — contradicting the durable-source guarantee the steward's eligibility relies on. The
 *  run row is the record of truth. FAIL CLOSED: no matching run row (or a non-1 flag) ⇒ not opted in.
 *
 *  LAUNCH RACE (issue #889 review): `dispatchDeliveryGraphRun` claims the run row with
 *  `process_key = NULL`, starts the engine instance, and only THEN stamps the returned key
 *  (`app/deliveryGraphDispatch.ts`). This connector job can activate BEFORE that post-launch write, so
 *  a single read keyed on `process_key` finds NO match and would convert the launch-in-flight row to a
 *  permanent opted-OUT enrollment. A NULL `process_key` is TRANSIENT (launch in flight), not proof of
 *  "no run" — so re-poll across the launch window until the stamp lands (or the budget runs out, after
 *  which we fail closed as before). */
const LAUNCH_STAMP_POLLS = 20;
const LAUNCH_STAMP_POLL_MS = 250;
/** The scheduler the poll loop sleeps on between launch-stamp reads. Overridable in tests via
 * {@link setLaunchStampSleep} so a regression drives the retry by a deterministic READ COUNT (the fake
 * table stamps `process_key` after N polls) rather than racing real wall-clock timers — AGENTS.md
 * forbids a test whose outcome depends on scheduler load. */
let launchStampSleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
/** Test-only seam: override the inter-poll sleep. Pass no argument to restore the real timer. */
export function setLaunchStampSleep(sleep?: (ms: number) => Promise<void>): void {
  launchStampSleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
}
async function resolveAutoResolveEscalations(data: DataLayer, processInstanceKey: string | null): Promise<boolean> {
  if (!processInstanceKey) return false;
  const runs = deliveryGraphRuns(data);
  for (let attempt = 0; attempt < LAUNCH_STAMP_POLLS; attempt++) {
    const rows = await runs.all();
    const run = rows.find((r) => r.process_key != null && String(r.process_key) === String(processInstanceKey));
    if (run != null) return run.auto_resolve_escalations === 1;
    // No row carries this process_key yet. If a launch-in-flight row (NULL process_key) is still
    // waiting for its stamp, re-poll; otherwise there is genuinely no run for this instance — fail
    // closed without burning the remaining budget.
    const launchInFlight = rows.some((r) => r.process_key == null && r.status === "running");
    if (!launchInFlight) return false;
    if (attempt < LAUNCH_STAMP_POLLS - 1) await launchStampSleep(LAUNCH_STAMP_POLL_MS);
  }
  return false;
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

/** JSON-stringify a user-controlled value for an error message, falling back to `String(value)` when
 * the value is not JSON-serializable (e.g. a `BigInt` or a circular object throws, or a `Symbol` /
 * `undefined` / function that `JSON.stringify` serializes to `undefined`) so the intended validation
 * error is never masked by a serializer `TypeError` and the function always honours its `string`
 * return type. */
export function safeStringify(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? String(value) : s;
  } catch {
    return String(value);
  }
}

/** Parse + validate the converge connector's payload (`{ pr, autoMerge?, dependsOn? }`) for a
 * `converge` / `converge-merge` / `merge-main` target. `pr` is REQUIRED and must parse to a canonical `owner/repo#N`
 * (fail CLOSED — a converge connector with no target PR is meaningless and could never enroll).
 * `autoMerge` DEFAULTS from the target (`converge` → `false`; `converge-merge`/`merge-main` → `true`) and
 * may be overridden per-dispatch by an explicit boolean. The deprecated `convergeOnly` alias is still
 * accepted for compatibility. `dependsOn` is an optional list of PR refs unioned into the enrolled PR's
 * merge-stage dependency set (only non-string entries are dropped; `submitPr` itself ignores unparseable
 * refs). Exported for unit coverage.
 *
 * `pr` may be sourced three ways (issue #548), resolved by {@link resolveConvergePr} against the
 * threaded `boundFacts` BEFORE parsing: a LITERAL `owner/repo#N`, an explicit fact REFERENCE
 * (`payload.pr: "<upstreamNode>.pr"`), or OMITTED — late-bound from the single incoming `pr` fact an
 * upstream `agent` node emitted for the PR it opened. This is what lets the canonical
 * `agent → connector[converge-merge] → wait` shape carry no hardcoded PR number. */
export function readConvergeInput(
  target: string,
  payload: Record<string, unknown> | null,
  boundFacts: readonly BoundFact[] | null,
): { parsed: ParsedPr; convergeOnly: boolean; dependsOn: string[] } {
  const p = payload ?? {};
  const prValue = resolveConvergePr(p.pr, boundFacts ?? []);
  const parsed = parsePr(prValue);
  if (!parsed) {
    throw new Error(
      `delivery-connector: '${target}' target requires a target PR — a literal "owner/repo#N" in ` +
        `payload.pr, an upstream-fact reference (payload.pr: "<node>.pr"), or a threaded \`pr\` fact ` +
        `bound from an upstream \`agent\` node (got ${safeStringify(prValue ?? null)})`,
    );
  }
  const autoMerge =
    typeof p.autoMerge === "boolean"
      ? p.autoMerge
      : typeof p.convergeOnly === "boolean"
        ? !p.convergeOnly
        : !convergeOnlyForTarget(target);
  const convergeOnly = !autoMerge;
  const dependsOn = Array.isArray(p.dependsOn) ? p.dependsOn.filter((d): d is string => typeof d === "string") : [];
  return { parsed, convergeOnly, dependsOn };
}

const handler: AppJobHandler<In, ConnectorDispatchResult> = async (job, app) => {
  const { target, payload, boundFacts, warnings } = readConnectorInput(job.variables);
  // A `converge`/`converge-merge` target enrolls a PR into the shared convergence (+ merge) loop.
  // Parse + validate its payload BEFORE claiming a ledger row, so a misconfigured converge node (no
  // parseable `pr`) fails CLOSED without writing a junk dispatch row it could never act on.
  const converge = isConvergeTarget(target) ? readConvergeInput(target, payload, boundFacts) : null;
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
    // For a `converge`/`converge-merge` target, the connector's REAL side effect is enrolling the PR
    // into the shared convergence (+ merge) loop via `submitPr` — the SAME enrollment
    // `workers/converge-feature` uses, no duplicated machinery. It is injected as the dispatch's
    // action so it lives INSIDE the at-most-once + resume envelope (`dispatchConnector`): it fires only
    // on the claim winner (or a resumed crashed claim), and a `deduped` redelivery — a worker restart /
    // lost ack / graph resume that lands AFTER the PR has settled — NEVER re-runs it. This is what
    // preserves the connector's at-most-once semantics against `submitPr`, which deliberately RE-OPENS a
    // terminal PR (it only short-circuits a non-terminal row); an unconditional call outside the fence
    // would flip a `merged`/`converged`/`abandoned` PR back to `converging` on redelivery.
    //
    // The action is ALSO terminal-safe (idempotent on RESUME). A still-`claimed` crashed claim is
    // re-performed by `dispatchConnector` (it never recorded delivery), and its first attempt may have
    // already enrolled the PR AND let the convergence/merge loop settle it. Because `submitPr` re-opens a
    // terminal row, re-performing blindly would regress that settled PR — so the action first checks
    // `isPrSettled` and NO-OPS when the PR row is already terminal. On a LIVE (non-terminal) row
    // `submitPr`'s own `prKey` short-circuit (`alreadyRunning`) already makes the resume double-safe.
    // `rootRequestKey` is the stable per-node `dedupeKey` (authored, else `<processInstanceKey>:<elementId>`),
    // so the enrolled PR's lineage is deterministic across redeliveries.
    converge
      ? async () => {
          if (await isPrSettled(app.data, converge.parsed.prKey)) {
            // Resume against an already-settled PR: the enrollment already ran its course. Record the
            // dispatch delivered WITHOUT re-opening the terminal PR (never regress a settled PR).
            app.log.info("delivery-connector: enrollment skipped — PR already terminal (resume-safe)", {
              target,
              dedupeKey,
              prKey: converge.parsed.prKey,
            });
            return { detail: `${converge.parsed.prKey} already terminal — enrollment skipped (at-most-once resume-safe)` };
          }
          // Propagate the delivery run's escalation-steward opt-in (issue #889) to the enrolled PR.
          // Resolve it from the DURABLE `delivery_graph_runs` row (keyed by this job's process
          // instance), NOT the inherited `autoResolveEscalations` process variable — an upstream agent
          // completion can clobber that variable, so the durable row is the only trustworthy source
          // (issue #889 review). Fails closed (false) when no run row matches.
          const autoResolve = await resolveAutoResolveEscalations(app.data, job.processInstanceKey != null ? String(job.processInstanceKey) : null);
          await submitPr(app.data, app.engine, converge.parsed, converge.dependsOn, MAX_ROUNDS, converge.convergeOnly, dedupeKey, false, autoResolve);
          app.log.info("delivery-connector: enrolled PR into convergence loop", {
            target,
            dedupeKey,
            prKey: converge.parsed.prKey,
            convergeOnly: converge.convergeOnly,
            autoResolveEscalations: autoResolve,
          });
          return { detail: `enrolled ${converge.parsed.prKey} into convergence loop (convergeOnly=${converge.convergeOnly})` };
        }
      : undefined,
  );
  app.log.info("delivery-connector", { target, dedupeKey, outcome: result.connectorOutcome });
  return result;
};

export default handler;
