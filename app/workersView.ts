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
// Internal job types are exactly the `workers[].taskType`s nano.app.json registers (served by this app's
// own in-process workers, summarised as one health line); every other type is external.
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

/** The job types THIS app serves in-process: the `workers[].taskType`s registered in `nano.app.json` —
 *  the same manifest the runtime mounts the handlers from, so the internal set is derived, never guessed
 *  from a job type's shape (a delivery graph can name an arbitrary external type such as `j`). */
export function registeredWorkerTypes(manifest: URL = new URL("../nano.app.json", import.meta.url)): string[] {
  const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  const workers = parsed !== null && typeof parsed === "object" && "workers" in parsed ? parsed.workers : undefined;
  const types = new Set<string>();
  if (Array.isArray(workers)) {
    for (const w of workers) {
      if (w !== null && typeof w === "object" && "taskType" in w && typeof w.taskType === "string") types.add(w.taskType);
    }
  }
  return [...types].sort();
}

/** An external job type is one this app does NOT serve in-process (fail-safe: unknown → external, so a
 *  queued job of an unrecognised type is reported, never folded into the always-live internal line). */
export function isExternalJobType(type: string, internalTypes: ReadonlySet<string>): boolean {
  return !internalTypes.has(type);
}

export interface WorkersViewJob {
  type: string;
  processInstanceKey: string;
  jobKey?: string;
  worker?: string;
}

/** One activation-ledger row: when the poller first saw the job attempt it tracks (`jobKey`). */
export interface FirstSeenEntry {
  jobKey: string | null;
  firstSeenAt: string;
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
  /** The job types this app serves in-process ({@link registeredWorkerTypes}). */
  internalTypes: readonly string[];
  jobs: readonly WorkersViewJob[];
  /** Workers visible on the agentic presence channel, or `null` when that channel is unavailable
   *  (e.g. `NANO_AGENTIC=off`) — worker supply is then UNKNOWN, not empty. */
  workers: readonly WorkersViewWorker[] | null;
  /** The activation-ledger row per `<processInstanceKey>:<jobType>`. */
  firstSeen: ReadonlyMap<string, FirstSeenEntry>;
  now: number;
  includeInternal: boolean;
}

/** Collect every CREATED job across `types`, one search per type, plus an untyped search that discovers
 *  types no model declares (delivery-graph agent nodes). The engine client's search returns a single
 *  page, so narrowing each search to one type keeps one busy type from crowding the others off the
 *  page. A search failure PROPAGATES — the caller must not report an unreadable queue as empty. */
export async function collectCreatedJobs(
  search: (filter: { state: string; type?: string }) => Promise<readonly WorkersViewJob[]>,
  types: readonly string[],
): Promise<WorkersViewJob[]> {
  const all = new Set(types);
  for (const j of await search({ state: "CREATED" })) if (j.type) all.add(j.type);
  const out: WorkersViewJob[] = [];
  for (const type of [...all].sort()) {
    for (const j of await search({ state: "CREATED", type })) if (j.type === type) out.push(j);
  }
  return out;
}

/** Pure: build the workers view. Sorted by job type, so it is stable frame to frame. */
export function buildWorkersView(input: WorkersViewInput): WorkersView {
  const internalSet = new Set(input.internalTypes);
  const types = new Set(input.jobTypes);
  for (const j of input.jobs) if (j.type) types.add(j.type);
  const sorted = [...types].sort();
  const supplyVisible = input.workers !== null;
  const visibleWorkers = input.workers ?? [];
  const jobsOf = (type: string) => input.jobs.filter((j) => j.type === type);
  const items: WorkersJobType[] = sorted.filter((t) => isExternalJobType(t, internalSet)).map((jobType) => {
    const token = jobTypeToRoutingToken(jobType);
    const jobs = jobsOf(jobType);
    const leasers = new Set(jobs.map((j) => j.worker).filter((w): w is string => typeof w === "string" && w !== ""));
    const waiting = jobs.filter((j) => !j.worker);
    const workers: ConnectedWorker[] = visibleWorkers
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
    // A ledger row is keyed by (instance, type), which a retry reuses — so its timestamp is only this
    // job's when the row tracks THIS job's key; otherwise the age is unknown (never a prior attempt's).
    const ages = waiting
      .map((j) => {
        const row = input.firstSeen.get(`${j.processInstanceKey}:${jobType}`);
        return row && j.jobKey && row.jobKey === j.jobKey ? row.firstSeenAt : undefined;
      })
      .map((iso) => (typeof iso === "string" ? input.now - Date.parse(iso) : Number.NaN));
    const liveWorkers = workers.filter((w) => w.live).length;
    return {
      jobType,
      workers,
      liveWorkers,
      queueDepth: waiting.length,
      inProgress: jobs.length - waiting.length,
            // Unknown when ANY waiting job's age is untracked: a partial max is only a lower bound.
      oldestWaitingAgeMs: ages.length > 0 && ages.every((ms) => Number.isFinite(ms)) ? Math.max(0, ...ages) : null,
      // Starvation is only asserted when worker supply is visible: with the presence channel off it is
      // unknown (null). A type some worker is actively leasing is being served, so it is not starved.
      starved: supplyVisible ? waiting.length > 0 && liveWorkers === 0 && jobs.length === waiting.length : null,
    };
  });
  // Internal `pr.*` workers run in THIS process: they are live exactly while the app serves this request.
  // Derived from the REGISTERED set (plus any observed internal type), independent of current demand,
  // so an idle handler used only by compiled graphs still appears.
  const internalTypes = [...new Set([...internalSet, ...sorted.filter((t) => !isExternalJobType(t, internalSet))])].sort();
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
  return { items, page: { totalItems: items.length }, internal, supplyVisible };
}
