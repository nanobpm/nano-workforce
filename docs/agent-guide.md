# Nano Workforce — agent operator guide

You are helping a human operate a running **Nano Workforce** instance: a durable
orchestration app that drives pull requests to **review convergence** and **merges** them,
takes whole issues through **plan → implement → converge** across a fleet of coding agents,
and runs agent-authored **delivery graphs**.

- **App control API base:** `__BASE__`
- **Engine (Camunda-8 v2 REST) base:** `__ENGINE__`
- **Source repository:** `nanobpm/nano-workforce`

**Tools first, curl as fallback.** Over MCP, call the projected tool named in each
recipe. Without MCP, use the curl door in the §10 crosswalk. If the deployment sets
`NANO_PR_WEBHOOK_SECRET`, add `-H "x-hook-secret: <secret>"` to **every** request — the
read endpoints (`/version`, `/status`, `/escalations`, `/agent`, `/agent/guide`, …) are
guarded too, not only the POSTs.

---

## 0. Orient yourself first

Confirm what is running and what is in flight before you act.

```bash
curl -sS __BASE__/version | jq   # tool: getVersion: app/urban version, git sha, uptime
curl -sS __BASE__/status  | jq   # tool: listActivePrs: every PR in flight
```

Each `/status` entry carries `prKey` (`owner/repo#123`), `status`, `round`, `processKey`
(the **engine process-instance key**, the bridge to §5), `openEscalation`,
`activeWorker`/`leaseUntil` (an agent holds the round, or the job is just queued), and
`updatedAt`.

It also carries the run's **merge intent** as a structured `merge` block (so "will this PR
merge?" is a read, not a guess):

```json
"merge": { "requested": true, "enabled": true, "effective": false, "blockedBy": "human-approval" }
```

| field | meaning |
|---|---|
| `requested` | the run's merge intent — the `autoMerge` process variable on its convergence loop (a loop seeded before that variable existed derives it from the inverse of the legacy flag). |
| `enabled` | the deployment's global `NANO_PR_AUTO_MERGE` switch. |
| `effective` | `requested && enabled && !humanApproval` — the run merges with no further gate. |
| `blockedBy` | why a *requested* merge will not proceed: `"env"` (the global switch is off) or `"human-approval"` (parked at the merge-approval task). `null` when the merge is effective — and when the run is converge-only (`requested: false`), which is a *choice*, not a block. |

The same intent is on the engine variables of the loop itself: query the instance
(`processKey`) for `autoMerge` — it is always seeded, so a missing `autoMerge` means a loop
started before this version (read `convergeOnly` and invert it there).

---

## 1. Submit a PR for review convergence

One PR → one durable `convergence-loop`. Each round runs a `senior:pr-review` agent. Between
rounds the process waits durably for the next review (the poller republishes `review-ready`),
so review latency never holds an agent slot.

```bash
# tool: startConvergenceLoop
curl -sS -X POST __BASE__/actions/start/convergence-loop \
  -H 'content-type: application/json' \
  -d '{ "pr": "owner/repo#42", "autoMerge": true, "maxRounds": 8, "dependsOn": ["owner/repo#40"] }'
```

| field | type | meaning |
|---|---|---|
| `pr` (or `url`) | string | `owner/repo#123` or a PR URL. Required. |
| `autoMerge` | boolean | `false` = review only, stop at `converged`. `true` = converge **then merge**. **Omitted = merge** (the merge path is the default). Merging also requires `NANO_PR_AUTO_MERGE` on (the default); a per-request value only ever narrows to review-only, it never forces a merge when the global switch is off. Choose deliberately — to guarantee review-only, set `autoMerge: false` explicitly. |
| `maxRounds` | integer | round cap before escalating (1–100; default `NANO_PR_MAX_ROUNDS`, 20). |
| `dependsOn` | string[] | `prKey`s that must land before this one merges. |
| `autoResolveEscalations` | boolean | opt in to the escalation steward (§3). Default `false`. |

Idempotent on the PR key: re-POSTing refreshes the record instead of starting a second
loop. The 202 response echoes `prKey` and `processKey`.

