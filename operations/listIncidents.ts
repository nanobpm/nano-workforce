// GET /app/api/incidents → operationId `listIncidents` (issue #931). The sibling of `/escalations`
// for TECHNICAL liveness faults: every tracked run (PR convergence/merge loop, delivery-graph run)
// whose engine instance is parked on an ACTIVE incident, with the `processInstanceKey` the operator
// remedy `retryIncident` (POST /actions/incident/retry) takes.
//
// Read-only projection over the ONE incident mirror the poller's `pollIncidents` pass writes onto
// the record rows (`incident_key/type/message/since`) — NOT a second engine query, so it can never
// disagree with the `/status` rows' `incident` overlay. Oldest incident first (longest-dead first).
//
// The optional shared-secret guard stays HERE (mirrors `listEscalations`).
import type { DataLayer } from "@nanobpm/urban";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

export interface IncidentView {
  kind: "pr" | "delivery";
  subjectKey: string;
  processInstanceKey: string | null;
  incidentKey: string;
  type: string | null;
  message: string | null;
  since: string | null;
  retry: { path: string; body: { processInstanceKey: string | null } };
}

interface MirrorRow {
  process_key?: string | null;
  incident_key?: string | null;
  incident_type?: string | null;
  incident_message?: string | null;
  incident_since?: string | null;
}

const RETRY_PATH = "/app/api/actions/incident/retry";

function toView(kind: IncidentView["kind"], subjectKey: string, r: MirrorRow): IncidentView | null {
  if (!r.incident_key) return null;
  const processInstanceKey = r.process_key ?? null;
  return {
    kind,
    subjectKey,
    processInstanceKey,
    incidentKey: r.incident_key,
    type: r.incident_type ?? null,
    message: r.incident_message ?? null,
    since: r.incident_since ?? null,
    retry: { path: RETRY_PATH, body: { processInstanceKey } },
  };
}

/** Every mirrored ACTIVE incident across the incident-watched aggregates, oldest first (a missing
 * `since` sorts last). */
export async function activeIncidents(data: DataLayer): Promise<IncidentView[]> {
  const out: IncidentView[] = [];
  const prRows = await data.table<MirrorRow & { pr_key: string }>("pull_requests", "pr_key").all();
  for (const r of prRows) {
    const v = toView("pr", r.pr_key, r);
    if (v) out.push(v);
  }
  const runRows = await data.table<MirrorRow & { run_key: string }>("delivery_graph_runs", "run_key").all();
  for (const r of runRows) {
    const v = toView("delivery", r.run_key, r);
    if (v) out.push(v);
  }
  return out.sort((a, b) => (a.since ?? "\uffff").localeCompare(b.since ?? "\uffff"));
}

export default defineOperation("listIncidents", async ({ req }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("listIncidents rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  if (!app.data) return { status: 200, body: { count: 0, incidents: [] } };
  const incidents = await activeIncidents(app.data);
  return { status: 200, body: { count: incidents.length, incidents } };
});
