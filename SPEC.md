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
            │      (BPMN)       │                                 └────┬─────┘
            └─────────┬─────────┘◀───────────────┐                    │ polls
                      │ senior:pr-review job      │ userTask complete  │ GitHub
                      ▼                           │ (inbox)            ▼
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
  main.ts                     # Node entrypoint: deploy + start workers + start the runtime (page runtime + OpenAPI operations + poller)
  deno.json
  pages/
    home.page.json            # the screen, authored declaratively (ADR 0042 Page Composer)
  scripts/
    purge-db.ts               # `deno task purge`: wipe + re-migrate the app db
  resources/
    processes/
      convergence-loop.bpmn   # the durable convergence process
    prompts/
      review-round.md         # agent instructions asset (deployed by the resources/ convention)
  db/
    migrations/
      001_init.sql            # sqlite schema
  docs/
    agent-guide.md            # operator guide (docs live OUTSIDE resources/ — never deployed)
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
      │                              (base prompt delivered via the review-round.md
      │                               linked resource, not a process variable)
      ▼
┌──▶ [Review round]  (service task, taskType: senior:pr-review)
│         in : prUrl, repo, prNumber, round, answer?   (prompt via linked resource)
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
│      │                          → [Wait: wait-answer userTask] ─────────────────────┤
│      │                                                                             │
│      └── needs_input     [Record escalation]                       │               │
│          or blocked  →   (kind = question | blocker)               │               │
│                          → [Wait: wait-answer userTask]            │               │
│                          → [record-answer: pr.answer-escalation]   │               │
│                          → set answer ──────────────────────────────┤               │
│                                                                    │               │
└────────────────────────────────────────────────────────────────────┴───────────────┘

Both `needs_input` (the agent has a question) and `blocked` (the agent is stuck
on something external — auth, a failing push, a missing secret) route to the
**same escalation path**: record it, park on the native `wait-answer` user task
(answered through the canonical `completeUserTask` door and surfaced in the Tasks
inbox), reconcile the answer via the `record-answer` (`pr.answer-escalation`)
step, then retry the same round with the human's `answer`. They differ only by escalation `kind`,
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

The base instructions are **not** a job variable: they are delivered as a
**linked resource** on the `senior:pr-review` task —
`<zeebe:linkedResource resourceId="review-round.md" bindingType="latest" resourceType="GenericScript" linkName="prompt"/>`,
which the engine resolves to the latest deployed `resources/prompts/review-round.md` at job
activation.

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
`cwd` set to it (`AGENT_WORKSPACE`/`AGENT_REPO_URL`/`AGENT_REPO_BRANCH`/`AGENT_REPO_REF` env), and
**reaps that run-dir when the job ends**. So multiple agents on one host do **not**
collide even in host mode — the isolation lives below the agent.

Consequences the prompt (`resources/prompts/review-round.md`) encodes:
- The agent works only inside its provided `cwd`; it must **not** re-clone or create
  a separate `git worktree`, and must not touch global/host state.
- The agent **cleans up anything it creates outside the commit** before returning
  (worktrees, scratch branches/clones, temp files), so host mode does not leak.
- The harness checks out the PR's **existing head branch** and pushes back to it
  (no new branch/PR). Provisioning only fires when the job carries a
  `io.nanobpm.agentTask.repository.url`; the **app** supplies it — plus the head
  branch as `…repository.ref` — as a process variable at `createInstance`
  (`repoEnvelopeVars` in `app/service.ts`, resolving the head via `fetchPrMeta`/
  `fetchPrHead`). The harness is PR-agnostic: it does **not** derive the head branch
  from `prNumber`/`prUrl`. When the head can't be resolved the envelope is omitted and
  the agent falls back to the worker's launch directory (the legacy behavior).

## 6. Signals

