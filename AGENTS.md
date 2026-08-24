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

## Shared contracts: one registry, one typed env schema (issue #227, ADR 0004)

Parallel/sliced work keeps producing **two divergent representations of one contract** — an env-key
synonym (the canonical `NANO_WORKFORCE_BASE_URL` vs. retired names like `NANO_PR_PUBLIC_BASE_URL`/its
phantom `NANO_PR_BASE_URL` fallback, #226/#223), a wire-shape drift (nano-ide #234), two type names
for one shape — each authored against a mock, discovered only at runtime. Prevent it at authoring
time:

- **Consult the durable registry FIRST — `app/contracts.ts`.** Before introducing a new **env/config
  key**, **wire-frame shape**, **shared exported type**, or **capability-URL scheme**, check the
  registry. If a semantically-equivalent contract exists, **reuse it**; otherwise declare it there
  (owner + semantics per entry).
- **Env keys go through the ONE typed schema** (`ENV_CONTRACTS` + `readEnv`/`readEnvOr`). Every
  config-family key (`NANO_*`, `NANOBPMN_*`, `CAMUNDA_*`, `PR_REVIEW_*`) MUST be declared; a synonym or
  an undeclared key is a **CI failure** (`npm run check:contracts`). A **retired synonym** (e.g.
  `NANO_PR_BASE_URL`) reappearing in code is a hard failure — never reintroduce a phantom fallback.
- **Signal in-flight on the blackboard.** When introducing/consuming a cross-cutting contract, POST a
  `kind:"contract"` entry (`dedupe_key` as `<category>:<name>`, e.g. `env:NANO_X`) so siblings see it
  before they reinvent it. The write-time guard reports near-duplicate-declaration `contractConflicts`.
- **Reconcile.** `npm run reconcile:contracts` reads the whole blackboard + registry and reports
  synonyms / contradictions / mock-vs-real skew (advisory). `npm run check:contracts` is the hard,
  registry-only gate (also in CI).

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

## Deploy by convention: `resources/` (ADR 0062)

**Deployables live under `resources/` and deploy by convention — `nano.app.json`
declares no `models`.** urban walks `resources/` (shallow, one level deep) and deploys
every file: `resources/processes/*.bpmn`, `resources/forms/*.form`, and one prompt per
task under `resources/prompts/*.md`.

- **`resources/` is deploy-only.** Anything under it ships to the engine; anything
  **outside** it never does. Docs therefore live under `docs/` (e.g.
  `docs/agent-guide.md`) — put a `.md` in `resources/` only if you actually want it
  deployed.
- **No `models` block.** Rely on the convention; add a `models` override *only* for a
  genuinely non-standard layout (nwf doesn't need one). An explicit `models` is used
  verbatim and skips the convention walk.
- **Basenames must be unique across the deploy set** — the deploy dedupe key is the
  filename only, so two files sharing a basename in different dirs collide. `npm run
  check:prompts` fails loudly on that.
- **Agent prompts: linkedResource is the blessed *and only* path.** Each agent service
  task links its base prompt with
  `<zeebe:linkedResource resourceId="<token>.md" bindingType="latest" resourceType="GenericScript" linkName="prompt"/>`,
  which the engine resolves to the latest deployed `resources/prompts/<token>.md` at job
  activation, combined at runtime with the per-task `appendPrompt` FEEL. `bindingType="latest"`
  lets a prompt update land mid-epic without a process redeploy.
- **Deploy-time `{{token}}` templating is removed — no back-compat.** To inject a per-run
  value (URL, flag) into an agent, pass it as a runtime job variable / `appendPrompt`
  FEEL; never bake it into a model at deploy time.

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

## Data envelopes: message payloads are scalar-only; worker I/O shapes support arrays

Two different `nano:dataEnvelope` uses have different rules — don't conflate them:

- **Message payloads are scalar-only.** A `nano:dataEnvelope` that crosses the
  engine's message correlation supports only **scalar** `nano:extend` types
  (`string`, `integer`, `datetime`, `boolean`) — **not arrays**. When a message
  must carry a list (e.g. failing check names), join it to a scalar (e.g.
  `\n`-separated) in the publisher before it crosses the envelope, and split it on
  the far side if needed.
- **Worker job-I/O shapes support `list="true"` arrays.** A service task's
  `io.nanobpm.dataEnvelope.in`/`.out` shape is codegen/typing-only (no runtime
  filtering), so `nano:extend … list="true"` (scalar arrays, e.g. `dependsOn`)
  and `nano:reference … list="true"` (object arrays) are supported end-to-end and
  derive to `T[]` in the generated types (per #211 — e.g.
  `RecordPlanIn.tasks: RecordPlanTask[]`, `RecordWaveIn.waveResults`). Prefer
  deriving a worker's array inputs from the model this way over a hand-typed
  `interface In`; don't "fix" a modelled `list="true"` array back to a joined
  scalar.
- **A service-task/worker `dataEnvelope.in` field is read from PROCESS scope, not
  task-local `ioMapping`.** (This applies to service-task/worker job envelopes; a
  `dataEnvelope.in` on a **message subscription** — e.g. `CapsResolved` at
  `plan-fanout.bpmn:12` — is instead populated from the correlated **message
  payload**, so this gotcha does not apply there.) At runtime the engine populates
  each declared `.in` field *by name* from the process variables in scope — a
  `<zeebe:ioMapping>` input that synthesises a **new** name with no backing process
  variable is silently ignored, so the field arrives **blank**. The engine itself
  raises no incident for that *omitted* field (an `.in` name with no backing
  variable resolves to null and blanks) — but this is distinct from a FEEL
  `ioMapping` that **errors**: on the pinned engine (`@nanobpm/engine-wasm` 0.8.1's
  `IO_MAPPING_ERROR` fix — before it, a failed mapping silently blanked, e.g. a
  blocked converge-gate's escalation *question*; see the `e2e/*escalation*.e2e.ts`
  comments) a failed FEEL mapping now raises an **incident** rather than blanking
  through. A consumer that fails fast on the blank value will also incident (e.g.
  `pr.readiness-probe` once read an empty `gateKey`;
  `readGateVars` in `workers/readiness-probe/worker.ts` now *throws* on a blank
  `gateKey`, creating an incident). Tasks like `ensure-base-branch` work only because
  `repo`/`baseBranch` already exist as process variables. Seed any field a task must
  read — **that is not already created in the task's visible process scope** — as a
  real process variable at plan start (e.g. in `startPlan`); don't rely on
  `ioMapping` to synthesise it. (A field already materialised in scope by the
  process — e.g. `ReadinessProbeIn.probe`, seeded per multi-instance child via
  `inputElement="probe"` in `resources/processes/feature.bpmn` — needs no such
  seeding.) A **constant/literal** ioMapping source is different again: a
  `<zeebe:input source="=true" target="lastAttempt"/>` (the readiness-gate
  boundary's last-attempt marker — `readiness-gate.bpmn:125`, `feature.bpmn:105`,
  `plan-fanout.bpmn:198`, and the generated `deliveryGraphCompiler.ts:1011`) is
  *evaluated* and materialised into the job's scope, so it needs **no** backing
  process variable — its value is the literal, not a reference to an (absent)
  variable. The "arrives blank" failure above is specific to a field whose value
  must be *derived from a process variable that isn't in scope* (the `gateKey`
  case). Do **not** "fix" a working literal marker like `lastAttempt` by seeding
  it as a process variable: besides being unnecessary, seeding a var an
  in-subprocess gateway reads re-introduces the multi-instance `=null`-shadow
  gotcha above.

## Urban page runtime: rendering primitives are not JS-truthy

The `@nanobpm/urban` page runtime (`pages.ts`, ~0.46) renders `pages/*.page.json`
with primitive-specific gating and linking rules that do **not** match ordinary JS
truthiness. Getting these wrong renders stray badges on every row or drops a link
silently — cheap to avoid, annoying to debug after the fact.

- **`badge` columns gate on non-empty string, not truthiness.** A column badge
  renders whenever `String(value).trim() !== ""`. So an `INTEGER NOT NULL DEFAULT
  0` flag renders the badge on *every* non-set row (value `0` → `"0"` → non-empty).
  For a "show a badge only when set" flag, store **`NULL`** (not `0`) when
  not-set, in the **canonical derivation** *and* everywhere else that clears it —
  a single `0`-writer re-lights the badge.
- **`detail.fields` render as plain text — no per-field links.** The detail panel
  emits `label + String(value)` per field; there is no per-field `linkField`/
  `link`. Clickable links exist only on **grid columns** (`col.linkField`,
  http(s)-gated — see `issue_url`/`issue_number` in `pages/epic.page.json`) and on
  the single block-level `detail.linkField`. To make a value clickable, add it as
  a grid column with `linkField`, not a `detail.fields` entry.
- **`showWhenField` *does* use JS truthiness.** Unlike `badge`, a control gated by
  `showWhenField` is hidden for `0`/`null`/`""` alike — so a `0`-or-`NULL` flag
  correctly hides it either way. (This is why the same flag can need `NULL` for a
  badge yet work as `0` for a `showWhenField` button.)
- **Renderer kinds are a version-pinned set — verify against the installed
  package, not an issue reference.** The page renderers are a finite set fixed by
  the pinned `@nanobpm/urban`; a version *range* only guarantees *some* matching
  build is installed. Do **not** assume a primitive exists because an issue,
  changelog, or *Links* section mentions it — `urban check` (a CI gate) rejects
  unknown renderer kinds only *after* you've authored a page around a phantom one
  (epic #254 bounced three review rounds asserting a page-level "stepper" that
  never shipped). Confirm the kind against the installed `RENDERERS` map
  (`node_modules/@nanobpm/urban/dist/runtime/core/modules/pages.js`) and the kinds
  already used across `pages/*.page.json`. Note a **nano-ide issue can ship a data
  read-model, not a page renderer** (nano-ide#254 shipped the lineage projection, a data
  primitive) — read *what kind* of primitive it delivers. Build composite visuals
  as a `dataGrid` column renderer over stored columns (e.g. the `"kind":
  "pipeline"` column in `pages/feature.page.json`), not a page-level primitive,
  unless you've verified that primitive exists in the installed build.

### The top nav has a single source of truth — edit `pages/_nav.json`

The `nav` node (the top-bar item list, including the **Tasks** live open-tasks
count badge) is **not** authored per page. It lives once in `pages/_nav.json` and
is materialised into every `pages/*.page.json` by `scripts/sync-nav.ts`. To change
a nav item or badge, edit `pages/_nav.json` then run **`npm run sync:nav`** — never
hand-edit the `nav` node in a page file. `scripts/sync-nav.test.ts` (run under
`npm test`) fails if any page's nav node drifts from the canonical source, and
`npm run sync:nav:check` is the CI-friendly verify. This is the "no drift surfaces"
rule applied to the nav that was previously copy-pasted across every page.

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
  Check `origin/main`, not your branch point — a fan-out epic branch forks at one
  prefix while `main` keeps advancing, so the branch-local "next" number collides
  on merge. **In a *simultaneous* fan-out wave, checking `origin/main` isn't
  enough**: every sibling forks at the same commit, sees the same highest prefix,
  and independently takes the same next number (main hasn't advanced yet), so the
  planner must **pre-assign each slice a disjoint prefix block at decomposition
  time** (e.g. give slice A `NNN`–`NNN+1`, slice B `NNN+2`–`NNN+3`, plus a separate
  cleanup block — start the whole allocation *after* the current highest committed
  prefix, never at fixed literals like `060`, which are long occupied) rather than
  have each
  agent compute "the next free" prefix. (This is the same "coarsen parallel work on
  a shared surface" principle as the one-task-owns-each-`.bpmn` rule above — a
  migration-prefix block is a shared numbering surface just like a `.bpmn`
  diagram.) Two files must never share a prefix; `npm run check:migrations`
  (a CI gate) enforces this and fails the build on any new duplicate. Because a
  **merge-skew** prefix collision only exists in the *union* of two branches (a
  single branch that adds two same-prefix files is a self-collision
  `check:migrations` already catches on the PR itself), this gate — like
  `layout:check`, the navigation-index check (`sync:nav:check`), and a catch-all
  committed-artifact backstop (`git diff --exit-code`) — is also re-run on the
  merge queue's **prospective merged commit** and on **push to `main`** by
  `.github/workflows/invariants.yml` (issue #366), so a merge-skew collision is
  blocked at merge time or fails a `main`-scoped build within minutes rather than
  first surfacing on an unrelated open PR.
- **A merged migration is IMMUTABLE — never rename, delete, or edit it.** The
  runtime keys the `_urban_migrations` ledger by *filename*, so a renamed file is
  a *new* migration to the runner: it re-runs its DDL against an already-migrated
  DB and aborts boot (`duplicate column …`); a deleted file desyncs the ledger
  from the schema; an edited file silently no-ops on every existing install (the
  name is already recorded) while diverging fresh ones. To change a merged
  migration's effect, add a NEW migration. `npm run check:migrations` also gates
  this — it diffs `db/migrations/` against the merge-base with `origin/main` and
  fails on any rename/delete/edit — and the upgrade smoke test
  (`app/migration-upgrade-smoke.test.ts`) materialises the previous release's
  migration set and upgrades it to the current set, catching non-idempotent DDL a
  fresh-DB CI never exercises (issue #357). Both need history: CI checks out with
  `fetch-depth: 0`.

### Healing an install wedged by a renamed migration

If a live node fails to boot with `migration "NNN_…sql" failed and was rolled
back … duplicate column` because a migration was renamed *before* the immutability
gate existed (e.g. `043_user_tasks_subject_title.sql` → `046_…`, issue #357),
reconcile its ledger — this makes **no schema change**, only aliases the old
ledger row to the new filename, and is safe to re-run:

```bash
npm run heal:migrations -- /path/to/the/app.sqlite   # then restart the node
```

The known renames live in `RENAMED_MIGRATIONS` (`app/migrationHeal.ts`), the
single source of truth the heal script and its tests share. This list only heals
the pre-gate past — the immutability gate above prevents any new entry from ever
being needed.

## Runtime & CI gates

Node-hosted (`node --experimental-strip-types`); Node is the only runtime. Tests run
on Node's built-in runner (`node:test`), which strips TypeScript types on the fly.
Match CI locally before pushing:

```bash
npm run lint                                          # biome check (incl. ban-`as` gate)
npm run typecheck                                     # tsc --noEmit (Node)
npm run check                                         # urban check (manifest validation)
npm run layout:check                                  # BPMN diagram freshness (no drift)
npm run check:prompts                                 # agent-prompt linkedResource resolution
npm run check:migrations                              # migration prefixes + immutability (no rename/delete/edit of a merged migration)
npm run check:contracts                               # contract registry (no synonyms / undeclared env keys)
npm test                                              # unit tests (node --test)
```

CI (`.github/workflows/ci.yml`) gates lint, typecheck, `urban check`, `layout:check`,
the prompt check, the migration-prefix check, the contract-registry check, and the Node test suite. Run `npm run layout <file.bpmn>` after
any BPMN flow change and commit the regenerated diagram — the `layout:check`
gate fails the build otherwise.

### Generated facades are gitignored — regenerate before running a single test file

`nano-generated/*` (the materialised Nano SDK facades — `operations.ts`, etc.) is
**gitignored** and produced by `urban gen`. Two consequences that have bitten
agents:

- **Never `git add nano-generated/`** — there is nothing to commit; `gen:check`
  and `typecheck` validate its freshness on disk. `npm run gen` (or the
  `pretypecheck`/`pretest` hook) refreshes it.
- **Run `npm run gen` before running a single delegate test file directly**, e.g.
  `node --test operations/foo.test.ts`. A raw single-file run does **not** fire an
  `urban gen` hook, so the delegate import fails with a cryptic
  `ERR_MODULE_NOT_FOUND` for `nano-generated/operations.ts`. `npm test`/`npm run
  e2e`/`typecheck` regenerate it first via a pre-hook, so full-suite runs are
  fine.

## Repo conventions

- **DCO sign-off is enforced.** Every commit needs a `Signed-off-by` trailer —
  use `git commit -s` (or `git rebase --signoff`). A missing sign-off fails the
  DCO check.
- **Conventional Commits.** `feat:`, `fix:`, `perf:`, `refactor:`, `build:`,
  `revert:`, `docs:`, `chore:`, `ci:`, `test:`, `style:`, imperative mood — see the
  next bullet for which of these trigger a release. Review-comment fix-ups are
  `chore:`, not `fix:`.
- **PR titles must be Conventional too — they become the release trigger.** PRs
  land on `main` via **squash merge**, so the **PR title is the commit subject**
  semantic-release analyses. `feat:` cuts a **minor**; `fix:`, `perf:`,
  `refactor:`, `build:`, `revert:`, and `docs:` cut a **patch** (see
  `.releaserc.json` `releaseRules`); a `BREAKING CHANGE:` footer cuts a **major**.
  Only `chore:`, `ci:`, `test:`, and `style:` are **no-release** — a PR titled
  with one of those lands on `main` and is **silently skipped** by the release job
  (no version, no changelog, no deploy). A user-facing feature **must** be titled
  `feat:`. The `PR title lint` workflow (`.github/workflows/pr-title-lint.yml`)
  enforces this; if a non-releasing title ever slips through, push one empty
  releasable commit (`git commit --allow-empty -s -m "feat(scope): …"`) to release
  the accumulated changes.
- **Feature work in a worktree** off `origin/main`, one branch per change; open a
  PR and reference the closing issue (`Closes #NN`).
- **Never `git push --force` on `main`;** use `--force-with-lease` on feature
  branches.

### Merging to `main` (merge queue)

`main` is protected by an **active ruleset** with a **GitHub merge queue**. You
do not merge a PR directly — you **add it to the queue** (UI "Merge when ready",
or the product merge loop's queued-merge path). The queue then builds the
**prospective merged commit** (`merge_group`) and only lands it if the required
checks pass **on that speculative tree**:

- `typecheck + test (Node)`, `whole-repo invariants`, `Conventional PR title`.

`whole-repo invariants` (the merge-skew guard, #366) runs only on the
`merge_group` commit and on `push:main`, never on a plain PR — so a
green-in-isolation PR that would collide once merged (a duplicate migration
prefix, a layout/artifact drift) is **blocked at merge time**, not after it has
already reddened `main`. Grouping is `ALLGREEN` (SQUASH merge), so any red entry
invalidates the whole batch. `Conventional PR title` passes through on
`merge_group` (the title was validated when the PR entered the queue).

### Releases bypass the ruleset via a dedicated App (do not break this)

The ruleset that protects `main` would also reject the **release** automation:
`semantic-release` (`@semantic-release/git`) pushes the `chore(release): X
[skip ci]` version/CHANGELOG commit and tags **directly** to `main`, which the
`pull_request` / `merge_queue` / `required_status_checks` rules forbid.

To allow exactly that push — and nothing else — the `main` ruleset lists a
**dedicated release GitHub App** as an `Integration` **bypass actor**
(`bypass_mode: always`). The `Release` workflow mints a short-lived token for
that App (`actions/create-github-app-token`) and hands it to `semantic-release`;
the job's own `GITHUB_TOKEN` is scoped to `contents: read` + `id-token: write`
(OIDC npm publish) and is **not** a bypass actor.

> ⚠️ **Coupling:** the default `GITHUB_TOKEN` cannot be a repo-level ruleset
> bypass actor, so the release depends on the App bypass actor staying in the
> ruleset. **Whenever you edit the `main` ruleset, keep the release App in
> `bypass_actors`** — dropping it wedges every release (GH013 on the push).

## Distributed fleet: NANO_WORKFORCE_BASE_URL

The abandon and blackboard hooks are how a **distributed worker fleet** calls back
into this app. Their capability URLs (`abandonUrl`, `blackboardUrl`) are minted from a
single knob, **`NANO_WORKFORCE_BASE_URL`** (`app/blackboard.ts` `publicBaseUrl()`,
default `http://localhost:3000`), and are **baked into process variables at
instance-seed time** (`app/service.ts`), then rendered into each remote agent's prompt.

- The value **must be reachable from wherever the worker runs** — `localhost` only
  works for a co-located agent, never for a remote fleet machine. Use a LAN IP /
  hostname the fleet can reach.
- When the app runs **embedded behind the nano console**, the base **must include the
  reverse-proxy prefix**, e.g.
  `http://<merlin-lan-ip>:<console-port>/console/app-view/Workforce`. `abandonUrl()`
  then appends `/app/api/hooks/abandon?token=...`.
- The base is **captured at instance-seed time**. Changing `NANO_WORKFORCE_BASE_URL`
  later does **not** heal already-running instances — re-seed to pick up the new value.
