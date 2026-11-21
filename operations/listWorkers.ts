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
import { buildWorkersView, deployedJobTypes, type WorkersViewJob } from "../app/workersView.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";
const JOB_TYPES = deployedJobTypes();

export default defineOperation("listWorkers", async ({ req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("listWorkers rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  const includeInternal = (req.query.get("internal") ?? "").trim().toLowerCase() === "true";
  let jobs: WorkersViewJob[] = [];
  if (app.engine) {
    try {
      jobs = (await app.engine.searchJobs({ state: "CREATED" })).map((j) => ({
        type: j.type,
        processInstanceKey: j.processInstanceKey,
        ...(j.worker ? { worker: j.worker } : {}),
      }));
    } catch (err) {
      app.log.warn("listWorkers: engine job search failed — reporting workers without queue depth", { err: String(err) });
    }
  }
  const firstSeen = new Map<string, string>();
  if (app.data) {
    for (const row of await agentActivations(app.data).all()) firstSeen.set(row.id, row.first_seen_at);
  }
  const resolver = crewResolver();
  const workers = (currentPresenceRegistry()?.snapshot().workers ?? []).map((w) => ({
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
  const body = buildWorkersView({ jobTypes: JOB_TYPES, jobs, workers, firstSeen, now: Date.now(), includeInternal });
  return { status: 200, body };
});