| message | correlationKey | published by | payload |
|---|---|---|---|
| `pr-submitted` | — (start) | submit route/webhook | `{repo, prNumber, prUrl, prKey}` |
| `review-ready` | `prKey` | **poller** | `{reviewId, reviewState, submittedAt}` |
| `deps-cleared` | `prKey` | **poller** (merge) | — (all `Depends-on` PRs merged) |
| `merge-ready` | `prKey` | **poller** (merge) | `{mergeState}` (`ready` \| `conflict` \| `blocked`); when `blocked`, also `{failingChecks, failingChecksList}` for the `senior:fix-ci` branch |
| `merge-landed` | `prKey` | **poller** (merge) | — (queued PR merged, or merged out-of-band) |

The `escalation-answered` message was retired (#256): the merge-loop escalation is
now a native `wait-merge-answer` `userTask`, exactly like the `convergence-loop`
review escalation (`wait-answer`). Both are answered through the ONE canonical
`completeUserTask` door and surface in the Tasks inbox — there is no longer a
merge-only message pathway.

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
child grids and a lazily-loaded transcript. The round/escalation grids are
read-only audit. Open native user-task escalations are additionally resolved
app-side from the **Tasks** page (`pages/tasks.page.json`, issue #236) — a nav
tab whose per-kind `dataGrid`s list every open escalation (feature / plan-review
/ trial-merge / PR review / blocked-run) off the `user_tasks` read-model and
submit the typed decision to the canonical human completer — so an operator no
longer depends on Urban's read-only `taskInbox` stub at `/tasks`.

The app-specific business-logic endpoints are **OpenAPI operations** mounted
under `api.base` (`/app/api`), each implemented by a delegate module in
`operations/`. The webhook endpoints are ordinary operations too (ADR 0059 — the
`actions[]` array is retired), mounted under `/app/api/hooks/*`. The runtime
serves them all; `main.ts` only starts the runtime and the review-ready poller.
The full, authoritative contract is `openapi.yaml` (Swagger UI at
`/app/api-docs`); the OpenAPI rows below are the complete set of operations:

| method | route | purpose |
|---|---|---|
| `GET` | `/app/api/status` | list tracked PRs + count |
| `GET` | `/app/api/version` | app + engine version |
| `POST` | `/app/api/actions/start/convergence-loop` | parse the PR ref → create the aggregate + start the process (the ONE submit door — page + external callers) |
| `POST` | `/app/api/actions/start/plan-fanout` | parse the issue ref → start a plan fan-out run (the ONE plan door) |
| `POST` | `/app/api/actions/message` | publish a BPMN message (optionally correlated) into the engine (generic; every escalation kind is now answered via `/actions/complete-user-task`) |
| `POST` | `/app/api/actions/complete-user-task` | complete an open native user-task escalation from the Tasks page (plan-review / trial-merge / PR `wait-answer` / PR merge `wait-merge-answer`) → `completeEscalationAsHuman` (the same resume path the task inbox uses) |
| `GET`/`POST` | `/app/api/hooks/blackboard` | per-plan coordination blackboard (capability-token side-channel) |
| `GET` | `/app/api/hooks/abandon` | cooperative abandon check (per-PR capability token) |

Everything else (`GET /`, `GET /app/pages/*`, `GET /app/data/*`, the renderer) is
served by the runtime — including `POST /app/actions/cancel`, which is Urban's
built-in reconcile-aware cancel primitive (there is **no** local handler in this
repo): it terminates the engine instance, verifies the termination, and flips the
tracked row to `abandoned` via the `instanceTracking` `onTerminated.set` patch.
`deno task purge` wipes and re-migrates the app db (used
when the engine data is purged, to keep app state and engine state consistent).

## 9. Prompt delivery — linked resources (`bindingType: latest`)

Each agent task's base prompt lives **only** in its `resources/prompts/*.md` side-car,
deployed as a **generic resource** and **linked** — not baked — into the model (issue
#169). Under the ADR 0062 `resources/` deploy-by-convention layout, `nano.app.json`
declares **no `models`**, so `@nanobpm/urban` walks `resources/` (shallow, one level) and
deploys each file as an `application/octet-stream` resource whose deployed **name is
the file's basename** (`resources/prompts/review-round.md` → resource `review-round.md`).
Each agent service task links it:

```xml
<zeebe:linkedResources>
  <zeebe:linkedResource resourceId="review-round.md" bindingType="latest" resourceType="GenericScript" linkName="prompt" />
</zeebe:linkedResources>
```

At **job activation** the engine resolves the *latest deployed* key for that
`resourceId` and hands the content to the harness in the `linkedResources` activation
header; the harness fetches by key and uses it as the base prompt. Because the binding
is `latest`, **redeploying a single `resources/prompts/*.md` changes the prompt for the
next task activation in a running epic** — no process redeploy, no in-flight epic restart.
This is the live-prompt debugging loop: edit one Markdown file, `urban deploy` (or restart
the app, which deploys on boot), and the next agent job of that type picks it up.

> **Latest-for-now, audited.** The engine currently keeps only the latest version per
> `resourceId` (`deployment`/`versionTag` bindings degrade to latest — no pinning yet).
> We accept `latest` (ideal for active debugging) and rely on the harness recording the
> resolved `resourceKey` per job for "which prompt did this run use?". True
> `deployment`-binding pinning for reproducible production epics is an engine follow-up,
> not part of #169.

> **The engine silently omits an unresolvable link.** A typo'd or undeployed
> `resourceId` is dropped from the activation header (no incident) — the agent would
> then run prompt-less. `scripts/check-agent-prompts.ts` (CI gate `check:prompts`)
> guards against this: every `linkName="prompt"` link's `resourceId` must match a
> prompt file the app actually deploys (a file under the `resources/` convention walk, or
> a manifest `models` override glob), each linked
> prompt must be non-blank and teach the agent to emit a machine-readable result
> (`$AGENT_RESULT_FILE` / `::nano:result::`), and no task may still carry the retired
> baked `io.nanobpm.agentTask.task.prompt` header.

Per-instance dynamic context still rides **`appendPrompt`** (unchanged): an ioMapping
sets a job-local `appendPrompt` string (a plan's rejection findings, a feature task's
brief, the failing-check list) which the agent harness concatenates **verbatim** onto
the linked base — the model owns any separator, and a null/empty append leaves the base
untouched. Base prompts can't be composed in FEEL (they are quote-heavy, and XML
attribute escaping would corrupt a FEEL string literal), so composition happens via
this append seam rather than inline in FEEL. Requires an `@nanobpm/urban` deploy that
deploys the `resources/` convention (generic-resource deployments for
`resources/prompts/*.md`) and a harness that consumes
`linkedResources` and fetches the resource by key.

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

A per-submit `convergeOnly: true` on the `start/convergence-loop` request pins that PR
to review-only regardless of the global default: `pr.finalize` reads the flag off the
instance and rests the PR at `converged` without starting `merge-loop`. The flag only
ever narrows (it never forces the merge stage on when `NANO_PR_AUTO_MERGE` is off).

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
                                                            (wait-merge-answer userTask)
```

- **CI auto-fix** — a `blocked` verdict means a **required check failed**
  (`classifyMergeability`). Rather than escalate immediately, the stage dispatches a
  `senior:fix-ci` agent (base prompt via the `fix-ci.md` linked resource; the failing
  check names ride `appendPrompt`) to green the checks on the branch, then re-arms the
  poller. It repeats while `ciFixRound < ciFixMax`
  (`NANO_PR_MAX_CI_FIX_ROUNDS`, default 3; `0` disables). Only when the budget is
  exhausted, the agent reports `blocked`, or the branch is in `conflict` does it fall
  through to the human escalation path.

- **Discovered dependency** — a `senior:fix-ci` or `senior:rebase` agent may find that
  the PR cannot land because **another PR must merge first** (a required linked-issue
  gate a sibling PR will close, a stacked base PR, or a `Depends-on:` the agent read
  from the PR/issue text). That is an ordering **wait, not a human decision**: the
  agent returns `status: "waiting-on-pr"` with a `dependsOn` list of `owner/repo#N`
  refs. `pr.record-dependency` appends those edges to `pr_dependencies` and parks the
  PR back at *wait: deps merged*, so the same poller pass lands it automatically once
  the named PRs merge — no escalation is opened.

- **Dependencies** — `pr_dependencies(pr_key, depends_on_key)` (migration 004).
  Declared three ways: a `Depends-on: owner/repo#N` line in the PR body (parsed on
  submit), a `dependsOn` array on the submit request, and/or **discovered at merge
  time** by a `fix-ci`/`rebase` agent (`status: "waiting-on-pr"`, above). `merge-loop`
  parks at *wait: deps merged*; the poller checks each dependency (own tracked row
  first, else GitHub `merged` state) and publishes `deps-cleared` once all have landed.
- **Mergeability** — the poller classifies GitHub's `mergeStateStatus`:
  `CLEAN`/`HAS_HOOKS`/`UNSTABLE`/`BEHIND` → `ready`; `DIRTY` → `conflict`;
  `BLOCKED` → `blocked` if a required check is failing, else keep waiting;
  `DRAFT`/`UNKNOWN`/empty → keep waiting. It publishes `merge-ready {mergeState}`.
- **Merge** — `pr.merge` attempts the merge (`NANO_PR_MERGE_METHOD`, default
  `squash`). GitHub auto-enqueues on merge-queue-required branches → the process
  waits for `merge-landed` (poller detects the landed PR). Every attempt is
  recorded in the `merges` audit table.
- **Escalation** — a conflict or a failing gate raises the same
  `pr.persist-escalation` worker as the review stage (status `escalated`), answered
  via the native `wait-merge-answer` `userTask` (the same `completeUserTask` door as
  the review escalation, #256); answering re-arms and retries.
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
| `NANO_PR_WEBHOOK_SECRET` | — | optional shared secret (`X-Hook-Secret`) for guarded operations (e.g. `/app/api/agent`, `/app/api/version`, `/app/api/status`) |
| `NANO_PR_AUTO_MERGE` | 1 | run the merge stage after convergence (`0` = review-only; per-submit `convergeOnly: true` override) |
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
  via the `plan.md` linked resource (`bindingType: latest`); when a prior review
  rejected the plan, the rejection findings ride `appendPrompt` (an ioMapping over
  `planFindings`) rather than being concatenated in FEEL. The agent reads the issue
  via `gh` and emits `tasks: [{ id, title, prompt }]`.
- **`record-plan`** — app worker `pr.record-plan`. Normalizes the tasks (assigns a
  stable `id`/index), writes one `plan_tasks` row each, sets `plans.task_count` and
  status `dispatched`, and **re-emits** the normalized `tasks` so the fan-out
  iterates the canonical list.
- **`implement`** — service task, job type `senior:feature`, **parallel
  multi-instance** over `=tasks` (`inputElement="task"`,
  `outputCollection="results"`). Its base prompt is delivered via the `feature.md`
  linked resource (`bindingType: latest`); each child's per-task brief
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

**App-worker payloads are typed from the model.** Each `pr.*` service task
(`record-plan`, `record-wave`, `record-trial-merge`, `select-wave`,
`record-plan-review`, `resolve-trial-attention`, `record-results`, …) carries an
`io.nanobpm.dataEnvelope.in` shape whose `nano:shapes` express the `tasks`/`results`
lists directly: worker job-I/O envelopes support `list="true"` arrays — both
`nano:extend … list="true"` scalar arrays (e.g. `dependsOn`, `conflicts`) and
`nano:reference … list="true"` object arrays (e.g. `RecordPlanIn.tasks`,
`RecordWaveIn.waveResults`) — which derive to `T[]` in the generated task types
(per #211). This job-I/O shape is codegen/typing-only (no runtime filtering); the
`scalar-only` constraint applies only to **message payload** envelopes that cross
correlation at runtime, not to these worker in/out shapes. The **agent** tasks
(`senior:*`) still self-type `job.variables` inline (like `finalize`).

**Domain model** (`db/migrations/004_planning.sql`): `plans` (one row per issue) +
`plan_tasks` (one row per slice, tracking its `status`/`pr_key`/`summary`).

**Entry points**: the epic page's "Hand an issue to the fleet" form or
`POST /app/api/actions/start/plan-fanout` (either `{ issue, baseBranch }` or
`{ url, baseBranch }` — a `oneOf` naming the target by **exactly one** of `issue`
(`owner/repo#123`) or `url`, plus optional `confirmDefaultBase`/`allowSharedBase`) —
the same flat operation the form posts. `baseBranch`
is required and admitted through the ADR 0003 gate (auto-create `epic/*`, confirm-default,
shared-base guard).

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
- **Adopting a decomposed epic** (`resources/prompts/plan.md` Step 0): when adopting existing
  sub-issues, the planner honours an explicit `Depends-on: #N` / `Blocked by #N`
  directive in a sub-issue body, mapping each prerequisite `#M` to `issue-M` in the
  adopted task's `dependsOn` — so a human-declared blocking order survives adoption.

### 13.2 Trial-merge integration gate (D3) — issue #69

Before a wave's still-open heads land, the fan-out runs a **D3 trial merge** to catch
**emergent** conflicts: heads that merge cleanly but whose *combination* breaks the
target repo's suite. `app/trialMerge.ts` classifies the result `clean | merge-conflict
| suite-failed`; only `suite-failed` escalates (`trialMergeDecision`). Textual
merge-conflicts are pass-through — D2/D6 own merge-exclusion and merge-train ordering.
It runs only for `headCount >= 2` on non-mergify repos (`shouldRunTrialMerge`).

Flow (`resources/processes/plan-fanout.bpmn`): `gw-trial-needed` → `trial-merge`
(`senior:trial-merge`) → `record-trial-merge` (audit row in `plan_trial_merges`) →
`gw-trial` (`trial red?`). On red it opens a plan-level **user task**
(`trial-merge-decision`, task id `trial-merge-wave-<N>`) and parks at
`wait-trial-answer` until it is completed through the task inbox. The operator
answers with `action: "proceed"` to override and continue, or `"rebase"`/`"abandon"`
to **rerun** the trial after pushing a fix (or give up).

**Known gap — inherited vs emergent failures (issue #129, PLANNED).** As shipped, D3
escalates on *any* red combined suite, including a failure that was **already red on
each head individually** (e.g. a per-PR build defect, or a repo-wide workspace
build-ordering bug). That parks a human on something that is not an integration
decision. The target behaviour is an **autonomy ladder**:

1. **Shift-left** — a head whose *required* checks are red never enters the trial merge;
  the convergence loop's `senior:fix-ci` path owns per-PR failures. D3 only sees
  individually-green heads.
2. **Baseline-diff** — the `senior:trial-merge` agent reports, per failing check,
  whether it was green on each head alone; D3 escalates **only** on checks that
  *regress under combination* (green-per-head → red-combined) and attributes inherited
  failures back to the owning head's loop.
3. **Auto-remediation** — for deterministic, agent-diagnosable classes (build ordering,
  lockfile drift, renamed scripts) a `senior:integration-fix` agent pushes the fix and
  reruns the trial before any human is parked (reusing the escalate→wait→rerun/proceed
  branch from the plan-review escalation, PR #128).

A human escalation is then reserved for its one true case: **two slices that each pass
but encode incompatible decisions about a shared contract** — a genuine design call.

## 14. Open questions / future

- **Provisioning the existing PR branch** — resolved: the `c8ctl` host-git
  integration provisions the repo and checks out the PR's head branch (it must
  already give the worker repo access to work at all). The **app** resolves the head
  branch and passes it in the `io.nanobpm.agentTask.repository.{url,ref}` envelope
  (a `createInstance` process variable — see `repoEnvelopeVars`); the harness is
  PR-agnostic and provisions from that envelope. The worker stays a pure provisioner.
- **review-ready via GitHub webhook** — same message, swappable faster trigger,
  when the app is publicly reachable. Deferred (poller-only for v1).
- **Supervised vs external worker** — the agent runs as an external
  `c8ctl nano work` daemon by default; a supervised in-server mode is possible
  later (ADR 0041 decision).
- **Autonomous D3** — shift-left + baseline-diff + auto-remediation so the trial-merge
  gate only escalates genuine cross-slice design conflicts (§13.2, issue #129).
- **Prompt versioning/hash** per PR for auditability.
- **Auth on the web UI** — the manifest `security` block (ADR 0028) if this is
  exposed beyond localhost.
