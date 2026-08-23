# ADR 0006 — Delivery units: one representation for feature / epic / delivery-graph

Status: **Proposed.**
Date: 2026-08-22.

> **Scope note.** This is a **nano-workforce-local** ADR — it governs how *this app* represents a
> unit of delivery work internally. Platform-wide ADRs live in `Magikcraft/nano-bpm/docs/adr`
> (referenced by number + repo). nano-workforce's own series continues here after ADR 0005.

Relates to:
nano-workforce **ADR 0005** (agent-authored delivery graphs — this ADR carries out 0005's
already-stated framing that the delivery graph is the *general* form, of which an epic is a waved DAG
and a feature a degenerate 1-node graph, by converging the data and process encodings onto it),
nano-workforce **ADR 0001** (cross-repo epics + the generic `ReadinessProbe` wait-gate — the epic
substrate being consolidated),
nano-workforce **ADR 0002** (escalations are user tasks + forms — the human-escalation cell that is
one of the copy-pasted subprocesses),
nano-bpm **ADR 0065** (reconciling read models / `defineReadModel` — the derivation mechanism S1 uses
to collapse three bespoke status unions into one),
nano-ide **#424** (datasource can read a SQL VIEW — the *data-level* unlock),
nano-workforce **#416** (the PR bumping the testkit to engine-wasm 0.7.2, which executes `callActivity`
— the *process-level* unlock),
nano-workforce **#464** (the tracking issue with slices S1–S5),
nano-workforce **#305** (consolidate escalations on native `user_tasks` — a natural sub-step of S1/S3).

## Context

### One aggregate, encoded three times

nano-workforce models the same real-world thing — **a scheduled unit of work driven to a delivery
outcome** (typically an agent taking one slice to one merged PR, but a unit may instead `wait`, ask a
`human`, call a `connector`, or — for a feature — terminate `opened`/`converged` without a merged PR;
and an epic aggregates *many* such units/PRs) — in three separate representations, each with its own
table, status union, operator read-surface, `instanceTracking` binding, and dispatch door:

| Representation | Data | Process | Shape |
|---|---|---|---|
| **Feature** | `feature_runs` (mig. 028) | `resources/processes/feature.bpmn` | one issue → one PR (1-node) |
| **Epic** | `plans` + `plan_tasks` (mig. 004) | `resources/processes/plan-fanout.bpmn` | fan-out of slices → waves (N-node) |
| **Delivery graph** | `delivery_graph_runs` (mig. 058) + compiled nodes | compiled BPMN (`app/deliveryGraphCompiler.ts`) | arbitrary DAG |

All three are keyed by an issue/run key and carry their own status union. Feature and epic each also
project a dedicated display read-model VIEW; delivery-graph pages instead bind **directly** to
`delivery_graph_runs` (`pages/delivery-graphs.page.json`, `pages/delivery-graph-detail.page.json`).
Feature and epic execute through **hand-authored** BPMN (`feature.bpmn`, `plan-fanout.bpmn`) and
dispatch hard-coded `senior:*` implementation jobs that funnel downstream to the *same* `pull_requests`
table (keyed by `pr_key`) — the convergence/merge loop, which they correctly do **not** duplicate.
Delivery graphs are the exception: only they are **compiled** to BPMN from JSON at runtime, they accept
the submitted node kind and `agent.jobType` (including `wait`, `human`, and `connector` nodes), and
`delivery_graph_runs` carries no `pr_key`, so a graph is not inherently PR-producing. So for the
feature/epic implementation path the *downstream* half of the aggregate is already factored to a single
source of truth; only the *upstream* "unit of work" half is triplicated.

ADR 0005 already names this: "plan-fanout is an epic — a `RecordPlanTask[]` + `dependsOn[]` DAG with
waves", "convergence-loop is one PR", and a feature is the degenerate one-node graph. The delivery
graph is the general form. What 0005 did *not* do is converge the data and process encodings onto that
general form — so we still carry three near-duplicate sources of truth for one aggregate. That is
precisely the "no drift surfaces / derivation over duplication" hazard this project treats as a defect
class: a change to the meaning of "a unit of work" has to be made, by hand, in three places that can
silently drift.

### The duplication was *forced* by two "can't-reference" constraints — both now lifted

The triplication is not a design preference; it was compelled by two symmetric constraints, one on
each encoding. Both have now been removed on `main`, which is why consolidation becomes possible now
rather than earlier.

**Data — "the datasource can't read a SQL VIEW."** Because the read layer could not read a VIEW, every
*display projection* had to be a physically **denormalized table** — or denormalized columns
hand-maintained on a source table (e.g. migrations 022/029 on `plans`) — rather than a VIEW derived
from its source. That is what made a *shared* display projection impossible: each representation grew
its own hand-maintained projection. (The delivery-unit source tables themselves —
`feature_runs`/028, `plans`+`plan_tasks`/004, `delivery_graph_runs`/058 — are domain stores, not
projection artifacts.) **Unlocked by nano-ide#424** (the datasource can now read a VIEW) → the derived
read-model VIEWs added in migrations 059–062, 064, and 073 (later refined by 074/075), with 070–072
dropping the now-redundant denormalized columns/tables. **Live today.**

