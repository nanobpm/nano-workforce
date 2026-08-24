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
nano-workforce **#464** (the tracking issue with slices S1–S6),
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
testkit, not the broker/runtime that will execute future `callActivity` models. S4–S6 therefore also
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

### 2. Process encoding — **fine-grained** cells composed by `callActivity`

The primitive is a set of **small, single-purpose cells** — `implement-cell`, `converge-cell`,
`merge-cell`, plus the sibling wait-gate and human-escalation cells — each a standalone process
(`resources/processes/implement-cell.bpmn`, …), composed by reference and gated by edges. This is a
deliberate choice of granularity **over** a single coarse whole-feature subprocess with opaque
completion flags.

- Compose by reference, replacing the inlined segments, not the surrounding orchestration: in
  **feature** (`feature.bpmn`) the readiness preflight, base-branch setup, and `record-feature` remain;
  the implement/escalation segment and the convergence/merge tail each become `callActivity`s. **Epic**
  = the multi-instance `implement` body is a `callActivity`; **delivery graph** = the compiler *emits*
  `callActivity` references, not inlined subprocess copies.
- `feature` / `epic` are **derived macros** over the cells, not hand-written processes: a `feature`
  expands to `implement → converge? → merge?`, so the cells stay the single source of truth and the
  common case is still one node. (Same derivation discipline as the data encoding: compose by
  reference, never inline a copy.)
- **Why fine-grained, not coarse.** A coarse whole-feature `callActivity` with `converge?`/`merge?`
  flags buries those steps *inside* the black box, so a graph can never insert a gate *between*
  "converged" and "merged". Fine-grained cells let a graph converge features A **and** B, then hold and
  land both behind a single `human`/`wait` fan-in — the integration-branch / gated-landing pattern.
  `feature.bpmn` already separates `converge` (its `gw-converge` gateway) from `autoMerge`, so the seam
  exists today; this promotes it to a **node boundary** the graph can wire (see §3).
- This is gated on the engine-wasm 0.7.2 unlock, which is now live on `main`.

### 3. Node completion policy — `converge` / `merge` are first-class cells, not smuggled state

Today the "get to green, then land" tail lives in two places the delivery graph cannot reach: a gateway
*inside* `feature.bpmn` (`gw-converge` + the `autoMerge` boolean on `ConvergeFeatureIn`), and — for a
delivery-graph `agent` node — **free text in a prompt** (`{ jobType: "senior:feature", prompt: "un-draft
+ merge #B" }`), with the graph only *observing* the result via a downstream `wait` node that emits
`mergedSha`. A graph therefore drives merge by asking an agent nicely, not structurally. Promote them to
first-class, edge-gated cells:

- **`converge`** = drive the PR through its review-convergence loop to green. **`merge`** = land it.
  These are deliberately **separable phases** (`feature.bpmn` already splits `gw-converge` from
  `autoMerge`), so a graph can stop at "green" and gate the landing behind any upstream node.
- A `feature`/`epic` node's `converge?` / `merge?` selectors choose whether the derived macro (§2)
  includes those cells; omitting `merge` and wiring an explicit `merge` cell downstream of a gate is the
  advanced case.
- **`merge` is two-level (ADR 0003 base-branch admission).** A unit's `merge` cell lands onto the
  epic/graph **base branch**, never `main` directly; the graph's final merge-to-`main` is a *separate*
  top-level step. `feature.bpmn`'s `autoMerge` is exactly this per-unit knob — do not collapse the two
  levels.

### 4. Status lifecycle — one derived union

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

### 4b. One derived **stepper** — the cells are the step axis, correlated by `process_key`

§4 collapses the three status *unions* into one derived union; this decision collapses the three
*progress projections* — the thing an operator actually reads as "where is this unit in its
lifecycle" — into **one derived stepper**, rendered by **one** primitive across all three surfaces.

Today that projection is triplicated the same way the aggregate is, and at three different maturity
levels for one idea:

