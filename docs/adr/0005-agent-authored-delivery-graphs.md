# ADR 0005 — Agent-authored delivery graphs (data-over-a-closed-vocabulary, human-in-the-loop)

Status: **Proposed.**
Date: 2026-08-20.

> **Scope note.** This is a **nano-workforce-local** ADR — it governs how *this app* runs
> heterogeneous cross-repo delivery work that mixes automated and human steps. Platform-wide ADRs live
> in `Magikcraft/nano-bpm/docs/adr` (referenced by number + repo, e.g. "nano-bpm ADR 0051").
> nano-workforce's own series continues here after ADR 0004.

Relates to:
nano-workforce **ADR 0001** (cross-repo epics + the generic `ReadinessProbe` wait-gate — this ADR
generalizes §4's deferred "release DAG" and its §2 gate into an arbitrary graph),
nano-workforce **ADR 0002** (escalations are user tasks + forms — the human-node machinery this ADR
promotes from *exception* to *scheduled node*),
nano-workforce **ADR 0003** (epic base-branch admission — the guardrail an `agent`/merge node inherits),
nano-workforce **ADR 0004** (shared-contract coordination — the discipline a cross-repo edge rides on),
nano-bpm **ADR 0026** (Urban human surfaces + `taskInbox` — where human nodes render),
nano-bpm **ADR 0046** (agent-as-worker vs agent-in-the-node — why an agent can answer a human node's
form, and why a node's *body* can itself be an agent),
nano-bpm **ADR 0051** (nano-workforce — the crew orchestrator whose `plan-fanout` interpreter is the
prior art this ADR widens),
nano-bpm **ADR 0056** (the Nano agentic protocol — the live-steering plane, complementary to this
durable lane),
nano-bpm **ADR 0059** (the app-hosted OpenAPI hook surface these graphs are submitted and signalled
through),
and issues **#263** (capability edges / publish provenance — the emit-vs-poll dual this ADR resolves),
**#289** (capability edge wired into dispatch — the `readiness-gate` call-activity pattern reused here),
**#242** (the pre-plan classifier — the *derive-by-default* front-end deferred here).

## Context

nano-workforce today runs exactly two shapes of work, each as a **static BPMN process interpreting a
data graph**: `convergence-loop.bpmn` (one PR) and `plan-fanout.bpmn` (an epic — a
`RecordPlanTask[] + dependsOn[]` DAG fanned out over multi-instance, with waves, trial-merges, and
escalations). Both are **specialised to one node shape**: "an agent implements a slice → opens a PR."

But real delivery in this ecosystem is a **heterogeneous, cross-repo, partly-human graph**. A concrete
case from one session:

1. PR **#A** must merge in repo 1.
2. *then* draft PR **#B** in repo 2 can be taken out of draft and merged.
3. *then* a **human** must do a **manual OTP publish** and **set up OIDC trusted publishing** — no
   automation can cross this step.
4. *then* PR **#C** in repo 3 can consume the just-published version.

This is a dependency graph whose **nodes are a mix of automated tasks, in-flight-PR/merge watches, and
human actions**, and whose **edges span repos**. nwf has every *primitive* this needs, but no way to
*compose* them into one arbitrary graph:

- **Automated execution** — agent job types + the supervisor/worker fleet.
- **"Watch the world"** — the `ReadinessProbe` gate (ADR 0001 §2): durable, bounded (timeout →
  escalate), resumable, with `http`/`command`/`npm`/`github-check`/`capability` kinds.
- **Cross-repo release edges** — capability edges + publish provenance (#263/#274), wired into dispatch
  as a `readiness-gate` call activity (#289).
- **Human decision points** — user tasks + forms (ADR 0002), answerable by a human **or** an agent,
  with SLA nudges.
- **Visible phase across a graph** — derived `epic_phase` (#261) + the cockpit/overview.

The gap is purely **composition**: a way to feed an *arbitrary* graph of these node kinds — including
human nodes as **scheduled stops that hand a value forward** — into one runner. ADR 0001 §4 sketched a
narrow "release DAG" and deferred it; the manual-publish-in-the-middle case is the general form that
finally justifies building it.

The obvious-but-wrong answer is "let an agent design a one-shot process definition per graph" — i.e.
generate BPMN (or process-builder code) with an LLM and deploy it. That fails on two axes at once:
**reliability** (an LLM emitting deployable BPMN/builder-code is authoring an artifact that must compile
and deploy before you learn it's wrong) and **trust** (agents deploying arbitrary executable process
definitions — or worse, arbitrary code — into your engine is an unbounded surface: any job type, any
service task, any script). Both objections point at the same fix: **the agent must never author the
executable artifact.**

## Decision

### 1. The contract is a validated JSON graph over a *closed* node vocabulary — never an agent-authored executable artifact

A delivery graph is submitted as **data**: a JSON DAG whose nodes each name a `kind` from a **fixed
allowlist** and whose edges name **facts** (below). This JSON — not BPMN, not builder-code — is the
durable, agent-facing contract, expressed as a **nano-app-schema** type and **published through the
agent guide** (`GET /app/api/agent`) so a co-designing agent reads exactly what it may build. Ingest
**validates** against the schema and rejects with **actionable** errors, closing the same
author→validate→fix loop the capability edges use.

This is decisive on both failing axes:

- **Reliability** — LLMs emit validated JSON reliably; deployable BPMN/builder-code they do not. The
  whole "co-design → submit" UX depends on the artifact being cheap to validate and safe to produce.
- **Trust** — a graph can only compose allowlisted `kind`s; it **cannot** express an arbitrary service
  task or run arbitrary code. Safe by construction, exactly as `plan-fanout`'s data model is today.

### 2. Node vocabulary — four kinds, each delegating to an engine-native body

The closed set (extensible only by a deliberate ADR/PR, never by graph authors):

- **`agent`** — a worker executes an agent job type (the existing fan-out body).
- **`wait`** — a `ReadinessProbe` (ADR 0001 §2), watching an external fact: `github-check`, `npm`,
  `capability` (#263), `http`, `command`, and a new **`pr`/merge-state** kind (draft→ready→merged,
  required checks, mergeable) lifted out of `mergeProtocol.ts` into a first-class probe kind.
- **`human`** — a scheduled user task + form (§4).
- **`connector`** — an automated, side-effecting outbound action (the connector I/O surface).

Crucially, **execution stays engine-native**: each node kind is a real, already-deployed
sub-process / call activity (`readiness-gate`, a user task, the implementation task, a connector
invocation). The graph layer owns **scheduling** (which nodes' edges are satisfied → dispatch), not a
re-implementation of execution.

### 3. Edges are *facts*, discovered — not declared values (extends ADR 0001 §4)

Every edge means *"B proceeds once fact X about A is observable."* The fact vocabulary is uniform —
*PR merged*, *check green*, *version on npm carrying capability C*, *human confirmed done*,
*connector action acknowledged* — and the satisfying state is **discovered**, never pre-declared
(ADR 0001 §4's discover-don't-declare, generalized from "capability published" to the whole graph). An
edge is therefore *always* a `wait`-shaped observation; a plain `dependsOn` between two internal nodes
is the degenerate "wait for the upstream node's completion fact."

### 4. Human nodes are first-class scheduled user tasks that can *emit* a typed fact

A `human` node is ADR 0002's user-task+form machinery promoted from **exception** (something broke) to
**scheduled node** (a planned stop). It surfaces *"now do X"* on the app's own **Tasks** page/inbox, blocks its
dependents, is **answerable by a human or an agent** (ADR 0046), and is **SLA-bounded** so it nags and
cannot silently wedge the graph.

- **It can hand a value forward.** A human node's form captures a **typed output** that **late-binds
  downstream** — e.g. the manual-publish node emits `resolvedArtifact` (`@nanobpm/urban@0.54.0`), which
  a downstream `capability`/`npm` edge binds and pins. A "click done" gate is the degenerate case that
  emits nothing. This is the **emit-side** of #263's emit-vs-poll dual — and a *human* emitter is the
  same shape as an automated one, which is what unifies human and automated steps in one graph.
- **Form resolution is specific-else-generic:** (1) an explicit `formKey` on the node; else (2) a form
  **selected** by node category; else (3) a **generic** fallback form that still captures a typed
  emitted fact (so *every* human node can emit downstream even with no bespoke form). Forms are
  preferably **attached at authoring time** (deterministic, visible in preview); a **runtime
  agent-form-router is a gated exception** — it fires only when a node activates with no resolvable
  form, never in every human node's critical path (same "deterministic default, agent judgment as the
  escape hatch" grain as the capability probe's empirical verifier).

### 5. A trusted, deterministic compiler turns the JSON into something the engine runs — exposed as an agent tool

The *only* thing that turns graph-data into an executable is a **deterministic, human-written, tested
compiler**. It is exposed to the co-designing agent as a **tool** — `validate/compile(JSON) →
{ ok, diagram, errors }` — which doubles as the **preview/dry-run**: the agent iterates JSON → tool →
fix, and the rendered graph is what a human approves before anything runs. Because the compiler only
ever instantiates allowlisted node kinds, it inherits Decision 1's trust bound.

### 6. Execution strategy is swappable behind the JSON contract; the axis is static-vs-dynamic topology

The compiler MAY target either execution strategy, and because the JSON is the contract, the choice is
an implementation detail the agent never sees:

- **Compile-to-native** — emit a **one-shot native BPMN definition** (native parallel/event gateways do
  the scheduling; you get a real diagram for free) and deploy it. **Best when the graph is known at
  authoring time.**
- **Interpret** — feed the JSON to one generic deployed process that evaluates the ready-set at
  runtime. **Best when the graph is discovered or mutated at runtime**, and the strategy that makes
  **mid-flight amendment** tractable (edit a variable, not migrate a deployed definition).

The discriminator is **author-time-static vs runtime-dynamic topology**. Delivery runbooks (the
motivating case — a *pre-known* release choreography) are static → **start with compile-to-native**.
`plan-fanout` stays **interpret** (its graph is agent-discovered and its waves adapt to results). The
shared JSON contract means either can be swapped in later without touching the agent UX.

### 7. Submission is propose → preview → approve → dispatch, idempotent, over the self-describing endpoint

Graphs are submitted exactly as epics are today — via a **new (proposed)** `POST
/actions/start/delivery-graph` endpoint (paths are relative to the agent guide's `__BASE__` prefix,
matching the guide's style) with the JSON body, discovered via the agent guide (which already
documents `POST /actions/start/plan-fanout` and `POST /actions/complete-user-task`). This endpoint
does not yet exist in `openapi.yaml` — it is introduced by this Proposed ADR. Three ways in, **one validated contract**: agent-ergonomic
(co-design → POST), raw REST, and a **UI JSON-paste fallback**. Because these graphs *merge PRs and
publish packages*, submission **defaults to propose-preview-approve** — the resolved graph (what it will
do, where it stops for humans) is rendered and a human approves before dispatch; that approval is itself
just the first human node. Submission carries an **idempotency key** so a re-POST cannot double-launch,
and every **side-effecting node (`connector`, merge, publish) carries a dedupe key** and tolerates
at-least-once execution (mirroring the release workflow's `npx semantic-release`
"skip already-published" discipline — `.github/workflows/release.yml`) so a
resume cannot double-fire.

## Consequences

- nwf gains a **generic delivery-graph runner** that composes its existing primitives; the motivating
  human-in-the-middle cross-repo case (merge → un-draft → manual publish+OIDC → consume) becomes a
  single submitted graph rather than hand-carried human coordination.
- **#263's deferred "publish node emits"** is subsumed: an emitting node (human *or* automated) that
  hands a version to a downstream edge is Decision 4 + Decision 3.
- The **connector I/O surface** finds its orchestration home: a connector is just an automated emitting
  node kind (Decision 2).
- New surface to own: the JSON graph schema, the deterministic compiler, and the `pr`/merge-state probe
  kind. All bounded — the schema is validated at ingest, the compiler is deterministic and tested, and
  every node inherits the ADR 0001 §2 timeout+escalation bound, so a malformed or hanging graph cannot
  stall silently.
- The **agent never deploys executable artifacts**; the trust boundary is the closed vocabulary + the
  human-written compiler, not agent output.
- Amendment is cheap **only** under the interpret strategy; compile-to-native graphs are amended by
  cancel + resubmit (an accepted cost for pre-known runbooks).

## Non-goals / deferred

- **Derive-by-default graph authoring.** Populating edges automatically from intake (the #242
  classifier facet, or PR-dependency inference) — this ADR ships the **declared** graph + the runner;
  derivation is sugar layered on later.
- **Runtime-dynamic delivery graphs.** The first cut is compile-to-native for **static** runbooks; the
  interpret strategy for graphs whose shape changes at runtime is kept behind the same contract but not
  built now.
- **Mid-flight amendment of a running graph** beyond cancel+resubmit.
- **A second workflow engine.** Scheduling composes the nano engine's native constructs (or a thin
  ready-set loop); execution is always engine-native sub-processes. Do not re-implement durability,
  timers, or receive-tasks.
- **Non-npm emit facts** (OCI/github-release) and behavioural edges beyond the `command` escape hatch —
  added when a real case lands.

## Open questions

- **Compiler target for the first cut** — confirm compile-to-native (diagram + native scheduling) vs a
  minimal interpreter reusing `plan-fanout` patterns; the ADR leans native for static runbooks.
- **`pr`/merge-state probe kind boundary** — how much of `mergeProtocol.ts` (required checks, mergeable,
  base guards) becomes probe-matcher config vs stays in the merge-loop node body.
- **Emitted-fact typing** — the schema for a node's typed output (version string, URL, artifact id) and
  how downstream edges reference it (`from: <nodeId>.<fact>`), so binds are validated not stringly.
- **Definition lifecycle under compile-to-native** — naming, versioning, and GC of one-shot deployed
  process definitions so the engine doesn't accumulate them.
- **Approval granularity** — one approval of the whole graph at submit, vs re-approval when a human node
  amends the un-started tail (if amendment is ever allowed).
