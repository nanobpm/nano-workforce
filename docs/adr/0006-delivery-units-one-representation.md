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
engine-wasm **#416** (engine-wasm 0.4.0 → 0.7.2, which executes `callActivity` — the *process-level*
unlock),
nano-workforce **#464** (the tracking issue with slices S1–S5),
nano-workforce **#305** (consolidate escalations on native `user_tasks` — a natural sub-step of S1/S3).

## Context

### One aggregate, encoded three times

nano-workforce models the same real-world thing — **one agent takes one unit of work and drives it to
one merged PR** — in three separate representations, each with its own table, status union, display
VIEW, `instanceTracking` binding, and dispatch door:

| Representation | Data | Process | Shape |
|---|---|---|---|
| **Feature** | `feature_runs` (mig. 028) | `resources/processes/feature.bpmn` | one issue → one PR (1-node) |
| **Epic** | `plans` + `plan_tasks` (mig. 004) | `resources/processes/plan-fanout.bpmn` | fan-out of slices → waves (N-node) |
| **Delivery graph** | `delivery_graph_runs` (mig. 058) + compiled nodes | compiled BPMN (`app/deliveryGraphCompiler.ts`) | arbitrary DAG |

All three are keyed by an issue/run key, carry their own status union, project a display read-model
VIEW, and dispatch `senior:*` jobs; all three compile to BPMN and funnel downstream to the *same*
`pull_requests` table (keyed by `pr_key`) — the convergence/merge loop, which they correctly do **not**
duplicate. So the *downstream* half of the aggregate is already factored to a single source of truth;
only the *upstream* "unit of work" half is triplicated.

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
display projection had to be a physically **denormalized table**, hand-maintained alongside its source
(migrations 022/029/051). That is what made a *shared* projection impossible: each representation grew
its own projection table. **Unlocked by nano-ide#424** (the datasource can now read a VIEW) → the
derived VIEWs in migrations 059–073, which cite #424 as the enabling change. **Live today.**

**Process — "the pinned WASM engine no-ops `callActivity`."** `app/deliveryGraphCompiler.ts:42`
records the constraint verbatim: `callActivity` is "a no-op on the pinned WASM engine (the child is
never instantiated)", so the compiler — and every hand-written process — **inlines** the subprocess
body instead of referencing it. The consequence is that the atomic *"agent-implement cell"*
(`implement-task (senior:*) → "escalated?" gateway → record-escalation → user-task → SLA boundary →
answer gateway`) is copy-pasted **four times**: `feature.bpmn`, the multi-instance `implement`
subprocess in `plan-fanout.bpmn`, and re-emitted per node by the compiler. Sibling cells
(readiness-poll, human-escalation) duplicate the same way. **No `callActivity` exists in any diagram**
because it did nothing. **Unlocked by #416** (engine-wasm 0.4.0 → **0.7.2**). engine-core executes
`callActivity` by inline-expanding the called process at deploy (`engine-core/src/model.rs:1217/1255`).
**Verified live:** a `callActivity` parent+child model deployed through engine-wasm 0.7.2 runs to
`COMPLETED`.

### The two constraints are the *same* constraint

Both are "an encoding can't *reference* a shared definition, so it *inlines a copy* of it." Data
inlined projection tables; process inlined subprocess bodies. Both share the same aggregate (the
delivery unit), the same fix shape (remove the can't-reference constraint, then reference instead of
copy), and both already have their downstream half factored correctly (`pull_requests`; the
convergence/merge loop). Removing one constraint without the other would leave the aggregate
half-consolidated; removing both is what makes a single representation reachable.

## Decision

Adopt a single internal aggregate — the **delivery unit** (*one agent → one unit of work → one PR*) —
with **two encodings** of it, each of which now *references* the shared definition rather than inlining
a copy:

### 1. Data encoding — one `delivery_unit` aggregate

- A `delivery_units` table is the single source of truth for "a unit of work." Feature = a 1-node
  unit; Epic = an N-node waved unit; DeliveryGraph = an arbitrary-DAG unit — a **shape**, not a
  separate table.
- `feature_runs` / `plan_tasks` / `delivery_graph_runs` become **derived VIEWs / rows** over
  `delivery_units` (using the nano-ide#424 VIEW capability), not independent tables.
- The three `instanceTracking` bindings and `senior:*` dispatch doors collapse toward one, keyed on
  the delivery unit.

### 2. Process encoding — shared cells composed by `callActivity`

- Extract the atomic *implement-cell* (and its sibling wait-gate and human-escalation cells) into
  standalone processes (`resources/processes/implement-cell.bpmn`, …).
- Compose them by reference: **feature** = one `callActivity`; **epic** = the multi-instance
  `implement` body is a `callActivity`; **delivery graph** = the compiler *emits* `callActivity`
  references, not inlined subprocess copies.
- This is gated on the engine-wasm 0.7.2 unlock, which is now live on `main`.

### 3. Status lifecycle — one derived union

The three bespoke status unions collapse into **one derived union** via ADR 0065's `defineReadModel`,
so a change to lifecycle semantics is made once and derived everywhere, not re-declared per
representation.

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
  deploy-valid and lay out, instead of four hand-maintained copies that can silently diverge (a graph
  can render and still fail deploy — the copies are exactly where that divergence hides).
- **Migration is incremental and reversible.** The VIEWs preserve every current read shape while the
  physical model consolidates underneath; each slice below is independently shippable and revertible.
- **Cost.** A backfill/migration for `delivery_units`; a one-time extraction of the shared cells; and
  the process slices are sequenced behind the (now-live) engine-wasm unlock. No behaviour change is
  intended — this is a representation consolidation, guarded by parity tests against the existing VIEWs
  and by the deploy+run engine tests.

## Rollout (see #464 for the live checklist)

Each slice is independently shippable; the process slices (S4/S5) are sequenced behind the engine-wasm
0.7.2 unlock, which has landed.

- **S0 · ADR** — this record.
- **S1 · status lifecycle** — one derived status union via ADR 0065 `defineReadModel`, replacing the
  three bespoke unions (subsumes #305's projection consolidation for escalations).
- **S2 · `delivery_units` table** — the aggregate; backfill `feature_runs` / `plan_tasks` /
  `delivery_graph_runs` as VIEWs/rows over it, guarded by read-model parity tests.
- **S3 · collapse doors** — unify the three `instanceTracking` bindings + `senior:*` dispatch doors.
- **S4 · `implement-cell.bpmn`** — extract the atomic cell; `feature.bpmn` + the `plan-fanout` MI body
  compose it via `callActivity`.
- **S5 · compiler emits calls** — `deliveryGraphCompiler` references shared cells instead of inlining
  per-node copies.

## Non-goals / deferred

- **Unifying the static-vs-adaptive execution axis** (see Decision §4) — preserved deliberately.
- **Changing the downstream PR/convergence loop** — already single-sourced (`pull_requests`); untouched.
- **Cross-repo/platform representation** — this ADR is nano-workforce-local; any platform-wide delivery
  aggregate would be a separate nano-bpm ADR.
