// POST /app/api/agentic/enrol → operationId `enrolAgenticWorker` (enrolment epic #152 / N1 #145, ADR
// 0059 revised). The server side of REGISTER → SERVE, per-worker: a worker declares its enrolment
// `capability` (cognition / weight / family / host) and gets back the SERVE token set it may serve,
// the vocab version it was resolved against, and the liveness lease TTL. Pure/deterministic — the
// same capability always yields the same SERVE, so enrol is idempotent per (app, worker).
//
// The ADR 0059 body is `{ capability, host }`; `host` is folded into `capability.host` when the
// latter is absent (a worker may declare its host either way). Advisory — this resolves and reports,
// it never places work.
//
// The optional shared-secret guard stays HERE (the runtime does not enforce OpenAPI `security`): when
// NANO_PR_WEBHOOK_SECRET is set, callers must present it via the x-hook-secret header. Unset → open.
import type { Capability } from "@nanobpm/agentic/protocol";
import { resolveEnrolment } from "../app/agentic/vocab/enrol.ts";
import { DurableResumeRegistry } from "../app/durableResume.ts";
import {
  HarnessProtocolRegistry,
  isStaleProtocol,
  minHarnessProtocol,
  staleHarnessPolicy,
} from "../app/harnessProtocol.ts";
import { envVar } from "../app/version.ts";
import type { EnrolResult } from "../nano-generated/api-io.d.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("enrolAgenticWorker", async ({ req, body }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("enrolAgenticWorker rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  // The runtime validates a well-formed body against openapi.yaml, but a directly-invoked delegate
  // (or a missing body) leaves `body` undefined — guard so that becomes a 400, not a 500.
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof body.capability !== "object" ||
    body.capability === null ||
    Array.isArray(body.capability)
  ) {
    app.log.warn("enrolAgenticWorker rejected: missing/invalid capability");
    return { status: 400, body: { error: "a `capability` object is required" } };
  }
  // A directly-invoked delegate bypasses the OpenAPI runtime validation, so the optional fields this
  // operation folds into the capability / echoes back / hands to the resolver can arrive with the
  // wrong type. Reject that as a 400 rather than passing a malformed Capability into the resolver
  // (unexpected behavior), emitting a non-string `instance` (500), or matching `requires` predicates
  // against a non-string cognition/family or non-number weight. Validate every scalar Capability
  // field (openapi.yaml `Capability`: cognition/family/host strings, weight a number) when present.
  const optionalStrings: Array<[string, unknown]> = [
    ["host", body.host],
    ["capability.host", body.capability.host],
    ["capability.cognition", body.capability.cognition],
    ["capability.family", body.capability.family],
    ["instance", body.instance],
  ];
  for (const [name, value] of optionalStrings) {
    if (value !== undefined && typeof value !== "string") {
      app.log.warn("enrolAgenticWorker rejected: non-string optional field", { field: name });
      return { status: 400, body: { error: `\`${name}\` must be a string when provided` } };
    }
  }
  if (
    body.capability.weight !== undefined &&
    (typeof body.capability.weight !== "number" || !Number.isFinite(body.capability.weight))
  ) {
    app.log.warn("enrolAgenticWorker rejected: non-finite capability.weight");
    return {
      status: 400,
      body: { error: "`capability.weight` must be a finite number when provided" },
    };
  }
  // The durable-resume enrolment attribute (issue #325, ADR 0062 Slice 5/5) — a boolean the harness
  // advertises. A directly-invoked delegate bypasses the OpenAPI runtime validation, so guard the type
  // here (a non-boolean would corrupt the {0,1} enrolment flag the world-restore gate reads).
  if (body.durableResume !== undefined && typeof body.durableResume !== "boolean") {
    app.log.warn("enrolAgenticWorker rejected: non-boolean durableResume");
    return { status: 400, body: { error: "`durableResume` must be a boolean when provided" } };
  }
  // The harness-protocol enrolment attribute (issue #802) — a non-negative integer the harness
  // advertises declaring which machine-readable artifacts it emits (AgentInstance, transcript flush,
  // result envelope). A directly-invoked delegate bypasses the OpenAPI runtime validation, so guard the
  // type here: a non-integer / negative value would corrupt the persisted staleness gate.
  if (
    body.harnessProtocol !== undefined &&
    (typeof body.harnessProtocol !== "number" ||
      !Number.isInteger(body.harnessProtocol) ||
      body.harnessProtocol < 0)
  ) {
    app.log.warn("enrolAgenticWorker rejected: non-integer harnessProtocol");
    return {
      status: 400,
      body: { error: "`harnessProtocol` must be a non-negative integer when provided" },
    };
  }

  // Fold a top-level `host` into the capability when the capability didn't carry its own — a worker
  // may declare its host either on the capability or beside it (ADR 0059 `{ capability, host }`).
  const capability: Capability =
    body.host !== undefined && body.capability.host === undefined
      ? { ...body.capability, host: body.host }
      : body.capability;

  const resolved = resolveEnrolment(capability);

  // Durable-resume enrolment gate (issue #325, ADR 0062 Slice 5/5): record whether this worker's
  // harness advertises durable-resume so the world-restore marker is emitted only to a fleet with a
  // participant. Recorded per instance (ADR 0056 §7 — an enrolment attribute, never a routing token),
  // so it needs a non-blank `instance`; a declaration without one — or with a blank/whitespace
  // string — is echoed but not persisted (a blank key would let unrelated workers collide on the
  // same registry row and wrongly open/close the fleet-wide durable-resume gate). Omission of the
  // field on a re-enrol persists an explicit `false` (degrade to scratch), so a harness that previously
  // advertised durable-resume and later re-enrols without the field clears its stale `true` rather than
  // leaving `fleetSupportsDurableResume()` true indefinitely. Best-effort — the enrolment resolution
  // must not fail on a registry write hiccup.
  const instanceKey = body.instance?.trim();
  if (app.data && instanceKey) {
    try {
      await new DurableResumeRegistry(app.data).recordEnrolment(instanceKey, body.durableResume ?? false);
    } catch (err) {
      app.log.warn("enrolAgenticWorker: durable-resume record failed", { instance: instanceKey, err: String(err) });
    }
  }

  // Harness-protocol enrolment gate (issue #802): record the advertised protocol per instance so the
  // app can expose it in getAgenticSupply / the registry and gate on it. Recorded even on a downgrade
  // (a re-enrol WITHOUT a version clears a stale-healthy value to absent → stale). Like durable-resume
  // it needs a non-blank `instance` and is best-effort — a registry write hiccup must not fail enrol.
  if (app.data && instanceKey) {
    try {
      await new HarnessProtocolRegistry(app.data).recordEnrolment(instanceKey, body.harnessProtocol);
    } catch (err) {
      app.log.warn("enrolAgenticWorker: harness-protocol record failed", { instance: instanceKey, err: String(err) });
    }
  }

  // Derive staleness from the just-advertised protocol against the configured minimum (absent version =
  // stale, the #802 signature). Under the `refuse` policy a stale harness is handed an EMPTY SERVE set
  // so it wins no job leases — a REGISTER→SERVE gate, never an engine/job-protocol change. Under the
  // default `flag` policy the SERVE set is unchanged (no routing regression); the worker is only
  // flagged so the cockpit can surface it for drain.
  const harnessStale = isStaleProtocol(body.harnessProtocol, minHarnessProtocol());
  const refuseRouting = harnessStale && staleHarnessPolicy() === "refuse";
  if (refuseRouting) {
    app.log.warn("enrolAgenticWorker: refusing routing for a stale harness", {
      instance: body.instance,
      harnessProtocol: body.harnessProtocol,
      minHarnessProtocol: minHarnessProtocol(),
    });
  }

  const result: EnrolResult = {
    serve: refuseRouting ? [] : [...resolved.serve],
    roles: refuseRouting
      ? []
      : resolved.roles.map((role) => {
          const out: EnrolResult["roles"][number] = { token: role.token, seatsDistinctFamily: role.seatsDistinctFamily };
          if (role.weight !== undefined) out.weight = role.weight;
          return out;
        }),
    demandVersion: resolved.demandVersion,
    leaseTtl: resolved.leaseTtl,
    // Always surface the staleness verdict so the caller (and the cockpit) can see a stale harness even
    // when it advertised no version at all.
    harnessStale,
  };
  if (body.instance !== undefined) result.instance = body.instance;
  if (body.durableResume !== undefined) result.durableResume = body.durableResume;
  if (body.harnessProtocol !== undefined) result.harnessProtocol = body.harnessProtocol;

  app.log.info("agentic enrol resolved", {
    instance: body.instance,
    serve: result.serve,
    family: capability.family,
    harnessStale,
  });
  return { status: 200, body: result };
});