**Process — "the pinned WASM engine no-ops `callActivity`."** `app/deliveryGraphCompiler.ts:47-51`
(and again at 604-607) records the constraint verbatim: `callActivity` is "a no-op on the pinned WASM
engine (the child is never instantiated)", so the compiler — and every hand-written process —
**inlines** the subprocess body instead of referencing it. The consequence is that the atomic
*"agent-implement cell"* (`implement-task (senior:*) → "escalated?" gateway → record-escalation →
user-task → SLA boundary → answer gateway`) exists as **two hand-authored copies** — `feature.bpmn` and
the multi-instance `implement` subprocess in `plan-fanout.bpmn` — plus a **third generator** in the
compiler that re-emits it once per graph node. Sibling cells
(readiness-poll, human-escalation) duplicate the same way. **No `callActivity` exists in any diagram**
because it did nothing. **Unlocked by #416** (engine-wasm 0.4.0 → **0.7.2**). engine-core executes
`callActivity` by inline-expanding the called process at deploy (`engine-core/src/model.rs:1217/1255`).
**Verified live:** a `callActivity` parent+child model deployed through engine-wasm 0.7.2 runs to
`COMPLETED`. Caveat: #416 bumps only the **dev-only** `@nanobpm/urban-testkit`; the production
`@nanobpm/urban` broker does not itself pin `engine-wasm`, so this verification proves the in-process
testkit, not the broker/runtime that will execute future `callActivity` models. S4/S5 therefore also
carry a **deployment-runtime prerequisite** — the deployed broker's `engine-core` must carry the same
`callActivity` support — which green testkit CI does not by itself guarantee.

### The two constraints are the *same* constraint

Both are "an encoding can't *reference* a shared definition, so it *inlines a copy* of it." Data
inlined projection tables; process inlined subprocess bodies. Both share the same aggregate (the
delivery unit), the same fix shape (remove the can't-reference constraint, then reference instead of
copy), and both already have their downstream half factored correctly (`pull_requests`; the
convergence/merge loop). Removing one constraint without the other would leave the aggregate
half-consolidated; removing both is what makes a single representation reachable.

## Decision

Adopt a single internal aggregate — the **delivery unit** — defined around its **nodes**: a node is one
**scheduled unit of work** whose executor may be an **agent, probe, human, or connector** (ADR 0005
`wait`/`human`/`connector` nodes are first-class, not exceptions). Its terminal is *typically* one merged
PR, but PR-less nodes and delivery graphs (`delivery_graph_runs` has no `pr_key`) make PR production
**optional**.
It has **two encodings**, each of which now *references* the shared definition rather than inlining
a copy — expressed here as the **target** state:

### 1. Data encoding — one `delivery_unit` aggregate

- A `delivery_units` table is the single source of truth for "a unit of work." Feature = a 1-node
  unit; Epic = an N-node waved unit; DeliveryGraph = an arbitrary-DAG unit — a **shape**, not a
  separate table.
- `feature_runs` / `plans` + `plan_tasks` / `delivery_graph_runs` become **derived VIEWs / rows** over
  `delivery_units` (using the nano-ide#424 VIEW capability), not independent tables. The epic case
  covers **both** levels: the `plans` aggregate row (process key, status, title, lifecycle) becomes a
  row/VIEW over `delivery_units`, and each `plan_tasks` slice becomes a node under it.
- The three `instanceTracking` bindings and `senior:*` dispatch doors collapse toward one, keyed on
  the delivery unit.
- **Identity.** `delivery_units` carries a stable `unit_id` plus `(unit_id, node_id)` for the N-node
  cases. The legacy keys are not interchangeable — a feature run and an active epic may share one
  `<owner>/<repo>#<N>` key (`app/feature.ts`), while delivery graphs key on a caller idempotency key or
  content digest (`app/deliveryGraphRun.ts` `computeRunKey`) — so S2's compatibility VIEWs map each
  legacy key onto the new identity, ensuring unrelated runs are never merged onto one row.

### 2. Process encoding — shared cells composed by `callActivity`

- Extract the atomic *implement-cell* (and its sibling wait-gate and human-escalation cells) into
  standalone processes (`resources/processes/implement-cell.bpmn`, …).
- Compose them by reference — replacing only the inlined *implement/escalation segment*, not the
  surrounding orchestration: in **feature** (`feature.bpmn`) the readiness preflight, base-branch setup,
  `record-feature`, and convergence handoff are retained; only the implement-cell segment becomes one
  `callActivity`. **Epic** = the multi-instance `implement` body is a `callActivity`; **delivery graph**
  = the compiler *emits* `callActivity` references, not inlined subprocess copies.
- This is gated on the engine-wasm 0.7.2 unlock, which is now live on `main`.

### 3. Status lifecycle — one derived union

The three bespoke status unions collapse into **one derived union** via ADR 0065's `defineReadModel`,
so a change to lifecycle semantics is made once and derived everywhere, not re-declared per
representation. These unions are **not** identical today — features use
`running`/`escalated`/`awaiting_operator`/…, plans use `planning`/`dispatched`/`done`, and graphs use
`running`/`done` with a reserved `awaiting-approval` (`app/feature.ts`, `app/plan.ts`,
`app/deliveryGraphRun.ts`); §1 additionally makes each `plan_tasks` row a **node**, which carries its own
`PlanTaskStatus` (`pending`/`waiting-for-lane`/…, `app/plan.ts`). So S1 owns defining the canonical
**aggregate** state set *and* explicitly deciding whether **node** status is part of that union or a
separate node contract — plus the per-shape mapping and precedence and the write/`instanceTracking`
behavior — not merely projecting an existing value.

### 4. Preserve — the static-vs-adaptive execution axis (do NOT bundle it)

This ADR consolidates the *representation*, not the *execution strategy*. ADR 0005's deliberate
distinction stays intact: **plan-fanout remains adaptive** (agent-discovered slices, waves that adapt),
**delivery graphs remain static/compiled**. Both are still *delivery units*; they differ only in how
their topology is produced. Unifying that axis is explicitly out of scope here.

## Consequences

- **Single source of truth for a unit of work.** A change to the meaning of "a delivery unit" — a new
  status, a lifecycle rule, a step in the implement cell — is made once and derived into every
  representation, eliminating the three-way drift surface this project treats as a defect class.
- **Renderability + executability both improve.** One implement-cell process is one thing to keep
  deploy-valid and lay out, instead of **two hand-authored copies plus a compiler generator** that can
  silently diverge (a graph can render and still fail deploy — the copies are exactly where that
  divergence hides).
- **Migration is incremental and forward-only.** The VIEWs preserve every current read shape while the
  physical model consolidates underneath, and each slice below is independently shippable. Consistent
  with this repo's forward-only, expand-and-contract migration contract (see
  `070_drop_plan_projection_columns.sql`, which treats dropping projection columns as a later contract
  phase), a slice is **not** reverted by reverting the app: rolling back a writer-repointing or
  table-to-VIEW slice requires a **separately designed recovery/compatibility migration**, not a plain
  revert.
