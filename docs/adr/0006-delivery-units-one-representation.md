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
nano-workforce **#464** (the tracking issue — its live checklist currently ends at **S5**; **S6 is
present in this ADR's rollout but not yet listed there**, and the S7/S8 slices below are **added by this
ADR** — so S6–S8 must all be appended to #464's checklist, which does not yet list them),
nano-workforce **#305** (consolidate escalations on native `user_tasks` — a natural sub-step of S1/S3),
nano-ide **#473** (surface the element-instance query on the `EngineClient` binding — the sole upstream
**binding/platform** dependency of the S8 stepper slice; S8 *additionally* depends on S4's
inline-vs-child / correlation decision, tracked with #464).

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
`callActivity` natively as a **linked child process instance** (`engine-core/src/model.rs`); inline-expanding
the called process into one flat instance is the **opt-in** `inline_call_activities` transform, *not* the
default — the same native-child-vs-opt-in-inline distinction §4b's cross-instance-correlation note below
depends on.
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

### 4b. One derived **stepper** — the cells are the step axis, per-shape correlated

§4 collapses the three status *unions* into one derived union; this decision collapses the three
*progress projections* — the thing an operator actually reads as "where is this unit in its
lifecycle" — into **one derived stepper**, rendered by **one** primitive across all three surfaces.

Today that projection is triplicated the same way the aggregate is, and at three different maturity
levels for one idea:

| Surface | Derivation | Step vocabulary | Render |
|---|---|---|---|
| **Feature** | `deriveStage` over the declare-once read-model (`app/stage.ts`; mig. 076 declared it, mig. 081 superseded the VIEW for terminal-folded status — 073 is historical). Its inputs are the feature run's effective `status` / `pr_key` / `converge`+`auto_merge` flags / open user-task projections; `pollFeatureDelivery` separately reconciles PR status **into** that row upstream | `STAGE_KEYS` = Requested → Implementing → PR open → Converging → Merging → Done | the **`pipeline` stepper** kind (`pages/feature.page.json`) |
| **Epic** | **write-time stamp** by each spine worker (`app/epicPhase.ts`, `ELEMENT_PHASE`) | `EPIC_PHASE` (wave-labelled) | a plain `{{epic_phase}}` **text cell** |
| **Delivery graph** | engine-truth poll of **process-instance state + open user-task parks** (`pollDeliveryGraphPhase` → `deriveDeliveryPhase`: `COMPLETED`/`TERMINATED` → `done`/`failed`, else the open human-node park) | `DELIVERY_PHASE` + `Parked on human node: <label>` | a plain `phase` **text cell** |

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
step, how `Requested`/`PR open`/`Done` bracket the cell run, and how an inserted `wait` / `human` /
`escalation` cell **collapses into an existing `STAGE_KEYS` bracket** — the `pipeline` renderer binds a
static `stages` array (`pages/feature.page.json:120-126`), so v1 adds no axis entries and needs no
renderer change — seeded from `STAGE_KEYS` but owning the canonical definition. It
is not enough to declare one axis *is* the other. **v1 leaves the two existing axis consumers physically
in place** — the exported `STAGE_KEYS` (`app/stage.ts`) and the static `stages` array in
`pages/feature.page.json` — and only *seeds* the new mapping from `STAGE_KEYS`; it does **not** yet
generate or retire either, so both remain until a follow-up derives the static `stages` array from the
canonical mapping (a parity test, then retirement of the duplicate) — flagged here as the residual
drift-surface the one-stepper decision does not close in v1. (The canonical stage *derivation* itself
already has a single author — `app/featureReadModel.ts`, from which both the SQLite VIEW and the
`deriveStage` TS oracle are generated; its `caseWhen` emits the `Requested`…`Done` literals directly and
does **not** import `STAGE_KEYS`. So `STAGE_KEYS` is not the derivation's source but *itself* one of the
two vocabulary duplicates whose literals must be reconciled against — and ultimately derived from — the
canonical `featureReadModel` declaration; `featureReadModel` is that canonical author, not a third
divergent one.)