`autoMerge` must be a JSON **boolean** — a string (`"true"`) is a `400` at every start door
(`startConvergenceLoop`, `startFeature`), never a silent review-only run. To *read* the intent
back, use the `merge` block in `/status` (§0). There is **no supported way to flip merge
intent on a running loop**. Direct variable writes onto a live instance (e.g. `autoMerge=true`)
are **unsupported and timing-dependent, not reliable no-ops**: the agent tasks guard-restore the
seeded value, so a write is usually overwritten — but a write that lands while the loop awaits
merge approval is never restored and reaches `pr.finalize`, where it can change whether merging
starts. To change the intent, cancel the run (`cancelInstance`, §7) and re-submit with the
intent you want.

---

## 2. Submit an epic (plan → implement → converge)

A planning agent splits an issue into levelled tasks. One implementation agent per task
opens a PR, and every PR is enrolled in its own convergence loop (§1).

```bash
# tool: startPlanFanout
curl -sS -X POST __BASE__/actions/start/plan-fanout \
  -H 'content-type: application/json' \
  -d '{ "issue": "owner/repo#123", "baseBranch": "epic/agent-protocol" }'

# Single issue → one PR, no planning (tool: startFeature). Adds `converge` and `autoMerge`.
curl -sS -X POST __BASE__/actions/start/feature \
  -H 'content-type: application/json' \
  -d '{ "issue": "owner/repo#123", "baseBranch": "main", "confirmDefaultBase": true, "converge": true, "autoMerge": true }'
```

Idempotent on the plan key. The 202 response echoes `planKey` and `processKey`, and the
plan's PRs appear in `/status` as ordinary convergence loops. Both doors accept
`autoResolveEscalations` (default `false`), and it propagates to every child the run spawns.

**Base-branch admission.** `baseBranch` is checked before anything fans out:

1. **Required.** Blank or absent → `400 MissingBaseBranchError`. An implausible name →
   `400 InvalidBaseBranchError`. There is no silent default.
2. **Only `epic/*` is created if missing** (off the default branch's HEAD; an existing branch
   is never reset). Any other missing base → `400 BaseBranchMustExistError`.
3. **The repo default branch needs `confirmDefaultBase: true`**, else
   `400 DefaultBaseNotConfirmedError`, because every task then lands straight on it.
4. **Shared base.** Another active epic on the same repo and custom base →
   `409 SharedBaseError`, unless you pass `allowSharedBase: true`. The default branch is exempt.

**Build hygiene.** Workers are ephemeral, so implementation prompts (`feature.md`,
`fix-ci.md`) tell agents to read the target repo's `AGENTS.md`/`CONTRIBUTING.md` build
recipe, run its dependency warm-up once (e.g. camunda: `./mvnw install -Dquickly -T1C`),
then build only the changed module offline (`./mvnw -Dquickly -o -pl <module> <goals>`),
never a cold `-am` reactor build per iteration. The recipe lives in the target repo, not here.

---

## 3. Answer escalations (unblock a human-in-the-loop wait)

A loop escalates when an agent returns `needs_input`/`blocked`, or when a safety net fires
(round cap, a review that never arrives, a merge conflict, unfixable CI). The process parks
on a native BPMN user task until someone answers.

```bash
# tool: listEscalations: every open escalation with userTaskKey, kind, subject, question
curl -sS __BASE__/escalations | jq
```

`/status` also carries a structured `openEscalation` pointer — `{ userTaskKey, kind, summary }`
(or `null`) — so you can answer straight from it. `listEscalations` remains the fuller
task-context surface (subject, question, findings). The raw task inbox is
`__BASE__/../../tasks/api/tasks`, and its UI for humans is at `__BASE__/../../tasks`.

**Answer** through the one door, `completeUserTask`, with the variables the task's kind
expects. Answering as an agent assignee? Use `agentCompleteEscalation` instead: it records
agent identity for attribution.

| kind (`elementId`) | `variables` |
|---|---|
| PR review loop (`wait-answer`) and merge loop (`wait-merge-answer`) | `{ "answer": "…" }` |
| Implementation task (`feature-escalation`) | `{ "resolution": "answer", "answer": "…" }` or `{ "resolution": "abandon" }` |
| Plan review (`plan-review-decision`) | `{ "directive": "revise", "notes": "…" }` (fresh review budget) or `{ "directive": "proceed" }` |
| Trial merge (`trial-merge-decision`) | `{ "action": "rebase", "notes": "…" }`; `action` is `proceed`, `rebase` or `abandon` (`notes` optional) |

