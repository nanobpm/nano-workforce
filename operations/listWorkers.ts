// GET /app/api/workers → operationId `listWorkers` (issue #989, `d8ctl nwf workers list`). Per job type
// nwf issues: the connected workers (id, host, transport, last-seen, live/stale), queue depth, the age
// of the oldest waiting job, and a `starved` flag — so "are workers picking up my nwf work?" is one
// command. nwf's own in-process `pr.*` workers are summarised as one health line (`?internal=true`
// expands them). The join itself is the pure `buildWorkersView` (app/workersView.ts). Read-only.
//
// The optional shared-secret guard mirrors the other read endpoints (NANO_PR_WEBHOOK_SECRET).
import { agentActivations } from "../app/agentActivationLedger.ts";
import { currentPresenceRegistry } from "../app/agentic/families/presence.family.ts";
import { crewResolver } from "../app/agentic/vocab/crew-vocab.ts";
import { envVar } from "../app/version.ts";
import {
  buildWorkersView,
  collectCreatedJobs,
  deployedJobTypes,
  type FirstSeenEntry,
  registeredWorkerTypes,
  type WorkersViewJob,
} from "../app/workersView.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";
const JOB_TYPES = deployedJobTypes();
const INTERNAL_TYPES = registeredWorkerTypes();

export default defineOperation("listWorkers", async ({ req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("listWorkers rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  const includeInternal = (req.query.get("internal") ?? "").trim().toLowerCase() === "true";
  let jobs: WorkersViewJob[] = [];
  if (app.engine) {
    const engine = app.engine;
    try {
      jobs = await collectCreatedJobs(
        async (filter) =>
          (await engine.searchJobs(filter)).map((j) => ({
            type: j.type,
            processInstanceKey: j.processInstanceKey,
            jobKey: j.jobKey,
            ...(j.worker ? { worker: j.worker } : {}),
          })),
        JOB_TYPES,
      );
    } catch (err) {
      // Never report an unreadable queue as an empty one (zero depth, nothing starved).
      app.log.warn("listWorkers: engine job search failed", { err: String(err) });
      return { status: 502, body: { error: "engine job search failed — queue depth is unknown; retry, or check the engine" } };
    }
  }
  const firstSeen = new Map<string, FirstSeenEntry>();
  if (app.data) {
    for (const row of await agentActivations(app.data).all()) {
      firstSeen.set(row.id, { jobKey: row.job_key, firstSeenAt: row.first_seen_at });
    }
  }
  const resolver = crewResolver();
  // No presence registry (agentic channel off) → supply is UNKNOWN (null), not "no workers".
  const registry = currentPresenceRegistry();
  const workers = registry === undefined ? null : registry.snapshot().workers.map((w) => ({
    instance: w.instance,
    identity: w.identity,
    ...(w.host !== undefined ? { host: w.host } : {}),
    live: w.live,
    lastSeen: w.lastSeen,
    staleMs: w.staleMs,
    serves: resolver.resolve({
      ...(w.cognition !== undefined ? { cognition: w.cognition } : {}),
      ...(w.weight !== undefined ? { weight: w.weight } : {}),
      ...(w.family !== undefined ? { family: w.family } : {}),
      ...(w.host !== undefined ? { host: w.host } : {}),
    }).tokens,
  }));
  const body = buildWorkersView({ jobTypes: JOB_TYPES, internalTypes: INTERNAL_TYPES, jobs, workers, firstSeen, now: Date.now(), includeInternal });
  return { status: 200, body };
});