- **Cost.** A backfill/migration for `delivery_units`; a one-time extraction of the shared cells; and
  the process slices are sequenced behind the (now-live) engine-wasm unlock. No behaviour change is
  intended — this is a representation consolidation, guarded by parity tests against the existing VIEWs
  and by the deploy+run engine tests.

## Rollout (see #464 for the live checklist)

Each slice is independently shippable; the process slices (S4/S5) are sequenced behind the engine-wasm
0.7.2 unlock. The **dev-testkit** side of that unlock has landed (#416, verified in-process above); S4/S5
additionally gate on the **deployed broker/runtime** carrying verified `callActivity` support (the
deployment-runtime prerequisite noted above), not on #416 alone.

- **S0 · ADR** — this record.
- **S1 · status lifecycle** — one derived status union via ADR 0065 `defineReadModel`, replacing the
  three bespoke unions. This **depends on and overlaps** #305 (consolidate escalations on native
  `user_tasks`) but does not subsume it: #305 additionally retires the `feature_runs` escalation
  columns and the bespoke completion doors and updates the escalation UI/forms, which remain #305's
  scope (an adjacent sub-step of S1/S3 per #464).
- **S2 · `delivery_units` table** — the aggregate. Because current code still **writes**
  `feature_runs` / `plans` / `plan_tasks` / `delivery_graph_runs` directly (`app/feature.ts`,
  `app/plan.ts`, `app/deliveryGraphRun.ts`) — **and** the framework's `instanceTracking` bindings in
  `nano.app.json` write termination status to `feature_runs`, `plans`, and `delivery_graph_runs` — and a
  SQLite VIEW is read-only, follow expand/contract **order**: (a) add `delivery_units` and dual-write it
  alongside the legacy tables; (b) backfill existing/legacy rows; (c) repoint reads to VIEWs/rows derived
  from `delivery_units`, guarded by read-model parity tests. The legacy tables stay **physical
  (writable) through S2** — they must **not** become read-only VIEWs while any writer, including the
  `instanceTracking` termination-reconciliation bindings, still targets them, or reconciliation fails
  with no writable target left for S3 to move. (d) Only after **S3** has moved those `instanceTracking`
  bindings and every other writer off the legacy tables does the table-to-VIEW contract phase retire the
  legacy write paths.
- **S3 · collapse doors** — unify the three `instanceTracking` bindings + `senior:*` dispatch doors.
- **S4 · shared cells** — extract the atomic `implement-cell.bpmn` **and its sibling wait-gate and
  human-escalation cells** (Decision §2) into standalone processes; `feature.bpmn` + the `plan-fanout`
  MI body compose them via `callActivity`.
- **S5 · compiler emits calls** — `deliveryGraphCompiler` references shared cells instead of inlining
  per-node copies.

## Non-goals / deferred

- **Unifying the static-vs-adaptive execution axis** (see Decision §4) — preserved deliberately.
- **Changing the downstream PR/convergence loop** — already single-sourced (`pull_requests`); untouched.
- **Cross-repo/platform representation** — this ADR is nano-workforce-local; any platform-wide delivery
  aggregate would be a separate nano-bpm ADR.
