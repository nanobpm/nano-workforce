# `app/agentic/vocab/` — the enrolment hub (epic #152 / N1 #145)

The app-tier **enrolment / token-resolution** side of the agentic plane (ADR 0059 revised + ADR 0056
§8–10). It **consumes** `@nanobpm/agentic` (`/vocab`, `/demand`, `/protocol`) — it never
re-implements the wire types (AGENTS.md: derivation over duplication).

## What N1 lands

- **`crew-vocab.ts`** — `CREW_VOCAB`, the nwf crew vocabulary artifact (the ONE capability→token map),
  authored in the package's `VocabDocument` schema, plus the memoised `crewResolver()`. Tokens:
  `planning.spar` (#red/#blue, strict distinct-family), `planning.finalize`, `qa.review`/`qa.lint`,
  `implementation.senior`/`.junior`/`.reviewer`, `ci.runner`, `decide`.
- **`enrol.ts`** — `resolveEnrolment(capability)`: the server side of REGISTER → SERVE. A declared
  enrolment capability resolves to a deterministic SERVE token set, the vocab version, and the
  liveness lease TTL. Idempotent per (app, worker) — the same capability always yields the same SERVE.
- **`publish.ts`** — the `GET /agentic/vocab` view (`{ networks, requirements, version }`).
- **`demand-report.ts`** — the demand×supply report behind `GET /agentic/registry`: deployed DEMAND
  (the models' `taskDefinition` leaves, read from the engine's C8 v2 REST API) diffed against live
  SUPPLY (the H1 presence registry resolved through the crew vocab), per network, with the
  **missing-agent-type** reds and the **diversity SLO** (ADR 0056 §10). Degrades to a supply-only
  report (`demandUnavailable: true`) when the engine can't be read.

## Endpoints (mounted under `/app/api`, ADR 0058/0059)

- `GET  /app/api/agentic/vocab`    → `getAgenticVocab`    — the published crew vocab artifact.
- `POST /app/api/agentic/enrol`    → `enrolAgenticWorker` — `{ capability, host }` → `{ serve, demandVersion, leaseTtl }`.
- `GET  /app/api/agentic/registry` → `getAgenticRegistry` — the demand×supply report.

The **N2 board** (`pages/board/`, App View — ADR 0057) renders the report: the matrix by network,
missing-agent-type reds, and the diversity-SLO lights.

## Invariants (ADR 0056)

App-tier only, never the engine; the C8 REST read is an ordinary read over a **separate** connection
(the engine and the C8 job protocol stay frozen). **Advisory** — the report is a read-only mirror and
never hard-locks or gates a BPMN sequence flow; there is no server-side matchmaking/placement.
Capability (cognition/weight/family/host) is an **enrolment** attribute, never a routing token.