**The current step is derived by per-shape correlation (not a single `process_key` join).**
The projection must answer "which cell has this unit reached," fusing two truth sources:

- **Engine truth — the furthest element reached — IS available on the runtime.** nwf runs against
  **Nano's Rust engine over its REST API** (not the wasm testkit). That API exposes a full
  element-instance read model: `POST /v2/element-instances/search` (`searchElementInstances` →
  `elementId` + `elementType` + element **state**, keyed by process-instance) and the element-instance
  **wait-states** search (`searchElementInstanceWaitStates` → **job and message** parks, not only user
  tasks). With namespaced cell element ids (a convention §2/S4 must still define — the current compiler
  uses node-local ids), a reached element maps to a reached cell — the
  sharpest signal, and the only one that sees a token mid-cell (an active `implement` job) that no
  work-table row has caught up to yet.
- **Work-table + aggregate truth — the correlated downstream state, per shape.** For a **feature**, the
  `feature_runs` row (`status` / `pr_key` / flags) gives the coarse `Requested` / `Implementing` / `Done`
  bracket; for an **epic** there is **no aggregate `pr_key`** — its status is `plans.status` / the plan
  rollups and its slice-PR identity is `plan_tasks.pr_key` (`app/retro.ts`, `app/delivery.ts`). On top of
  that bracket, `pull_requests` (and siblings) carry the `converging` / `waiting_review` /
  `merging` sub-state — but this is a **coarse status handoff, not a preserved sub-state**:
  `pollFeatureDelivery` maps the feature's **own `pr_key`** PR status into `feature_runs` (keeping the
  detailed value only in `delivery_label`), and `deriveStage` reads neither `delivery_label` nor those
  sub-states — an opened `pr_key` renders `PR open` and a `converging` run renders `Converging`, i.e. it
  exposes only the coarse lifecycle key (never `Merging` as the active stage). (`pollFeatureDelivery` does
  **not** consume the lineage/plan projections — those are separate aggregate rollups for the epic path,
  not the feature derivation; `instanceTracking` supplies only the tracking-status edges, not the PR
  rollup.) So S7 must describe this as a coarse handoff and, for an epic, treat the lineage/plan rollups
  as their own shape-specific path. The projection must
  name an explicit **precedence** between engine truth and this state (engine element position when
  available, else aggregate/work-table), not silently pick one.

