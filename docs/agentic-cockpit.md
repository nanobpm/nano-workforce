# The agentic visibility cockpit — operator guide

> **Scope: SUPPLY side only.** This guide covers the *supply* half of the agentic
> visibility plane (ADR 0056) — the live worker registry and the drill-into-a-worker
> terminal. The **demand** side — the demand×supply matrix by network,
> missing-agent-type reds, and diversity-SLO lights — is a separate concern,
> deferred to the **enrolment epic #152**. Nothing here shows demand.

## What the cockpit shows you

The cockpit is a read-only, advisory window onto the fleet of agentic workers
connected to this app. It answers two operator questions:

1. **Who is here?** — every connected worker, grouped by the leaf token it
   authenticated under, with its declared **family** and **host**, its current
   **jobs**, the **process instance / plan** each job belongs to, and a
   **liveness** dot (live / stale / down).
2. **What is that worker doing right now?** — click a worker (or a specific
   process/plan) to open its **live terminal**, streamed off the relay.

It is **advisory**: it never gates, locks, or influences any BPMN sequence flow.
Turning the cockpit off changes nothing about how work runs — it only changes
what you can *see*.

## The architecture in one breath

The cockpit rides the **agentic channel** — one WebSocket the app serves on its
*own* port at `/agentic`, alongside its pages and hooks (no sidecar port). Four
cooperating families sit on that channel, each mounted through a single
extension **seam** (`app/agentic/registry.ts`) so no family ever touches the boot
script:

| Family | Module | What it owns |
| --- | --- | --- |
| **presence** (H1) | `app/agentic/families/presence.family.ts` | The live worker registry over the app's SQLite store — REGISTER / heartbeat / disconnect. |
| **relay** (H3) | `app/agentic/families/relay.family.ts` | The bounded replay ring + three-lane QoS scheduler + transcript store — the terminal stream. |
| **blackboard** (H4) | `app/agentic/families/blackboard.family.ts` | The advisory coordination blackboard. |
| **correlation** (H6) | `app/agentic/families/correlation.family.ts` | The jobKey ⇄ process-instance / plan join. |

The supply report the cockpit polls is served by
`GET /app/api/agentic/supply` (`operations/getAgenticSupply.ts`), which projects
the presence snapshot — enriched with correlation — into the view.

## Reading a worker row

Each row in a leaf-token section is one connected worker:

- **worker** — the worker instance id. Click it to drill into its terminal on its
  default stream.
- **family** — the declared agent family (e.g. `senior`, `junior`), or `—`.
- **host** — where the worker runs, or `—`.
- **jobs** — the jobKeys the worker is currently processing. Empty (`—`) when the
  worker is idle *or* when nothing has correlated a job to it yet.
- **process / plan** — the engine context for each current job: the BPMN process,
  element, process-instance key, and plan/epic key, rendered as
  `plan-fanout · implement-task · inst 4612 · owner/repo#142`. **Click it to open
  that job's live terminal** (`job:<jobKey>`), not just the worker's default
  stream.
- **liveness** — `live` (heartbeating), `stale` (no refresh past the threshold,
  default 15 s), or `down` (disconnected). Rendered as a coloured dot.

### How jobs and process/plan get populated — the correlation seam (H6)

A worker's channel frames don't carry job attribution — the relay only knows a
*stream id*. So correlation is an explicit, advisory **registry**
(`app/agentic/correlation.ts`) that the orchestrator populates when it dispatches
an agentic job:

```ts
import { currentCorrelation } from "./app/agentic/correlation.ts";

// When a worker instance picks up a Camunda-8 job:
currentCorrelation()?.link("wk-a", jobKey, {
  processInstanceKey,
  bpmnProcessId,
  elementId,
  planKey, // e.g. owner/repo#142
});

// When the job finishes (or the worker disconnects):
currentCorrelation()?.releaseJob(jobKey);      // one job
currentCorrelation()?.releaseInstance("wk-a"); // every job the worker held
```

One `link` write is the single canonical join — it projects to **both**
directions the cockpit needs:

- `instance → jobKeys` feeds the presence snapshot's `jobKeysFor` seam, so a
  worker's **jobs** column lights up;
- `jobKey → context` (with the derived `job:<jobKey>` **stream**) drives the
  **process / plan** cell and the drill-in.

A jobKey belongs to at most one worker at a time — re-linking it moves it. The
relay stream a job's terminal rides is always `job:<jobKey>` (see
`jobStream` / `jobKeyOfStream` in `app/agentic/correlation.ts`); repointing the
drill stream there is what lets you open the *live job's* terminal from the
process/plan cell.

If the correlation family is not mounted (or nothing has linked a job), the
report still serves — jobs stay empty and every worker drills into its default
instance stream. Correlation is **additive and advisory**; its absence never
errors.

## Drilling into a worker — resume-from-offset

Clicking a worker (or a process/plan) opens a `TerminalSession`
(`@nanobpm/agentic/cockpit`) subscribed to the relay stream. The session is
**resume-from-offset**: it tracks the offset just past the last chunk it applied,
and on every (re)connect it re-subscribes from there. This means:

- A **cockpit reconnect** replays only the un-applied tail — no lost output, no
  double-printed lines (within the ring's retained window).
- A **hub restart** (the ring is in memory and is lost; the app's SQLite store is
  durable) is survived the same way: the worker reconnects and replays its
  transcript on a bumped incarnation, and your terminal resumes from its own
  offset — receiving only what it hadn't already seen. Incarnation fencing stops
  a stale producer from double-attaching. This exact path is pinned by the
  end-to-end wiring test (`test/agentic-e2e.test.ts`).

## Liveness and cleanup

Presence rows are kept live by worker heartbeats and removed on disconnect or
when a worker ages out past the liveness TTL. On (re)mount the presence family
reconciles the store against live connections, so a worker that vanished while
the app was down does not linger as a ghost row after a restart.

## What you will NOT find here (and where it lives)

- **Demand×supply matrix, missing-agent-type reds, diversity-SLO lights** →
  enrolment epic **#152**. They depend on the vocab / capability→SERVE /
  diversity-SLO machinery this epic deliberately de-scopes. This report carries
  no demand-side fields and the renderer draws none.
- **Engine / job-protocol changes** → none. The visibility plane is app-tier
  only; the Camunda-8 worker⇄engine job protocol is untouched. The agentic
  channel is the only new conversation.
