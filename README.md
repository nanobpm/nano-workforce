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
| `conformance` | `senior:conformance` | `retro` | Examine a finished epic's implementation against its spec; report met/deviations on the issue, and escalate an unmet/undisclosed deviation to the Tasks inbox as a non-blocking ack |

- `--command 'copilot -p - --allow-all-tools'` starts the Copilot CLI reading its
  prompt from **stdin** (`-p -`). The harness pipes the whole job JSON (prompt +
  `job.variables`) to stdin; the relevant `resources/prompts/*.md` resource (linked into
  the task and fetched by the harness at activation) tells the agent how
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
  -d '{ "issue": "owner/repo#123", "baseBranch": "epic/agent-protocol" }'
```

`baseBranch` is **required** (ADR 0003) — it's the integration branch the whole fleet
branches off and opens every PR against. A missing `epic/*` base is auto-created off the
default branch's HEAD; a missing non-`epic/*` base is a `400` (must already exist). Two
optional flags gate the dangerous cases: `confirmDefaultBase: true` is required to name the
repository default branch as the base, and `allowSharedBase: true` is required when another
active epic already targets the same custom base. See
[ADR 0003](docs/adr/0003-epic-base-branch-admission.md) for the full admission model.

---

## Delivery graphs

Beyond a single PR (review convergence) and an epic (plan → fan-out), Nano Workforce can
run an **arbitrary, heterogeneous, cross-repo, partly-human delivery graph** — e.g.
*merge PR #A → un-draft+merge PR #B → a human runs a manual OTP publish → PR #C consumes
the just-published version*. You author the graph as **JSON over a closed node vocabulary**
(`agent` | `wait` | `human` | `connector`) — never BPMN or code — whose edges are
**discovered facts** (`from: "<node>.<fact>"`). A deterministic compiler turns it into an
engine-native process; a human previews the staged proposal and dispatches it from the
cockpit before any side effect runs.

Two doors — and the second is **operator-only** (issue #460): a
`POST /app/api/actions/compile-delivery-graph` on the agent surface that validates + previews
the graph and **stages** it as a proposal (the agent surface ends there — no run key or token
comes back), and a `POST /app/api/actions/delivery-graph/dispatch` the **cockpit** uses to
dispatch a staged proposal by its content `digest` (idempotent, at-most-once). There is no
agent `start` door to replay — the human clicking Dispatch in the cockpit is the approval.

The agent guide served at `GET /app/api/agent` documents the full vocabulary, both
operation contracts, and a complete worked example — see §9 there, or point your coding
agent at that URL to author, compile, and submit a graph unaided. See
[ADR 0005](docs/adr/0005-agent-authored-delivery-graphs.md) for the design and rationale.

---

## Configuration

| env | default | purpose |
|---|---|---|
| `PR_REVIEW_PORT` | `3000` | app HTTP port |
| `NANO_APP_DB_URL` | `file:./app.db` | sqlite datasource |
| `NANOBPMN_BASE_URL` | `http://localhost:8080` | engine base URL (or set `CAMUNDA_REST_ADDRESS` to the `/v2` REST address directly). See [Engine address & the startup preflight](#engine-address--the-startup-preflight) |
| `GITHUB_TOKEN` | — | token for the review poller / merge (or use the host `gh` CLI) |
| `NANO_PR_GITHUB_TRANSPORT` | `auto` | how the poller reads GitHub: `gh` (host CLI), `token` (`GITHUB_TOKEN` over HTTP), or `auto` |
| `NANO_PR_POLL_MS` | `60000` | review-ready poll interval |
| `NANO_PR_MAX_ROUNDS` | `20` | default cap: escalate after N rounds (per-submit override via the form / the `maxRounds` field on `start/convergence-loop`; clamped 1–100) |
| `NANO_PR_WEBHOOK_SECRET` | — | optional shared secret (`X-Hook-Secret`) for guarded operations (e.g. `POST /app/api/agent`, `/app/api/version`, `/app/api/status`); unset = open |
| `NANO_PR_AUTO_MERGE` | `1` | after convergence, run the merge stage; `0` = stop at `converged` (review-only). Per-submit override via the `convergeOnly` field on `start/convergence-loop` (`true` forces review-only for that PR) |
| `NANO_PR_MERGE_METHOD` | `squash` | merge method: `squash`, `merge`, or `rebase` |
| `NANO_PR_MERGE_ADMIN` | `0` | pass `--admin` to override failing non-required checks (use with care) |
| `NANO_PR_MAX_CI_FIX_ROUNDS` | `3` | max `senior:fix-ci` attempts to green a `blocked` PR before escalating; `0` disables (escalate immediately), clamped 0–20 |
| `NANO_PR_REVIEW_WAIT_TIMEOUT` | `PT20M` | ISO-8601 duration the loop waits for a fresh review before escalating a stalled review (timer arm of the `wait-review` gateway) |
| `NANO_PR_REVIEW_NUDGE_MINUTES` | `5` | cooldown between the poller's automatic reviewer re-request nudges for one waiting PR (clamped 1–1440) |
| `NANO_WORKFORCE_BASE_URL` | `http://localhost:3000` | externally-reachable base URL for the capability hooks (`/app/api/hooks/*`). Must resolve from **wherever the agent runs** — set it to the app's LAN address (or console-proxy URL) for a remote fleet. See [Fleet networking](#fleet-networking-remote-workers) |
| `NANO_AGENTIC_SECRET` | — | enables **secure mode** for the agentic visibility channel (`/agentic`): every peer must present the **same** `NANO_AGENTIC_SECRET` value (set the identical env var on the server and every worker box — Tab A → Slot A). Unset = on-by-default **LOCAL mode** — the well-known token is honoured from **any origin** (open on the trusted LAN, matching the engine's posture); exposure is governed by the server bind address, not a shared secret. Also accepts `NANO_PR_WEBHOOK_SECRET` |

### Engine address & the startup preflight

The app talks to one engine over the Camunda 8 REST API. The REST address is
resolved with a fixed precedence — set **one** of:

1. **`CAMUNDA_REST_ADDRESS`** — used verbatim (it already points at the `/v2`
   REST address, e.g. `http://engine.example:8080/v2`). **Wins** if set.
2. **`NANOBPMN_BASE_URL`** — the engine *base*; the app appends `/v2`
   (e.g. `http://localhost:7000` → `http://localhost:7000/v2`).
3. Neither set → the base defaults to **`http://localhost:8080`**.

At boot the app **echoes the resolved address and which input it came from**,
then probes `/v2/topology` and announces **which engine answered** — so a
misconfigured address is obvious immediately instead of surfacing later as a
cryptic mid-run engine error:

```
Engine address: http://localhost:8080/v2 (from default (http://localhost:8080))
Engine: Nano engine (nanobpmn v0.114.1) — Falcon streaming at /falcon at http://localhost:8080/v2.
```

The preflight is **informational, never a gate** — Nano Workforce runs against a
stock **Camunda 8** cluster too, so a non-Nano engine is announced
(`Engine: Camunda 8 (gateway v8.x) — REST only …`), not rejected. If nothing
answers, it logs a `warn` (`could not reach … features will fail to start until
the engine is reachable`) and boot continues. On a **secured** cluster the probe
sends `CAMUNDA_TOKEN` as a bearer credential; a `401/403` is reported as an auth
hint (check `CAMUNDA_TOKEN`), not as an unreachable engine.

> **Watch the port when launched from a console.** A console-launched app can
> default `NANOBPMN_BASE_URL` to `http://localhost:8080`. If **another Camunda 8**
> is already on `:8080`, the app will talk to *that* engine (it works — C8 is
> supported), which may not be the engine you intended. Check the startup
> `Engine:` line; to target a Nano engine on a different port, set
> `NANOBPMN_BASE_URL` (or `CAMUNDA_REST_ADDRESS`) explicitly.
>
> When the app *can't* work against the reached engine you'll see a job/instance
> decode error at first feature start — `MalformedFrameError` / `MalformedJobError`
> (Falcon) or the Camunda REST client's own `4xx` (older versions surfaced
> `engine response missing processInstanceKey/key`). The startup `Engine:` line
> tells you which engine you actually reached, before any such error.


### Fleet networking (remote workers)

`nano-workforce` can drive a **distributed worker fleet** — `senior:*` agents running on other LAN
machines. Two app surfaces must be reachable from those off-box workers:

- The **capability hooks** — `/app/api/hooks/abandon` and `/app/api/hooks/blackboard`. Every
  side-effecting agent is handed an unguessable per-run capability URL in its prompt and `curl`s it
  before each irreversible action (an unknown token is a `404`). A remote worker can only reach these
  if (a) the app's HTTP server is bound so off-box hosts can connect, and (b) the base URL baked into
  that prompt resolves from the worker's host — hence **`NANO_WORKFORCE_BASE_URL` must be the app's
  LAN address, not `localhost`**. This base is **captured at instance-seed time** and baked into each
  agent's prompt, so changing it later does **not** heal already-running instances — re-seed them to
  pick up the new base.
- The **agentic visibility channel** — `/agentic` (WebSocket). In on-by-default **LOCAL mode** it is
  gated only by a *well-known, non-secret* token that the hub honours from **any origin** — so an
  off-box or reverse-proxied peer appears live with no shared secret, matching the open trusted-LAN
  posture of the engine itself. Exposure therefore depends on network reachability — the app's
  **bind address** (below) *and* any reverse proxy or port forwarding in front of it — not on the
  channel: bound to loopback it stays on-box *unless a same-host proxy forwards `/agentic`*, bound
  wide it is reachable across the LAN. The startup WARN only reflects what the server can verify about
  its own bind (it fires when it binds wide in LOCAL mode); it cannot see proxy-forwarded exposure. To
  *authenticate* the channel
  instead of leaving it open, run it in **secure mode** by setting `NANO_AGENTIC_SECRET` — the
  **same** env var name and value on the server and on every worker box (the worker presents it as
  its identity token, the hub verifies it against its own). (Fleet coordination itself does not
  depend on this channel — it is visibility only.)

#### Bind the HTTP server

The capability hooks are only reachable off-box if the app's HTTP server binds to a routable
interface. The declarative, per-app control is an **app-manifest** setting (loopback by default,
opt-in to all interfaces):

```jsonc
// nano.app.json
{ "network": { "bind": "all" } }   // 0.0.0.0 / :: — expose to the LAN for a remote fleet
```

> **Status:** this manifest key is delivered by the Urban runtime in
> [`nanobpm/nano-ide#235`](https://github.com/nanobpm/nano-ide/issues/235) (add the field to the app
> schema + plumb the bind host to the node adapter). This repo already ships
> `"network": { "bind": "all" }` so a fleet reaches the hooks off-box. The agentic visibility channel
> is **open on the LAN by default** in LOCAL mode (governed by the bind address, with a startup WARN
> when bound wide), so no loopback-only guard stands between a wide bind and remote worker visibility —
> set `NANO_AGENTIC_SECRET` if you want to authenticate that channel instead.

#### Choose a path: direct LAN bind vs console proxy

nwf composes with two deployment topologies — pick one and point the fleet at it:

| Path | When | Fleet uses |
|---|---|---|
| **Direct LAN bind** | nwf run standalone for a fleet | Bind the server wide (above) and set `NANO_WORKFORCE_BASE_URL=http://<app-lan-host>:3000`. Workers `curl` the hooks directly on the app's LAN address. |
| **Console reverse-proxy** | nwf embedded behind the nano console at `/console/app-view/Workforce` | Leave the app bound to loopback and set `NANO_WORKFORCE_BASE_URL` to the console's public origin + the app-view prefix, so `/app/api/hooks/*` resolves through the proxy. Workers reach the hooks via the console. |

Either way the capability URL in each agent's prompt (`${NANO_WORKFORCE_BASE_URL}/app/api/hooks/…`)
must resolve from the worker's host. **Verify** from a fleet host before relying on it:

```sh
# From a remote LAN worker, against the base URL seeded into agent prompts.
# A live run returns { "prKey": "...", "status": "...", "abandoned": false }; -f exits non-zero on 404.
curl -fsS "${NANO_WORKFORCE_BASE_URL}/app/api/hooks/abandon?token=<per-run-token>"
```

If the `curl` cannot reach the host, off-box agents will (correctly, per the abort contract) treat the
run as abandoned and stop — the exact failure behind
[`jwulf/c8ctl-plugin-nano#76`](https://github.com/jwulf/c8ctl-plugin-nano/issues/76). Fix it by
binding wide + setting a routable `NANO_WORKFORCE_BASE_URL`, or by fronting nwf with the console proxy.


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
agent's base prompt is **not** in the job payload — it is delivered as a
**linked resource** (likewise `plan.md`, `feature.md`, `fix-ci.md`, …):

```xml
<zeebe:linkedResource resourceId="review-round.md" bindingType="latest" resourceType="GenericScript" linkName="prompt"/>
```

that the engine resolves to the latest deployed `resources/prompts/*.md` at job
activation (the prompts deploy as generic resources under the `resources/` deploy-by-
convention layout — `nano.app.json` declares no `models`; ADR 0062); per-instance context
(e.g. a human's escalation answer) is appended
by the harness. Because the binding is `latest`, redeploying one `resources/prompts/*.md`
updates the prompt for the next activation in a **running** epic — see SPEC §9.

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
`docs/agent-guide.md`.

### Configure an agent over MCP

Where your agent supports **MCP**, prefer it over the curl path above. The Urban
runtime serves a Streamable-HTTP MCP endpoint at **`/app/mcp`** for every instance and
projects this app's `openapi.yaml` into tools with **zero MCP code in nwf** — the app
operations, a framework-owned engine-debug tool family (process instances, wait states,
variables, incidents), the `urban_*` projection reads, and the operator guide as an MCP
**resource** (ADR 0067, nano-ide#488). Register one server entry per instance and name
it when you drive — tool calls are namespaced per entry, so the wrong-instance mistake
becomes impossible:

```bash
copilot mcp add --transport http workforce-local http://localhost:3000/app/mcp
# guarded instance: add the app secret as a header (never in chat)
copilot mcp add --transport http workforce-merlin http://merlin.local:3000/app/mcp \
  --header "x-hook-secret: $NANO_PR_WEBHOOK_SECRET"
```

Reads work from loopback with no credential; mutations require the instance secret as a
header when `NANO_PR_WEBHOOK_SECRET` is set. **Operator-only doors stay operator-only** —
delivery-graph **dispatch** (and the stage/dismiss lifecycle) is `x-mcp`-excluded, so the
human clicking Dispatch in the cockpit remains the approval (ADR 0005). MCP is a **third
door**: `GET /app/api/agent` and `GET /app/api/agent/skill` are unchanged for agents
without it.

The full recipe — multiple instances, Basic-Auth-fronted instances, LAN exposure,
verification and wedged-instance debugging prompts — is the **agent-configuration
runbook**: [`docs/mcp-runbook.md`](docs/mcp-runbook.md).

---

## Architecture & contributing

- **[SPEC.md](SPEC.md)** — the behavioural source of truth for the processes.
- **[AGENTS.md](AGENTS.md)** — the operational guide for anyone (human or AI) making
  changes: engineering principles, the BPMN authoring rules (author the semantic
  model, **generate** the diagram — CI enforces DI freshness), migration policy, and
  the CI gates.

### Dependency updates (Renovate)

First-party `@nanobpm/*` packages (notably `@nanobpm/urban`) are kept current by a
self-hosted [Renovate](https://docs.renovatebot.com/) runner:
[`.github/workflows/renovate.yml`](.github/workflows/renovate.yml) runs on a schedule (and
`workflow_dispatch`), opens update PRs, and — per [`renovate.json`](renovate.json) — merges
non-major `@nanobpm/*` bumps once CI is green while leaving majors for a human.

It requires a repository secret **`RENOVATE_TOKEN`**: a Personal Access Token with `repo` +
`workflow` scope (or a fine-grained PAT with *Contents: read & write*, *Pull requests: read &
write*, *Issues: read & write* — the Dependency Dashboard is a GitHub Issue — and *Workflows:
read & write*, so Renovate can update files under `.github/workflows`). A PAT is
mandatory rather than the built-in `GITHUB_TOKEN` because PRs opened by `GITHUB_TOKEN` do not
trigger `on: pull_request` CI — so the "merge when green" gate would never fire. Set it via
`gh secret set RENOVATE_TOKEN --repo nanobpm/nano-workforce` (or repo → Settings → Secrets →
Actions), then trigger a first run from the Actions tab.

## License

Apache-2.0 — see [LICENSE](LICENSE).