```bash
# tool: completeUserTask
curl -sS -X POST __BASE__/actions/complete-user-task -H 'content-type: application/json' \
  -d '{ "userTaskKey": "<key>", "variables": { "answer": "Cap retries at 5 and proceed." } }'
```

The answer becomes the agent's next-round context and the loop resumes. Read the
`question`/`findings` first and give the smallest answer that unblocks it. The history is
durable: completed user tasks, plus the `escalations` table shown per PR on the Convergence page.

> **A delivery-graph `wait` escalation is different.** Completing it releases the gate
> **as not-ready**, so the downstream work runs against the unmet dependency. Read §9.2
> before clearing one.

### The escalation steward (opt-in auto-resolution)

Work submitted with `autoResolveEscalations: true` has its open escalations reviewed by the
**steward** every 30 minutes (`NANO_ESCALATION_STEWARD_INTERVAL`; `NANO_ESCALATION_STEWARD=off`
disables it). The steward submits the recommended choice through `completeUserTask` with
**agent** attribution. It is conservative:

- It waits a minimum age, so a human already answering wins.
- It never touches human-only kinds: merge approval, permission prompts, readiness gates,
  blocked/conformance acks, abandon.
- It **abstains** when the right choice is unclear, or when a subject has already been
  auto-resolved twice and escalated again.

Every resolution and abstention is recorded for review in **Auto-resolutions** (nav badge =
pending count). Read with `listAutoResolutions` (`GET __BASE__/auto-resolutions`), review with
`reviewAutoResolution` (`{ id, action: "dismiss" | "intervene", note? }`).

---

## 4. The lifecycle & statuses (so you can reason about state)

```
 submit ──► convergence-loop
   round (senior:pr-review) ──► addressed ──► wait review-ready ─┐
                             ├─ converged  ──► finalize ──► merge-loop (when autoMerge and NANO_PR_AUTO_MERGE are enabled)
                             └─ needs_input/blocked ──► escalate ──► wait-answer userTask (task inbox)
 merge-loop: wait deps ─► arm merge ─► (queue-aware) merge / land
             blocked (CI red) ─► senior:fix-ci ─► retry     conflict ─► senior:rebase ─► retry
```

PR `status` values: `converging` (round live), `waiting_review`, `escalated`, `converged`,
`waiting_deps` / `waiting_merge` / `queued` / `merging`, `merged`, `abandoned`. An
**incident** (§5) can overlay any live status when the engine parks the token on a fault.

The merge-stage statuses only ever appear when the run's merge policy is effective — read the
`merge` block in `/status` (§0) to distinguish "merge requested but disabled by env"
(`blockedBy: "env"`) and "waiting for human approval" (`blockedBy: "human-approval"`) from
"converge-only" (`requested: false`).

---

## 5. Debug: find engine instances and relate them to PRs

`processKey` (DB column `process_key`) joins the app's record to the engine instance. Take it
from `/status`, then query the engine. Over MCP, the framework `urban_debug_*` tools front
these same searches (§10).

```bash
PK=<processKey>
H='content-type: application/json'
# State, BPMN process, start time:
curl -sS -X POST __ENGINE__/process-instances/search -H "$H" -d "{\"filter\":{\"processInstanceKey\":\"$PK\"}}" | jq
# Where it is parked (a job with a `worker` set is leased by an agent; none = queued):
curl -sS -X POST __ENGINE__/jobs/search -H "$H" -d "{\"filter\":{\"processInstanceKey\":\"$PK\",\"state\":\"CREATED\"}}" | jq
# Technical fault?
curl -sS -X POST __ENGINE__/incidents/search -H "$H" -d "{\"filter\":{\"processInstanceKey\":\"$PK\",\"state\":\"ACTIVE\"}}" | jq
# Which BPMN element it sits on:
curl -sS -X POST __ENGINE__/element-instances/search -H "$H" -d "{\"filter\":{\"processInstanceKey\":\"$PK\"}}" | jq
# The variables the engine holds:
curl -sS -X POST __ENGINE__/variables/search -H "$H" -d "{\"filter\":{\"processInstanceKey\":\"$PK\"}}" | jq
```

