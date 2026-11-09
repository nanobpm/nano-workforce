// POST /app/api/actions/incident/retry → operationId `retryIncident` (issue #931).
//
// The app-owned, RECORD-AWARE incident-retry door. A convergence/merge/delivery instance parked on
// an engine incident used to need a hand-run engine-REST remedy — `PATCH /v2/jobs/<k>
// {changeset:{retries:1}}` to give the failed job a retry, then `POST /v2/incidents/<k>/resolution`
// — which is exactly what the two merlin incidents (nano-bpm#1452 loop 576515, nano-workforce#930
// loop 594789) sat waiting on for hours. This delegate wraps that two-call remedy in ONE operator
// action the UI's per-row "Retry incident" button and an operator/agent can call:
//
//   1. Resolve the tracked record owning `processInstanceKey` (the SAME `resolveTrackedInstance`
//      the cancel door uses, issue #705) — a key no tracked record owns is a clean 404 no-op; we
//      never retry an instance we don't track.
//   2. Read the instance's OLDEST ACTIVE incident off the engine (`fetchActiveIncident`, the SAME
//      reader the poller's `pollIncidents` pass mirrors from, so the door and the mirror can never
//      disagree about WHICH incident is being retried). No active incident → 409 (nothing to
//      retry — it may already be resolved).
//   3. Bump the failed job's retries (a `JOB_NO_RETRIES` incident parks until the job can be
//      retried) and resolve the incident. A failed bump aborts BEFORE the resolution — resolving
//      without retries would re-incident instantly, a half-applied remedy.
//   4. Clear the mirrored `incident_*` columns off the record row immediately, so the `/status`
//      row leaves `incident` on the action's return rather than waiting out a poll tick (the next
//      `pollIncidents` pass re-mirrors if the engine still reports an active incident — the row
//      can never lie for more than a tick).
//
// The runtime validates the body against openapi.yaml (`processInstanceKey` required); the optional
// shared-secret guard stays HERE (the runtime does not enforce OpenAPI `security`): as a MUTATING
// door, when NANO_PR_WEBHOOK_SECRET is set callers must present it via the x-hook-secret header —
// mirroring `cancelInstance`. The door is operator-only: it is excluded from the projected MCP tool
// surface (`x-mcp`, see app/mcpExclusions.test.ts).

import type { DataLayer } from "@nanobpm/urban";
import { resolveEngineAddress } from "../app/enginePreflight.ts";
import { resolveTrackedInstance } from "../app/instanceTracking.ts";
import { fetchActiveIncident, type IncidentSearchItem } from "../app/service.ts";
import { envVar } from "../app/version.ts";
import { defineOperation } from "../nano-generated/operations.ts";

const SECRET = envVar("NANO_PR_WEBHOOK_SECRET") ?? "";

// The engine REST base + auth the remedy calls run against, resolved ONCE at module load exactly as
// main.ts wires the poller (`resolveEngineAddress` — CAMUNDA_REST_ADDRESS wins, else
// NANOBPMN_BASE_URL + /v2 — and the CAMUNDA_TOKEN bearer).
const ENGINE_BASE = resolveEngineAddress().restAddress.replace(/\/+$/, "");
const ENGINE_HEADERS: Record<string, string> = { "content-type": "application/json" };
{
  const token = envVar("CAMUNDA_TOKEN");
  if (token) ENGINE_HEADERS.authorization = `Bearer ${token}`;
}

/** The mirrored incident columns cleared off the record row after a confirmed resolution — the
 *  same all-four null write `pollIncidents`' clearing path makes, so the two can never drift. */
const INCIDENT_CLEARED = {
  incident_key: null,
  incident_type: null,
  incident_message: null,
  incident_since: null,
} as const;

