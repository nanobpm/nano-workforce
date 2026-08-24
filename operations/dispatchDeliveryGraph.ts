// POST /app/api/actions/delivery-graph/dispatch → operationId `dispatchDeliveryGraph` (ADR 0005
// Decision 7, issue #460). The OPERATOR-ONLY dispatch door: the cockpit's staged-proposals grid posts
// the `digest` of the proposal the operator picked; this door loads that `staged` proposal, runs the
// retained S4 runner for its previewed graph (`dispatchDeliveryGraphRun`), and marks the proposal
// `dispatched`.
//
// The operator clicking Dispatch IS the approval — there is no replayable token. This door is NOT part
// of the agent surface: the agent compile door returns only a navigational preview (no digest-as-
// dispatch-handle), so an agent cannot reach a run through the documented surface. Idempotent: a
// re-dispatch of an already-running run short-circuits with `alreadyRunning`. An unknown / expired /
// superseded / already-dispatched digest is a clean 400.

import { dispatchDeliveryGraphRun } from "../app/deliveryGraphDispatch.ts";
import { getStagedProposal, markProposalDispatched, markProposalExpired } from "../app/deliveryGraphProposals.ts";
import { isValidIsoDuration } from "../app/reviewWait.ts";
import type { DeliveryGraphTextResult } from "../nano-generated/api-io.d.ts";
import { defineOperation } from "../nano-generated/operations.ts";

/** Cap an untrusted, rejected duration string before it is echoed into logs/response bodies. The
 * dispatch fields carry no max length, so a very large malformed value would otherwise bloat both. */
const MAX_ECHO_LEN = 80;
function truncateForEcho(value: string): string {
  return value.length > MAX_ECHO_LEN ? `${value.slice(0, MAX_ECHO_LEN)}… (${value.length} chars)` : value;
}

/** Validate an OPTIONAL run-level ISO-8601 duration override off the dispatch body (#505). Blank/
 * whitespace is treated as absent (→ the runner default). A present-but-malformed value returns
 * `{ ok: false, invalid }` so the door can reject it at submit rather than silently deploy an
 * uninterpretable timer. Reuses the canonical `reviewWait` grammar so accept/reject never drifts from
 * the runner's normalise-or-default one. */
function validateDurationOverride(raw: unknown): { ok: true; value: string | undefined } | { ok: false; invalid: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "string") return { ok: false, invalid: String(raw) };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: undefined };
  if (!isValidIsoDuration(trimmed)) return { ok: false, invalid: trimmed };
  return { ok: true, value: trimmed.toUpperCase() };
}