An active incident is mirrored onto the PR row, so a PR showing an incident in the UI is
parked on an engine fault. The engine base comes from `NANOBPMN_BASE_URL` or
`CAMUNDA_REST_ADDRESS`.

Have a `processKey` but not the PR? Use `/status | jq '.prs[] | select(.processKey == "<PK>")'`.
A terminal PR has left `/status`.

---

## 6. Debug the models and the prompts

- **Processes.** Engine truth is the deployed XML (`urban_debug_get_process_definition_xml`).
  The source in git is `resources/processes/*.bpmn`: `convergence-loop.bpmn` (review),
  `merge-loop.bpmn` (merge/CI-fix/rebase), `plan-fanout.bpmn`, `retro.bpmn`. The repo copy can
  lag a running deployment. To see *why* an instance routed somewhere, read the FEEL
  conditions on the outgoing sequence flows of the element it is parked on (§5).
- **Prompts.** `resources/prompts/*.md` (`review-round.md`, `plan.md`, `feature.md`,
  `fix-ci.md`, `rebase.md`, `trial-merge.md`, …) deploy by convention. Each agent task links its
  base prompt as a linked resource that the engine resolves at job activation:

  ```xml
  <zeebe:linkedResource resourceId="prompts/review-round.md" bindingType="latest" resourceType="GenericScript" linkName="prompt"/>
  ```

  It is combined with the task's runtime `appendPrompt` FEEL. Because of `latest`, redeploying a
  prompt changes it mid-epic with no process redeploy. A systematically misbehaving agent
  usually means a prompt problem. There is no deploy-time `{{token}}` templating: pass per-run
  values as job variables / `appendPrompt`.
- **Job contract.** `senior:pr-review` receives `{ prUrl, repo, prNumber, round, answer? }` and
  returns `{ status, summary, question? }`, with `status ∈ { converged, addressed, waiting,
  needs_input, blocked }`. Any push (including a rebase) is `addressed`. An empty or unknown
  result is treated as `addressed` and re-enters the review wait.

Validate a model or prompt change with `npm run layout:check`, `check:prompts`, `check`,
`typecheck`, `lint` and `test`.

---

## 7. Unstick a stuck process

1. **Is it actually stuck?** `converging` with an `activeWorker` means an agent is working.
   No worker for a long time means the job is queued: check that a fleet `c8ctl nano work`
   daemon is running and subscribed to the `senior:*` types.
2. **Incident?** (§5) It parks the token until the fault is resolved, or until you cancel and
   resubmit.
3. **Open escalation?** (§3) Answer it.
4. **Review never arrives?** It escalates after `NANO_PR_REVIEW_WAIT_TIMEOUT` (default `PT30M`),
   and the poller re-nudges the reviewer. If no reviewer bot is provisioned on the repo, that
   is a repo-config problem.
5. **Last resort: cancel and resubmit** through the app-owned door, `cancelInstance`. It cancels
   the engine instance **and** marks the record `abandoned`. Then resubmit (§1). Never use the
   engine-level `urban_debug_cancel_instance` or a raw engine cancel: it leaves the PR row
   inconsistent.

   ```bash
   curl -sS -X POST __BASE__/actions/cancel -H 'content-type: application/json' \
     -d '{ "processInstanceKey": "<PK>" }'
   ```

---

## 8. Raise an issue or a PR against nano-workforce

For a genuine orchestration bug or gap (not a transient repo/agent problem), file it against
`nanobpm/nano-workforce`. Include the evidence: `prKey`, `processKey`, the parked element or
incident message (§5), and the BPMN or prompt file you suspect (§6).

If you change code: open or claim an issue first, work in a worktree off `origin/main`, and
sign off every commit (`git commit -s`, DCO). Never hand-edit `bpmndi` (run
`npm run layout <file.bpmn>`). Run the CI gates locally (§6 list). Drive the PR to convergence
against Copilot review. Read `AGENTS.md` and `SPEC.md` before changing a process.

---

## 9. Author and run a delivery graph (ADR 0005)

A delivery graph composes heterogeneous, cross-repo, partly-human work as **data**, for example:
*merge PR #101 → un-draft and merge PR #202 → a human does a manual OTP publish → PR #303
consumes that version.* You author **JSON only, never BPMN or code**.

