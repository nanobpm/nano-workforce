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

import { isPlausibleBranchName } from "../app/baseBranch.ts";
import { dispatchDeliveryGraphRun } from "../app/deliveryGraphDispatch.ts";
import { getStagedProposal, markProposalDispatched, markProposalExpired } from "../app/deliveryGraphProposals.ts";
import { isValidIsoDuration } from "../app/reviewWait.ts";
import type { DeliveryGraphTextResult } from "../nano-generated/api-io.d.ts";
import { defineOperation } from "../nano-generated/operations.ts";

/** Cap an untrusted, rejected duration string before it is echoed into logs/response bodies. `openapi.yaml`
 * caps these dispatch duration fields at `maxLength: 64` at the edge, and the door re-enforces that bound
 * (see `MAX_DURATION_LEN`); this truncation is defense-in-depth for when the edge validator is bypassed,
 * so a very large malformed value can never bloat either the logs or the response. */
const MAX_ECHO_LEN = 80;
function truncateForEcho(value: string): string {
  return value.length > MAX_ECHO_LEN ? `${value.slice(0, MAX_ECHO_LEN)}… (${value.length} chars)` : value;
}

/** Door-level cap on a duration override, mirroring the `maxLength: 64` on these fields in `openapi.yaml`.
 * Re-enforced here so a syntactically-valid-but-oversized duration is still rejected when the edge
 * validator is bypassed (internal calls/tests), keeping seeded process variables and error/log output bounded. */
const MAX_DURATION_LEN = 64;

/** Validate an OPTIONAL run-level ISO-8601 duration override off the dispatch body (#505). Blank/
 * whitespace is treated as absent (→ the runner default). A present-but-malformed value returns
 * `{ ok: false, invalid }` so the door can reject it at submit rather than silently deploy an
 * uninterpretable timer. Reuses the canonical `reviewWait` grammar so accept/reject never drifts from
 * the runner's normalise-or-default one, and enforces `MAX_DURATION_LEN` so an oversized value is
 * rejected even if the OpenAPI `maxLength` edge check is bypassed. */
function validateDurationOverride(raw: unknown): { ok: true; value: string | undefined } | { ok: false; invalid: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "string") return { ok: false, invalid: String(raw) };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: undefined };
  if (trimmed.length > MAX_DURATION_LEN || !isValidIsoDuration(trimmed)) return { ok: false, invalid: trimmed };
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

  // Host-git provisioning override (#684/#686) — the OPTIONAL `owner/repo` + base branch the run's
  // `agent` nodes implement against. When both are present the runner seeds the canonical
  // `io.nanobpm.agentTask.repository` isolation envelope (`repoEnvelopeVars`) onto every agent cell's
  // job so it provisions a throwaway clone instead of mutating the worker's launch dir. `repository` is
  // shape-validated here (mirrors `repoEnvelopeVars`' own `owner/repo` allowlist) so a malformed value
  // is a clean 400 rather than a silently-dropped envelope; both absent → no envelope (legacy behaviour).
  const repoRaw = body && typeof body === "object" && "repository" in body && typeof body.repository === "string" ? body.repository.trim() : "";
  let repository: string | undefined;
  if (repoRaw !== "") {
    if (repoRaw.length > 255 || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repoRaw) || /\.git$/i.test(repoRaw)) {
      const shown = truncateForEcho(repoRaw);
      app.log.warn("dispatch-delivery-graph rejected: invalid repository", { value: shown });
      return { status: 400, body: { ok: false, error: `\`repository\` must be an \`owner/repo\` reference; got \`${shown}\`` } };
    }
    repository = repoRaw;
  }
  const baseRaw = body && typeof body === "object" && "baseBranch" in body && typeof body.baseBranch === "string" ? body.baseBranch.trim() : "";
  let baseBranch: string | undefined;
  if (baseRaw !== "") {
    // `baseBranch` becomes the isolation envelope's `ref` — a real Git ref the harness checks out and
    // branches off. Gate it with the canonical conservative branch-name allowlist (`app/plan.ts`,
    // shared with the epic/feature launch paths) so whitespace, shell metacharacters, newlines, a
    // leading `-`, `..`/`//`, etc. are a clean 400 rather than an invalid-ref/argument-parsing edge
    // case in a downstream git invocation.
    if (baseRaw.length > 255 || !isPlausibleBranchName(baseRaw)) {
      const shown = truncateForEcho(baseRaw);
      app.log.warn("dispatch-delivery-graph rejected: invalid baseBranch", { value: shown });
      return { status: 400, body: { ok: false, error: `\`baseBranch\` must be a plausible git branch name; got \`${shown}\`` } };
    }
    baseBranch = baseRaw;
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

  const dispatched = await dispatchDeliveryGraphRun(app, graph, { runKey: idempotencyKey, title: proposal.title, repository, baseBranch, ...timeouts });
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
