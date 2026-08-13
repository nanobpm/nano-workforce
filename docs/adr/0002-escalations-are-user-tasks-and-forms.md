# ADR 0002 — Escalations are user tasks + forms

Status: **Proposed.**
Date: 2026-08-13.

> **Scope note.** This is a **nano-workforce-local** ADR — it governs how *this app's* agent workforce
> models human (and agent) decision points. Platform-wide ADRs live in `Magikcraft/nano-bpm/docs/adr`
> (referenced by number + repo, e.g. "nano-bpm ADR 0026"). nano-workforce's own series continues here
> after ADR 0001.

Relates to:
nano-bpm **ADR 0026** (Urban human surfaces + run model — the `taskInbox` surface this ADR builds on:
a hosted task list backed by the engine's user-task search that renders a linked `.form` and posts
completion),
nano-bpm **ADR 0037** (execution + task listeners — the user-task lifecycle hooks this ADR leans on),
nano-bpm **ADR 0046** (agent-as-worker vs agent-in-the-node — the duality that lets an **agent** be a
task assignee, answering the same form a human would),
nano-bpm **ADR 0051** (nano-workforce — the crew orchestrator whose escalations this reshapes),
nano-bpm **ADR 0056** (the Nano agentic protocol — this ADR is the **durable** human-in-the-loop lane,
complementary to that ADR's **ephemeral** live-steering cockpit),
nano-workforce **ADR 0001** (this repo's ADR series),
and the current bespoke escalation subsystem in this repo: `app/plan.ts` (`plan_escalations`,
`plan_review_escalations`, `answerTaskEscalation`, `answerPlanEscalation`, `refreshOpenTaskEscalation`),
`app/service.ts` (the `open_escalation_*` pointer on `pull_requests`), the `pr.persist-*-escalation`
service workers, and the `feature-escalation-answered` / `plan-escalation-answered` resume messages in
`resources/processes/plan-fanout.bpmn`.

## Context

When a fanned-out agent task cannot proceed on its own — an open question, a trial-merge conflict, a
plan-review budget cap, a stuck PR-review loop — nano-workforce **escalates**: it parks the process and
waits for a human decision. Today that is a hand-rolled subsystem, and the same shape recurs three times:

1. **Task escalation** (`plan_escalations`, issue #25) — a fanned-out task's open question. In
   `plan-fanout.bpmn`: an `exclusiveGateway` (`escalated?`) routes to a **service task**
   `persist-task-escalation` (`pr.persist-task-escalation`) which writes the row + a denormalised
   `open_task_escalation_id` pointer on the plan, then an **intermediate message-catch**
   `wait-feature-answer` parks on `feature-escalation-answered` (correlationKey `=escalationCorrKey`).
2. **Plan-review escalation** (`plan_review_escalations`) — a plan-review cap; a human returns a
   `proceed | revise` directive. Same persist-service-task → message-catch shape
   (`plan-escalation-answered`); the table is **append-only** and the review **epoch** is derived from
   the count of answered rows.
3. **PR review-loop escalation** (`open_escalation_*` columns on `pull_requests`, #597/#599) — a review
   convergence that will not settle; surfaced via denormalised columns on the PR row.

Answering, in every case, means: an app worker records the answer, **mirrors** it onto the task/PR row,
**publishes the resume message**, and **re-surfaces** the next open escalation by rewriting a denormalised
"oldest open" pointer. The "form" is a bespoke Urban page that fires when a pointer is set and prints the
free-text `question`; the answer is a free-text string.

This is a **user task + form, re-implemented by hand** — and the bug tail proves it. Every incident is a
denormalised-pointer or free-text-contract failure: stale rows resurfacing a *dead* form after a re-plan
(`refreshOpenTaskEscalation`), the "addressed-escalation paradox," `blank question fabricates an
answerable escalation` (a hack to avoid an incident on an empty question), and per-run one-by-one row
cleanup. None of these can occur under a single-source-of-truth user-task lifecycle.

Crucially, **the primitives already exist**:

- The engine has **native user tasks** — `UserTaskProps`, `Command::CompleteUserTask` / `UpdateUserTask`,
  task listeners (ADR 0037), and `zeebe:assignmentDefinition` / priority / schedule parsed off the
  `userTask` element (`engine-core/src/bpmn.rs`, `model.rs`).
- Urban ships the **`taskInbox` surface** (ADR 0026): `GET /tasks` (list), `GET /tasks/api/tasks`
  (`engine.searchUserTasks`), `POST /tasks/api/complete` (`engine.completeUserTask(key, variables)`),
  rendering the linked **`.form`**. It is manifest-enabled (`surfaces.taskInbox`) and unused by nwf today.
- Forms are `.form` assets; the Urban **form editor** (the "Delphi" authoring surface) is the tool that
  authors them. This ADR is that editor's **first real internal customer**.

## Decision

**Model every decision-required escalation in nano-workforce as a native BPMN `userTask` with a linked
`.form`, surfaced through Urban's `taskInbox`, completed with typed variables that resume the process.**
Retire the bespoke `persist-escalation` service task → message-catch → resume-publish → denormalised-pointer
machinery.

### 1. A tiered taxonomy — not everything is a task

The current code conflates three tiers; draw the line explicitly at each raise site:

| Tier | Example | Mechanism |
| --- | --- | --- |
| **Transient** | empty-status backstop, re-request a review, a retriable step | stays **in-process** (retry / default arm) — **no task** |
| **Advisory** | a hint, a note for the next agent | the **blackboard** (`app/blackboard.ts`) — never gates a flow |
| **Decision-required** | proceed/revise, answer an open question, resolve a conflict, abandon | **user task + form** |

Only the third tier becomes a user task. This retires the "fabricate a blank answerable escalation" hack:
an empty question is a *non-escalation*, not a task.

### 2. `serviceTask(persist) + message-catch(wait)` → one `userTask`

Each `persist-*-escalation` service task and its paired intermediate message-catch collapse into a single
`userTask` bearing a `zeebe:formDefinition` (linked `.form`) and a `zeebe:assignmentDefinition`. The engine
owns the wait, the correlation, and the work-item state — so `escalationCorrKey`, the
`feature-escalation-answered` / `plan-escalation-answered` messages, and the `pr.persist-*-escalation`
workers are deleted. Completing the task carries typed variables straight back into the process.

### 3. Forms are the typed escalation contract

Each escalation kind gets a `.form` whose schema *is* its interface — replacing free-text question/answer:

- **Task escalation** → `{ resolution: "answer" | "abandon", answer?: string }`.
- **Plan-review escalation** → `{ directive: "proceed" | "revise", notes?: string }` — deleting the
  hand-rolled `parsePlanEscalationDirective`; the enum + required-field validation live in the form/FEEL.
- **Trial-merge escalation** → `{ action: "proceed" | "rebase" | "abandon", notes?: string }`.
- **PR review-loop escalation** → `{ answer: string }` (or a kind-specific action enum).

### 4. One queryable task list replaces three denormalised pointers

`open_task_escalation_id`, `open_plan_escalation_id`, and the `open_escalation_*` columns on
`pull_requests` all collapse into `engine.searchUserTasks(...)` — filterable by assignee, candidate group,
process instance, element, age. There is **no "surfaced" field to go stale**, so the resurface / dead-form
bug class is eliminated at the root. The plans page and any inbox read the live task search; the
`inbox_entries` seed is the natural home for the cross-plan view.

### 5. The assignee may be a human **or** an agent

`zeebe:assignmentDefinition` routes a task to a specific human, a **candidate group** (e.g. the operator /
crew leads), or — per ADR 0046 — an **agent**. An LLM worker can complete the *same* form a human would,
via the `chat`/agent surface or a job-worker-style completer. This makes "auto-resolve with a
slower/smarter model, else route to a human" a single lifecycle with one contract — something the bespoke
subsystem cannot express. Agent-answered completion is still a first-class, audited task completion.

### 6. SLA via a timer boundary

A user task carries a due date; a **timer boundary event** provides escalation-of-the-escalation —
reassign, notify, or auto-proceed on a default — the durable replacement for the review poller's ad-hoc
nudge. A decision no longer hangs forever with no deadline.

### 7. Audit trail from user-task history

`plan_review_escalations` is append-only because the **review epoch** = count of answered plan-review
escalations. Under this ADR the epoch is derived from **completed plan-review user tasks** (native user-task
history / completion events), so the dedicated audit table is retired without losing the audit.

## Consequences

- **A whole bug class disappears.** No denormalised "surfaced" pointer ⇒ no stale/dead-form resurfacing, no
  addressed-escalation paradox, no blank-question fabrication. The engine's single-source-of-truth
  user-task lifecycle replaces three hand-maintained mirrors.
- **Less code.** Delete `pr.persist-*-escalation` workers, the two resume messages + their catch events,
  `escalationCorrKey`, `answerTaskEscalation`/`answerPlanEscalation`/`refreshOpenTaskEscalation`, the
  denormalised columns, and the bespoke answer page — replaced by `userTask` nodes + `.form`s + the
  existing `taskInbox` surface.
- **Dogfoods the Delphi vision.** nwf becomes the first real consumer of the Urban form editor + user-task
  inbox, exercising forms end to end on a live app.
- **The third human-in-the-loop lane.** Enrolment (#152) = what work exists; visibility (#142) =
  watch/nudge a *live* agent (ephemeral); **escalation-as-user-task** = decide *durably* when blocked. The
  cockpit can list a worker's open escalation tasks; the two planes reinforce each other.
- **Migration is a real refactor, not a rename.** The bespoke tables encode edge cases (epoch-from-count,
  re-plan cleanup, trial-merge "proceed" override). The migration must preserve those semantics on the new
  substrate and run behind tests, phased kind-by-kind.
- **New dependency on engine user-task depth.** Assignment, candidate groups, task listeners, and timer
  boundaries on user tasks must be exercised (some may surface gaps to file against the engine). Form
  rendering richness is bounded by the `taskInbox`/form-editor state of the art.

## Open questions

- **Form-rendering fidelity.** The current `taskInbox` page is minimal (lists key/element). How rich a
  `.form` render is needed before the answer page can be deleted — and is that the form editor's job or a
  `taskInbox` upgrade (an nano-ide concern)?
- **Agent-answer policy (§5).** When may an agent auto-complete vs must-route-to-human — a per-kind policy,
  a confidence gate, or an operator toggle? How is an agent completion attributed and reversible?
- **Assignment model.** Candidate group vs named assignee for each kind; where the operator's routing
  preference is persisted (manifest vs app state).
- **Cross-plan inbox surface.** Does nwf embed `taskInbox` directly, or render its own plan-aware inbox
  page over `searchUserTasks` (matching the existing plans page), keyed through `inbox_entries`?
- **Back-compat window.** Do in-flight escalations at migration time drain on the old path, or are they
  re-issued as user tasks? (Prefer drain-old, issue-new, per kind.)