export default defineOperation("retryIncident", async ({ req, body }, app) => {
  if (SECRET && req.headers.get("x-hook-secret") !== SECRET) {
    app.log.warn("retryIncident rejected: missing/invalid shared secret");
    return { status: 401, body: { error: "unauthorized" } };
  }
  if (!app.data) {
    app.log.warn("retryIncident: no data source configured — cannot resolve the record");
    return { status: 503, body: { error: "no data source configured" } };
  }

  // Require a STRING key (mirrors cancelInstance): engine keys are 64-bit and a numeric JSON value
  // would already have lost precision before it reached us — reject rather than coerce.
  const raw = body && typeof body === "object" ? body.processInstanceKey : undefined;
  const processInstanceKey = typeof raw === "string" ? raw.trim() : "";
  if (!processInstanceKey) {
    return { status: 400, body: { error: "processInstanceKey is required and must be a string" } };
  }

  // Resolve which tracked aggregate (PR / delivery run / …) this key belongs to BEFORE touching the
  // engine. A key that maps to NO tracked record is a clean 404 no-op — we never retry an instance
  // we don't track (mirrors cancelInstance, issue #705).
  const record = await resolveTrackedInstance(app.data, processInstanceKey);
  if (!record) {
    app.log.warn("retryIncident: no tracked record for processInstanceKey — no-op", { processInstanceKey });
    return {
      status: 404,
      body: { ok: false, processInstanceKey, error: "no tracked record for processInstanceKey" },
    };
  }

  // Read the instance's OLDEST ACTIVE incident off the engine — the SAME reader the poller mirrors
  // from, so the door retries exactly the incident the row shows. `undefined` = transport unhappy →
  // 502 (unknown, retry the action); `null` = no active incident → 409 (nothing to retry).
  let active: IncidentSearchItem | null | undefined;
  try {
    active = await fetchActiveIncident(ENGINE_BASE, ENGINE_HEADERS, processInstanceKey);
  } catch (err) {
    app.log.warn("retryIncident: incident search failed", { processInstanceKey, error: String(err) });
    return { status: 502, body: { ok: false, processInstanceKey, error: `incident search failed: ${String(err)}` } };
  }
  if (active === undefined) {
    return { status: 502, body: { ok: false, processInstanceKey, error: "engine incident search unavailable" } };
  }
  if (!active?.incidentKey) {
    return { status: 409, body: { ok: false, processInstanceKey, error: "no active incident on this instance" } };
  }
  const incidentKey = active.incidentKey;
  const jobKey = active.jobKey ?? null;

  // The remedy, in order: give the failed job a retry, THEN resolve the incident. A failed bump
  // aborts before the resolution — resolving a JOB_NO_RETRIES incident without retries would
  // re-incident instantly, a half-applied remedy that reads as success.
  if (jobKey) {
    const patch = await fetch(`${ENGINE_BASE}/jobs/${jobKey}`, {
      method: "PATCH",
      headers: ENGINE_HEADERS,
      body: JSON.stringify({ changeset: { retries: 1 } }),
    });
    if (!patch.ok) {
      app.log.warn("retryIncident: job retries bump failed", { processInstanceKey, jobKey, status: patch.status });
      return {
        status: 502,
        body: {
          ok: false,
          processInstanceKey,
          incidentKey,
          jobKey,
          error: `job retries bump failed (engine ${patch.status}) — incident left ACTIVE`,
        },
      };
    }
  }
  const resolution = await fetch(`${ENGINE_BASE}/incidents/${incidentKey}/resolution`, {
    method: "POST",
    headers: ENGINE_HEADERS,
  });
  if (!resolution.ok) {
    app.log.warn("retryIncident: incident resolution failed", { processInstanceKey, incidentKey, status: resolution.status });
    return {
      status: 502,
      body: {
        ok: false,
        processInstanceKey,
        incidentKey,
        jobKey,
        error: `incident resolution failed (engine ${resolution.status}) — the mirror stays until the engine confirms`,
      },
    };
  }

  // The engine confirmed the resolution: clear the mirrored columns off the record row NOW so the
  // `/status` row leaves `incident` on this action's return. The next pollIncidents pass re-mirrors
  // if the engine still reports an active incident, so this can never paper over a real one. The
  // record row is the one `resolveTrackedInstance` matched on the tracking VIEW — re-read it off
  // the base table by the SAME instance key, then update by the table's primary key.
  const cleared = await clearMirroredIncident(app.data, record.table, processInstanceKey);
  if (!cleared) {
    app.log.warn("retryIncident: resolved but the mirrored row could not be cleared (the next poll reconciles)", {
      processInstanceKey,
      table: record.table,
    });
  }

  app.log.info("retryIncident: incident resolved and job retried", { processInstanceKey, incidentKey, jobKey });
  return { status: 200, body: { ok: true, processInstanceKey, incidentKey, jobKey } };
});

/** Clear the four mirrored incident columns off the tracked record owning `processInstanceKey`.
 *  Only the incident-watched aggregates carry the columns (PRs since #94/#931, delivery-graph runs
 *  since #931); any other tracked table has no mirror to clear and is a no-op. Returns false when
 *  the row could not be found/updated (the next poll reconciles regardless). */
async function clearMirroredIncident(
  data: DataLayer,
  table: string,
  processInstanceKey: string,
): Promise<boolean> {
  const pkField = incidentMirrorPrimaryKeyFor(table);
  if (!pkField) return true; // not an incident-watched aggregate — nothing to clear
  const rows = await data.table<Record<string, unknown>>(table, pkField).find({ process_key: processInstanceKey });
  const row = rows[0];
  if (!row) return false;
  const pk = row[pkField];
  if (typeof pk !== "string" && typeof pk !== "number") return false;
  await data.table(table, pkField).update(pk, { ...INCIDENT_CLEARED, updated_at: new Date().toISOString() });
  return true;
}

/** The primary-key field of an incident-watched aggregate, or null for a tracked table that carries
 *  no incident mirror (plans, feature_runs, plan_conformance, delivery_units — nothing to clear
 *  there). Keyed off the SAME table name `resolveTrackedInstance` resolved, so the write can never
 *  drift from the tracked aggregate's identity column. */
function incidentMirrorPrimaryKeyFor(table: string): string | null {
  switch (table) {
    case "pull_requests":
      return "pr_key";
    case "delivery_graph_runs":
      return "run_key";
    default:
      return null;
  }
}
