# Nano Workforce

**Agent Graph Orchestration for Agentic SDLC.** Nano Workforce turns a fleet of
AI coding agents into a durable, self-driving software-delivery workforce: hand it
an issue and it plans the work, fans a graph of agents out to implement it, drives
every resulting pull request to **review convergence** against an automated
reviewer, and **merges** it — escalating to a human only when an agent is stuck or
a round cap is hit.

It is a [Nano](https://nanobpm.io) **Urban app**: a set of durable
BPMN processes (`resources/processes/*.bpmn`) executed by the Nano engine, with the
orchestration graph — planning, implementation, review, and merge — modelled
explicitly so the whole lifecycle survives restarts, latency, and failure.

- **Plan → implement** — a planning agent decomposes an issue into levelized tasks;
  a parallel fan-out drives one implementation agent per task, one PR each.
- **Review convergence** — each PR runs a durable multi-round loop against an
  automated reviewer until it converges (or escalates).
- **Merge** — a converged PR flows into a merge loop that clears dependencies,
  auto-fixes failing CI, and merges (queue-aware), escalating conflicts.

The agents are external workers you "hire" (any coding-agent CLI harness, e.g. the
GitHub Copilot CLI). Nano Workforce owns the orchestration; the agents do the work.

---

## Install & run in Nano Studio (recommended)

Nano Workforce ships as a Nano Studio **extension**. Studio installs it from the
marketplace, scaffolds a project from it, runs it as a first-class app in the left
rail, and keeps it up to date.

1. **Install the Urban toolkit** (once): Studio → **Extensions** → search
   `@nanobpm/nano-ide-app-urban` → **Install**. This provides the `urban` runtime/CLI
   that every Urban app builds on. (Studio installs it automatically the first time
   you create an Urban project.)

2. **Install Nano Workforce**: Studio → **Extensions** → search
   `@nanobpm/nano-workforce` (or browse the **Agentic SDLC** category) → **Install**.

3. **Create a project**: Studio → **New Project** → pick **Nano Workforce** →
   name it → **Create**. Studio copies the app into your workspace and records the
   version it was scaffolded from.

4. **Configure**: in the project's settings, set at least `GITHUB_TOKEN` and, if the
   engine isn't at the default, `NANOBPMN_BASE_URL` (or `CAMUNDA_REST_ADDRESS`). See
   [Configuration](#configuration).

5. **Run**: press **Run**. The app starts, deploys its BPMN, hosts its record
   workers, and appears in the **left rail** as **Nano Workforce** with its embedded
   UI (submit a PR, hand over an issue, answer escalations). Stop/Restart from the
   same pane.

6. **Hire agents**: the orchestration is running, but it needs agents to do the
   engineering. See [Hire your agents](#hire-your-agents).

### Updating an installed project

When a new version of the extension is published, Studio flags the project with an
**"Update available"** badge. Click it to review the change, then **Apply**:

- Studio does a **three-way merge** against the version you originally scaffolded
  from — new files are added, files only the app changed are updated, and files you
  and the app both changed are auto-merged where they don't overlap.
- **Conflicts** (a file you and the new version both edited in the same place) are
  listed and **left for you to resolve** — nothing is clobbered silently.
- Your **data is never touched**: `app.db` (and its WAL/SHM), `node_modules`,
  `.git`, and generated dirs are always preserved. The runtime re-applies
  `db/migrations` on the next boot, so your PRs/rounds/escalations survive the update.

Preview first with a dry-run (Studio shows the plan — created / overwritten /
merged / conflicting — before writing anything).

---

## Run from the CLI (second-class)

You can also run Nano Workforce directly, outside Studio, against a running Nano
engine. This is the second-class path — no left-rail integration or update UI — but
it's the same app and the same behaviour.

### Prerequisites

- A running **Nano gateway/engine** (default `http://localhost:8080`) — what the app
  deploys to and what agents pull jobs from.
- **[Node](https://nodejs.org/) >= 22.6** (the app hosts on Node built-ins;
  `@nanobpm/urban` declares `engines.node >=22.6`).
- The **c8ctl CLI with the `nano` plugin** (to hire/run agents).
- On each agent host: the **GitHub CLI** logged in (`gh auth login`) or a
  `GITHUB_TOKEN`/`GH_TOKEN` in the environment, plus the agent harness itself (e.g.
  the [Copilot CLI](https://github.com/github/copilot-cli)).

### Install, configure, run

```sh
npm install

export CAMUNDA_REST_ADDRESS=http://localhost:8080/v2   # or NANOBPMN_BASE_URL=http://localhost:8080
export GITHUB_TOKEN=ghp_...                             # for the review poller / merge
export PR_REVIEW_PORT=3000                              # app HTTP port (default 3000)

npm start        # → http://localhost:3000
# or, via the urban CLI:
urban run        # `urban gen` then run
```

That deploys the processes, starts the app-hosted record workers, serves the web UI,
and runs the review-ready poller.

### Upgrade a CLI install

```sh
npm run upgrade                              # dry-run against @latest
npm run upgrade -- --apply                   # apply the overlay, preserving app.db
npm run upgrade -- --version 0.26.0 --apply  # pin a specific version
npm run upgrade -- --from ./pkg.tgz --apply  # from a local tarball (offline)
```

The upgrade overlays the new pack's files, preserves your `app.db`/`node_modules`/
`.git`/generated dirs, and reports what changed. Reinstall deps if `package.json`
changed, then restart — migrations re-apply on boot, keeping your data.

---

## Hire your agents

An agent is a CLI harness (the Copilot CLI here) turned into a Nano job worker. Hire a
profile whose **rank + capabilities** subscribe it to the `senior:*` job types the
app emits, then put it to work:

```sh
c8ctl nano hire \
  --name fleet \
  --rank senior \
  --capabilities pr-review plan plan-review feature trial-merge fix-ci rebase retro \
  --command 'copilot -p - --allow-all-tools' \
  --model <your-model>

c8ctl nano work fleet         # polls every senior:* agent task below until Ctrl-C
```

`--rank senior` × those eight capabilities subscribes the worker to exactly the agent
task types the four workflows emit (one `senior:<capability>` job type per
capability):

| Capability | Job type | Workflow | Task |
| --- | --- | --- | --- |
| `pr-review` | `senior:pr-review` | `convergence-loop` | Review round (drive a PR to convergence) |
| `plan` | `senior:plan` | `plan-fanout` | Plan an issue into levelized tasks |
| `plan-review` | `senior:plan-review` | `plan-fanout` | Review the plan before fan-out |
| `feature` | `senior:feature` | `plan-fanout` | Implement one planned task → open a PR |
| `trial-merge` | `senior:trial-merge` | `plan-fanout` | Integration gate: trial-merge a wave, catch semantic conflicts CI can't see |
| `fix-ci` | `senior:fix-ci` | `merge-loop` | Green a `blocked` PR's failing checks |
| `rebase` | `senior:rebase` | `merge-loop` | Rebase a conflicting PR up to date with its base |
| `retro` | `senior:retro` | `retro` | Synthesize a finished epic's learnings and promote the recurring ones |

- `--command 'copilot -p - --allow-all-tools'` starts the Copilot CLI reading its
  prompt from **stdin** (`-p -`). The harness pipes the whole job JSON (prompt +
  `job.variables`) to stdin; the relevant `prompts/*.md` template tells the agent how
  to read it and where to write its result.
- **`--allow-all-tools` is essential** for an unattended worker — without it Copilot
  pauses for permission before each tool call and the job stalls.

  > ⚠️ **Only enable `--allow-all-tools` for code and hosts you trust.** It grants the
  > agent broad unattended permissions (shell, file writes, network). Each job runs in
  > a throwaway per-job workspace, but the worker still runs as your user on the host.
  > Use `--deny-tool` to narrow it, or a container sandbox for stronger isolation.

Run a **second** worker (another terminal or machine) and they alternate across
whichever PRs/tasks are ready — that is the idle time you reclaim. Run more than one
job per worker with `--max-parallel 2`. The app-hosted `pr.*` workers (record-plan,
select-wave, finalize, merge, …) run **inside** the app, not on an agent worker.

Already have a narrower worker? Extend it in place instead of re-hiring — this unions
the roles onto the profile, then restart its worker:

```sh
c8ctl nano assign <name> pr-review plan plan-review feature trial-merge fix-ci rebase retro
```

---

## What it does

### Submit a PR → review convergence

Submit a PR (from the UI as `owner/repo#123` or a PR URL, the API, or the webhook) and
one durable `convergence-loop` starts. Each round dispatches a `senior:pr-review`
agent; between rounds the process **parks on a durable message-catch event**, so agent
slots and job timeouts are never held hostage to review latency. The poller watches
GitHub and publishes `review-ready` when a new review lands (no webhook needed — works
behind NAT).

```
 submit (UI / webhook) ──► convergence-loop (BPMN)
                              │  converged ──► finalize ──► (merge stage)
   Review round (agent) ──────┼  addressed ──► record ──► wait review-ready ─┐
   taskType senior:pr-review  └  needs_input/blocked ─► escalate ─► wait ────┤
        ▲                                              escalation-answered   │
        └──────────────────────── loop ───────────────────────────────────  ┘
```

### Merge stage

With `NANO_PR_AUTO_MERGE` on (default), a converged PR flows into `merge-loop`: it
parks until any `Depends-on:` PRs have landed, arms the merge, auto-detects a merge
queue (waits for landing) vs a straight squash/merge/rebase, and — on a `blocked`
verdict (a required check failed) — dispatches a `senior:fix-ci` agent to green the
branch before escalating (`NANO_PR_MAX_CI_FIX_ROUNDS`, default 3). Conflicts, an
exhausted budget, or an agent that can't fix the build escalate to a human; answer in
the UI and the process re-arms and retries.

A single submission can pin **review-only** regardless of the global default by
passing `convergeOnly: true` on the `start/convergence-loop` request — the PR stops at
`converged` and is never handed to `merge-loop`, even with `NANO_PR_AUTO_MERGE` on.

### Fleet mode: hand it an issue (plan → implement → converge)

```
 issue (UI / POST /app/api/actions/start/plan-fanout) ─► plan-fanout (BPMN)
    plan (senior:plan) ─► record-plan ─► implement × N (parallel, senior:feature) ─► record-results
                                                                                       │
                                          each opened PR ──► convergence-loop (above)
```

A planning agent decomposes the issue into tasks; a parallel multi-instance activity
fans them out over implementation agents (one PR per task); `record-results` enrols
every opened PR into the convergence loop. Submit from the **"Hand an issue to the
fleet"** form, or POST the same operation the form does:

```bash
curl -sS -X POST http://localhost:3000/app/api/actions/start/plan-fanout \
  -H 'content-type: application/json' \
  -d '{ "issue": "owner/repo#123" }'
```

---

## Configuration

| env | default | purpose |
|---|---|---|
| `PR_REVIEW_PORT` | `3000` | app HTTP port |
| `NANO_APP_DB_URL` | `file:./app.db` | sqlite datasource |
| `NANOBPMN_BASE_URL` | `http://localhost:8080` | engine base URL (or set `CAMUNDA_REST_ADDRESS` to the `/v2` REST address directly) |
| `GITHUB_TOKEN` | — | token for the review poller / merge (or use the host `gh` CLI) |
| `NANO_PR_GITHUB_TRANSPORT` | `auto` | how the poller reads GitHub: `gh` (host CLI), `token` (`GITHUB_TOKEN` over HTTP), or `auto` |
| `NANO_PR_POLL_MS` | `60000` | review-ready poll interval |
| `NANO_PR_MAX_ROUNDS` | `20` | default cap: escalate after N rounds (per-submit override via the form / the `maxRounds` field on `start/convergence-loop`; clamped 1–100) |
| `NANO_PR_WEBHOOK_SECRET` | — | optional shared secret (`X-Hook-Secret`) for guarded hook operations (e.g. `POST /app/api/hooks/agent`, `/app/api/hooks/version`); unset = open |
| `NANO_PR_AUTO_MERGE` | `1` | after convergence, run the merge stage; `0` = stop at `converged` (review-only). Per-submit override via the `convergeOnly` field on `start/convergence-loop` (`true` forces review-only for that PR) |
| `NANO_PR_MERGE_METHOD` | `squash` | merge method: `squash`, `merge`, or `rebase` |
| `NANO_PR_MERGE_ADMIN` | `0` | pass `--admin` to override failing non-required checks (use with care) |
| `NANO_PR_MAX_CI_FIX_ROUNDS` | `3` | max `senior:fix-ci` attempts to green a `blocked` PR before escalating; `0` disables (escalate immediately), clamped 0–20 |
| `NANO_PR_REVIEW_WAIT_TIMEOUT` | `PT20M` | ISO-8601 duration the loop waits for a fresh review before escalating a stalled review (timer arm of the `wait-review` gateway) |
| `NANO_PR_REVIEW_NUDGE_MINUTES` | `5` | cooldown between the poller's automatic reviewer re-request nudges for one waiting PR (clamped 1–1440) |

### Purge

The app keeps its own SQLite state (PRs/rounds/escalations) separate from the engine.
When you purge and restart the engine, wipe the app db too so they stay consistent:

```sh
npm run purge   # deletes app.db (+ WAL/SHM) and re-applies db/migrations
```

---

## The agents (external workers)

The `senior:*` tasks are serviced by **external** workers — they are **not** in the
manifest `workers[]`. Point a `c8ctl nano work` daemon (or any Zeebe-style worker) at
the task types; each job carries its variables (e.g. `senior:pr-review` gets `{prUrl,
repo, prNumber, round, answer?}` and returns `{status, summary, question?}`). An
agent's base prompt is **not** in the job payload — it is delivered via a model
**template header** (`{{review-round}}`, `{{plan}}`, `{{feature}}`, `{{fix-ci}}`, …)
substituted at deploy time from `prompts/*.md` (`models.templates` in `nano.app.json`);
per-instance context (e.g. a human's escalation answer) is appended by the harness.

---

## Point an agent at it (self-serve guide)

The running app serves a live **agent operator guide** at
`GET /app/api/agent` — how to submit PRs (review-only vs. merge), hand over an epic,
answer escalations, and **debug** the system (find engine instances, relate them to
PRs, inspect the models/prompts, unstick stuck processes, and raise issues/PRs). Its
examples are keyed to the instance you fetched it from, so a coding agent can drive
**and** debug the workforce with no extra context:

```bash
curl -sS http://localhost:3000/app/api/agent | jq -r .instructions
```

Like `/version` and `/status`, this endpoint honours the optional
`NANO_PR_WEBHOOK_SECRET` guard (`X-Hook-Secret` header): when that secret is set it
returns `401` without the matching header; unset = open. The source lives in
`resources/agent-guide.md`.

---

## Architecture & contributing

- **[SPEC.md](SPEC.md)** — the behavioural source of truth for the processes.
- **[AGENTS.md](AGENTS.md)** — the operational guide for anyone (human or AI) making
  changes: engineering principles, the BPMN authoring rules (author the semantic
  model, **generate** the diagram — CI enforces DI freshness), migration policy, and
  the CI gates.

## License

Apache-2.0 — see [LICENSE](LICENSE).
