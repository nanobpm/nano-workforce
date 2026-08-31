# Nano Workforce — agent operator guide

You are an AI assistant helping a human operate a running **Nano Workforce**
instance. Nano Workforce is a durable orchestration app (a [Nano](https://nanobpm.io)
Urban app) that drives pull requests to **review convergence** against an automated
reviewer, then **merges** them, and can take a whole issue and **plan → implement →
converge** it across a fleet of coding agents.

This document is served live by the running app so you always match the deployed
version. Use it to **drive** the workforce (submit work, answer escalations) and to
**debug** it (find stuck instances, relate them to PRs, inspect the models/prompts,
and unstick or report problems).

- **App control API base:** `__BASE__`
- **Engine (Nano/Camunda-8 v2 REST) base:** `__ENGINE__`
- **Source repository:** `nanobpm/nano-workforce`

Everything below assumes the app control API is reachable at `__BASE__`. Most app
endpoints are mounted under that base (ADR 0059), but a few siblings sit outside it —
notably the interactive docs (Swagger UI) at `__BASE__/../api-docs` and the action
endpoints (e.g. the cancel action at `/app/actions/cancel`). Paths below are written
in full so you can tell which are under the control-API base and which are not.

---

## 0. Orient yourself first

Before acting, confirm what is running and what is in flight. **Prefer the projected
tools** (`getVersion`, `listActivePrs`); curl is the no-MCP fallback only. Every step in
this guide that has a tool is mapped in the **tool↔curl crosswalk (§10)** — reach for the
tool first and drop to curl only when you are not driving this instance over MCP.

```text
# Which code is live (app version, urban version, git sha/branch, uptime):
tool: getVersion            # GET /version

# Every PR currently in flight (not converged/abandoned), with its engine
# process key, status, round, and any open escalation:
tool: listActivePrs         # GET /status
```

```bash
# No-MCP fallback (agent without the projected tools):
curl -sS __BASE__/version | jq
curl -sS __BASE__/status | jq
```

`listActivePrs` (the `/status` endpoint) is your primary situational-awareness surface.
Each entry carries:
`prKey` (`owner/repo#123`), `status`, `round`, `processKey` (the **engine process
instance key** — the bridge to the engine REST API, §5), `openEscalation`,
`activeWorker`/`leaseUntil` (is an agent actually working the round, or is the job
just queued), and `updatedAt`.

---

## 1. Submit a PR for review convergence

One PR → one durable `convergence-loop`. Each round dispatches a `senior:pr-review`
agent; between rounds the process parks on a durable message-catch, so review latency
never holds an agent slot. The app's poller watches GitHub and republishes
`review-ready` when a new review lands.

```bash
# Minimal: converge, then merge (if NANO_PR_AUTO_MERGE is on — the default).
curl -sS -X POST __BASE__/actions/start/convergence-loop \
  -H 'content-type: application/json' \
  -d '{ "pr": "owner/repo#123" }'
```

The body is flat. Fields:

| field | type | meaning |
|---|---|---|
| `pr` (or `url`) | string | the PR — `owner/repo#123` or a full PR URL. Required. |
| `convergeOnly` | boolean | **`true` = review only.** The PR stops at `converged` and is **never** handed to the merge loop, even when `NANO_PR_AUTO_MERGE` is on. Omit / `false` = converge **then merge**. |
| `maxRounds` | integer | per-submit cap before escalating (clamped 1–100; default from `NANO_PR_MAX_ROUNDS`, 20). |
| `dependsOn` | string[] | other `prKey`s that must land before this one merges (merge-loop barrier). |

**Converge-only vs. converge-and-merge — choose deliberately:**

```bash
# Review only — do NOT merge (use when the human wants to merge by hand,
# or is only after a review pass):
curl -sS -X POST __BASE__/actions/start/convergence-loop \
  -H 'content-type: application/json' \
  -d '{ "pr": "owner/repo#123", "convergeOnly": true }'

# Converge then merge, with a dependency barrier and a tighter round cap:
curl -sS -X POST __BASE__/actions/start/convergence-loop \
  -H 'content-type: application/json' \
  -d '{ "pr": "owner/repo#42", "maxRounds": 8, "dependsOn": ["owner/repo#40"] }'
```

Submitting is **idempotent on the PR key** — re-POSTing the same PR refreshes the
aggregate rather than starting a duplicate loop. The response (202) echoes the
`prKey` and the engine `processKey`.

---

## 2. Submit an epic (plan → implement → converge)

Hand the fleet a whole issue. A planning agent decomposes it into levelized tasks; a
parallel fan-out drives one implementation agent per task (one PR each); every opened
PR is then enrolled into its own convergence loop (§1).

```bash
curl -sS -X POST __BASE__/actions/start/plan-fanout \
  -H 'content-type: application/json' \
  -d '{ "issue": "owner/repo#123", "baseBranch": "epic/agent-protocol" }'
```

The body is flat: `issue` (or `url`) — `owner/repo#123` or an issue URL — plus a REQUIRED
`baseBranch` (ADR 0003), the branch the fleet branches off and opens every PR against; a
blank/absent base is rejected with a 400. Starting a
plan is idempotent on the plan key; an already-running plan short-circuits. The
response (202) echoes the `planKey` and engine `processKey`.

### Base-branch admission (ADR 0003)

`startPlanFanout` admits the base through one fail-fast gate before any task fans out.
Four ordered rules govern which base is accepted:

1. **Required + explicit.** `baseBranch` is mandatory — a blank/absent value is a `400`
   (`MissingBaseBranchError`), and an implausible name is a `400` (`InvalidBaseBranchError`).
   There is no silent "land on the default branch" fallback.
2. **Create-if-missing, `epic/*` only.** A missing `epic/*` base is **auto-created** off the
   repository default branch's HEAD (idempotently — an existing branch is never reset). A
   missing base that is **not** `epic/*` is a clean `400` (`BaseBranchMustExistError`): a typo
   can't silently spawn a wrong-rooted branch, so any non-`epic/*` base must already exist.
3. **Confirm-default.** Naming the repository **default branch** as the base requires
   `confirmDefaultBase: true`, else `400` (`DefaultBaseNotConfirmedError`). This is a
   deliberate acknowledgement that every task lands directly on the default branch with no
   integration buffer, and any merge-to-default side effect fires per task.
4. **Shared-base guard.** If another **active** epic (status not `done`/`failed`/`abandoned`)
   already targets the **same repo + same custom base**, admission is a `409` (`SharedBaseError`)
   unless you pass `allowSharedBase: true`. The default branch is exempt — many epics target it
   concurrently without colliding.

So the body may also carry two optional booleans — `confirmDefaultBase` and `allowSharedBase` —
each a "warn you can't skip" for its rule:

```bash
curl -sS -X POST __BASE__/actions/start/plan-fanout \
  -H 'content-type: application/json' \
  -d '{ "issue": "owner/repo#123", "baseBranch": "main", "confirmDefaultBase": true }'
```

Grandfathered: in-flight plans launched before this admission gate (with a `null` base branch)
keep running unchanged — the requirement is enforced at admission of **new** launches, not by a
database constraint.

Track a plan the same way you track PRs — its `process_key` is an engine instance you
can inspect in §5, and the PRs it opens show up in `/status` as ordinary convergence
loops.

---

## 3. Answer escalations (unblock a human-in-the-loop wait)

A loop escalates only when an agent returns `needs_input`/`blocked`, or a safety net
fires (round cap, a review that never arrives, a merge conflict, an unfixable CI
failure). The parked process waits for a human answer.

Find the open escalations, then answer them. **Prefer the `listEscalations` tool**
(the projected read tool that lists every open escalation with the `userTaskKey` and form
you need to answer it); curl is the no-MCP fallback.

```text
# Every open escalation waiting for a human, across all four kinds — each with its
# userTaskKey, prKey, kind (elementId), question/findings/task, and formVariables:
tool: listEscalations
```

```bash
# No-MCP fallback: read the open escalations off /status …
curl -sS __BASE__/status | jq '.prs[] | select(.openEscalation != null)
  | { prKey, status, round, openEscalation }'
```

The four decision-required escalation kinds — **PR review-loop**, **implementation
(feature) task**, **plan-review**, and **trial-merge** — are now native BPMN
`userTask`s bearing a linked `.form`, all answered the same way through the
`completeUserTask` tool (a human uses the same **task inbox** surface underneath).
There is no bespoke per-kind webhook or answer page any more.

**List the open escalation tasks.** `listEscalations` returns each open task with its
context (`prKey` / `question` / `findings` / `task`) and its kind in `elementId` /
`kind`, so you do **not** need to reach for the raw Tasks inbox. No-MCP fallback only:

```bash
# No-MCP fallback — the un-projected engine task inbox (prefer `listEscalations`):
curl -sS __BASE__/../../tasks/api/tasks | jq '.[] | { userTaskKey, elementId, variables }'

# Filter to one kind (e.g. plan-review decisions) by elementId:
curl -sS __BASE__/../../tasks/api/tasks \
  | jq '[.[] | select(.elementId == "plan-review-decision")]'
```

The inbox UI is also served at `__BASE__/../../tasks` for a human to browse, filter, and
answer (assignee/candidate-group and age surface on each task once assignment lands).

> **`wait`-gate escalations are different — completing one does NOT re-arm the gate.** The
> escalation kinds above resume a loop with your answer. A **delivery-graph `wait` node**
> (§9) that elapses its bound also parks a task, but completing *that* one releases the token
> **as not-ready** and the graph proceeds **past the gate** — the downstream side-effecting
> node then runs against the unmet dependency. See §9.2 before clearing one.

**Answer a task** by completing it with the typed variables its form expects — the
completion resumes the parked process. **Prefer the `completeUserTask` tool** (or
`agentCompleteEscalation` when you answer as an agent assignee, ADR 0046); the
`curl … /tasks/api/complete` inbox call is the no-MCP fallback.

```text
# PR review-loop (elementId `wait-answer`, pr-escalation form):
tool: completeUserTask { "userTaskKey": "<key>",
                         "variables": { "answer": "Cap retries at 5 and proceed." } }

# Implementation (feature) task (elementId `feature-escalation`):
#   { "resolution": "answer", "answer": "…" }  to resume, or  { "resolution": "abandon" }
tool: completeUserTask { "userTaskKey": "<key>",
                         "variables": { "resolution": "answer", "answer": "Use v2." } }

# Plan-review (elementId `plan-review-decision`):
#   { "directive": "revise", "notes": "…" }  (fresh review budget)  or  { "directive": "proceed" }
tool: completeUserTask { "userTaskKey": "<key>",
                         "variables": { "directive": "revise", "notes": "Make issue-7 the seam." } }

# Trial-merge (elementId `trial-merge-decision`):
#   { "action": "proceed" | "rebase" | "abandon", "notes"?: "…" }
tool: completeUserTask { "userTaskKey": "<key>",
                         "variables": { "action": "rebase", "notes": "Re-run after the fix." } }
```

```bash
# No-MCP fallback — the un-projected engine task-inbox complete door (prefer the tool):
curl -sS -X POST __BASE__/../../tasks/api/complete -H 'content-type: application/json' \
  -d '{ "userTaskKey": "<key>", "variables": { "answer": "Cap retries at 5 and proceed." } }'
```

**Answer a PR escalation** (both the review-loop `wait-answer` and the merge-loop
`wait-merge-answer` — both are now native user tasks answered the same way, #256).
Use the PR key's parked user task and submit the `pr-escalation` form's `{ answer }`
through the `completeUserTask` tool; curl is the no-MCP fallback:

```text
tool: completeUserTask { "userTaskKey": "<key>",
                         "variables": { "answer": "Yes — cap the retries at 5 and proceed." } }
```

```bash
# No-MCP fallback:
curl -sS -X POST __BASE__/actions/complete-user-task \
  -H 'content-type: application/json' \
  -d '{
        "userTaskKey": "<key>",
        "variables": { "answer": "Yes — cap the retries at 5 and proceed." }
      }'
```

The `userTaskKey` comes from `listEscalations` (or `GET /status`/the Tasks inbox). This
is the ONE canonical answer door (`completeUserTask`) for every escalation kind — with
`agentCompleteEscalation` the agent-assignee variant that records identity for
attribution (ADR 0046); the merge loop no longer uses a durable `escalation-answered`
message catch.

If `NANO_PR_WEBHOOK_SECRET` is set on the deployment, add `-H "x-hook-secret: <secret>"`.

The answer is delivered to the agent as its next-round context (e.g. the `answer`,
`directive`, or `action` variable), and the loop resumes. **Audit** is durable: the
completed user tasks form the escalation history, and the review/merge loops' rows
live in the `escalations` table (surfaced read-only per PR on the Convergence page).

Guidance for the human you assist: read the escalation `question` or plan-review
`findings` first, decide the smallest unblocking answer, and answer it precisely —
the answer becomes the agent's next-round context.

---

## 4. The lifecycle & statuses (so you can reason about state)

```
 submit ──► convergence-loop
   round (senior:pr-review) ──► addressed ──► wait review-ready ─┐
                             ├─ converged  ──► finalize ──► merge-loop (unless convergeOnly)
                             └─ needs_input/blocked ──► escalate ──► wait-answer userTask (task inbox)
 merge-loop: wait deps ─► arm merge ─► (queue-aware) merge / land
             blocked (CI red) ─► senior:fix-ci ─► retry     conflict ─► senior:rebase ─► retry
```

PR `status` values you will see in `/status`:
`converging` (a review round is live), `waiting_review` (parked for a fresh review),
`escalated` (waiting on a human answer), `converged`, `waiting_deps` / `waiting_merge`
/ `queued` / `merging` (merge stage), `merged`, `abandoned`. A separate
`incident` signal (§5) can overlay any live status when the engine parks the token on
a technical fault.

---

## 5. Debug: find engine instances and relate them to PRs

The app stores each PR/plan's engine **process instance key** in its `process_key`
column and surfaces it as `processKey` in `/status`. That key is the join between the
app's business view and the engine's execution view.

**Find the instance for a PR:** take `processKey` from `listActivePrs` (`/status`), then
query engine truth. **Prefer the framework `urban_debug_*` engine-debug tools** (owned by
the nano-ide urban runtime — see the crosswalk in §10); the `curl __ENGINE__/…` engine
REST calls are the no-MCP fallback:

```text
PK = <processKey from listActivePrs>

# The instance itself (state, the BPMN process it is running, start time):
tool: urban_debug_search_process_instances   { "filter": { "processInstanceKey": PK } }

# Where is it parked? — active jobs on the instance (a CREATED senior:pr-review job
# with a `worker` set means an agent has leased the round; none means it is queued):
tool: urban_debug_search_jobs                 { "filter": { "processInstanceKey": PK, "state": "CREATED" } }

# Its variables (the aggregate/job payload the engine holds):
tool: urban_debug_search_variables           { "filter": { "processInstanceKey": PK } }

# Is it dead-in-the-water on a technical fault? — active incidents:
tool: urban_debug_search_incidents           { "filter": { "processInstanceKey": PK, "state": "ACTIVE" } }

# Which BPMN element/wait-state is it sitting on?
tool: urban_debug_search_element_instance_wait_states { "filter": { "processInstanceKey": PK } }
```

```bash
# No-MCP fallback — the raw engine Camunda-8 v2 REST API:
PK=<processKey-from-status>

# The instance itself (state, the BPMN process it is running, start time):
curl -sS -X POST __ENGINE__/process-instances/search \
  -H 'content-type: application/json' \
  -d "{ \"filter\": { \"processInstanceKey\": \"$PK\" } }" | jq

# Where is it parked? — active jobs on the instance:
curl -sS -X POST __ENGINE__/jobs/search \
  -H 'content-type: application/json' \
  -d "{ \"filter\": { \"processInstanceKey\": \"$PK\", \"state\": \"CREATED\" } }" | jq

# Is it dead-in-the-water on a technical fault? — active incidents:
curl -sS -X POST __ENGINE__/incidents/search \
  -H 'content-type: application/json' \
  -d "{ \"filter\": { \"processInstanceKey\": \"$PK\", \"state\": \"ACTIVE\" } }" | jq

# What are the element/flow-node instances (which BPMN element is it sitting on)?
curl -sS -X POST __ENGINE__/element-instances/search \
  -H 'content-type: application/json' \
  -d "{ \"filter\": { \"processInstanceKey\": \"$PK\" } }" | jq
```

> The `urban_debug_search_jobs`, `urban_debug_search_variables` and
> `urban_debug_get_process_definition_xml` reads are owned by the sibling nano-ide urban
> epic; where a deployment's framework has not yet projected them, use the curl fallback
> for that row. The three always-present engine reads are
> `urban_debug_search_process_instances`, `urban_debug_search_element_instance_wait_states`
> and `urban_debug_search_incidents`.

The app already mirrors an ACTIVE incident onto the PR row (`incident`/incident
message), so a PR that shows an incident in the UI is parked on an engine fault —
inspect it with `urban_debug_search_incidents` (or `incidents/search`) above. If the
engine is not at the default, the deployment's engine base is `__ENGINE__` (set via
`NANOBPMN_BASE_URL` or `CAMUNDA_REST_ADDRESS`).

**Relate an instance back to a PR:** if you have a `processKey` but not the PR, match
it against `listActivePrs`/`/status` (`.prs[] | select(.processKey == "<PK>")`). A
terminal PR is no longer in `/status`; its instance has already completed or been
cancelled.

---

## 6. Debug the models and the prompts

The behaviour is defined by durable BPMN processes and model-authored agent prompts —
both live in the source repo, not in the job payload.

- **Processes:** to inspect the model an instance is **actually running**, prefer the
  framework tool **`urban_debug_get_process_definition_xml`** (owned by the sibling
  nano-ide urban epic — see §10), which returns the deployed BPMN XML for a process
  definition; that is engine truth and cannot drift from what is live. The repo copies
  `resources/processes/*.bpmn` — `convergence-loop.bpmn` (review), `merge-loop.bpmn`
  (merge/CI-fix/rebase), `plan-fanout.bpmn` (planning), `retro.bpmn` — are the
  **source of truth in git** for routing, read them from the checkout when you want the
  authored form (or have no MCP). They can lag a running deployment, so confirm against
  the deployed XML when *why did this instance route here* matters. To understand *why* an
  instance went where it did, read the gateway conditions (FEEL expressions on the
  sequence flows) for the element it is parked on (§5).
- **Prompts (agent base instructions):** `resources/prompts/*.md` — `review-round.md`,
  `plan.md`, `feature.md`, `fix-ci.md`, `rebase.md`, `trial-merge.md`, etc. They live
  under `resources/` so they deploy by convention (ADR 0062 — the app declares no
  `models`; every file under `resources/` is deployed, one `.md` per task under
  `resources/prompts/`). An agent's base prompt is **not** a job variable and is **not**
  a deploy-time `{{token}}` substitution (that templating is removed — there is no
  back-compat): it is delivered as a **linked resource**, the blessed **and only**
  prompt-modularity path:

  ```xml
  <zeebe:linkedResource resourceId="prompts/review-round.md" bindingType="latest" resourceType="GenericScript" linkName="prompt"/>
  ```

  that the engine
  resolves to the latest deployed prompt at job activation, combined at runtime with the
  per-task `appendPrompt` FEEL (the task-specific slice appended to this base). Because
  the binding is `latest`, redeploying one of these files updates the prompt mid-epic
  without a process redeploy. If an agent misbehaves systematically, the prompt is the
  first thing to inspect/fix.

  > **Value-injection caveat:** never bake a per-run value (a URL, a flag) into a prompt
  > at deploy time — that path is gone. Pass it as a runtime job variable / `appendPrompt`
  > FEEL instead; deploy-time string substitution is not available.
- **Job contract:** `senior:pr-review` receives `{ prUrl, repo, prNumber, round,
  answer? }` and must return a flat result `{ status, summary, question? }` with
  `status ∈ { converged, addressed, waiting, needs_input, blocked }`. A round that
  pushes anything (including a rebase/force-push) is `addressed`; a round with an
  unknown/empty result is treated as a safe `addressed` and re-enters the review wait
  rather than escalating.

To validate a model/prompt change locally: `npm run layout:check` (BPMN diagram
freshness), `npm run check:prompts` (every prompt link resolves), `npm run check`
(manifest), `npm run typecheck`, `npm run lint`, `npm test`.

---

## 7. Unstick a stuck process

Work through this order:

1. **Confirm it is actually stuck.** From `/status`, a PR `converging` with an
   `activeWorker` set is *working*, not stuck — an agent holds the round. No worker
   for a long time means the job is queued: is a fleet `c8ctl nano work` daemon
   running and subscribed to the `senior:*` task types?
2. **Check for an incident** (§5). An ACTIVE incident parks the token; the underlying
   fault must be resolved (or the instance cancelled and the work resubmitted). The
   app surfaces the incident message on the PR row.
3. **Check for an open escalation** (§3) — the process may simply be waiting for a
   human answer. Answer it.
4. **A review that never arrives** escalates on its own after
   `NANO_PR_REVIEW_WAIT_TIMEOUT` (default `PT20M`); the poller also re-nudges the
   reviewer periodically. If the reviewer bot is not provisioned on the repo, no
   review will ever land — that is a repo-config problem, not an app bug.
5. **Cancel + resubmit** as a last resort. Cancel through the **app-owned** door —
   **prefer the `cancelInstance` tool** (`POST /actions/cancel { "processInstanceKey":
   "<PK>" }`, the same record-consistent path as the UI's per-row Cancel), which cancels
   the engine instance **and** marks the PR `abandoned` so it drops out of
   `listActivePrs`. Then re-submit the PR (§1) to start a fresh loop. **Do not** cancel a
   raw engine instance out from under the app with the engine-level
   `urban_debug_cancel_instance` tool (or a direct engine REST cancel) — that cancels the
   token but leaves the PR row inconsistent. Always go through `cancelInstance` /
   `POST /actions/cancel` so the app's record state stays consistent. No-MCP fallback:

   ```bash
   curl -sS -X POST __BASE__/actions/cancel -H 'content-type: application/json' \
     -d '{ "processInstanceKey": "<PK>" }'
   ```

---

## 8. Raise an issue or a PR against nano-workforce

When you find a genuine bug or a missing capability in the orchestration itself
(not a transient repo/agent problem), help the human file it against
`nanobpm/nano-workforce`:

- **Every change needs a tracked issue or PR** — no silent fixes. Open an issue
  first if one does not exist.
- **DCO is enforced:** every commit needs a `Signed-off-by` trailer — commit with
  `git commit -s` (or `git rebase --signoff`).
- **Work in a git worktree** off `origin/main`, on a `feat/*` or `fix/*` branch.
- **Author the BPMN semantics, generate the diagram.** Never hand-edit the
  `bpmndi:BPMNDiagram`; run `npm run layout <file.bpmn>` and commit the result. CI
  fails on stale DI.
- **Match the CI gates locally before pushing:** `npm run lint`, `npm run typecheck`,
  `npm run check`, `npm run layout:check`, `npm run check:prompts`, `npm test`.
- **Copilot code review is provisioned** — drive the PR to convergence against it.
- Read `AGENTS.md` (engineering principles + gates) and `SPEC.md` (behavioural source
  of truth) before proposing a change to a process.

When describing the bug, include the concrete evidence you gathered here: the
`prKey`, the engine `processKey`, the parked element / incident message (§5), and the
BPMN/prompt file you believe is responsible (§6).

---

## 9. Author and run a delivery graph (ADR 0005)

The two workflows above (§1 convergence-loop, §2 plan-fanout) are each specialised to
**one** node shape ("an agent implements a slice → opens a PR"). Real delivery is often a
**heterogeneous, cross-repo, partly-human graph** — e.g. *merge PR #101 → un-draft+merge
PR #202 → a human does a manual OTP publish → PR #303 consumes the just-published version*. A
**delivery graph** ([ADR 0005](https://github.com/nanobpm/nano-workforce/blob/main/docs/adr/0005-agent-authored-delivery-graphs.md))
lets you compose exactly that as **data** and hand it to a generic runner.

> **Discover the vocabulary from the surface.** Everything this section describes — the four
> node kinds and their body contracts, every `wait` probe kind and **what it observes**, the
> real-vs-stub connector targets, the `onTimeout` options, the poll-budget trap, and the
> fact-threading rules — is also available as **structured JSON** from the read tool
> **`getDeliveryGraphVocabulary`** (`GET __BASE__/delivery-graph/vocabulary`). It is derived
> from the implementing code (a drift test fails the build if the two disagree), so prose and
> data can never drift. Fetch it to author against the live vocabulary; this section is the
> narrative companion.

You author the graph as **JSON — never BPMN or code** (Decision 1: the agent must never
author the executable artifact; the closed node vocabulary is the trust boundary). Your
surface ends at **propose → compile → stage**: a single `compile` door validates the JSON,
renders a preview, and — when valid — **stages the compiled graph as a proposal** for a
human. **Dispatch is an operator action in the cockpit, not an agent endpoint** (issue #460):
there is deliberately no `start` door on the agent surface, so there is nothing an agent can
call — or replay — to launch a run. A human previews the staged proposal and dispatches it.

### 9.1 The `DeliveryGraph` shape

A `DeliveryGraph` is a JSON **DAG**: `{ name?, nodes[], edges[] }`.

- **`nodes[]`** — each node has a unique `id`, a `kind` from the **closed allowlist**
  (`agent` | `wait` | `human` | `connector`), the matching per-kind config, and an
  optional typed `emits[]` declaration (the facts it hands forward).
- **`edges[]`** — each edge is `{ from, to }` meaning *"`to` proceeds once fact `from` is
  observable"* (Decision 3 — edges are **discovered facts**, not declared values). `from`
  is either a bare **`<nodeId>`** (the degenerate "wait for the upstream node's
  completion" fact) or a **qualified `<nodeId>.<fact>`** referencing one of that node's
  declared `emits`. The whole edge set must be a DAG. Omit / `[]` for independent roots.

**The four node kinds** (each delegates to an existing engine-native body — the graph
layer schedules, it does not re-implement execution):

| kind | config | what it does | may `emits`? |
|---|---|---|---|
| `agent` | `agent: { jobType, prompt?, converge?, merge? }` | a worker runs an agent job type (the fan-out body). **Side-effecting.** First-class **`converge?` / `merge?`** cell policy (§9.4) — a **declared, compiler-validated** completion-policy flag that *declares* review-convergence / landing intent (`merge` requires `converge`); a raw `senior:converge`/`senior:merge` job is rejected. This slice adds + validates the flags; the delivery-graph execution wiring that consumes them lands in a follow-up slice. | yes |
| `wait` | `wait: <ReadinessProbe>` | a durable, bounded readiness probe — kind ∈ `http`, `command`, `npm`, `github-check`, `capability`, `pr`, `epic`. Read-only. | yes (binds observed facts) |
| `human` | `human?: { formKey?, prompt? }` | a scheduled user task + form (the Tasks inbox, §3). Blocks dependents, SLA-bounded, answerable by a human **or** an agent. | yes |
| `connector` | `connector: { target, dedupeKey?, payload? }` | an automated, side-effecting outbound action. Carries a `dedupeKey` (at-least-once safe). Three **real targets** ship today — **`converge`**, **`converge-merge`** (unit → base branch) and **`merge-main`** (graph → `main`, the two-level top-level land) (§9.4); other targets are a forward-declared stub. | yes |

A **`wait` node's `wait` is a `ReadinessProbe` verbatim** (the same shape feature-run
intake uses): `{ kind, target, onTimeout?, match?, poll? }`, where `poll` is
`{ everyMs?, timeoutMs?, backoff? }` — `everyMs` is the re-probe cadence, `timeoutMs` the
total bounded budget, and `backoff ∈ fixed|exponential`.

> **The bound is invisible unless you set it.** When `poll` (or `poll.timeoutMs`) is
> **omitted**, the gate inherits the built-in default budget of **`PT30M` (30 minutes),
> re-probing every 15s** (`DEFAULT_READINESS_TIMEOUT` / `DEFAULT_EVERY_MS`,
> `app/readiness.ts`). That default is right for *"is the package published yet"* and badly
> wrong for `wait[pr, merged]` / `wait[epic]`, which routinely wait **hours or days** — an
> unpopulated `poll` on such a gate escalates after 30 minutes for no visible reason. Neither
> `compile` nor `preview` surfaces the effective bound, so **set `poll.timeoutMs` explicitly**
> on any gate that waits on a merge or an epic (see §9.4 / §9.5).

The **`pr` kind** watches an
in-flight PR — `target: "owner/repo#123"`, `match.prState ∈ ready|merged|mergeable|checks-green`
(default `merged`) — and on a merged match binds `mergedSha` as an output fact. The **`epic`
kind** (issue #568) gates on an **nwf plan-fanout epic reaching "fully merged"** — `target:
"owner/repo#NN"` is the epic's durable **`planKey`** (the epic issue, *not* the engine
`processInstanceKey`, so a resubmit/replay still resolves), `match.epicState ∈ merged|done`
(default `merged`, both mean "every opened slice landed"). It observes the app's own aggregate
(the lineage read-model), so a **failed/abandoned/mixed** epic never reports merged and the
bounded wait routes to **`onTimeout`** rather than hanging; on a fully-merged match it binds
`prCount` (how many slice PRs landed) as an output fact. Both `pr` and `epic` targets may also
be a **`<nodeId>.<fact>` late-binding reference** the compiler resolves at dispatch (§9.4),
rather than a literal handle.

A **typed fact** (`emits[]` entry) is `{ name, type, description? }` where
`type ∈ string|number|boolean|artifact|version|url|pr` (`artifact` = a `pkg@version` handle,
`version` = a bare version, `pr` = a PR reference `owner/repo#N` an `agent` node emits for the
PR it opened, late-bound by a downstream `wait[pr]`/`connector[converge*]` target — issue #548).
`name` matches `^[A-Za-z_][A-Za-z0-9_]*$` and is referenced
downstream as `<nodeId>.<name>`. A "click done" human node or a pass-through node declares
no facts.

**Guarded routing + the agent classifier-emit contract.** An edge may carry a **guard** —
`when: "<nodeId>.<fact>"` + `equals: <scalar>` — or be the split's single `default: true`
else-branch (S7). A node whose out-edges are guarded is a **data-based exclusive split**: at
runtime exactly one branch fires, chosen by the producer's emitted fact. For an **`agent`**
node the fact is late-bound from the servicing job's completion: the delivery output-mapping
publishes the engine variable named **exactly after the fact** (e.g. a fact `result` reads the
completion variable `result`). A real `senior:*` fleet agent completes with its **Output
contract** envelope (`{ status, summary, pr, question, delta }`), so — to make a guarded split
fire — an agent node that declares `emits` has a **classifier emit contract** automatically
appended to its prompt at dispatch: the agent MUST return each declared fact as an **extra
top-level field of the same result JSON** (the `AGENT_RESULT_FILE` it already writes
`status`/`summary`/`pr` to). Author side, this means: declare `emits: [{ name, type }]` on the
agent node and guard the downstream edge on `<node>.<name>`; a contract-following agent returns
`{ …, <name>: <value> }` and the split routes on it. If the agent cannot decide the fact it
**omits** it, and the split takes its `default` (else) branch — the deadlock-safe fallback. A
node that declares no `emits` gets no contract text and behaves exactly as before.

### 9.2 The agent loop: draft → compile → stage → ask an operator to dispatch

```
GET __BASE__/agent           # ← you are reading it; learn the vocabulary + endpoints
   └─ draft a DeliveryGraph JSON
        └─ POST __BASE__/actions/compile-delivery-graph   # validate + preview + STAGE
             ├─ 400 { ok:false, errors:[{path,message}] } → fix the exact offending input, recompile
             └─ 200 { status:"ready", message, digest, preview, reviewUrl }
                  └─ ask the operator to preview + dispatch it in the cockpit (there is no start door)
```

**Compile (validate + preview + stage).** The compile door runs the semantic validator and
the deterministic compiler and, on success, **stages** the compiled graph as a proposal a
human can dispatch — it does **not** deploy or run anything. Recompiling a graph you are
still drafting is safe: a re-compile of the same graph is idempotent, and a changed graph
with the same `name` supersedes the prior staged proposal, so the cockpit shows exactly one
live proposal per graph.

```bash
curl -sS -X POST __BASE__/actions/compile-delivery-graph \
  -H 'content-type: application/json' \
  -d @graph.json | jq
```

- `200 { status:"ready", message, digest, preview, reviewUrl }` — the graph compiled and is
  **staged for operator review**. `digest` is the content-address that NAMES the proposal (so
  you can tell the operator exactly which one to dispatch); `preview` is `{ diagram,
  sideEffects, humanNodes }` — `diagram` is a mermaid `flowchart` of the resolved graph,
  `humanNodes[]` are the stop-points where it waits for a person, and `sideEffects[]` are the
  `agent`/`connector` actions it **will** perform once an operator dispatches it; `reviewUrl`
  is a **navigational** cockpit deep-link (a pointer only — **not** a dispatch handle). The
  response carries **no run key, no token, and no process-instance key**: nothing you can
  replay to start a run. Your role ends here — hand the operator the `digest` (or `reviewUrl`)
  and ask them to preview and dispatch it.
- `400 { ok:false, errors:[{ path, message }] }` — every error path-qualified
  (`nodes[2].kind`, `edges[1].from`, …) for unknown kind, dangling edge, a cycle, or an
  unresolvable `from` fact. Fix and recompile; nothing is staged.

**Dispatch (operator-only — NOT on the agent surface).** There is deliberately no agent
`start` endpoint (Decision 5/7, issue #460). Dispatch is a human action: an operator opens
the **Delivery Graphs** page in the cockpit, reviews the staged proposal's rendered preview
(its diagram, the human stop-points, and the side effects a dispatch authorises), and clicks
**Dispatch** on the one they approve. The operator clicking Dispatch **is** the approval — it
is content-addressed to the exact digest they previewed, so it cannot be a replay of some
other graph. Once dispatched, the graph deploys + runs engine-natively and registers as a run
aggregate, so its current phase / parked node shows in the cockpit's **Active Delivery
Graphs** grid (e.g. *"parked on human node: manual OTP publish"*). A `human` node parks on the
**Tasks** inbox and is answered exactly as an escalation is (§3) — its completion emits any
declared facts, which downstream edges bind.

> **Completing a `wait` escalation proceeds *as not-ready* — it does NOT re-arm the gate.**
> A `wait` node with `onTimeout: "escalate"` (the default) that elapses its bound parks a
> human-completable escalation task on the Tasks inbox. **Completing that task does not retry
> the probe or wait for readiness** — it releases the token **as not-ready** and the graph
> proceeds **past the gate**, so the downstream side-effecting node then runs *against the
> unmet dependency* (`waitBodyLines`, `app/deliveryGraphCompiler.ts`). An operator clearing
> what looks like a stuck task therefore *launches the very work the gate was holding back*.
> If the dependency genuinely is not ready, do **not** complete the escalation to "unstick"
> it — extend the gate's `poll.timeoutMs` and re-dispatch, or abandon the run. (Same for
> `onTimeout: "continue"`, which proceeds past the gate as not-ready with **no** human stop
> at all.)

> **Why the split?** Making the compile door the end of the agent surface closes a
> self-approval hole: the old flow handed the same caller a content-addressed approval token
> to re-submit with, so any holder of the API credential approved its own graph. Removing the
> dispatch affordance from the agent surface entirely (capability by absence) means there is
> nothing to replay — the human in the cockpit is the only actor who can launch side effects.

### 9.3 Worked example — the cross-repo human-in-the-loop release

*Merge PR #101 (repo 1) → un-draft+merge PR #202 (repo 2) → a **human** runs the manual OTP
publish and records the version → open+merge PR #303 (repo 3) consuming that version.* The
`human` node **emits** a typed `version` fact, and the downstream `from:
"manual-publish.publishedVersion"` edge binds it into the PR-#303 path:

```json
{
  "name": "cross-repo release: merge #101 → un-draft+merge #202 → manual OTP publish → consume in #303",
  "nodes": [
    { "id": "merge-a", "kind": "wait",
      "wait": { "kind": "pr", "target": "acme/repo-1#101", "match": { "prState": "merged" },
                "poll": { "everyMs": 300000, "timeoutMs": 259200000 }, "onTimeout": "escalate" } },
    { "id": "undraft-merge-b", "kind": "agent",
      "agent": { "jobType": "senior:feature", "converge": true, "merge": true, "prompt": "Take draft PR acme/repo-2#202 out of draft; converge it to green and land it." } },
    { "id": "manual-publish", "kind": "human",
      "human": { "prompt": "Run the manual OTP-authenticated `npm publish` for @acme/widget and set up OIDC trusted publishing. Record the exact published version." },
      "emits": [ { "name": "publishedVersion", "type": "version", "description": "The version just published to npm." } ] },
    { "id": "open-pr-c", "kind": "agent",
      "agent": { "jobType": "senior:feature", "prompt": "Bump @acme/widget to the published version in acme/repo-3 and open PR #303." } },
    { "id": "merge-c", "kind": "wait",
      "wait": { "kind": "pr", "target": "acme/repo-3#303", "match": { "prState": "merged" },
                "poll": { "everyMs": 300000, "timeoutMs": 259200000 }, "onTimeout": "escalate" } }
  ],
  "edges": [
    { "from": "merge-a", "to": "undraft-merge-b" },
    { "from": "undraft-merge-b", "to": "manual-publish" },
    { "from": "manual-publish.publishedVersion", "to": "open-pr-c" },
    { "from": "open-pr-c", "to": "merge-c" }
  ]
}
```

`compile` returns this preview (abridged):

```
diagram (mermaid flowchart):
  n4["agent: undraft-merge-b"] --> n0["human: manual-publish"]
  n0 -- "publishedVersion" --> n3["agent: open-pr-c"]
  n1["wait: merge-a"] --> n4
  n3 --> n2["wait: merge-c"]

humanNodes: [ { nodeId: "manual-publish", emits: [ { name: "publishedVersion", type: "version" } ], … } ]
sideEffects: [ { nodeId: "open-pr-c", kind: "agent", … }, { nodeId: "undraft-merge-b", kind: "agent", … } ]
```

Two side-effecting `agent` nodes ⇒ the compile door **stages** the proposal and hands you a
`digest` + `reviewUrl`; ask an operator to preview and **Dispatch** it in the cockpit. Once
they do, the graph runs to `manual-publish`, parks it on the Tasks inbox (`now do X`), and —
once a human (or agent) completes it with the `publishedVersion` — binds that fact into
`open-pr-c` and carries on to `merge-c`.

To swap the manual PR-#303 path for a **capability** edge instead of a raw `pr` watch, make
the consumer a `wait` node with `kind: "capability"` (resolving *which published
`pkg@version` first carries the change*) fed by the same `manual-publish.publishedVersion`
fact — the fact-edge syntax is identical.

### 9.4 Connector targets — drive a PR to convergence + merge (`converge` / `converge-merge` / `merge-main`)

A `connector` node with **`target: "converge-merge"`** (or **`"converge"`** / **`"merge-main"`**)
enrolls an agent-opened PR into the app's **shared convergence loop** — the *same* enrollment §1 (a
standalone submit) and a feature run use (`submitPr`), no duplicated machinery. This replaces
the old habit of bridging an `agent`-opened PR to review with a **human `land-*` gate** whose
only job was "go run convergence yourself".

- **`converge-merge`** — the **unit-level** land: drive review convergence **and then the merge
  loop**, landing the PR onto **its own base branch** (for a unit inside an epic that base is the
  epic integration branch, never `main` directly — ADR 0003 base-branch admission). Equivalent to a
  submit with `convergeOnly: false`.
- **`merge-main`** — the **graph-level** top-level land: the second level of the two-level merge
  (ADR 0006 §3), landing the graph/epic **integration** PR onto **`main`**. Dispatch-identical to
  `converge-merge` (both enroll + merge); the distinction is the *level*, kept a first-class literal
  so the two levels are authored explicitly rather than left emergent.
- **`converge`** — **converge-only**: drive review convergence and stop at `converged`, never
  handing off to the merge loop (equivalent to `convergeOnly: true`).

> **converge/merge are cell POLICY, not raw nodes.** A raw `senior:converge` / `senior:merge`
> **agent** job is **not expressible** — the compiler rejects it (`raw-converge-node`). Express
> "get to green, then land" via a cell node's first-class **`agent.converge` / `agent.merge`**
> policy flags (`merge` requires `converge`), or, for enrolling an already-open PR, the
> `connector` targets above (ADR 0006 §3 / S5).

**Payload:** `{ pr: "owner/repo#123", convergeOnly?: boolean, dependsOn?: string[] }`. `pr` is
required (a literal `owner/repo#N`, identical to how a `wait: pr` node targets a known PR).
`convergeOnly` defaults from the target and may be overridden per-node; `dependsOn` is unioned
into the PR's merge-stage dependency set. The enrollment is idempotent (the connector's
at-least-once dedupe fence **plus** `submitPr`'s own `prKey` idempotency), so a graph resume /
redelivery never double-enrolls.

**Canonical shape** — the agent opens the PR, emits it as a typed **`pr` fact**, and the connector
and `wait[pr, merged]` gate **late-bind** that fact (no hardcoded PR number, no human node). The
author never knows the PR number at compose time, so reference it by fact:

```json
{
  "name": "open → converge+merge → wait merged",
  "nodes": [
    { "id": "open", "kind": "agent",
      "agent": { "jobType": "senior:feature", "prompt": "Implement the change in acme/repo and open a PR." },
      "emits": [ { "name": "pr", "type": "pr" } ] },
    { "id": "land", "kind": "connector",
      "connector": { "target": "converge-merge", "payload": { "pr": "open.pr" } } },
    { "id": "merged", "kind": "wait",
      "wait": { "kind": "pr", "target": "open.pr", "match": { "prState": "merged" },
                "poll": { "everyMs": 300000, "timeoutMs": 259200000 }, "onTimeout": "escalate" } }
  ],
  "edges": [
    { "from": "open.pr", "to": "land" },
    { "from": "open.pr", "to": "merged" }
  ]
}
```

The `merged` gate carries an explicit **`poll`** (re-probe every 5 minutes, budget 3 days:
`timeoutMs: 259200000`) because a `wait[pr, merged]` waits on a human-paced merge — **omitting
`poll` inherits the 30-minute default** (§9.1) and escalates mid-review. Set `poll.timeoutMs`
to a realistic budget on any merge/epic gate.

The `pr` fact is threaded along the **fact-qualified edges** (`open.pr → land`, `open.pr → merged`) —
those edges are what carry the observed PR into each consumer, so they are **required** when you
reference `open.pr` (the validator rejects a reference with no threading edge, `unbound-pr`). Three
ways to name the target PR:

- **fact reference** `"<node>.pr"` — late-bound from the upstream `agent`'s emitted `pr` fact (the
  shape above). The referenced fact must be declared **`pr`-typed** and threaded on an incoming edge.
- **omitted** (connector only) — `payload` without a `pr` auto-binds the **single** incoming `pr`
  fact, so `"connector": { "target": "converge-merge" }` works when exactly one `pr` fact flows in.
- **literal** `"owner/repo#N"` — still accepted for a PR you already know (a real ref is never
  `<node>.pr`-shaped, so it never collides with a reference).

`senior:feature` already returns the PR it opened, so declaring `emits: [{ "name": "pr", "type": "pr" }]`
on the agent node is all it takes to publish it (issue #548).

> **Don't hand-author this shape — generate it.** When your intent is simply "sequence these
> issues, each implemented → converged → merged (optionally behind a gate)", call the
> **`sequenceIssues`** door instead of assembling the nodes/edges by hand. Its body is the intent
> `{ "issues": ["owner/repo#A", "owner/repo#B", …] }` with an optional leading `"behind": "owner/repo#NN"`
> gate, and it GENERATES
> exactly the canonical chain above — for each issue `agent` (`senior:feature`, emits `pr`) →
> `connector[converge-merge]` → `wait[pr, merged]` with a realistic `poll.timeoutMs`, threading the
> `pr` fact, plus an optional leading `wait[epic]` gate (§9.5) when `behind` is given — then STAGES it
> through the same compile+stage path as `compileDeliveryGraph` (it never dispatches). The issues run
> in **sequence**: each issue's implementation starts once the prior issue has merged.

### 9.5 Gate a graph on an epic reaching "fully merged" (`wait[epic]`)

Sometimes the thing you must wait for is not one PR but a **whole epic** — an nwf
`plan-fanout` that fans many slice PRs across waves whose numbers are unknown at compose
time. The **`wait` kind `epic`** (issue #568) gates on that epic reaching **"fully merged"**
(every opened slice landed), keyed by its durable **`planKey`** (`owner/repo#NN` — the epic
issue), so *"start feature B once epic A has fully landed"* is an automated edge, not a human
babysitting a `confirm` gate.

```json
{
  "name": "start #567 once epic #488 has fully merged",
  "nodes": [
    { "id": "gate-epic", "kind": "wait",
      "wait": { "kind": "epic", "target": "nanobpm/nano-ide#488",
                "match": { "epicState": "merged" },
                "poll": { "everyMs": 300000, "timeoutMs": 259200000 },
                "onTimeout": "escalate" },
      "emits": [ { "name": "prCount", "type": "number" } ] },
    { "id": "start-b", "kind": "agent",
      "agent": { "jobType": "senior:feature", "prompt": "Implement nanobpm/nano-workforce#567 and open a PR." } }
  ],
  "edges": [ { "from": "gate-epic", "to": "start-b" } ]
}
```

Semantics:

- **`target` is the `planKey`** (`owner/repo#NN`, the epic issue) — the *stable business id*,
  not the engine `processInstanceKey` (`64200`), so a resubmit/replay still resolves.
- **`match.epicState`** is `merged` (default) or its synonym `done` — both mean "every opened
  slice landed". The gate reads the app's own **aggregate** (the lineage read-model over
  `NANO_WORKFORCE_BASE_URL`), so it is level-triggered like `pr` (no missed edge).
- **A failed/abandoned/mixed epic never reports merged**, so it never falsely releases the
  gate; the **bounded** wait elapses and routes via **`onTimeout`** (`escalate`/`continue`) —
  it does **not** hang.
- **Set `poll.timeoutMs` to a realistic budget.** An epic reaching "fully merged" is a
  multi-day, human-paced event, so the example gives it `poll: { everyMs: 300000, timeoutMs:
  259200000 }` (re-probe every 5 minutes, budget 3 days). **Omitting `poll` inherits the
  30-minute default** (§9.1) — the gate would escalate long before the epic lands, and (per
  §9.2) completing that escalation would release `start-b` **as not-ready**, launching feature
  B before its dependency merged. Size `timeoutMs` to how long the epic realistically takes.
- On a fully-merged match it binds **`prCount`** (how many slice PRs the epic landed) as an
  output fact, so a downstream node can consume it (parity with the `pr` kind's `mergedSha`).
- **It also gates a single-PR *feature run*, not just a plan-fanout epic.** The gate resolves the
  lineage thread whose **`rootRequestKey`** matches `target` **regardless of the thread's `kind`**
  (`feature` | `epic` | `pr` | `delivery`), and `app/lineage.ts` lands a *feature* thread on
  `stage:"merged"` once its PR merges. So `wait[epic]` targeting a feature/epic **root issue**
  observes that thread's aggregate frontier and releases on `stage:"merged" && active:false` either
  way — see `getDeliveryGraphVocabulary` (the `epic` probe entry) for the structured contract.

---

## 10. Tool ↔ curl crosswalk (MCP-first, curl is the no-MCP fallback)

When you drive this instance over MCP, **call the projected tool** — every recipe above
leads with it. `curl __BASE__/…`/`curl __ENGINE__/…` is only the **no-MCP fallback** for an
agent that has no tools (see the runbook, `docs/mcp-runbook.md` §2/§3, and [§5
Fallback](mcp-runbook.md#5-fallback)). This table maps every guide action to its projected
tool name and the exact curl door underneath.

App-owned operations (projected from this app's `openapi.yaml`; the `__BASE__` control API):

| Guide action | Projected tool | curl no-MCP fallback |
|---|---|---|
| Which code is live (§0) | `getVersion` | `curl __BASE__/version` |
| Every PR in flight (§0/§5) | `listActivePrs` | `curl __BASE__/status` |
| List open escalations (§3) | `listEscalations` | `curl __BASE__/status \| jq '.prs[]\|select(.openEscalation!=null)'` / `curl __BASE__/../../tasks/api/tasks` |
| Answer an escalation (§3) | `completeUserTask` (agent-assignee: `agentCompleteEscalation`) | `curl -X POST __BASE__/actions/complete-user-task` |
| Cancel an instance (record-consistent) (§7) | `cancelInstance` | `curl -X POST __BASE__/actions/cancel` |
| Publish a BPMN message (§7) | `postMessage` | `curl -X POST __BASE__/actions/message` |
| The operator guide itself | `getAgentInstructions` (full) / `getAgentGuide(section?)` (addressable) | `curl __BASE__/agent` / `curl __BASE__/agent/guide` |

Framework engine-debug tools (owned by the nano-ide urban runtime, not this app; they front
the engine's Camunda-8 v2 REST API at `__ENGINE__`). The first three are always projected;
`urban_debug_search_jobs` / `urban_debug_search_variables` /
`urban_debug_get_process_definition_xml` are owned by the sibling nano-ide urban epic — use
them by name where the framework projects them, else drop to the curl door:

| Guide action | Projected tool | curl no-MCP fallback |
|---|---|---|
| Search process instances (§5) | `urban_debug_search_process_instances` | `curl -X POST __ENGINE__/process-instances/search` |
| Inspect element/wait states (§5) | `urban_debug_search_element_instance_wait_states` | `curl -X POST __ENGINE__/element-instances/search` |
| Active incidents (§5) | `urban_debug_search_incidents` | `curl -X POST __ENGINE__/incidents/search` |
| Jobs on an instance (§5) | `urban_debug_search_jobs` | `curl -X POST __ENGINE__/jobs/search` |
| Instance variables (§5) | `urban_debug_search_variables` | `curl -X POST __ENGINE__/variables/search` |
| Deployed BPMN model XML (§6) | `urban_debug_get_process_definition_xml` | read the source copy `resources/processes/*.bpmn` from the checkout |
| Engine-level cancel — **avoid** (§7) | `urban_debug_cancel_instance` | *(use the app-owned `cancelInstance` instead — engine cancel leaves the PR row inconsistent)* |

**Rule of thumb (agent-guide §5 fallback discipline):** if a row has a projected tool, use
it; reach for its curl door only when you are genuinely not on MCP. The app-owned cancel door
(`cancelInstance`) is always preferred over the engine-level `urban_debug_cancel_instance`,
because only the app door transitions the PR/plan record to `abandoned`.
