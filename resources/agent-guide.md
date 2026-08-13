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

Before acting, confirm what is running and what is in flight:

```bash
# Which code is live (app version, urban version, git sha/branch, uptime):
curl -sS __BASE__/version | jq

# Every PR currently in flight (not converged/abandoned), with its engine
# process key, status, round, and any open escalation:
curl -sS __BASE__/status | jq
```

`/status` is your primary situational-awareness endpoint. Each entry carries:
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
  -d '{ "issue": "owner/repo#123" }'
```

The body is flat: `issue` (or `url`) — `owner/repo#123` or an issue URL. Starting a
plan is idempotent on the plan key; an already-running plan short-circuits. The
response (202) echoes the `planKey` and engine `processKey`.

Track a plan the same way you track PRs — its `process_key` is an engine instance you
can inspect in §5, and the PRs it opens show up in `/status` as ordinary convergence
loops.

---

## 3. Answer escalations (unblock a human-in-the-loop wait)

A loop escalates only when an agent returns `needs_input`/`blocked`, or a safety net
fires (round cap, a review that never arrives, a merge conflict, an unfixable CI
failure). The parked process waits for a human answer.

Find the open escalations, then answer them:

```bash
# Which in-flight PRs have an open escalation waiting for a human?
curl -sS __BASE__/status | jq '.prs[] | select(.openEscalation != null)
  | { prKey, status, round, openEscalation }'
```

The four decision-required escalation kinds — **PR review-loop**, **implementation
(feature) task**, **plan-review**, and **trial-merge** — are now native BPMN
`userTask`s bearing a linked `.form`, all answered the same way through the **task
inbox** surface. There is no bespoke per-kind webhook or answer page any more.

**List the open escalation tasks.** Each task carries its context (e.g. `prKey` /
`question` / `findings` / `task`) in its `variables`, and its kind in `elementId`:

```bash
# Every parked escalation, across all kinds:
curl -sS __BASE__/../tasks/api/tasks | jq '.[] | { userTaskKey, elementId, variables }'

# Filter to one kind (e.g. plan-review decisions) by elementId:
curl -sS __BASE__/../tasks/api/tasks \
  | jq '[.[] | select(.elementId == "plan-review-decision")]'
```

The inbox UI is also served at `__BASE__/../tasks` for a human to browse, filter, and
answer (assignee/candidate-group and age surface on each task once assignment lands).

**Answer a task** by completing it with the typed variables its form expects — the
completion resumes the parked process:

```bash
# PR review-loop (elementId `wait-answer`, pr-escalation form):
curl -sS -X POST __BASE__/../tasks/api/complete -H 'content-type: application/json' \
  -d '{ "userTaskKey": "<key>", "variables": { "answer": "Cap retries at 5 and proceed." } }'

# Implementation (feature) task (elementId `feature-escalation`):
#   { "resolution": "answer", "answer": "…" }  to resume, or  { "resolution": "abandon" }
curl -sS -X POST __BASE__/../tasks/api/complete -H 'content-type: application/json' \
  -d '{ "userTaskKey": "<key>", "variables": { "resolution": "answer", "answer": "Use v2." } }'

# Plan-review (elementId `plan-review-decision`):
#   { "directive": "revise", "notes": "…" }  (fresh review budget)  or  { "directive": "proceed" }
curl -sS -X POST __BASE__/../tasks/api/complete -H 'content-type: application/json' \
  -d '{ "userTaskKey": "<key>", "variables": { "directive": "revise", "notes": "Make issue-7 the seam." } }'

# Trial-merge (elementId `trial-merge-decision`):
#   { "action": "proceed" | "rebase" | "abandon", "notes"?: "…" }
curl -sS -X POST __BASE__/../tasks/api/complete -H 'content-type: application/json' \
  -d '{ "userTaskKey": "<key>", "variables": { "action": "rebase", "notes": "Re-run after the fix." } }'
```

**Answer a merge-loop escalation** (the one out-of-scope kind that still uses the
durable message catch, not a user task). Use the message name `escalation-answered`,
correlated by the PR key:

```bash
curl -sS -X POST __BASE__/actions/message \
  -H 'content-type: application/json' \
  -d '{
        "name": "escalation-answered",
        "correlationKey": "owner/repo#123",
        "variables": { "answer": "Yes — cap the retries at 5 and proceed." }
      }'
```

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

**Find the instance for a PR:** take `processKey` from `/status`, then query the
engine's Camunda-8 v2 REST API:

```bash
PK=<processKey-from-status>

# The instance itself (state, the BPMN process it is running, start time):
curl -sS -X POST __ENGINE__/process-instances/search \
  -H 'content-type: application/json' \
  -d "{ \"filter\": { \"processInstanceKey\": \"$PK\" } }" | jq

# Where is it parked? — active jobs on the instance (a CREATED senior:pr-review job
# with a `worker` set means an agent has leased the round; none means it is queued):
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

The app already mirrors an ACTIVE incident onto the PR row (`incident`/incident
message), so a PR that shows an incident in the UI is parked on an engine fault —
inspect it with `incidents/search` above. If the engine is not at the default, the
deployment's engine base is `__ENGINE__` (set via `NANOBPMN_BASE_URL` or
`CAMUNDA_REST_ADDRESS`).

**Relate an instance back to a PR:** if you have a `processKey` but not the PR, match
it against `/status` (`.prs[] | select(.processKey == "<PK>")`). A terminal PR is no
longer in `/status`; its instance has already completed or been cancelled.

---

## 6. Debug the models and the prompts

The behaviour is defined by durable BPMN processes and model-authored agent prompts —
both live in the source repo, not in the job payload.

- **Processes:** `resources/processes/*.bpmn` — `convergence-loop.bpmn` (review),
  `merge-loop.bpmn` (merge/CI-fix/rebase), `plan-fanout.bpmn` (planning),
  `retro.bpmn`. These are the source of truth for routing. To understand *why* an
  instance went where it did, read the gateway conditions (FEEL expressions on the
  sequence flows) for the element it is parked on (§5).
- **Prompts (agent base instructions):** `prompts/*.md` — `review-round.md`,
  `plan.md`, `feature.md`, `fix-ci.md`, `rebase.md`, `trial-merge.md`, etc. An
  agent's base prompt is **not** a job variable: it is delivered as a model
  **template header** (`{{review-round}}`, `{{plan}}`, …) substituted from these files
  at deploy time. If an agent misbehaves systematically, the prompt is the first thing
  to inspect/fix.
- **Job contract:** `senior:pr-review` receives `{ prUrl, repo, prNumber, round,
  answer? }` and must return a flat result `{ status, summary, question? }` with
  `status ∈ { converged, addressed, waiting, needs_input, blocked }`. A round that
  pushes anything (including a rebase/force-push) is `addressed`; a round with an
  unknown/empty result is treated as a safe `addressed` and re-enters the review wait
  rather than escalating.

To validate a model/prompt change locally: `npm run layout:check` (BPMN diagram
freshness), `npm run check:prompts` (every template resolves), `npm run check`
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
5. **Cancel + resubmit** as a last resort. Cancel the instance via the app (the UI's
   per-row Cancel, `POST /app/actions/cancel { "processInstanceKey": "<PK>" }`), which
   marks the PR `abandoned`, then re-submit the PR (§1) to start a fresh loop. Do not
   cancel a raw engine instance out from under the app — go through the app so its
   record state stays consistent.

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