Your surface is **propose → compile → stage**. **Dispatch is an operator action** in the
cockpit. There is no agent start door, so nothing an agent can call or replay launches a run.

> **The structured vocabulary is authoritative:** `getDeliveryGraphVocabulary`
> (`GET __BASE__/delivery-graph/vocabulary`) returns the node kinds and fields, every `wait`
> probe kind and what it observes, connector targets, `onTimeout` options, poll defaults and
> fact-threading rules. It is derived from the code, so read it before authoring. This section
> covers the workflow and the traps.

### 9.1 The `DeliveryGraph` shape

`{ name?, nodes[], edges[] }`, a DAG. Each node has a unique `id`, a `kind`, that kind's
config, and optional `emits[]` (typed facts `{ name, type, description? }`, with
`type ∈ string|number|boolean|artifact|version|url|pr`). For edges, each edge is `{ from, to }`:
`to` proceeds once `from` is observable. `from` is a bare `<nodeId>` (completion) or a
qualified `<nodeId>.<fact>` naming one of that node's `emits`.

| kind | config | does |
|---|---|---|
| `agent` | `agent: { jobType, repository?, baseBranch?, prompt?, converge?, merge?, timeout? }` | runs an agent job in a fresh checkout of `repository`. Side-effecting. `converge`/`merge` (merge requires converge) declare land intent; a raw `senior:converge`/`senior:merge` job is rejected. `timeout` is an ISO-8601 per-node SLA overriding the run's `nodeTimeout` (default `PT1H`). |
| `wait` | `wait: <ReadinessProbe>` | a durable, bounded, read-only readiness probe `{ kind, target, match?, poll?, onTimeout? }`. Kinds: `http`, `command`, `npm`, `github-check`, `capability`, `pr`, `epic`. |
| `human` | `human?: { formKey?, prompt? }` | a user task on the Tasks inbox (§3), answerable by a human or an agent. |
| `connector` | `connector: { target, dedupeKey?, payload?, timeout? }` | an at-least-once, deduped outbound action. Real targets: `converge`, `converge-merge`, `merge-main` (§9.4). |

> **Provision every `agent` node with a repository — compile will NOT catch it.** Each agent
> clones its node's `repository` (`owner/repo`) at `baseBranch` (node value, else the run-level
> dispatch base, else the repo default) and cuts `feat/<node.id>`. A node with no `repository`
> compiles cleanly, then Dispatch fails with `N agent node(s) resolve to no repository (…)`
> unless the operator supplies a run-level fallback. So set `repository` on **every** agent node.
> If you leave one unset, tell the operator. `repoless` is a run-wide mode for graphs where
> **no** node needs a checkout.

> **Set `poll.timeoutMs` on every merge or epic gate.** If `poll` is omitted, a `wait` inherits
> **30 minutes** (re-probing every 15 s). That suits "is the package published?", but a
> `wait[pr, merged]` or `wait[epic]` then escalates mid-review. Use e.g.
> `"poll": { "everyMs": 300000, "timeoutMs": 259200000 }` (5 min / 3 days).

**Guarded routing.** An edge may carry `when: "<nodeId>.<fact>"` + `equals: <scalar>`, or be the
split's single `default: true` branch. Exactly one branch fires. For an `agent` node, the fact
is read from a same-named top-level field in the agent's result JSON. The system adds that
instruction to the agent's prompt automatically when the node declares `emits`. If the agent
omits the fact, the `default` branch is taken.

**Result statuses are added automatically. Don't write them into your prompt.** Every agent
node's prompt gets the allowed terminal statuses (`done` / `opened` / `skipped`). A completion
moves on only with one of those statuses and every required emit present. Anything else parks
the run on a human `__contract` escalation — **except** an absent/null `status`, which a legacy
worker that populates its required emits may still advance with (the status contract binds only
when a status is actually reported).

### 9.2 The agent loop: draft → compile → stage → ask an operator to dispatch

```bash
# tool: compileDeliveryGraph: validate + preview + STAGE (never deploys or runs)
curl -sS -X POST __BASE__/actions/compile-delivery-graph \
  -H 'content-type: application/json' -d @graph.json | jq
```

