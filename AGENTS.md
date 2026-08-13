# AGENTS.md

Operational guide for AI coding agents working in this repository. Read this
before making any change. `SPEC.md` is the behavioural source of truth for the
processes; `README.md` covers setup, roles, and running.

## What this repo is

`nano-workforce` is an [Urban](https://github.com/jwulf/nano-ide) app (ADR 0055)
— **Agent Graph Orchestration for Agentic SDLC**. It drives GitHub PRs to
**review convergence** and then **merge**, and can take a whole issue and fan a
fleet of agents out to implement it. It is a set of
durable BPMN processes (`resources/processes/*.bpmn`) plus host glue
(`app/`, `workers/`, `actions/`, `main.ts`) over the Urban runtime seams
(`DataLayer`, `EngineClient`). The processes are executed by the **nanobpmn
engine** (`~/workspace/nanobpmn` `engine-core`, embedded in the nano broker the
app deploys to via the nano SDK).

## Universal engineering principles

### No such thing as "flaky tests"
Intermittently failing tests must always be root-caused and fixed as either a
product defect (code) or a production-line defect (test). We do not acknowledge
the existence of "flaky tests".

### No test retries
A test must pass or fail deterministically on a single run — no test-runner
`retry`, no CI re-run-on-failure to coax a green. A test that only passes on a
later attempt is non-deterministic: root-cause and fix it, never paper over it.

### Red/Green discipline
Every bug fix must have a test that reproduces the defect **before** modifying
code. Red first, then green — always.

### Fix the failure mode, don't just squash the bug
When you find a defect, reason about its whole class and write a guard for the
class. Prefer securing the surface — including an architectural refactor that
eliminates the failure mode categorically — over squashing a single instance.
(Example: a durable wait that can hang forever is a *class* of bug — fix it by
modelling a bounded race in the process, not by special-casing one PR.)

### Feature test coverage
New features must carry test coverage over the new surface so regressions are
caught.

### Derivation over duplication: no drift surfaces
Eliminate duplicate sources of truth. Everything derivable must be derived from
one canonical source with one canonical implementation. Do not add a parallel
implementation of an existing stage (a second poller pass, a second escalation
path, a second review loop) — extend the canonical one.

### Zero tolerance for warnings, errors, and test failures
There are no pre-existing failures or warnings, and you will not allow any to
enter the codebase. `tsc`, `urban check`, `biome check`, and `node --test` must all
be clean.

### No task without a tracked issue or PR
Before starting planned work, check for an existing issue or PR. If one is
already in progress, stop and flag it with a link. Otherwise create and claim an
issue before writing code.

## BPMN: author the semantic model, generate the diagram

**The `.bpmn` files under `resources/processes/` are hand-authored semantic
models. The diagram interchange (`bpmndi:BPMNDiagram` — shapes and edges) is
GENERATED, never hand-edited.**

- Edit the BPMN semantics (elements, sequence flows, gateways, ioMappings,
  `zeebe:taskHeaders`) by hand in the XML.
- Regenerate the DI with `npm run layout <path/to/file.bpmn>`
  (`scripts/layout-bpmn.ts` → `@nanobpm/urban`'s `layoutBpmn`, which wraps
  `bpmn-auto-layout`). Re-run it **whenever the flow changes** (new node, new
  flow). Header/ioMapping-only edits don't change shapes and don't need a relayout.
- Never hand-edit `<bpmndi:…>` — the semantic model is authoritative; a
  hand-tweaked diagram will be clobbered on the next layout and drifts from the
  model in the meantime.
- **CI enforces DI freshness.** `npm run layout:check` (`scripts/layout-bpmn.ts
  --check`) regenerates every diagram in memory and fails if a committed one is
  stale. It runs in `.github/workflows/ci.yml`, so a flow change that forgets the
  relayout **cannot merge**. Run `npm run layout` and commit the result whenever
  the check flags a model.
- **`cancelActivity="true"` is the BPMN default and `bpmn-auto-layout`
  canonicalises it away.** Don't hand-add it back to an interrupting boundary
  event — the serializer strips it, so a hand-written `cancelActivity="true"`
  makes `layout:check` drift on the next relayout. Interrupting is the default;
  only `cancelActivity="false"` (non-interrupting) is emitted.
- **One task owns each `.bpmn` file — never fan two parallel tasks onto the same
  process diagram.** `layoutBpmn` regenerates the *entire* `<bpmndi:BPMNDiagram>`
  block, so two independently relaid-out copies of one process diverge across
  every shape and edge. Each PR is green alone, but the second to land collides
  in the DI and — even after a text-merge — leaves the committed diagram stale
  vs. the merged semantic model, so `layout:check` fails on a combined state that
  no single PR's CI ever exercised. When decomposing a fleet, coarsen the tasks
  that touch a shared process file into one; do **not** paper the collision over
  with a `dependsOn` edge added purely to serialise otherwise-parallel work.

## Engine capabilities (Zeebe parity — use them, don't work around them)

The nanobpmn engine (`~/workspace/nanobpmn` `engine-core`, deployed via the nano
broker) already implements, with **Zeebe-parity semantics** and passing tests:

- **Event-based gateways** — the deferred-choice race (e.g. wait for a message
  **or** a timer), with correct sibling-withdrawal when one arm wins
  (engine PR #369).
- **Boundary events** — timer, message, error, and signal, each **interrupting
  and non-interrupting**, attachable to activities.
- **FEEL-expression timer durations** — `<bpmn:timeDuration>=someVar</…>` is
  evaluated at timer creation, so a timeout can be driven by a process variable
  (not just a static `PT15M`).

Model liveness properly in the process. To bound a durable wait, author an
**event-based gateway** racing the awaited message against a timer catch (or a
boundary event on an activity) — do **not** invent a poller-side timeout/sentinel
to force a token off a wait. The engine owns token semantics; the poller only
reconciles external (GitHub) state.

**Caveat — code-first authoring:** the `@nanobpm/workflow` `defineFlow` builder
cannot yet express event-based gateways or boundary events (its `FlowNode` union
has no such node). This app authors BPMN as XML, so author those constructs in
the XML directly; `layoutBpmn` lays them out correctly.

## Testing flows against the testkit (WASM) engine

Unit tests boot the app against an in-process WASM build of the engine. Two
non-obvious behaviours bite user-task / escalation tests — budget for them
instead of rediscovering them:

- **A COMPLETED instance's variables are folded away.** `snapshot()` reports
  `instance.variables = {}` once an instance completes, and a completed
  `userTask` carries no vars — so you cannot assert a typed completion variable
  from a finished instance. Either read variables while the instance is still
  ACTIVE (parked on the next wait), or route the resume through a FEEL gateway
  condition and assert `app.snapshot().takenSequenceFlows`. `takenSequenceFlows`
  is engine-**global** and cumulative, so assert it with a single instance per
  booted app.
- **A `zeebe:input source="=null"` seed shadows a job-completion value at an
  immediately-following gateway inside a multi-instance subProcess.** The gate
  reads the stale `null` and takes its default. Don't seed a var that an
  in-subprocess gateway reads; instead hoist it into the MI-child scope with a
  `zeebe:output source="=var" target="var"` mapping on the service task (a no-op
  on the production nano engine, which updates the nearest scope, but it keeps
  per-child isolation in the testkit). Only vars read by an in-subprocess gateway
  need this — output-only vars (e.g. `summary`, `pr`) are fine.

## Data envelopes are scalar-only

`nano:dataEnvelope` shapes support only **scalar** `nano:extend` types
(`string`, `integer`, `datetime`, `boolean`) — **not arrays**. When a message
must carry a list (e.g. failing check names), join it to a scalar (e.g.
`\n`-separated) in the publisher before it crosses the envelope, and split it on
the far side if needed.

## The poller owns liveness/reconciliation

`main.ts` runs a **self-scheduling** poll loop (`pollOnce` in `app/service.ts`),
not `setInterval`, so a slow GitHub call can't overlap passes. Each pass advances
the review stage, the merge stage, job-activation visibility, and wave gates by
reading GitHub and correlating engine messages. Any new external-state watch
belongs here as another idempotent pass. A pass must always make forward
progress possible — never leave a PR on a status no pass scans (it wedges), and
never rely on an external actor (e.g. Copilot re-reviewing) that the app doesn't
itself trigger.

## Database migrations (SQLite, forward-only, expand-and-contract)

Migrations live in `db/migrations/*.sql` and are **auto-applied on boot** from
`nano.app.json` (`data.sources.app.migrations`). They are forward-only.

- **Default to additive (expand):** nullable/`DEFAULT`ed `ADD COLUMN`, new
  tables/indexes. Never drop or rename a column/table in the same change that
  stops using it.
- **Destructive drops are a separate, later contract phase**, shipped only after
  a release stopped reading the old shape.
- Number a new migration after the current highest prefix (they apply in order).

## Runtime & CI gates

Node-hosted (`node --experimental-strip-types`); Node is the only runtime. Tests run
on Node's built-in runner (`node:test`), which strips TypeScript types on the fly.
Match CI locally before pushing:

```bash
npm run lint                                          # biome check (incl. ban-`as` gate)
npm run typecheck                                     # tsc --noEmit (Node)
npm run check                                         # urban check (manifest validation)
npm run layout:check                                  # BPMN diagram freshness (no drift)
npm run check:prompts                                 # agent-prompt template resolution
npm test                                              # unit tests (node --test)
```

CI (`.github/workflows/ci.yml`) gates lint, typecheck, `urban check`, `layout:check`,
the prompt check, and the Node test suite. Run `npm run layout <file.bpmn>` after
any BPMN flow change and commit the regenerated diagram — the `layout:check`
gate fails the build otherwise.

## Repo conventions

- **DCO sign-off is enforced.** Every commit needs a `Signed-off-by` trailer —
  use `git commit -s` (or `git rebase --signoff`). A missing sign-off fails the
  DCO check.
- **Conventional Commits.** `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`,
  `test:`, imperative mood. Review-comment fix-ups are `chore:`, not `fix:`.
- **Feature work in a worktree** off `origin/main`, one branch per change; open a
  PR and reference the closing issue (`Closes #NN`).
- **Never `git push --force` on `main`;** use `--force-with-lease` on feature
  branches.