| Surface | Derivation | Step vocabulary | Render |
|---|---|---|---|
| **Feature** | `deriveStage` over the declare-once read-model (`app/stage.ts`; mig. 076 declared it, mig. 081 superseded the VIEW for terminal-folded status — 073 is historical) — reconciled from the feature run's `status` / `pr_key` / flags **and** the correlated `pull_requests` work-state | `STAGE_KEYS` = Requested → Implementing → PR open → Converging → Merging → Done | the **`pipeline` stepper** kind (`pages/feature.page.json`) |
| **Epic** | **write-time stamp** by each spine worker (`app/epicPhase.ts`, `ELEMENT_PHASE`) | `EPIC_PHASE` (wave-labelled) | a plain `{{epic_phase}}` **text cell** |
| **Delivery graph** | engine-truth poll of open **user tasks** (`pollDeliveryGraphPhase` → `deriveDeliveryPhase`) | `DELIVERY_PHASE` + `Parked on human node: <label>` | a plain `phase` **text cell** |

Three derivations × three vocabularies × two renderers — and only the feature surface renders an
actual stepper; epic and delivery-graph project a bare string. A change to "the lifecycle steps of a
unit of work" is the same by-hand-in-three-places drift this ADR exists to remove.

**The step axis is the cells — but the cell→step mapping must be defined, not assumed.** Once §2 makes
the process a composition of named cells (`implement` → `converge?` → `merge?`, plus `wait` / `human` /
`escalation`), those ordered cells are the natural step axis. `STAGE_KEYS` is the closest *existing*
projection of it, but it is **not** literally that sequence: `Requested` / `PR open` / `Done` are
lifecycle states, while `implement` / `converge` / `merge` are process cells (and today's feature
derivation additionally treats `Merging` as an upcoming/visual stage and can mark stages *skipped*). So
§4b's first deliverable is an explicit **cell → step mapping** — which cell entry/exit advances which
step, how `Requested`/`PR open`/`Done` bracket the cell run, and where an inserted `wait` / `human` /
`escalation` cell appears as a step — seeded from `STAGE_KEYS` but owning the canonical definition. It
is not enough to declare one axis *is* the other.

**The current step is derived by correlation — and the correlation key is not simply `process_key`.**
The projection must answer "which cell has this unit reached," fusing two truth sources:

- **Engine truth — the furthest element reached — IS available on the runtime.** nwf runs against
  **Nano's Rust engine over its REST API** (not the wasm testkit). That API exposes a full
  element-instance read model: `POST /v2/element-instances/search` (`searchElementInstances` →
  `elementId` + `elementType` + element **state**, keyed by process-instance) and the element-instance
  **wait-states** search (`searchElementInstanceWaitStates` → **job and message** parks, not only user
  tasks). With namespaced cell element ids (§2), a reached element maps to a reached cell — the
  sharpest signal, and the only one that sees a token mid-cell (an active `implement` job) that no
  work-table row has caught up to yet.
- **Work-table + aggregate truth — the correlated downstream state.** The feature/epic aggregate row
  (`status` / `pr_key` / flags) gives the coarse `Requested` / `Implementing` / `Done` bracket even
  with no PR and no park; `pull_requests` (and siblings) carry the `converging` / `waiting_review` /
  `merging` sub-state that `instanceTracking` + `deriveStage` already reconcile. The projection must
  name an explicit **precedence** between engine truth and this state (engine element position when
  available, else aggregate/work-table), not silently pick one.