**Correlation is per-shape, because `process_key` is reassigned.** A feature/epic aggregate's
`process_key` identifies its *own* (feature / plan-fanout) process instance, but
`pull_requests.process_key` is **overwritten** — first to the downstream convergence instance, then
again to the merge instance (`app/service.ts` — `submitPr` writes the convergence-instance key,
`startMerge` the merge-instance key). The stable
aggregate↔PR link is **`pr_key`**, and epics additionally need node/root mapping (lineage
`rootRequestKey`, nwf#245). So §4b must define the per-shape joins — or persist a **canonical unit
key** — rather than assume a single `process_key` join; a naïve `process_key` join would misattribute
or miss work-table state. This canonical-key requirement is itself an argument for the §1 aggregate.

**The aggregate step is a frontier — reduced to one deterministic step for the renderer.** For the
1-node feature there is one active step. For an N-node/parallel DAG (epic waves, delivery graphs), two
branches can occupy incomparable cells at once, and no total order picks a unique maximum. But the
`pipeline` renderer binds a **single scalar** `activeField` (`pages/feature.page.json`), so S7 **must**
reduce that frontier deterministically to one step — the canonical choice is the **least-advanced active
branch** (the "still blocked on" read), so the aggregate never renders further along than its slowest
in-flight branch. This reduction is an explicit S7 decision, not left to the implementer; a set-valued /
multi-track render would be a separate renderer change, out of scope here. **v1 does not populate the
pipeline's `notInPathField` (the skipped-path axis) for the aggregate** — the reduction exposes only the
scalar `activeField` + terminal `state`, so no deterministic skipped-set rollup is defined and equivalent
graphs cannot diverge on a skipped path they never render; a per-branch skipped-set rollup onto
`notInPathField` is deferred with the set-valued renderer change (out of scope). The per-node steps are
individually well-defined **only in the conceptual / S8 element-instance model** underneath the
reduction; at S7's coarse fidelity an active agent/wait/connector node exposes only `Running` with **no
node id** (`deriveDeliveryPhase`), so S7 assigns it **no individual cell step** and renders a single
coarse run-level step — the per-cell reduction becomes observable only once S8 binds the element-instance
topology. Because the canonical unit union carries more
terminal states than `done`/`failed` (a branch can end `merged` / `converged` / `skipped` / `blocked` /
`abandoned`), the rule first **normalizes** each terminal branch — reusing the **shipped
`featureReadModel` `stage_state` tiers** (`app/featureReadModel.ts`: `STAGE_DONE_STATUSES` + the
`stage_state` CASE) verbatim rather than inventing a second mapping, per derivation-over-duplication:
the already-canonical `done` stays `done`, and `merged` / `converged` likewise collapse to that same
**successful** terminal (`done`); `failed` / `skipped` /
`abandoned` collapse to a **failed** terminal; and `blocked` stays the renderer's **distinct `blocked`**
state — *not* folded into `done` or `failed`, preserving the existing per-node semantics (`skipped` is a
failed-tier terminal there, not a success; `blocked` is its own terminal). These canonical tiers are
**not** fed to the renderer as-is: the `pipeline` column's `state` field accepts only `ok` / `failed` /
`blocked` / `null` (`app/stage.ts` `StageState`), so when rendered the **successful** terminal (`done`)
must map to `activeField = Done` with `state = ok`, the **failed** tier to `state = failed`, and
`blocked` to the distinct `blocked` state — the raw canonical `done` never reaches the renderer's
`stateField` (any other string silently degrades to in-progress, so a converged terminal must not be fed
`done` verbatim). For the frontier precedence
below, `done` is the only **successful** terminal, while both `failed` and `blocked` are **non-success,
operator-actionable** terminals — so the combinations below are defined over `done` (success) vs. a
non-success terminal (`failed`/`blocked`). This `done` is the **derived per-cell/delivery success
terminal**, **not** the raw `plans.status = 'done'` fan-out handoff — per `app/delivery.ts:39-42` that
plan status only means "the fan-out finished and ≥1 slice opened a PR, dispatched to convergence" (other
slices may still be blocked/skipped), so feeding it verbatim would render an epic `Done` prematurely; the
epic's actual success signal is `delivery = landed` (all slice PRs merged), which is what maps to this
success bucket. The rule must then define the **terminal combinations** the least-advanced-*active*
read leaves unspecified, so parallel epics/graphs render deterministically: (a) **mixed** — one or more
branches terminal alongside ≥1 active branch — reduces to the least-advanced *active* branch (terminal
branches are past, not "still blocked on"), **except** that a **non-success** terminal (`failed` or
`blocked`) takes **precedence** and renders the aggregate at that branch's step with that terminal's
render state (`state = failed` for a failed branch, the distinct `blocked` state for a blocked one — an
operator-actionable signal, not something an in-flight sibling should mask); when **multiple** branches
are in a non-success terminal the tie-break is **earliest terminal step, then stable node id**, so the
exposed step (and its `failed`/`blocked` state) is deterministic; (b) **all-terminal** — reduces to the
**earliest non-success terminal** step (`failed`/`blocked`, same tie-break) if any branch is non-success,
else `done`.

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

**v1 ships on what's correlated today, at lifecycle-stage fidelity; the element-instance query sharpens
it to per-cell.** Until the binding surfaces the element model, §4b's projection is derivable *now* only
from aggregate/work-table state, **process-instance lifecycle state** (`searchProcessInstances` —
`COMPLETED`/`TERMINATED`, which `deriveDeliveryPhase` folds to `done`/`failed`), and user-task parks —
and that is **lifecycle-stage, not per-cell, even
for feature**: `deriveStage` collapses a token parked in a readiness-probe service/timer loop, or an
active `implement-task`, all to `Implementing` while `feature_runs.status` stays `running` and no user
task is open. It is coarser still for the other two, for reasons that must be stated *separately*:

- **Delivery graph:** `deriveDeliveryPhase` (`app/deliveryGraphRun.ts`) returns a generic `Running`
  with **no node id** for an active `agent` / `wait` / `connector` node when no human task is open, and
  `delivery_graph_runs` stores no current node.
- **Epic:** `record-plan` is classified **Reviewing** (`app/epicPhase.ts`), not Planning, so the
  *initial* Planning phase carries only the `plans` row — `plan_tasks` rows first become available once
  **Reviewing** starts, where `record-plan` *does* write them, so from Reviewing on it is not literally
  row-less — but **no field exposes the current
  pre-PR process position** (which plan/review activity is live): there is no PR row, and while the
  `plan-review-decision` user-task park *is* a real open user-task signal for the Reviewing decision
  point, no field surfaces the **complete activity position** (which plan/review step is live) — the
  initial Planning phase and the running plan/review work between decision parks remain unobservable.
  Only the write-time `epic_phase` stamp (`app/epicPhase.ts`) and the plan/PR rollups
  observe *where* it is. `deriveDeliveryPhase` is the delivery-graph projection only and provides no
  evidence for epic resolution.

So v1's scope is deliberately bounded: the one derivation + `pipeline` renderer covers **feature and
delivery-graph at lifecycle-stage fidelity**, rendering any unobservable node as an **explicitly coarse**
in-flight step. Because `activeField` must resolve to a *configured* pipeline stage (`STAGE_KEYS` runs
`Requested`…`Done`, with no `In flight` key), S7's canonical behaviour for that coarse case is **fixed
here, not left to the implementer**: **derive a configured key statelessly from the current coarse
inputs on every pass** — map the run's `status`/`phase` to the corresponding `STAGE_KEYS` key (e.g. a
`running` feature *with no PR key* to `Implementing`, marked in-progress — preserving `deriveStage`'s
input precedence, where the `pr_key`/`opened` arm runs **before** the `running` arm, so a `running`
feature whose `pr_key` is set already derives `PR open`, not `Implementing`; `app/stage.ts`,
`app/featureReadModel.ts:77-85`) rather than remembering a prior key the read
model does not persist, so the projection survives a restart, no new stage is invented, and no
renderer/axis change is needed. (This stateless per-pass derivation is the **resolved** S7 policy and
**supersedes** any earlier "hold the aggregate at its last observed configured stage" phrasing — the read
model persists no such key, so there is nothing to hold; a coarse run is recomputed from current inputs
every pass.) Adding a dedicated `In flight` key to the canonical axis is
**explicitly rejected** for v1 — it would fork the stage vocabulary across surfaces; the S7 rollout
below binds this same **stateless coarse-key** rule, so independent S7 implementations cannot diverge on
the stage axis or `activeField`. For
a **first observation with no prior key** (a freshly `running` `delivery_graph_runs` row carries only
`phase = "Running"`, no stored lifecycle key to hold), S7 must pin a deterministic **initial**
`STAGE_KEYS` value from a **status-specific** map — a `running` graph, whose dispatch has begun, maps to
`Implementing` (not the `Requested` head), while the pre-dispatch case below maps to the pre-run initial
key (literally **`Requested`**, `STAGE_KEYS[0]`) — so the scalar `activeField` is never undefined. The same rule must cover the **`awaiting-approval`** rows
`delivery-graphs.page.json` filters into the active grid: migration 058 gives these a `phase =
"Awaiting approval"` and a **NULL `process_key`** (no engine instance yet), so they have no observable
element and no prior lifecycle key — S7 must map them to that same deterministic **initial** pre-run
`STAGE_KEYS` value, literally **`Requested`** (they are dispatch-pending, before `Implementing`), not leave their `activeField`
undefined. It
must never fabricate a specific cell position it cannot observe. The **epic pipeline is deferred to S8**:
because its pre-PR position is unobservable from S7 inputs, epic keeps its `epic_phase` **text cell** as
an explicit, retained **second source** (write-provenance) until the element query lands — rather than
fabricating a derived step or promoting `epic_phase` to a permanent stepper source. When the binding
lands the element query (S8), the projection swaps its park/position source for the live engine element
instance — sharpening feature + delivery-graph to per-cell and bringing epic onto the same `pipeline` —
**preserving the step axis and renderer, and using whatever parent/child correlation strategy S4
selects** — retiring *both* the `epic_phase` write-time stamp and the user-task-only delivery-graph poll
into one derivation.

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
  the process slices are sequenced behind the (now-live) engine-wasm unlock. No **process/data-semantic**
  behaviour change is intended — this is a representation consolidation, guarded by parity tests against
  the existing VIEWs and by the deploy+run engine tests. (The rendered cell *does* change for operators —
  S7 turns the delivery-graph `phase` text cell into a `pipeline`, and S8 the epic phase cell; that
  operator-visible presentation change is intended, per the S7/S8 rollout below.)