- **`200 { status:"ready", message, digest, preview, reviewUrl }`**: staged.
  `preview` is `{ diagram (mermaid), sideEffects[], humanNodes[] }`. `digest` names the proposal,
  and `reviewUrl` is a cockpit link (navigation only, not a dispatch handle). Give the operator
  the `digest`/`reviewUrl` and ask them to dispatch.
- **`400 { ok:false, errors:[{ path, message }] }`**: path-qualified errors (unknown kind,
  dangling edge, cycle, unbound fact). Fix and recompile; nothing is staged.

Recompiling is safe: the same graph is idempotent, and a changed graph with the same `name`
replaces the staged proposal. The operator previews it on the **Delivery Graphs** page and
clicks **Dispatch**. That click is the approval, bound to the previewed digest. Dispatch also
accepts `autoResolveEscalations` (§3). The running graph shows in **Active Delivery Graphs**,
and `human` nodes are answered like escalations (§3), emitting their declared facts.

> **Completing a `wait` escalation proceeds *as not-ready*. It does NOT re-arm the gate.** With
> `onTimeout: "escalate"` (default), an elapsed bound parks a task. Completing it releases the
> token past the gate, so the downstream side-effecting node runs against the unmet dependency.
> If the dependency isn't ready, don't complete it: raise `poll.timeoutMs` and re-dispatch, or
> abandon. (`onTimeout: "continue"` proceeds the same way with no human stop.) **Exception:** a
> `wait` that declares `emits` validates the resume value and re-parks on a missing or invalid one.

### 9.3 Worked example — the cross-repo human-in-the-loop release

The `human` node emits a `version` fact that the edge `manual-publish.publishedVersion` binds
into the next agent:

```json
{
  "name": "cross-repo release: merge #101 → un-draft+merge #202 → manual OTP publish → consume in repo-3",
  "nodes": [
    { "id": "merge-a", "kind": "wait",
      "wait": { "kind": "pr", "target": "acme/repo-1#101", "match": { "prState": "merged" },
                "poll": { "everyMs": 300000, "timeoutMs": 259200000 }, "onTimeout": "escalate" } },
    { "id": "undraft-merge-b", "kind": "agent",
      "agent": { "jobType": "senior:feature", "repository": "acme/repo-2", "converge": true, "merge": true, "prompt": "Take draft PR acme/repo-2#202 out of draft; converge it to green and land it." } },
    { "id": "manual-publish", "kind": "human",
      "human": { "prompt": "Run the manual OTP-authenticated `npm publish` for @acme/widget. Record the exact published version." },
      "emits": [ { "name": "publishedVersion", "type": "version" } ] },
    { "id": "open-pr-c", "kind": "agent",
      "agent": { "jobType": "senior:feature", "repository": "acme/repo-3", "prompt": "Bump @acme/widget to the published version in acme/repo-3 and open a PR." },
      "emits": [ { "name": "pr", "type": "pr" } ] },
    { "id": "merge-c", "kind": "wait",
      "wait": { "kind": "pr", "target": "open-pr-c.pr", "match": { "prState": "merged" },
                "poll": { "everyMs": 300000, "timeoutMs": 259200000 }, "onTimeout": "escalate" } }
  ],
  "edges": [
    { "from": "merge-a", "to": "undraft-merge-b" },
    { "from": "undraft-merge-b", "to": "manual-publish" },
    { "from": "manual-publish.publishedVersion", "to": "open-pr-c" },
    { "from": "open-pr-c.pr", "to": "merge-c" }
  ]
}
```

### 9.4 Connector targets — drive a PR to convergence + merge (`converge` / `converge-merge` / `merge-main`)

A connector with one of these targets enrolls a PR in the same convergence loop as §1
(idempotent; never double-enrolls). Payload: `{ pr, autoMerge?, dependsOn? }`.

- **`converge`**: review only, stop at `converged`.
- **`converge-merge`**: converge, then merge onto the PR's own base (inside an epic, that is the
  integration branch).
- **`merge-main`**: same mechanics, for landing the graph's integration PR on `main`.

The PR number is unknown when you write the graph, so have the agent **emit a `pr` fact** and
reference it as `"<node>.pr"`. The reference needs a threading edge from that fact, otherwise
compile rejects it (`unbound-pr`). A connector with no `payload.pr` binds the single incoming
`pr` fact, and a literal `owner/repo#N` also works.