**Correlation is per-shape, because `process_key` is reassigned.** A feature/epic aggregate's
`process_key` identifies its *own* (feature / plan-fanout) process instance, but
`pull_requests.process_key` is **overwritten** — first to the downstream convergence instance, then
again to the merge instance (`app/service.ts` `startConverge` / `startMerge`). The stable
aggregate↔PR link is **`pr_key`**, and epics additionally need node/root mapping (lineage
`rootRequestKey`, nwf#245). So §4b must define the per-shape joins — or persist a **canonical unit
key** — rather than assume a single `process_key` join; a naïve `process_key` join would misattribute
or miss work-table state. This canonical-key requirement is itself an argument for the §1 aggregate.

**The aggregate step is a frontier, not a single "furthest."** For the 1-node feature there is one
active step. For an N-node/parallel DAG (epic waves, delivery graphs), two branches can occupy
incomparable cells at once, and no total order picks a unique maximum — so the aggregate is a
**frontier** (set-valued, or reduced by an explicit, deterministic rollup, e.g. the least-advanced
active branch for a "still blocked on" read). §4b specifies that rollup rather than leaving "furthest"
undefined; the per-node steps remain individually well-defined.

**Cross-instance correlation, because composed cells are child instances by default.** engine-core's
`CallActivity` spawns a **distinct child process instance** and links it to the parent
(`engine-core/src/model.rs`); `inline_call_activities` (embedded-subprocess, one flat instance) is an
**opt-in** transform, not the default. So a §2 cell composition is a **parent + child instances**
unless the composition explicitly opts into inlining — and the broker's `/v2/process-instances/search`
has been observed returning null parent/root keys (#464), meaning a filter on the parent key alone
cannot be assumed to see a child cell's elements. §4b therefore requires an explicit choice at S4:
either compose cells with `inline_call_activities` (keeping one flat instance, so the element query
under one key suffices) **or** correlate across child instances by the canonical unit key. This is a
named design decision, not a settled fact.

**The binding, not the engine, is the current limiter — and that is the claim to retire.** The
`@nanobpm/urban` `EngineClient` binding nwf consumes surfaces only `searchProcessInstances` +
`searchUserTasks` today, so nwf cannot *yet* read the element-instance model the engine already serves.
This is exactly why the two existing derivations are workarounds: `pollDeliveryGraphPhase`
(`app/deliveryGraphRun.ts`) sees only **user-task** parks (missing job/message parks and active
elements), and epic's `epic_phase` (`app/epicPhase.ts`, nano-ide#266) projects from **write-provenance**
(each worker stamps its own `job.elementId`) *because* a live "furthest element" query wasn't surfaced.
The enabling upstream step is to **surface `searchElementInstances` / wait-states on the `EngineClient`
binding** (nano-ide / urban), after which both workarounds collapse into one live element-instance
projection over the cell axis.

**v1 ships on what's correlated today, at a coarser resolution; the element-instance query sharpens
it.** Until the binding surfaces the element model, §4b's projection is derivable *now* only from the
aggregate/work-table state + user-task parks — which is enough for feature (its `deriveStage` already
runs on exactly this) but is **coarse for delivery-graph and epic**: `deriveDeliveryPhase` returns a
generic `Running` with **no node id** for an active `agent` / `wait` / `connector` node when no human
task is open, and `delivery_graph_runs` stores no current node. So the v1 stepper must either (a) render
those as an **explicitly coarse** step (a single "in flight" step, not an invented cell position), or
(b) gate the per-cell delivery-graph/epic resolution on the element-instance source (S8). It must not
fabricate a precise step it cannot observe. When the binding lands the element query, the projection
swaps its park/position source for the live engine element instance **without changing the step axis,
the correlation key, or the renderer** — so §4b is shippable now at feature-grade fidelity and sharpens
epic + delivery-graph to per-cell later, retiring *both* the `epic_phase` write-time stamp and the
user-task-only delivery-graph poll into one derivation.

### 5. Preserve — the static-vs-adaptive execution axis (do NOT bundle it)

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
- **One stepper kills the second-order drift.** The unit's *progress projection* — the thing an
  operator reads as "where is this in its lifecycle" — is triplicated the same way the aggregate is
  (feature's `deriveStage`, epic's write-time `epic_phase`, delivery-graph's `pollDeliveryGraphPhase`),
  and only feature renders an actual stepper; epic and delivery-graph render a bare string. §4b collapses
  the three onto one derivation over the cell axis (with an explicit cell→step mapping and per-shape
  correlation — `pr_key`/canonical unit key, since `pull_requests.process_key` is reassigned downstream),
  rendered by one `pipeline` kind on all three pages. Feature unifies at full per-cell fidelity with **no
  engine change** (S7); epic + delivery-graph render a coarse "in flight" step until the *only* upstream
  dependency — surfacing the element-instance query on the `@nanobpm/urban` `EngineClient` binding (S8),
  which the engine already serves — sharpens them to per-cell and retires epic's write-provenance stamp.

## Rollout (see #464 for the live checklist)

Each slice is independently shippable; the process slices (S4–S6) are sequenced behind the engine-wasm
0.7.2 unlock. The **dev-testkit** side of that unlock has landed (#416, verified in-process above); S4–S6
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
- **S4 · fine-grained cells** — extract `implement-cell.bpmn`, `converge-cell.bpmn`, `merge-cell.bpmn`
  **and the sibling wait-gate and human-escalation cells** (Decision §2) into standalone processes;
  `feature.bpmn` + the `plan-fanout` MI body compose them via `callActivity`, with `feature`/`epic` as
  derived macros over the cells.
- **S5 · `converge?` / `merge?` as first-class node policy** — promote convergence + landing from the
  `feature.bpmn` `gw-converge`/`autoMerge` gateway and the delivery-graph *prompt prose* into edge-gated
  `converge`/`merge` cell nodes on the delivery vocabulary (Decision §3); honour ADR 0003 two-level
  merge (unit → base branch; graph → `main`).
- **S6 · compiler emits calls** — `deliveryGraphCompiler` references shared cells instead of inlining
  per-node copies.
- **S7 · one derived stepper — v1 on today's surface** (Decision §4b) — define the **cell → step
  mapping** (seeded from `STAGE_KEYS`, but owning the canonical definition — `STAGE_KEYS` mixes
  lifecycle states with cells), derive current-step by correlating the aggregate/work-table state
  (`feature_runs` `status`/`pr_key`/flags + `pull_requests`, joined by **`pr_key`** per shape — *not* a
  naïve `process_key` join, which is reassigned downstream) with user-task parks (`searchUserTasks`), and
  **promote the `pipeline` stepper kind** (feature-only today) onto the epic and delivery-graph pages.
  This needs **no** engine-binding change, but ships at **feature-grade fidelity only**: feature gets a
  true per-cell stepper now, while for a delivery-graph/epic node that is running with no open user task
  (`deriveDeliveryPhase` returns generic `Running`, no node id), the stepper renders an **explicitly
  coarse "in flight" step** rather than fabricating a cell position. Epic keeps its write-provenance
  `epic_phase` stamp for its pre-PR phases (see S8). The mapping can begin as soon as S4 names the cells;
  the `pipeline` render binding can start immediately.
- **S8 · surface the element-instance query → retire the epic write-stamp** (Decision §4b) — the one
  slice that **does** depend on an upstream binding change. Nano's Rust engine already serves the
  element-instance read model (`POST /v2/element-instances/search` `searchElementInstances` +
  element-instance **wait-states** — active elements and **job/message** parks, not only user tasks), but
  the `@nanobpm/urban` `EngineClient` binding nwf consumes surfaces only `searchProcessInstances` +
  `searchUserTasks`. Surface `searchElementInstances` / wait-states on the binding (upstream in
  nano-ide / urban), then swap the S7 projection's park/position source for the live engine element
  instance — **without changing the step axis, the correlation key, or the renderer**. This is
  what lets epic's **Planning** phase and the **non-parked** part of **Reviewing** — which run inside
  `plan-fanout.bpmn` before any PR exists and have no work-table row (Reviewing *is* partly visible via
  the real `plan-review-decision` user task, but Planning and the running review work are not), today
  knowable only from write-provenance — become a pure read-model derivation, retiring the `epic_phase`
  write-time stamp (`app/epicPhase.ts`, nano-ide#266) and folding the user-task-only
  `pollDeliveryGraphPhase` into one live projection.

## Non-goals / deferred

- **Unifying the static-vs-adaptive execution axis** (see Decision §5) — preserved deliberately.
- **Changing the downstream PR/convergence loop** — already single-sourced (`pull_requests`); untouched.
- **Cross-repo/platform representation** — this ADR is nano-workforce-local; any platform-wide delivery
  aggregate would be a separate nano-bpm ADR.