- **One stepper kills the second-order drift.** The unit's *progress projection* — the thing an
  operator reads as "where is this in its lifecycle" — is triplicated the same way the aggregate is
  (feature's `deriveStage`, epic's write-time `epic_phase`, delivery-graph's `pollDeliveryGraphPhase`),
  and only feature renders an actual stepper; epic and delivery-graph render a bare string. §4b collapses
  the three onto one derivation over the cell axis (with an explicit cell→step mapping and per-shape
  correlation — `pr_key`/canonical unit key, since `pull_requests.process_key` is reassigned downstream),
  rendered by one `pipeline` kind. **S7** unifies **feature + delivery-graph** at **lifecycle-stage
  fidelity** with **no engine change** (even feature is not per-cell today — `deriveStage` collapses
  readiness/timer/implement to `Implementing`); the **epic pipeline is deferred to S8**, keeping its
  `epic_phase` text cell meanwhile. The *only* upstream **binding** dependency — surfacing the element-instance query
  on the `@nanobpm/urban` `EngineClient` binding (S8, nano-ide#473), which the engine already serves —
  then sharpens all three to per-cell and retires epic's write-provenance stamp. (This is the only
  *binding/platform* dependency, **not** the sole upstream dependency: S8 additionally depends on S4's
  inline-vs-child/correlation decision (#464) — #473 is necessary, not sufficient; see the S8 rollout.)

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
  **per shape**: for a **feature**, `feature_runs` `status`/`pr_key`/flags + the
  `pollFeatureDelivery`-reconciled `pull_requests` state, joined by **`pr_key`** (*not* a naïve
  `process_key` join, which is reassigned downstream); for a **delivery graph** — which has **no
  `pr_key`** — its `delivery_graph_runs` row, its downstream PRs correlated through the run's **lineage
  root mapping** (`app/lineage.ts` `collectRootPrs` over `pull_requests.root_request_key`), and engine
  parks by the run's own `process_key`. Note the root mapping is **not** a single clean
  `root_request_key = run_key` join for every PR, and the per-node correlation **differs by node kind**,
  so S7 must **define/persist a run-level root rollup** (or document the per-node correlation and how it
  aggregates to the run) rather than assume one join: a **connector** PR roots by the connector's
  *effective* `dedupeKey` — the author-supplied `connector.dedupeKey`, else the graph-derived
  `<processInstanceKey>:<elementId>` (`app/deliveryConnector.ts` `connectorDedupeKey`) — threaded into
  `submitPr` as its `rootRequestKey`; whereas an **agent** PR has **no `dedupeKey` at all** (the runner
  seeds only `jobType`/`appendPrompt`/`timeout` for an `agent` node, `app/deliveryGraphCompiler.ts`
  `ioMappingLines`, never a dedupe/root key), so it **self-roots on its own `pr_key`** (`submitPr`'s
  `effectiveRoot = rootRequestKey ?? existing.root_request_key ?? pr_key`) unless the run explicitly
  threads a root. The run-level rollup S7 defines must therefore attribute the **agent** case explicitly —
  it cannot lean on the connector's `dedupeKey` fallback, which agent nodes never carry. Engine parks correlate via `searchUserTasks({ processInstanceKey: run.process_key })`, which is
  correct **for today's inlined graphs** (the compiler inlines subProcesses into one flat instance); once
  S4's `callActivity` composition puts a human cell in a **child** instance, this parent-key query would
  miss it, so that step is bound to the S4 inline-vs-child decision (correlate child instances, or keep
  the graph inlined) — it is not a silent promise. Reduce any parallel frontier to the
  **least-advanced active branch** and **promote the `pipeline` stepper
  kind** (feature-only today) onto the delivery-graph surface — **both** the list page and the detail
  page (`pages/delivery-graph-detail.page.json:95`, which today renders `delivery_graph_runs.phase` as a
  plain-text Phase column), so S7 does not leave the detail view on a second renderer while §4b claims the
  surface uses the shared stepper. Because `delivery_graph_runs` stores **no
  stage column** (only `phase`/park metadata, whose values such as `Running` are *not* `STAGE_KEYS`), S7
  supplies the pipeline's `activeField`/`state` for the graph from a **read model/VIEW over
  `delivery_graph_runs`** that maps `phase`/park metadata onto the `STAGE_KEYS` axis (the stateless
  coarse-key rule) — it assumes no stored `activeField` column and defines the mapping columns explicitly,
  so the page renders a valid configured step rather than a raw `phase` string.
  This needs **no** engine-binding change, but ships at **lifecycle-stage fidelity only — for feature
  *and* delivery-graph alike**: even feature is not truly per-cell today (`deriveStage` collapses a
  readiness-probe/timer park or an active `implement-task` all to `Implementing`), and for a
  delivery-graph node running with no open user task (`deriveDeliveryPhase` returns generic `Running`, no
  node id) the stepper renders the configured coarse key derived statelessly from run `status`/`phase` (a *configured* stage — never a
  fabricated cell position or an unconfigured `activeField` label; see the coarse-case rule in §4b). **The
  least-advanced-*active* frontier reduction (§4b) is therefore *defined* at S7 but not yet *computable*
  from this source:** `delivery_graph_runs` stores a **single** `phase`/`phase_node_id` per run, not a
  per-branch topology, so a VIEW over it cannot compare branch advancement — at S7 the graph collapses to
  that one coarse run-level step, and the genuine per-branch frontier reduction is deferred to S8's
  element-instance/topology read model (a single-track feature is unaffected). The **epic pipeline is out of S7 scope**: epic's pre-PR position is unobservable from these
  inputs, so epic keeps its write-provenance `epic_phase` **text cell** as an explicit retained second
  source until S8 (below). The mapping can begin as soon as S4 names the cells; the `pipeline` render
  binding for feature + delivery-graph can start immediately.
- **S8 · surface the element-instance query → retire the epic write-stamp** (Decision §4b) — the
  slice that depends on an upstream binding change, tracked as **`nanobpm/nano-ide#473`** — but
  #473 is **necessary, not sufficient**: it surfaces the element read model keyed by a *process-instance
  key*, while the current process-instance read model has been observed returning **null parent/root
  keys** (#464), so under S4's default `callActivity` child instances #473 alone cannot traverse from a
  run to its child cells' elements. S8 therefore also depends on S4's inline-vs-child decision (inline
  the graph so one flat instance suffices, **or** resolve the child/root correlation, tracked with #464)
  — #473 is not the sole upstream dependency. Nano's
  Rust engine already serves the element-instance read model (`POST /v2/element-instances/search`
  `searchElementInstances` + element-instance **wait-states** — active elements and **job/message**
  parks, not only user tasks), but the `@nanobpm/urban` `EngineClient` binding nwf consumes surfaces only
  `searchProcessInstances` + `searchUserTasks`. Surface `searchElementInstances` / wait-states on the
  binding (upstream in nano-ide / urban, **nano-ide#473**), then swap the S7 projection's park/position
  source for the live engine element instance — **preserving the step axis and the renderer, and using
  whatever parent/child correlation strategy S4 selects**: if S4 chooses cross-instance correlation
  (default `callActivity` child instances), S8 must also extend the element lookup to resolve the
  child/root instance keys, so the "no change to the correlation key" is scoped to the axis and renderer,
  not to a fixed single-instance join. This is
  what lets epic's **Planning** phase and the **non-parked** part of **Reviewing** — which run inside
  `plan-fanout.bpmn` before any PR exists — Planning has no `plan_tasks` work-table row (its `plans`
  aggregate row *does* exist, carrying `status`/`process_key`, so the gap is a missing per-activity field,
  not a missing row), and while pre-PR Reviewing
  *does* carry `plan_tasks` rows (`record-plan` writes them), **no field exposes the currently executing
  plan/review activity** (Reviewing *is* partly visible via the real `plan-review-decision` user task,
  but Planning and the running review work are not), today
  knowable only from write-provenance — become a pure read-model derivation, bringing epic onto the same
  `pipeline`, retiring the `epic_phase` write-time stamp (`app/epicPhase.ts`, nano-ide#266 — **including
  its genesis write in `startPlan`, `app/plan.ts`**, which stamps `epic_phase` for fresh/replanned
  epics, so the retirement must move or drop that write too or those epics still depend on the retired
  source) and folding
  the user-task-only `pollDeliveryGraphPhase` into one live projection. **Ownerships this retirement
  must carry forward, not silently drop:** (a) `app/lineage.ts` consumes `plans.epic_phase` to project
  `epicPhaseLabel` and writes `pull_requests.epic_phase_label`, shown on the home/convergence surfaces —
  so S8's replacement contract must supply that label from the derived pipeline (a derived
  compatibility field) or update the lineage projection, or it either breaks the display or leaves a
  second phase source; and (b) `pollDeliveryGraphPhase` is not only a park projection — it also owns the
  `COMPLETED → done` / `TERMINATED → failed` terminal reconciliation for graphs (`app/service.ts`,
  since a delivery graph has no spine worker to write its own terminal row), so S8 must **retain or move**
  that reconciliation into the live projection, or completed graphs stay wedged in the active `running`
  set; and (c) `app/lineage.ts` also reads `delivery_graph_runs.phase` to form `LineageThread.stageLabel`
  and persists `lineage_threads.stage_label` (shown on delivery-lineage / home rows), so S8 must supply
  that phase narrative from the derived projection or update the lineage read too, else those rows lose
  their phase label; and (d) **three** **page bindings** read `plans.epic_phase` **directly** — the epic
  index grid (`pages/epic.page.json:119`), the epic-detail page (`pages/epic-detail.page.json:99,146`),
  and the nested Epic grid on the Home page (`pages/home.page.json:284`) — so
  retiring the column without repointing these page/schema bindings to the pipeline/read-model field
  renders a missing field on the epic index, epic-detail, and Home pages; S8's checklist must replace them too.

## Non-goals / deferred

- **Unifying the static-vs-adaptive execution axis** (see Decision §5) — preserved deliberately.
- **Changing the downstream PR/convergence loop** — already single-sourced (`pull_requests`); untouched.
- **Cross-repo/platform representation** — this ADR is nano-workforce-local; any platform-wide delivery
  aggregate would be a separate nano-bpm ADR.