```json
{
  "name": "open → converge+merge → wait merged",
  "nodes": [
    { "id": "open", "kind": "agent",
      "agent": { "jobType": "senior:feature", "repository": "acme/repo", "prompt": "Implement the change and open a PR." },
      "emits": [ { "name": "pr", "type": "pr" } ] },
    { "id": "land", "kind": "connector", "connector": { "target": "converge-merge", "payload": { "pr": "open.pr" } } },
    { "id": "merged", "kind": "wait",
      "wait": { "kind": "pr", "target": "open.pr", "match": { "prState": "merged" },
                "poll": { "everyMs": 300000, "timeoutMs": 259200000 }, "onTimeout": "escalate" } }
  ],
  "edges": [ { "from": "open.pr", "to": "land" }, { "from": "open.pr", "to": "merged" } ]
}
```

> **Don't hand-write that chain. Generate it.** To run issues one after another (each
> implemented, converged, then merged), call **`sequenceIssues`**
> (`POST __BASE__/actions/start/sequence-issues`, body
> `{ "issues": ["owner/repo#A", "owner/repo#B"], "behind"?: "owner/repo#NN" }`). It builds the
> chain above for each issue, with an optional leading `wait[epic]` gate, and stages it through
> compile (it never dispatches).

### 9.5 Gate a graph on an epic reaching "fully merged" (`wait[epic]`)

`kind: "epic"` waits until every slice PR of an epic (or the PR of a feature run) has landed.
`target` is the **`planKey`** (`owner/repo#NN`, the root issue), not an engine key, so it
survives a resubmit. `match.epicState` is `merged` (default) or `done`. A failed or abandoned
epic never reports merged, so the bounded wait routes via `onTimeout`. On a match it binds
`prCount`.

```json
{ "id": "gate-epic", "kind": "wait",
  "wait": { "kind": "epic", "target": "nanobpm/nano-ide#488", "match": { "epicState": "merged" },
            "poll": { "everyMs": 300000, "timeoutMs": 259200000 }, "onTimeout": "escalate" },
  "emits": [ { "name": "prCount", "type": "number" } ] }
```

---

## 10. Tool ↔ curl crosswalk (MCP-first, curl is the no-MCP fallback)

| Action | Tool | No-MCP fallback |
|---|---|---|
| Live version (§0) | `getVersion` | `GET __BASE__/version` |
| PRs in flight (§0) | `listActivePrs` | `GET __BASE__/status` |
| Submit a PR / epic / feature (§1–2) | `startConvergenceLoop` / `startPlanFanout` / `startFeature` | `POST __BASE__/actions/start/{convergence-loop,plan-fanout,feature}` |
| List escalations (§3) | `listEscalations` | `GET __BASE__/escalations` |
| Answer an escalation (§3) | `completeUserTask` (as agent: `agentCompleteEscalation`) | `POST __BASE__/actions/complete-user-task` (as agent: `POST __BASE__/hooks/agent-complete` with `agentId` required) |
| Auto-resolutions (§3) | `listAutoResolutions` / `reviewAutoResolution` | `GET __BASE__/auto-resolutions` / `POST __BASE__/auto-resolutions/review` |
| Cancel a run (§7) | `cancelInstance` | `POST __BASE__/actions/cancel` |
| Publish a BPMN message | `postMessage` | `POST __BASE__/actions/message` |
| Delivery graphs (§9) | `getDeliveryGraphVocabulary` / `compileDeliveryGraph` / `sequenceIssues` | `GET __BASE__/delivery-graph/vocabulary`, `POST __BASE__/actions/{compile-delivery-graph,start/sequence-issues}` |
| This guide | `getAgentInstructions` (full) / `getAgentGuide(section?)` | `GET __BASE__/agent` / `GET __BASE__/agent/guide` |

The engine-debug tools come from the urban framework and front `__ENGINE__` (§5).
`urban_debug_search_process_instances`, `urban_debug_search_element_instance_wait_states` and
`urban_debug_search_incidents` are always available. `urban_debug_search_jobs`,
`urban_debug_search_variables` and `urban_debug_get_process_definition_xml` exist where the
framework provides them; otherwise use the §5 curl searches or read `resources/processes/` from
the checkout. **Never use `urban_debug_cancel_instance`**: use `cancelInstance` (§7).
