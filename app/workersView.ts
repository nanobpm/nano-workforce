// The nwf workers view (issue #989, `GET /workers` → `d8ctl nwf workers list`). Answers "are workers
// picking up my nwf work?" per job type nwf issues, without hand-filtering the console's consumer list
// (which publishes no OpenAPI spec, so no CLI can reach it).
//
// Pure join over sources nwf already owns — no second source of truth:
//   - the job types: the deployed models' `<zeebe:taskDefinition type>`s (`resources/processes/*.bpmn`,
//     the same corpus the engine runs), plus any type observed on a waiting job (a delivery-graph
//     `agent` node can name a job type no static model declares);
//   - the waiting/leased jobs: the engine's CREATED jobs (`searchJobs`) — a job with a leasing `worker`
//     is picked up, one without is queued (Camunda projects Activated → CREATED);
//   - the connected workers: the H1 presence registry, matched to a `<rank>:<task>` job type via the
//     crew vocab SERVE tokens and the canonical `jobTypeToRoutingToken` derivation (the same bridge the
//     demand×supply report uses), plus any worker currently leasing a job of that type;
//   - the age of the oldest waiting job: the agent-activation ledger's `first_seen_at` (tracked for
//     the bounded agent job types), else unknown.
//
// External job types are colon-form (`senior:feature`); internal `pr.*` jobs are served by this app's
// own in-process workers, summarised as one health line.
import { readdirSync, readFileSync } from "node:fs";
import type { ConnectedWorker, InternalWorker, WorkersJobType, WorkersView } from "../nano-generated/api-io.d.ts";
import { jobTypeToRoutingToken } from "./agentic/vocab/job-types.ts";

/** Every `<zeebe:taskDefinition type>` declared by one BPMN document, in first-occurrence order. */
export function taskDefinitionTypes(xml: string): string[] {
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<(?:\w+:)?taskDefinition\b[^>]*\btype="([^"=]+)"/g)) seen.add(m[1]);
  return [...seen];
}

/** The job types the deployed models (`resources/processes/*.bpmn`) declare. */
export function deployedJobTypes(dir: URL = new URL("../resources/processes/", import.meta.url)): string[] {
  const types = new Set<string>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".bpmn")).sort()) {
    for (const t of taskDefinitionTypes(readFileSync(new URL(f, dir), "utf8"))) types.add(t);
  }
  return [...types].sort();
}

/** An external job type is a fleet agent task in `<rank>:<task>` form; anything else is internal. */
export function isExternalJobType(type: string): boolean {
  return jobTypeToRoutingToken(type) !== undefined;
}

export interface WorkersViewJob {
  type: string;
  processInstanceKey: string;
  worker?: string;
}

export interface WorkersViewWorker {
  instance: string;
  identity: string;
  host?: string;
  live: boolean;
  lastSeen: number;
  staleMs: number;
  /** The crew SERVE tokens the worker's declared capability resolves to. */
  serves: readonly string[];
}

export interface WorkersViewInput {
  jobTypes: readonly string[];
  jobs: readonly WorkersViewJob[];
  workers: readonly WorkersViewWorker[];
  /** `first_seen_at` (ISO) per `<processInstanceKey>:<jobType>` from the activation ledger. */
  firstSeen: ReadonlyMap<string, string>;
  now: number;
  includeInternal: boolean;
}

/** Pure: build the workers view. Sorted by job type, so it is stable frame to frame. */
export function buildWorkersView(input: WorkersViewInput): WorkersView {
  const types = new Set(input.jobTypes);
  for (const j of input.jobs) if (j.type) types.add(j.type);
  const sorted = [...types].sort();
  const jobsOf = (type: string) => input.jobs.filter((j) => j.type === type);
  const items: WorkersJobType[] = sorted.filter(isExternalJobType).map((jobType) => {
    const token = jobTypeToRoutingToken(jobType);
    const jobs = jobsOf(jobType);
    const leasers = new Set(jobs.map((j) => j.worker).filter((w): w is string => typeof w === "string" && w !== ""));
    const waiting = jobs.filter((j) => !j.worker);
    const workers: ConnectedWorker[] = input.workers
      .filter((w) => (token !== undefined && w.serves.includes(token)) || leasers.has(w.instance) || leasers.has(w.identity))
      .map((w): ConnectedWorker => ({
        workerId: w.instance,
        host: w.host ?? null,
        transport: "agentic-channel",
        lastSeen: new Date(w.lastSeen).toISOString(),
        live: w.live,
        status: w.live ? "live" : "stale",
        busy: leasers.has(w.instance) || leasers.has(w.identity),
      }));
    const ages = waiting
      .map((j) => input.firstSeen.get(`${j.processInstanceKey}:${jobType}`))
      .filter((iso): iso is string => typeof iso === "string")
      .map((iso) => input.now - Date.parse(iso))
      .filter((ms) => Number.isFinite(ms));
    const liveWorkers = workers.filter((w) => w.live).length;
    return {
      jobType,
      workers,
      liveWorkers,
      queueDepth: waiting.length,
      inProgress: jobs.length - waiting.length,
      oldestWaitingAgeMs: ages.length > 0 ? Math.max(0, ...ages) : null,
      starved: waiting.length > 0 && liveWorkers === 0,
    };
  });
  // Internal `pr.*` workers run in THIS process: they are live exactly while the app serves this request.
  const internalTypes = sorted.filter((t) => !isExternalJobType(t));
  const internal: WorkersView["internal"] = {
    total: internalTypes.length,
    live: internalTypes.length,
    stale: 0,
    summary: internalTypes.length === 0 ? "no internal workers" : `all ${internalTypes.length} internal workers live (in-process)`,
  };
  if (input.includeInternal) {
    internal.workers = internalTypes.map((jobType): InternalWorker => {
      const jobs = jobsOf(jobType);
      const queueDepth = jobs.filter((j) => !j.worker).length;
      return { jobType, status: "live", queueDepth, inProgress: jobs.length - queueDepth };
    });
  }
  return { items, page: { totalItems: items.length }, internal };
}
