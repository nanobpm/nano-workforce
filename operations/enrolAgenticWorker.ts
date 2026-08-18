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
import { envVar } from "../app/version.ts";
import type { EnrolResult } from "../nano-generated/api-io.d.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export default defineOperation("enrolAgenticWorker", ({ req, body }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("enrolAgenticWorker rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  // The runtime validates a well-formed body against openapi.yaml, but a directly-invoked delegate
  // (or a missing body) leaves `body` undefined — guard so that becomes a 400, not a 500.
  if (!body || typeof body !== "object" || typeof body.capability !== "object" || body.capability === null) {
    app.log.warn("enrolAgenticWorker rejected: missing/invalid capability");
    return { status: 400, body: { error: "a `capability` object is required" } };
  }

  // Fold a top-level `host` into the capability when the capability didn't carry its own — a worker
  // may declare its host either on the capability or beside it (ADR 0059 `{ capability, host }`).
  const capability: Capability =
    body.host !== undefined && body.capability.host === undefined
      ? { ...body.capability, host: body.host }
      : body.capability;

  const resolved = resolveEnrolment(capability);
  const result: EnrolResult = {
    serve: [...resolved.serve],
    roles: resolved.roles.map((role) => {
      const out: EnrolResult["roles"][number] = { token: role.token, seatsDistinctFamily: role.seatsDistinctFamily };
      if (role.weight !== undefined) out.weight = role.weight;
      return out;
    }),
    demandVersion: resolved.demandVersion,
    leaseTtl: resolved.leaseTtl,
  };
  if (body.instance !== undefined) result.instance = body.instance;

  app.log.info("agentic enrol resolved", { instance: body.instance, serve: result.serve, family: capability.family });
  return { status: 200, body: result };
});
