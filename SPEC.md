# nano-workforce — specification (draft)

A Nano **Urban app** that drives GitHub pull requests to convergence against an
automated reviewer (e.g. GitHub Copilot's PR review), one durable, multi-round
loop per PR. The reviewer-agent is **decoupled**: from this app's point of view
it is just a BPMN service task with a `taskType` and a job payload. Whether a
Copilot instance (via `c8ctl nano hire`/`work`), a script, or anything else
services that job is entirely the worker's concern — this app never names it.

Status: **design draft** — decisions below are agreed; domain model + web
surface are proposed and open for adjustment.

---

## 1. Goal

- Submit a PR (web form or webhook) → the app runs a durable convergence loop:
  address the reviewer's comments, push, re-request review, **wait** for the
  next review, repeat until the latest review has nothing actionable.
- A web UI shows PRs **currently converging** (collapsible detail) and
  **historical converged** PRs, with their round-by-round data.
- Persist everything in **SQLite**.
- Handle **escalation**: if the agent needs to ask a question mid-round, pause
  and let a human answer, then resume.

## 2. Architecture (decoupled)

```
          submit (form / webhook)
                     │
                     ▼
            ┌───────────────────┐        review-ready (msg)      ┌──────────┐
            │  convergence-loop │◀───────────────────────────────│  poller  │
            │      (BPMN)       │        escalation-answered (msg)└────┬─────┘
            └─────────┬─────────┘◀───────────────┐                    │ polls
                      │ senior:pr-review job      │ answer POST        │ GitHub
                      ▼                           │                    ▼
            ┌───────────────────┐          ┌──────┴───────┐     ┌────────────┐
            │  decoupled agent  │          │   web UI +   │     │   SQLite   │
            │ (c8ctl nano work) │          │  API routes  │────▶│ (app.db)   │
            └───────────────────┘          └──────────────┘     └────────────┘
```

- **Engine**: embedded Nano (the Urban app deploys its BPMN + runs the loop).
- **Agent**: external worker subscribed to `senior:pr-review`. Short jobs — one
  round then return. It never blocks on the wait.
- **BPMN owns the durable wait** between rounds (message catch events), so
  agent worker slots and job timeouts are never held hostage to Copilot's reply
  latency.
- **Poller**: an in-app background loop that watches waiting PRs and publishes
  the `review-ready` message when a new review lands (no GitHub webhook needed;
  works behind NAT).

## 3. Repository layout

```
nano-workforce/
  nano.app.json               # manifest (ADR 0027): sqlite data, domain types, submit webhook trigger
  main.ts                     # Deno entrypoint: deploy + start workers + Deno.serve (page runtime + action overrides + poller)
  deno.json
  pages/
    home.page.json            # the screen, authored declaratively (ADR 0042 Page Composer)
  scripts/
    purge-db.ts               # `deno task purge`: wipe + re-migrate the app db
  resources/
    processes/
      convergence-loop.bpmn   # the durable convergence process
  db/
    migrations/
      001_init.sql            # sqlite schema
  prompts/
    review-round.md           # agent instructions asset (injected into job data)
  components/
    review-round.json         # Zeebe element template for the senior:pr-review service task
  SPEC.md                     # this document
  README.md
```

## 4. Convergence process (`convergence-loop.bpmn`)

Correlation key for all messages: **`prKey = "<owner>/<repo>#<number>"`** — stable,
known at submit time, carried as a process variable and stored on the DB row.

```
(start: pr-submitted)                      vars in: { repo, prNumber, prUrl, prKey }
      │
      ▼
[Register PR]  (script/handler)   → insert DB row; round = 1
      │                              (base prompt delivered via the {{review-round}} model
      │                               template header, not a process variable)
      ▼
┌──▶ [Review round]  (service task, taskType: senior:pr-review)
│         in : prUrl, repo, prNumber, round, answer?   (prompt via task header)
│         out: status, summary, question?
│         │
│         ▼
│    <gateway: status>
│      ├── converged  → [Mark converged] → (end: converged)
│      │
│      ├── addressed  → [Record round] → <event-based gateway: review ready or timeout?>
│      │                     ├── review-ready (msg catch, key = prKey) → round++ ─────┐
│      │                     └── =reviewWaitTimeout (timer catch)                     │
│      │                          → [Escalate: review stalled] (blocked)              │
│      │                          → [Wait: escalation-answered] ──────────────────────┤
│      │                                                                             │
│      └── needs_input     [Record escalation]                       │               │
│          or blocked  →   (kind = question | blocker)               │               │
│                          → [Wait: escalation-answered] (msg catch) │               │
│                          → set answer ──────────────────────────────┤               │
│                                                                    │               │
└────────────────────────────────────────────────────────────────────┴───────────────┘

Both `needs_input` (the agent has a question) and `blocked` (the agent is stuck
on something external — auth, a failing push, a missing secret) route to the
**same escalation path**: record it, sleep at `escalation-answered`, then retry
the same round with the human's `answer`. They differ only by escalation `kind`,
which the UI uses to label the card. Neither ends the run — a human always gets
a chance to unblock and resume.

Guard: before each Review round, if round > MAX_ROUNDS → force an escalation
("not converged after N rounds") so a human decides, rather than looping forever.
```

Notes:
- On `addressed`, the loop parks at an **event-based gateway** that races a
  `review-ready` message (correlated by the poller when a fresh review lands)
  against a `=reviewWaitTimeout` timer (seeded at submit from
  `NANO_PR_REVIEW_WAIT_TIMEOUT`, default `PT20M`). Whichever fires first
  withdraws the other — the message arm advances `round`, the timer arm escalates
  a **stalled review** (`blocked`) so a human decides rather than the instance
  hanging forever. Because `persist-round` already recorded this `round` as
  `addressed` before the gateway, the timer arm opens the escalation **without
  re-recording the round** (it passes `recordRound=false`), so a single round is
  never logged as both `addressed` and `blocked`. This replaced a bare
  `review-ready` catch that could hang
  indefinitely: Copilot won't re-review a round with no new commit and routinely
  dismisses a re-request, so with no timeout a review that never arrives wedged
  the loop (observed: three convergence processes stalled ~22h). The poller's
  auto re-request (§10) is the primary liveness mechanism; this timer is the
  backstop when even repeated nudges fail.
- On `needs_input`, the same `round` is retried after the answer (the answer is
  added to the agent's context; the round number does not advance).


## 5. Agent job contract (`senior:pr-review`)

**Input** (`job.variables`):
| var | type | notes |
|---|---|---|
| `prUrl` | string | canonical PR URL |
| `repo` | string | `owner/name` |
| `prNumber` | int | |
| `round` | int | 1-based round counter |
| `answer` | string? | present only when resuming from an escalation |

The base instructions are **not** a job variable: they are delivered as a model
**template header** on the `senior:pr-review` task — header key
`io.nanobpm.agentTask.task.prompt` with value `{{review-round}}`, substituted with
`prompts/review-round.md` at deploy time.

**Output** (job result variables):
| var | type | notes |
|---|---|---|
| `status` | enum | `converged` \| `addressed` \| `needs_input` \| `blocked` |
| `summary` | string | human-readable account of what the round did |
| `question` | string? | required when `status = needs_input` or `blocked` — the question/blocker text a human must resolve |

The agent is responsible, within a round, for: reading the latest review,
triaging, editing/replying/pushing, and (when `addressed`) re-requesting review.

### Workspace isolation (host mode)

Workspace isolation is the **worker harness's** responsibility, not this app's and
not the prompt's. The `c8ctl nano work` host-git provisioning (frozen v1 envelope)
gives **each job its own `mkdtemp` run-dir + fresh clone**, runs the agent with
`cwd` set to it (`AGENT_WORKSPACE`/`REPO_URL`/`REPO_BRANCH`/`REPO_REF` env), and
**reaps that run-dir when the job ends**. So multiple agents on one host do **not**
collide even in host mode — the isolation lives below the agent.

Consequences the prompt (`prompts/review-round.md`) encodes:
- The agent works only inside its provided `cwd`; it must **not** re-clone or create
  a separate `git worktree`, and must not touch global/host state.
- The agent **cleans up anything it creates outside the commit** before returning
  (worktrees, scratch branches/clones, temp files), so host mode does not leak.
- The harness checks out the PR's **existing head branch** and pushes back to it
  (no new branch/PR). The `c8ctl` integration provisions the repo and resolves the
  head branch from `prNumber`/`prUrl` — the app does not pass a `headBranch` var.

## 6. Signals

| message | correlationKey | published by | payload |
|---|---|---|---|
| `pr-submitted` | — (start) | submit route/webhook | `{repo, prNumber, prUrl, prKey}` |
| `review-ready` | `prKey` | **poller** | `{reviewId, reviewState, submittedAt}` |
| `escalation-answered` | `prKey` | UI answer route | `{answer, escalationId}` |
| `deps-cleared` | `prKey` | **poller** (merge) | — (all `Depends-on` PRs merged) |
| `merge-ready` | `prKey` | **poller** (merge) | `{mergeState}` (`ready` \| `conflict` \| `blocked`); when `blocked`, also `{failingChecks, failingChecksList}` for the `senior:fix-ci` branch |
| `merge-landed` | `prKey` | **poller** (merge) | — (queued PR merged, or merged out-of-band) |

Note `escalation-answered` is reused by both processes (`convergence-loop` and
`merge-loop`); only one is ever active for a given `prKey`, so correlation is
unambiguous. Each `.bpmn` gives it a distinct message **id** (and distinct
envelope shape ids) to avoid duplicate-id collisions when the manifest deploys
both files.

## 7. Domain model (SQLite — `db/migrations/001_init.sql`) — PROPOSED

```sql
CREATE TABLE pull_requests (
  pr_key           TEXT PRIMARY KEY,          -- "<owner>/<repo>#<number>"
  repo             TEXT NOT NULL,             -- "<owner>/<repo>"
  number           INTEGER NOT NULL,
  url              TEXT NOT NULL,
  title            TEXT,                       -- fetched from GitHub
  status           TEXT NOT NULL,             -- review: converging | waiting_review | escalated | converged; merge: waiting_deps | waiting_merge | queued | merging | merged; abandoned
  current_round    INTEGER NOT NULL DEFAULT 0,
  process_key      TEXT,                       -- engine process-instance key
  waiting_since    TEXT,                       -- ISO ts we began waiting for a review (poller cursor)
  last_review_id   INTEGER,                    -- last GitHub review id we reacted to
  outcome          TEXT,                       -- final summary
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  converged_at     TEXT,
  merged_at        TEXT                        -- set by `pr.mark-merged` (migration 004)
);

CREATE TABLE rounds (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_key      TEXT NOT NULL REFERENCES pull_requests(pr_key),
  round_no    INTEGER NOT NULL,
  status      TEXT,                             -- converged | addressed | needs_input | blocked
  summary     TEXT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT
);

CREATE TABLE escalations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_key      TEXT NOT NULL REFERENCES pull_requests(pr_key),
  round_no    INTEGER NOT NULL,
  kind        TEXT NOT NULL,                    -- question | blocker
  question    TEXT NOT NULL,
  answer      TEXT,
  status      TEXT NOT NULL,                    -- open | answered
  asked_at    TEXT NOT NULL,
  answered_at TEXT
);

CREATE INDEX idx_pr_status ON pull_requests(status);
CREATE INDEX idx_rounds_pr ON rounds(pr_key);
CREATE INDEX idx_esc_pr ON escalations(pr_key);
```

## 8. Screen + routes (`main.ts` + `pages/home.page.json`)

The UI is authored declaratively as `pages/home.page.json` and served by the
generic Urban **page runtime** (`@nanobpm/app`, ADR 0042) — no hand-written SPA.
The page defines status-filtered tabs (active vs. history), a submit form, a
per-row **Cancel** action, and an expandable detail with the round/escalation
child grids, a lazily-loaded transcript, and a conditional **answer** form shown
when the PR has an open escalation (`open_escalation_id`, denormalised onto the
row by migration `003`).

The app-specific business-logic endpoints are **OpenAPI operations** mounted
under `api.base` (`/app/api`), each implemented by a delegate module in
`operations/`, plus a `/hooks/*` webhook. The runtime serves them all; `main.ts`
only starts the runtime and the review-ready poller. The full, authoritative
contract is `openapi.json` (Swagger UI at `/app/api-docs`); the OpenAPI rows
below are the complete set of operations, `/hooks/submit` is one of the `/hooks/*`
webhooks:

| method | route | purpose |
|---|---|---|
| `GET` | `/app/api/status` | list tracked PRs + count |
| `GET` | `/app/api/version` | app + engine version |
| `POST` | `/app/api/actions/start/convergence-loop` | parse the PR ref → create the aggregate + start the process |
| `POST` | `/app/api/actions/start/plan-fanout` | start a plan fan-out run |
| `POST` | `/app/api/actions/message` (`escalation-answered`) | answer an open escalation → publish `escalation-answered` |
| `POST` | `/hooks/submit` | webhook submit (shared-secret auth) → start the process |

Everything else (`GET /`, `GET /app/pages/*`, `GET /app/data/*`, the renderer) is
served by the runtime — including `POST /app/actions/cancel`, which is Urban's
built-in reconcile-aware cancel primitive (there is **no** local handler in this
repo): it terminates the engine instance, verifies the termination, and flips the
tracked row to `abandoned` via the `instanceTracking` `onTerminated.set` patch.
`deno task purge` wipes and re-migrates the app db (used
when the engine data is purged, to keep app state and engine state consistent).

## 9. Prompt delivery — model-authored template headers

Each agent task's base prompt lives **only** in its `prompts/*.md` side-car and is
authored **into the model** as a deploy-time `{{stem}}` template. `nano.app.json`
declares `models.templates: ["prompts/*.md"]`, and each agent service task carries a
`io.nanobpm.agentTask.task.prompt = {{stem}}` task header (`{{review-round}}`,
`{{plan}}`, `{{plan-review}}`, `{{feature}}`, `{{fix-ci}}`). At deploy the template
substitutes the file content into the header, so the host no longer reads prompt
assets or carries them as process variables.

Per-instance dynamic context rides **`appendPrompt`**: an ioMapping sets a job-local
`appendPrompt` string (a plan's rejection findings, a feature task's brief, the
failing-check list) which the agent harness concatenates **verbatim** onto the header
base — the model owns any separator, and a null/empty append leaves the base
untouched. Base prompts can't be composed in FEEL (they are quote-heavy, and XML
attribute escaping would corrupt a FEEL string literal), so composition happens via
this append seam rather than inline in FEEL. Requires `@nanobpm/urban` with
deploy-time template substitution.

## 10. Poller

An in-app loop (interval `NANO_PR_POLL_MS`, default 60s):
1. `SELECT pr_key, repo, number, waiting_since, last_review_id, last_nudge_at FROM pull_requests WHERE status = 'waiting_review'`.
2. For each, GET the PR's reviews from GitHub; find the newest review submitted
   after `waiting_since` with id > `last_review_id`.
3. If found → publish `review-ready` (key = `pr_key`, `{reviewId, ...}`) and set
   `last_review_id`.
4. If **not** found → ensure a review is in flight: unless Copilot is already a
   pending reviewer, **re-request** it (REST `requested_reviewers`, exact login
   `copilot-pull-request-reviewer[bot]`) and record `last_nudge_at`. This is
   throttled to one attempt per `NANO_PR_REVIEW_NUDGE_MINUTES` window (default 5m)
   so a re-request Copilot dismisses is retried without hammering the API. A repo
   where Copilot isn't an assignable reviewer (HTTP 422) is left to the process's
   review-wait timer (§4). This closes the stall where Copilot won't spontaneously
   re-review and silently dismisses a re-request, so no `review-ready` ever fires.

Requires a GitHub token (`GITHUB_TOKEN`) or the host `gh` CLI. One cheap API call
per waiting PR per interval (plus at most one reviewer-state check + re-request per
nudge window).

## 11. Merge stage (`merge-loop.bpmn`)

With `NANO_PR_AUTO_MERGE` on (default), the `pr.finalize` worker does not stop at
`converged` — it starts a **second** durable process, `merge-loop`, keyed on the
same `prKey`, sharing the datasource and poller. It merges the PR, honouring
merge-queue branches and cross-PR dependencies, and reuses the review stage's
escalation machinery for anything it can't resolve autonomously.

Flow:

```
start ─► wait: deps merged ─► arm merge ─► wait: mergeable ─┬─ ready ─► merge ─┬─ merged ─► mark merged ─► end
   (deps-cleared)              (waiting_merge)  (merge-ready)│                 ├─ queued ─► wait: landed ─► mark merged
                                                             │                 │            (merge-landed)
                                                             │                 └─ blocked ──────────────► escalate ─┐
                                                             ├─ conflict ─────────────────────────────► escalate ─┤
                                                             └─ blocked (failing checks) ─► auto-fix CI?           │
                                                                     ├─ within budget ─► [senior:fix-ci] ─┐        │
                                                                     └─ budget exhausted ─► escalate ─┐    │        │
                                    (re-arm) ◄── fixed ─┬────────────────────────────────────────────│────┘        │
                                                        └─ could not fix ─► escalate ─┐               │             │
                                                                                      ▼               ▼             ▼
                                                             wait: answered ─► (re-arm) ◄──────── (all escalations)
                                                                   (escalation-answered)
```

- **CI auto-fix** — a `blocked` verdict means a **required check failed**
  (`classifyMergeability`). Rather than escalate immediately, the stage dispatches a
  `senior:fix-ci` agent (base prompt via the `{{fix-ci}}` template header; the failing
  check names ride `appendPrompt`) to green the checks on the branch, then re-arms the
  poller. It repeats while `ciFixRound < ciFixMax`
  (`NANO_PR_MAX_CI_FIX_ROUNDS`, default 3; `0` disables). Only when the budget is
  exhausted, the agent reports `blocked`, or the branch is in `conflict` does it fall
  through to the human escalation path.

- **Dependencies** — `pr_dependencies(pr_key, depends_on_key)` (migration 004).
  Declared two ways: a `Depends-on: owner/repo#N` line in the PR body (parsed on
  submit) and/or a `dependsOn` array on the submit request. `merge-loop` parks at
  *wait: deps merged*; the poller checks each dependency (own tracked row first,
  else GitHub `merged` state) and publishes `deps-cleared` once all have landed.
- **Mergeability** — the poller classifies GitHub's `mergeStateStatus`:
  `CLEAN`/`HAS_HOOKS`/`UNSTABLE`/`BEHIND` → `ready`; `DIRTY` → `conflict`;
  `BLOCKED` → `blocked` if a required check is failing, else keep waiting;
  `DRAFT`/`UNKNOWN`/empty → keep waiting. It publishes `merge-ready {mergeState}`.
- **Merge** — `pr.merge` attempts the merge (`NANO_PR_MERGE_METHOD`, default
  `squash`). GitHub auto-enqueues on merge-queue-required branches → the process
  waits for `merge-landed` (poller detects the landed PR). Every attempt is
  recorded in the `merges` audit table.
- **Escalation** — a conflict or a failing gate raises the same
  `pr.persist-escalation` worker / UI answer form as the review stage (status
  `escalated`); answering re-arms and retries.
- **Terminal** — `merged` (with `merged_at`), or `converged` when
  `NANO_PR_AUTO_MERGE=0` (review-only), or `abandoned` on cancel.

Poller status choreography mirrors the review stage: before publishing a
resuming message the poller flips the row to a **transient** status the scan
queries skip (`merging`), so a slow pass can't double-signal.

## 12. Configuration (env, `${VAR:-default}` in the manifest)

| var | default | purpose |
|---|---|---|
| `PORT` | 8090 | app HTTP port |
| `NANO_APP_DB_URL` | `file:./app.db` | sqlite |
| `GITHUB_TOKEN` | — | GitHub API (poller + agent) |
| `NANO_PR_POLL_MS` | 60000 | poll interval |
| `NANO_PR_MAX_ROUNDS` | 20 | default round cap (per-submit `maxRounds` override, clamped 1–100) |
| `NANO_PR_WEBHOOK_SECRET` | — | HMAC for `/hooks/submit` |
| `NANO_PR_AUTO_MERGE` | 1 | run the merge stage after convergence (`0` = review-only) |
| `NANO_PR_MERGE_METHOD` | squash | `squash` \| `merge` \| `rebase` |
| `NANO_PR_MERGE_ADMIN` | 0 | pass `--admin` on merge |
| `NANO_PR_REVIEW_WAIT_TIMEOUT` | PT20M | ISO-8601 wait before a stalled review escalates (timer arm of the `wait-review` event-based gateway); malformed → default |
| `NANO_PR_REVIEW_NUDGE_MINUTES` | 5 | cooldown between poller Copilot re-request nudges per PR (clamped 1–1440) |

## 13. Planning fan-out (`plan-fanout.bpmn`) — issue #14

A second process turns a **GitHub issue** into a fleet of PRs. It is the "series
then parallel" flat form: plan once, then fan out over the tasks in parallel, then
hand every produced PR to the convergence loop of §4.

```
Start(issue) → plan → record-plan → implement (parallel MI) → record-results → End
```

- **`plan`** — service task, job type `senior:plan`. Its base prompt is delivered
  via the `{{plan}}` model template header (`prompts/plan.md`); when a prior review
  rejected the plan, the rejection findings ride `appendPrompt` (an ioMapping over
  `planFindings`) rather than being concatenated in FEEL. The agent reads the issue
  via `gh` and emits `tasks: [{ id, title, prompt }]`.
- **`record-plan`** — app worker `pr.record-plan`. Normalizes the tasks (assigns a
  stable `id`/index), writes one `plan_tasks` row each, sets `plans.task_count` and
  status `dispatched`, and **re-emits** the normalized `tasks` so the fan-out
  iterates the canonical list.
- **`implement`** — service task, job type `senior:feature`, **parallel
  multi-instance** over `=tasks` (`inputElement="task"`,
  `outputCollection="results"`). Its base prompt is delivered via the `{{feature}}`
  model template header (`prompts/feature.md`); each child's per-task brief
  (`"\n\n---\n\n" + task.prompt`) rides `appendPrompt` — an input mapping evaluated
  **per child** (Zeebe parity: the inner activity keeps its own `zeebe:ioMapping`,
  applied on each inner-instance activation with `task`/`loopCounter` bound). Each
  agent opens a PR and returns `{ status, summary, pr }`; `outputElement` collects
  those into `results[i]`, index-aligned with `tasks[i]`.
- **`record-results`** — app worker `pr.record-results`. Zips `results` back onto
  `plan_tasks` by index, and for each opened `pr` calls the same idempotent
  `submitPr` as §4 — **the handoff**: every fleet-produced PR enrols into the
  review-convergence loop. On success it sets `plans` status `done`; if the epic
  finalizes having opened **zero** PRs (empty plan, or every task blocked/skipped)
  it raises a non-retryable `NO_WORK_DISPATCHED` incident instead of completing
  green — a no-op run must not masquerade as success (issue #86).

**Payloads are untyped** (no `nano:shapes`/`io.nanobpm.dataEnvelope`): the vocab is
scalar-only and cannot express the `tasks`/`results` lists, so the workers self-type
`job.variables` inline (like `finalize`). `urban gen` still emits the four task types.

**Domain model** (`db/migrations/004_planning.sql`): `plans` (one row per issue) +
`plan_tasks` (one row per slice, tracking its `status`/`pr_key`/`summary`).

**Entry points**: the page's "Hand an issue to the fleet" form
(`startProcess plan-fanout` → `actions/plan-start.ts`), or `POST /hooks/plan`
(`{ issue | url }`, optional `X-Hook-Secret`).

**Visibility**: the home page adds a **Plans** grid (Active: planning/dispatched;
History: done/failed/abandoned) with a `plan_tasks` child grid showing each task's
status and the PR it produced (`pr_key` cross-references the Pull requests grid for
convergence status).

### 13.1 Dependency waves + merge barrier (issues #20, #26, release-notes-concierge)

The flat `implement → record-results` shape above evolved into a **wave loop**. The
planner may emit `dependsOn` edges; `record-plan` levelizes them into ordered
**waves** (`app/waves.ts` `computeWaves`, `plan_tasks.wave` + `plan_task_deps`), and
the loop runs one parallel `implement` MI fan-out per wave:

```
… → select-wave → implement (parallel MI) → record-wave → gw-more
       ↑                                                     │ more
       └───────────── wait-wave-merged ←────────────────────┘
                                                             │ done
                                                             ▼
                                                       record-results
```

- **`select-wave`** (`pr.select-wave`) emits the current wave's still-`pending`
  tasks as `waveTasks`; a task whose dependency ended `blocked`/`skipped` is marked
  `skipped` (the failure cascades) rather than dispatched.
- **`record-wave`** (`pr.record-wave`) records each slice's outcome, hands every
  opened PR to the convergence loop via `submitPr` (declaring dependency PRs as
  `dependsOn`), and advances `currentWave`.
- **Wave-merge barrier** (`wait-wave-merged`): when a wave has a successor,
  `record-wave` sets `plans.gate_wave` to that wave's index and the process parks at
  the `wait-wave-merged` catch event. The poller's `pollWaveGates` pass publishes the
  `wave-merged` message (correlated on `planKey`) once **every opened PR in that wave
  has merged** (`app/waves.ts` `waveMergeTargets` selects the PRs to wait on;
  `blocked`/`skipped`/keyless tasks clear vacuously), then clears `gate_wave`
  single-shot. So a `dependsOn` means the dependent wave is not **implemented** until
  its prerequisites have **landed on the base branch** — not merely opened. This lets
  a blocking prerequisite (e.g. app scaffolding) fully converge and merge before the
  next wave builds on it. `gate_wave` lives in `db/migrations/007_wave_gate.sql`.
- **Adopting a decomposed epic** (`prompts/plan.md` Step 0): when adopting existing
  sub-issues, the planner honours an explicit `Depends-on: #N` / `Blocked by #N`
  directive in a sub-issue body, mapping each prerequisite `#M` to `issue-M` in the
  adopted task's `dependsOn` — so a human-declared blocking order survives adoption.

## 14. Open questions / future

- **Provisioning the existing PR branch** — resolved: the `c8ctl` host-git
  integration provisions the repo and checks out the PR's head branch (it must
  already give the worker repo access to work at all), resolving the branch from
  `prNumber`/`prUrl`. The app does **not** pass a `headBranch` job variable; the
  job stays engine-shaped and the worker stays a pure provisioner.
- **review-ready via GitHub webhook** — same message, swappable faster trigger,
  when the app is publicly reachable. Deferred (poller-only for v1).
- **Supervised vs external worker** — the agent runs as an external
  `c8ctl nano work` daemon by default; a supervised in-server mode is possible
  later (ADR 0041 decision).
- **Prompt versioning/hash** per PR for auditability.
- **Auth on the web UI** — the manifest `security` block (ADR 0028) if this is
  exposed beyond localhost.