export default defineOperation("dispatchDeliveryGraph", async ({ body }, app) => {
  const digest = body && typeof body === "object" && "digest" in body && typeof body.digest === "string" ? body.digest.trim() : "";
  if (digest === "") {
    app.log.warn("dispatch-delivery-graph rejected: missing digest");
    return { status: 400, body: { ok: false, error: "request body must carry a `digest` naming the staged proposal to dispatch" } };
  }
  const idemRaw = body && typeof body === "object" && "idempotencyKey" in body && typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  const idempotencyKey = idemRaw !== "" ? idemRaw : undefined;

  // Run-level timeout overrides (#505) — exposed at submission, validated as ISO-8601 durations here so
  // an invalid value is a clean 400 (never a deployed, uninterpretable timer). Absent → runner defaults.
  const rawTimeouts: Record<"nodeTimeout" | "probeTimeout" | "escalationSlaTimeout", unknown> =
    body && typeof body === "object"
      ? {
          nodeTimeout: "nodeTimeout" in body ? body.nodeTimeout : undefined,
          probeTimeout: "probeTimeout" in body ? body.probeTimeout : undefined,
          escalationSlaTimeout: "escalationSlaTimeout" in body ? body.escalationSlaTimeout : undefined,
        }
      : { nodeTimeout: undefined, probeTimeout: undefined, escalationSlaTimeout: undefined };
  const timeouts: { nodeTimeout?: string; probeTimeout?: string; escalationSlaTimeout?: string } = {};
  for (const field of ["nodeTimeout", "probeTimeout", "escalationSlaTimeout"] as const) {
    const parsed = validateDurationOverride(rawTimeouts[field]);
    if (!parsed.ok) {
      const shown = truncateForEcho(parsed.invalid);
      app.log.warn("dispatch-delivery-graph rejected: invalid duration", { field, value: shown, invalidLength: parsed.invalid.length });
      return { status: 400, body: { ok: false, error: `\`${field}\` must be an ISO-8601 duration (e.g. \`PT2H\`); got \`${shown}\`` } };
    }
    if (parsed.value !== undefined) timeouts[field] = parsed.value;
  }

  // Load the live staged proposal for this digest — refuses an unknown/expired/superseded/already-
  // dispatched digest cleanly (no run is launched).
  const proposal = await getStagedProposal(app.data, digest);
  if (!proposal) {
    app.log.warn("dispatch-delivery-graph rejected: no live staged proposal", { digest });
    return {
      status: 400,
      body: { ok: false, error: `no staged proposal for digest ${digest} — it may have been dispatched, superseded, or aged out; recompile to re-stage it` },
    };
  }

  // The stored graph was validated at stage time; dispatch re-compiles it to derive the run-row shape.
  let graph: unknown;
  try {
    graph = JSON.parse(proposal.graph);
  } catch (err) {
    app.log.error("dispatch-delivery-graph: stored graph is corrupt", { digest });
    // Fail closed: a corrupt graph can never launch, so retire the proposal (→ `expired`) instead of
    // leaving an undismissable `staged` row that fails every dispatch attempt the same way.
    await markProposalExpired(app.data, digest);
    return { status: 400, body: { ok: false, error: `staged proposal ${digest} is corrupt: ${err instanceof Error ? err.message : String(err)}` } };
  }

  const dispatched = await dispatchDeliveryGraphRun(app, graph, { runKey: idempotencyKey, title: proposal.title, ...timeouts });
  if (!dispatched.ok) {
    app.log.warn("dispatch-delivery-graph refused: compile", { digest, errors: dispatched.errors.length });
    const outBody: DeliveryGraphTextResult = {
      ok: false,
      error: `graph failed validation: ${dispatched.errors.length} error(s)`,
      errors: dispatched.errors,
    };
    return { status: 400, body: outBody };
  }

  // Retire the proposal from the staged list — the run now shows in the in-flight grid. Guard against
  // an `idempotencyKey` that short-circuits onto an ALREADY-running run of a DIFFERENT graph: in that
  // case `dispatchDeliveryGraphRun` returns that other run's `digest`, so THIS proposal's graph was
  // never launched. Consuming it then would mark a proposal `dispatched` that never ran. Only retire the
  // proposal when the live run is genuinely this proposal's graph (`dispatched.digest === digest`).
  if (dispatched.digest !== digest) {
    app.log.warn("dispatch-delivery-graph refused: idempotencyKey bound to a different running graph", {
      digest,
      runDigest: dispatched.digest,
      runKey: dispatched.runKey,
    });
    return {
      status: 409,
      body: {
        ok: false,
        error: `idempotencyKey is already bound to a different running delivery graph (digest ${dispatched.digest}); the staged proposal ${digest} was NOT dispatched — retry with a fresh idempotencyKey (or none)`,
      },
    };
  }
  await markProposalDispatched(app.data, digest);

  const outBody: DeliveryGraphTextResult = {
    ok: true,
    status: dispatched.status,
    runKey: dispatched.runKey,
    digest: dispatched.digest,
    sideEffecting: dispatched.sideEffecting,
    alreadyRunning: dispatched.alreadyRunning,
  };
  if (dispatched.processInstanceKey !== undefined) outBody.processInstanceKey = dispatched.processInstanceKey;
  if (dispatched.processDefinitionId !== undefined) outBody.processDefinitionId = dispatched.processDefinitionId;
  return { status: 202, body: outBody };
});
