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
            ┌───────────────────┐      readiness-ready (msg)     ┌──────────┐
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
  the canonical `readiness-ready` wait-gate message (ADR 0001 §2) when a new
  review lands — the "out-of-band poller-correlated shape" the review-ready wait
  is re-expressed on (#259), so there is one "wait for the world" mechanism (no
  GitHub webhook needed; works behind NAT).

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
│      ├── converged  → [Check review comments] (pr.converge-gate; ++ackRetryRound on ack-only block)
│      │                   → <gateway: comments addressed?>
│      │                       ├── addressed → [Scope classifier] → … → <human approval?> → [Mark converged] → (end)
│      │                       ├── review stale (#799) → [Record round] (re-solicit fresh review) ┐
│      │                       └── unaddressed → <gateway: auto-ack within budget?>               │
│      │                            ├── convergeAckOnly and ackRetryRound ≤ ackRetryMax           │
│      │                            │      → re-dispatch review-round (round unchanged) ───────────┤
│      │                            └── unresolved thread / budget exhausted                      │
│      │                                 → [Escalate: unaddressed comments] (blocked)             │
│      │                                 → [Wait: wait-answer userTask] ────────────────────────────┤
│      │                                                                                          │
│      ├── addressed  → <adversarial pass due? (#844)>                                             │
│      │  (or waiting)    ├── pass due (addressed, or first push; budget unspent)                  │
│      │                  │      → [Adversarial review] (service task, taskType: senior:adversarial-review) │
│      │                  │          → <findings?> ── findings → re-dispatch [Review round] (round unchanged) │
│      │                  │                          └── clean → [Record round]                    │
│      │                  └── disabled / budget spent → [Record round]                             │
│      │                        [Record round] → [Check progress] (did the PR head advance?)       │
│      │                   ├── progressed → <guard: round ≥ maxRounds → escalate "not converged"> │
│      │                   │                   → <event-based gateway: review ready or timeout?>   │
│      │                   │      ├── readiness-ready (msg catch, key = prKey) → round++ ─┐        │
│      │                   │      └── =reviewWaitTimeout (timer catch)                     │        │
│      │                   │           → [Escalate: review stalled] (blocked)             │        │
│      │                   │           → [Wait: wait-answer userTask] ────────────────────┤        │
│      │                   └── no progress → <husk? no commit AND no terminal instance>   │        │
│      │                          ├── husk & retries < MAX → re-enter [Review round] (bypasses the round-cap guard) │
│      │                          └── no-advance / husk cap → [Escalate: no progress]      │       │
│      │                                     → [Wait: wait-answer userTask] ───────────────────┤   │
│      │                                                                             │            │
│      └── needs_input     [Record escalation]                       │               │            │
│          or blocked  →   (kind = question | blocker)               │               │            │
│                          → [Wait: wait-answer userTask]            │               │            │
│                          → [record-answer: pr.answer-escalation]   │               │            │
│                          → set answer ──────────────────────────────┤               │            │
│                                                                    │               │            │
└────────────────────────────────────────────────────────────────────┴───────────────┴────────────┘

Both `needs_input` (the agent has a question) and `blocked` (the agent is stuck
on something external — auth, a failing push, a missing secret) route to the
**same escalation path**: record it, park on the native `wait-answer` user task
(answered through the canonical `completeUserTask` door and surfaced in the Tasks
inbox), reconcile the answer via the `record-answer` (`pr.answer-escalation`)
step, then retry the same round with the human's `answer`. They differ only by escalation `kind`,
which the UI uses to label the card. Neither ends the run — a human always gets
a chance to unblock and resume.

**Local adversarial-review stage (issue #844).** Before an `addressed` or first-push
`waiting` round parks on `waiting_review` (the only status the poller solicits a Copilot
review for), the loop runs a bounded local adversarial pass over the round's diff. The
`<adversarial pass due?>` gate (`gw-adv-due`) fires when the per-round budget is unspent
and the round is `addressed` **or** the first push (`advMax != null and advPass < advMax
and (status != "waiting" or round = 1)`); otherwise (disabled, budget spent) it skips
straight to `[Record round]`. The `senior:adversarial-review` service task (prompt
delivered via the `prompts/adversarial-review.md` linked resource) critiques the diff and
returns `adversarialFindings`. Non-blank findings **re-dispatch `[Review round]` within the
same round** (round unchanged) with `adversarialFindings` seeded, so the agent fixes them
before this app's poller solicits the Copilot review (the only `waiting_review` trigger); a
clean result records the round and proceeds to `[Check progress]`. The pass budget is
`MAX_ADVERSARIAL_PASSES` (default 1,
`NANO_PR_MAX_ADVERSARIAL_PASSES=0` disables the stage).

**Durable adjudication auto-resume (issue #806).** A human's answer to a `wait-answer`
is remembered durably, keyed by `(PR, canonical question fingerprint)` — the
`record-answer` step persists it (`pr_adjudications`), and before the poller surfaces a
*new* `wait-answer` it checks for a settled adjudication of the **same** question. On a
match it auto-resumes the round with the recorded answer through the canonical
`completeUserTaskAttributed` door — attributed to the original adjudicator, marked
`auto_applied` and recorded reversible so a human can still override — instead of
re-parking a human on an already-settled question (PR #800 saw the same design question
escalate at round 2 and again at round 13). This is the one exception to "every
`needs_input`/`blocked` parks `wait-answer`": a question with an existing adjudication for
this PR resumes without a fresh human park. A *materially different* question still
escalates, resolution failure fails open to the human, and re-submitting the PR
(`submitPr`) invalidates its adjudications so a fresh run re-decides. Only the convergence
loop feeds and reads this memory — a merge-loop answer (same `pr.answer-escalation` step)
is tagged `answerContext = "merge"` and never recorded as a convergence adjudication.

**Human approval before merge (issue #826).** A feature run started with `humanApproval`
seeds `humanApproval = true` on its convergence instance — only when the PR would merge
(`autoMerge` on and `NANO_PR_AUTO_MERGE` enabled; otherwise it is pinned off).
After the scope gate passes, the `human approval?` gateway then parks the converged PR on the
native `merge-approval` user task (`merge-approval.form`, surfaced in the Tasks inbox as
"PR merge approval") instead of going straight to `[Mark converged]`. `mergeDecision = "approve"`
continues to `pr.finalize`, which hands the PR to the merge-loop. Approval covers the PR, not a
pinned SHA: as with any auto-merge, the merge-loop may still rebase it or fix CI before landing.
Anything else (the form's
`revise` plus required guidance) loops back to `capture-head` with the guidance as `answer`, so
the review agent updates the **same** PR. Convergence then re-runs and approval is asked again.
The default route is fail-closed: once parked, nothing merges without an explicit approval. A
gated run that adopts a PR already converging under a live loop (e.g. one an ungated run started)
narrows that loop to `humanApproval = true` rather than inheriting its auto-merge; a loop already
past its `human approval?` gateway can no longer be gated. The task is
human-only (never agent-answerable) and never auto-resumed from an adjudication. Without the
flag the gateway defaults straight through, so existing runs are unchanged.

Guard: after progress classification, a **progressing** round with round ≥
MAX_ROUNDS forces an escalation ("not converged after N rounds") so a human
decides rather than looping forever. The guard sits *after* `check-progress`
(not before), so a husk auto-retry — which does not consume a round — bypasses
the cap and is re-tried onto a healthy worker even on the final configured round.
The **stale-review re-solicitation** path (below) likewise bypasses the cap: its
`f_guardMax` arm is gated on `round ≥ maxRounds and reviewStale != true`, so a
stale review received on the final configured round re-solicits a fresh review
instead of escalating (the review-wait timeout remains the backstop).
```

Notes:
- **Convergence comment-gate + stale-review re-solicitation (issue #799).** The
  agent's self-reported `converged` does not finalize directly: it first runs the
  deterministic `pr.converge-gate` (`check-converge` → `gw-converge-gate`). That
  gate **blocks** convergence (`convergeBlocked = true`) while any review thread
  is unresolved or any suppressed advisory lacks a resolved `nano-ack:` thread.
  A block whose *sole* outstanding items are unresolved `nano-ack:` threads is
  classified **ack-only** and does **not** immediately escalate to a human:
  within the `ackRetryMax` budget the bounded auto-ack retry re-dispatches
  `review-round` (round unchanged) to finish the acknowledgements; only a
  substantive unresolved thread — or an exhausted ack-retry budget — escalates
  ("unaddressed comments"). Otherwise the gate proceeds to the scope
  classifier and finalizes. A third arm handles a **stale review** — one whose
  `commit_id` predates the PR's current HEAD (its advisories describe code the
  head has moved past, e.g. an advisory already fixed in a later commit). Rather
  than block/escalate on the obsolete body, the gate signals `reviewStale = true`
  and `f_convergeStale` re-enters `persist-round` → `check-progress` (which parks
  the PR in `waiting_review`, the single writer), so the poller re-solicits a
  fresh review of the current HEAD. The head is read via the shared
  branch-ref-preferring reader (`makeDefaultReadHead`, atomic with the push, #786)
  in BOTH the gate and the poller so they agree on the current head. `reviewStale`
  is written only by the gate and cleared on BOTH loop re-entry paths — by the
  `wait-review` catch when a fresh review lands, and by `record-answer` when a
  human resumes after the review-stall timer — so the marker cannot leak into a
  later round. Because a stale review is not a failure to converge, this path
  bypasses the round cap (see the Guard above).
- On `addressed`, the loop parks at an **event-based gateway** that races the
  canonical `readiness-ready` wait-gate message (ADR 0001 §2; correlated by the
  poller when a fresh review lands)
  against a `=reviewWaitTimeout` timer (seeded at submit from
  `NANO_PR_REVIEW_WAIT_TIMEOUT`, default `PT30M`). Whichever fires first
  withdraws the other — the message arm advances `round`, the timer arm escalates
  a **stalled review** (`blocked`) so a human decides rather than the instance
  hanging forever. Because `persist-round` already recorded this `round` as
  `addressed` before the gateway, the timer arm opens the escalation **without
  re-recording the round** (it passes `recordRound=false`), so a single round is
  never logged as both `addressed` and `blocked`. This wait is re-expressed on the
  ONE `ReadinessProbe` wait-gate primitive (#258, ADR 0001 §2); it replaced a bare
  `review-ready` catch that could hang
  indefinitely: Copilot won't re-review a round with no new commit and routinely
  dismisses a re-request, so with no timeout a review that never arrives wedged
  the loop (observed: three convergence processes stalled ~22h). The poller's
  auto re-request (§10) is the primary liveness mechanism; this timer is the
  backstop when even repeated nudges fail.
- On `needs_input`, the same `round` is retried after the answer (the answer is
  added to the agent's context; the round number does not advance).
- On `converged`, the run does **not** finalize blindly: it first runs the
  deterministic **converge gate** (`pr.converge-gate`, `Check review comments`),
  which re-reads GitHub and re-blocks (`convergeBlocked=true`) while **any
  substantive** review thread is unresolved or **any** suppressed advisory lacks a
  resolved `nano-ack:` thread. An unresolved `nano-ack:` **ack thread** is **never
  dropped** from the gate — it is a genuinely-open GitHub thread, so it still
  **blocks** convergence — but a block whose only open threads are unresolved acks
  is classified **ack-only**: a partially-completed acknowledgement the bounded
  auto-ack retry can finish (post-and-resolve), not a code-review finding, so it
  stays on the recoverable path instead of escalating. (An ack thread is one whose
  *root* comment carries a canonical `nano-ack: <path> :: <text>` marker; a
  substantive reviewer finding never does, so it escalates. Because an unresolved
  ack still blocks either way, this classification is **fail-closed**: even a
  mislabelled root cannot finalize the gate with an open thread — worst case it
  routes to the bounded ack-retry, which cannot ack a non-advisory and so escalates
  to a human on exhaustion.)
  A block whose SOLE cause is unacknowledged suppressed
  advisories or unresolved ack threads (no unresolved *substantive* thread) is
  flagged **ack-only**
  (`convergeAckOnly=true`) and is routine + recoverable: rather than pulling a
  human in first, the loop makes a **bounded auto-ack re-dispatch** of
  `review-round` — up to `ackRetryMax` times, advancing `ackRetryRound` on each
  ack-only block (seeded from `NANO_PR_MAX_ACK_RETRIES`). It escalates to the human
  `wait-answer` only when the block is **not** ack-only (an unresolved inline
  thread), or the budget is exhausted. Both counters are process variables.
- **Contested advisory → human is via the agent's `needs_input`, not a decline
  (#787 / #796).** A resolved `Declined, false positive. nano-ack: …` thread is a
  *considered agent adjudication* and, by design (#787), keeps the advisory
  acknowledged so the gate **converges** — a stateless gate cannot re-block a
  decline without re-introducing the #787 per-round-escalation livelock. The
  "genuinely contested advisory surfaces to a human" path of #796 is reached when
  the (re-dispatched) agent cannot decide and returns **`needs_input`** — that
  routes through the normal status-escalation arm to `wait-answer`. Decline =
  agent-adjudicated → converge; `needs_input` = agent defers → human.
- **Scope-integrity gate: a closed issue must not be under-delivered (issue #858).**
  Convergence is guarded against a partial delivery that silently under-delivers a
  broader-scoped parent — an agent ships one slice of an issue, `Closes #N` it, and
  records the deferred remainder only in prose (never a filed, tracked issue), so the
  parent reads as fully done. Two layers enforce this:
  - **Compile/lint-time (deterministic, lexical).** `validateDeliveryGraph`
    (`app/deliveryGraph.ts`, `isPartialScopeClose`) rejects an `agent` node whose
    `prompt` pairs a GitHub closing keyword (`Closes/Fixes/Resolves #N`,
    `owner/repo#N`, or an issue URL) with NO full-scope acknowledgement **tied to
    that same issue** (`partial-scope-close`). The acknowledgement must assert THIS
    brief owns the issue's whole stated scope and be anchored to the issue it closes:
    a marker for a different issue, one **attributed to siblings/others**, one
    **negated/disclaimed** in its clause ("does not deliver the full scope of #N"),
    or one **qualified down to a part** ("the whole issue's parser slice") does not
    count. Issue **identity preserves the repository** — `owner/alpha#12`,
    `owner/beta#12`, and a bare `#12` are distinct, so an acknowledgement of one repo
    cannot licence closing a same-numbered issue in another. A part-scoped brief must
    instead reference the issue non-blockingly (`Part of #N` / `Refs #N`) and leave
    it open.
  - **Convergence-time (semantic, `scope-classify`).** After the comment-gate passes,
    the `Scope classifier` (`resources/prompts/scope-classify.md`) reads each closed
    issue's stated scope and blocks (`scopeBlocked = true`, routing to a human) when
    the PR leaves part of a *closed* issue's stated scope undelivered with the
    remainder untracked. It extracts closing keywords from the **PR title, the PR
    body, AND every commit body** (via `git log origin/<base>..<head>`, not the GitHub
    CLI's
    `--json commits`, which silently truncates at 100 entries): this repo family
    **squash-merges with `COMMIT_MESSAGES`**, so the squash commit concatenates every
    commit body — and takes the **PR title as its subject** — so a `Closes #N` left in
    ANY commit body (or in the PR title) closes #N on merge even if
    the PR body was later reworded to `Part of #N`. Such a PR — body `Part of #N`,
    a commit body still `Closes #N`, part of #N undelivered and untracked — is a
    genuine under-delivery the gate blocks (naming the offending commit to reword).
- **No-progress guard + husk classification (issue #786).** Before the review
  wait, an `addressed` round passes through `pr.progress-check`
  (`workers/progress-check/worker.ts`, mirrored by `app/roundProgress.ts`): it
  reads the PR's current head SHA (the branch ref, atomic with the push) and
  compares it to the **round-entry head** — the head captured by `pr.capture-head`
  immediately BEFORE `review-round` ran this round, published as the
  `roundEntryHead` process variable. `pr.capture-head` sits on EVERY entry into
  `review-round` (the first round from `Start`, a review-loop re-enter, a
  human-answer resume, and a husk auto-retry), so within any round there is always
  a baseline captured against the agent's own starting point — closing the
  no-baseline gap where a FIRST addressed round had no prior-round head to compare
  against (and either waved a first-round husk through as progress, or risked
  mis-escalating a straggler push). If `roundEntryHead` is absent — an older
  in-flight instance whose flow predates `capture-head`, or a capture read that
  failed open (it publishes the empty string as its "unknown" sentinel) —
  progress-check falls back to the head persisted from the previous round
  (`last_round_head`). A round whose head DID advance past the round-entry baseline
  is real progress and continues to the review-wait gateway. A round whose head did
  NOT advance pushed no commit, so re-requesting a review would loop on
  byte-identical code; `gw-progress` routes it to `gw-husk`, which SPLITS it on a
  corroboration correlated to the COMPLETING `review-round` element-instance (NOT
  an aggregate terminal count — a same-round human-answered resume is classified on
  its own fresh attempt):
    - a **husk** — no commit AND the completing `review-round` attempt is
      NON-TERMINAL (the producer harness died mid-run, leaving a stuck instance) —
      is auto-re-run onto a healthy worker up to `MAX_HUSK_RETRIES` (2) before
      escalating; and
    - a **no-advance** — the completing attempt ran to a terminal instance but
      nothing was pushed — (and a husk that exhausts its retries) escalates to the
      human `wait-answer` task.
  The agent-instance read is AVAILABILITY-AWARE via a **two-tier probe** and fails
  SAFE (ADR 0056). `review-round` is an external-agent service task, so a job that
  husks BEFORE it ever registers an AgentInstance leaves the scoped `review-round`
  search EMPTY — indistinguishable, on that query alone, from an engine that has no
  AgentInstance projection at all. The probe therefore resolves an empty
  `review-round` search against a SECOND, process-wide read:
    - if the process-wide read also finds NO instance, the **channel is absent**
      (an engine with no AgentInstance projection) — UNKNOWN, treated as no-advance,
      never an auto-retry that could duplicate genuinely-completed work;
    - if the process-wide read finds ANOTHER instance (from `classify-scope`, an
      earlier round, etc.), the **channel is PRESENT** but this round registered
      nothing — a genuine **pre-registration husk**, so it is classified as a husk
      and auto-retried.
  A head that cannot be read fails OPEN (continue), so a transient GitHub hiccup
  never fabricates a no-progress escalation. Two supporting invariants keep an
  auto-retry clean: `pr.persist-round`
  records a round IDEMPOTENTLY on `(pr_key, round_no, process_instance_key)` — a husk
  retry (same process instance) updates its row in place, while a resubmission that
  re-opens the PR at round 1 in a NEW process instance inserts a fresh row and so
  never clobbers a prior run's durable round history (migration 102) — and the guard flips the PR back to
  the running `converging` status before a retry re-enters `review-round` so the
  poller does not solicit a spurious review against the still-running round. The
  round cap and the review-wait timeout remain the outer safety nets.

- **Non-converging same-surface churn guard (issue #870).** The no-progress guard
  above catches a round that pushed NOTHING. Churn is the opposite failure mode: a
  loop where EVERY round pushes a commit (so the head advances and the round
  legitimately "progresses") yet never reaches a fixed point — a contested surface
  (e.g. a fail-closed analyzer whose bypass forms are unbounded) keeps producing new
  findings in the SAME file round after round, and the loop runs to `maxRounds`
  without a human ever being asked to make the scope call. So on a head-advancing
  `addressed` round, BEFORE parking for the next review, `pr.progress-check` reads
  the PR's durable `rounds` history (`app/roundChurn.ts` `detectChurn`, the single
  canonical detector) and escalates when the trailing run of CONSECUTIVE `addressed`
  rounds is at least `CHURN_WINDOW` (4) long AND some single file appears in EVERY
  round of that window. Requiring the SAME file across the whole window keeps normal
  convergence — findings that move between areas and trend down — from escalating
  early. The file names are mined from each round's free-text `summary` (URL spans
  stripped, so a cited link is never mistaken for a repo path). When it fires, the
  round routes to the SAME human escalation path the no-advance guard uses (`gw-husk`
  → `persist-escalation-noprogress`) carrying a `noProgressReason:"churn"` SCOPE
  question — it never parks at `waiting_review`. Two invariants keep the signal
  honest across runs and resumes:
    - **Run-scoped history.** The history read is filtered by the job's
      `process_instance_key` (the `rounds` table is run-scoped — migration 102), so a
      prior run's retained rows never leak into this run's window. A legacy NULL-key
      row is dropped (fail-OPEN: dropping a row only ever reduces the churn signal).
    - **Churn-reset watermark.** A churn escalation writes no `blocked` round
      (`recordRound=false`) and the human-answer resume re-enters the SAME numeric
      round (the counter only advances at the review-wait gateway), so the escalating
      round number is persisted as `pull_requests.churn_escalated_round`
      (migration 117, cleared on re-open with the rest of the per-run state).
      `detectChurn` drops every round at or before that watermark, so the human's
      scope decision restarts the churn clock: churn can only fire again after a
      fresh `CHURN_WINDOW` of same-file rounds accumulates past the decision, exactly
      as a recorded `needs_input`/`blocked` round would restart it.
    A head that cannot be read, and a history read that throws, both fail OPEN (no
    churn escalation) — a transient GitHub/datasource hiccup never fabricates one.

- **Stale-output reset on round entry (issue #822).** `pr.capture-head` — the
  single task every entry into `review-round` routes through first (from `Start`,
  the review-loop re-enter, the human-answer resume, the husk auto-retry, and the
  ack-only retry) — additionally CLEARS the round's output variables on entry:
  `status`, `summary`, and `question` (→ `null`) and `escalated` (→ `false`),
  mirroring the merge loop's `arm-merge` (which already clears `status` on entry
  before its agent runs). A `review-round` job taken by a misconfigured worker can
  exit 0 with no result variables, empty output, and no push; because nothing
  overwrote them, the PREVIOUS round's `status`/`summary`/`question` would
  otherwise persist and `gw-status` would re-route on that stale decision —
  re-opening a word-for-word duplicate of an escalation a human had just answered
  (the answer never reaching an agent). Resetting on entry makes a no-result round
  enter on a blank `status`/`question`, so it can no longer inherit the prior
  round's decision: it falls through `gw-status`'s `f_addressed` default into
  `persist-round` → `check-progress`, where the unchanged head is caught by the
  no-progress guard above and classified (husk vs. no-advance) on its own merits.
  These vars are reset on ENTRY here rather than on `review-round`'s own output
  because a same-task output-clear would clobber the agent's real verdict;
  `answer`/`scopePending` (inputs the agent consumes) stay cleared on the
  review-round output.


## 5. Agent job contract (`senior:pr-review`)

**Input** (`job.variables`):
| var | type | notes |
|---|---|---|
| `prUrl` | string | canonical PR URL |
| `repo` | string | `owner/name` |
| `prNumber` | int | |
| `round` | int | 1-based round counter |
| `answer` | string? | present only when resuming from an escalation |
| `adversarialFindings` | string? | present only when the local adversarial-review stage (§4) produced findings on this round's push — the agent is re-dispatched within the same round to address them |

The base instructions are **not** a job variable: they are delivered as a
**linked resource** on the `senior:pr-review` task —
`<zeebe:linkedResource resourceId="prompts/review-round.md" bindingType="latest" resourceType="GenericScript" linkName="prompt"/>`,
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
  `fetchPrHead`). The envelope also carries clone-shaping fields so large monorepos
  provision within the c8ctl clone timeout (issue #287): `singleBranch: true` and
  `filter: "blob:none"` request a **branch-scoped, blobless partial clone** (trees are
  still fetched up-front — a *treeless* clone would be `--filter=tree:0`; the full
  commit graph is kept — no `--depth 1` — so `git merge-base` / the review 3-dot diff
  stays correct while blobs fetch lazily), and, when the PR base branch is resolvable,
  an optional `…repository.baseRef` so the harness fetches the base tip alongside the
  head and keeps `origin/<base>` reachable for the diff. The harness is PR-agnostic: it
  does **not** derive the head branch from `prNumber`/`prUrl`. When the head can't be
  resolved the envelope is omitted and the agent falls back to the worker's launch
  directory (the legacy behavior).

## 6. Signals

| message | correlationKey | published by | payload |
|---|---|---|---|
| `pr-submitted` | — (start) | submit route/webhook | `{repo, prNumber, prUrl, prKey}` |
| `readiness-ready` | `prKey` | **poller** | `{ready, detail?}` (ADR 0001 §2 wait-gate; the review-ready wait, re-expressed on the ReadinessProbe gate — #259) |
| `deps-cleared` | `prKey` | **poller** (merge) | — (all `Depends-on` PRs merged) |
| `merge-ready` | `prKey` | **poller** (merge) | `{mergeState}` (`ready` \| `conflict` \| `blocked` \| `draft`); when `blocked`, also `{failingChecks, failingChecksList}` for the `senior:fix-ci` branch. A transient `UNKNOWN`/`waiting` verdict is NOT published — the poller keeps polling (fast self-heal); the merge loop's `gw-mergeable` sees `waiting` only via the dead-poller stall-probe re-derivation, where it re-polls (bounded, #774) instead of escalating |
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
/ empty-plan / trial-merge / PR review / blocked-run) off the `user_tasks` read-model and
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
declares **no `models`**, so `@nanobpm/urban` walks `resources/` **recursively (every file at any
depth)** and deploys each file as an
`application/octet-stream` resource whose deployed **id is its path relative to `resources/`**
(`resources/prompts/review-round.md` → resource `prompts/review-round.md`). Each agent service
task links it by that `resources/`-relative id (a bare basename resolves to nothing and the
engine silently omits the link, leaving the agent prompt-less):

```xml
<zeebe:linkedResources>
  <zeebe:linkedResource resourceId="prompts/review-round.md" bindingType="latest" resourceType="GenericScript" linkName="prompt" />
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

> **`<zeebe:agentDefinition agentType="external" />` is the ONE agentic-task signal.**
> Every hand-authored `senior:*` agent service task in `resources/processes` carries this
> engine-native AgentTask marker
> (issue #745) alongside its `<zeebe:taskDefinition>`, and it is the **single
> convention** the worker harness `--auto` reconciliation scans to discover agentic
> tasks — replacing the legacy `linkName="prompt"` / header dual signal so the app and
> harness converge on one signal (issue #779, harness jwulf/c8ctl-plugin-nano#235). The
> marker is CI-enforced over the deployed `resources/` process models
> (`agentTaskTypesMissingExternalMarker`,
> `agent-marker.test.ts`), so no prompt-bearing agent task in those models relies on
> prompt-link-only discovery. (The delivery-graph compiler's GENERATED agent BPMN —
> deployed at run time by `runDeliveryGraph`, not authored under `resources/` — is a
> separate deployed path NOT covered by this static guard; whether its generated cells
> should also carry the marker/opt-out convention is tracked separately under issue #745,
> not #779.) To **exclude** a task from `--auto` — one that must be served only by a
> worker that explicitly subscribes (`--job-type <type>` / a profile capability) — add
> the inert opt-out property inside its `extensionElements`, nested in the
> `<zeebe:properties>` wrapper the models and engine expect (as
> `resources/processes/feature.bpmn:57-63` does — a bare `<zeebe:property>` placed
> directly under `<bpmn:extensionElements>` is NOT the accepted shape):
>
> ```xml
> <bpmn:extensionElements>
>   <zeebe:properties>
>     <zeebe:property name="io.nanobpm.agentTask.autoSubscribe" value="false" />
>   </zeebe:properties>
> </bpmn:extensionElements>
> ```
>
> Absence (or any value other than `"false"`) auto-subscribes as normal — opt-out is
> explicit and fail-safe. The property is inert to the engine (no migration, no
> behaviour change). It is a registered contract (`agentTask.autoSubscribe` in
> `app/contracts.ts`), read by the ONE helper `agentTaskTypesOptedOutOfAuto`
> (`app/agentic/vocab/job-types.ts`) and guarded by `auto-subscribe.test.ts`.

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
3. If found → publish the canonical `readiness-ready` wait-gate message (key =
   `pr_key`, `{ready, detail}`) and set `last_review_id`.
4. If **not** found → ensure a review is in flight: unless Copilot is already a
   pending reviewer, **re-request** it (REST `requested_reviewers`, exact login
   `copilot-pull-request-reviewer[bot]`) and record `last_nudge_at`. This is
   throttled to one attempt per `NANO_PR_REVIEW_NUDGE_MINUTES` window (default 5m)
   so a re-request Copilot dismisses is retried without hammering the API. A repo
   where Copilot isn't an assignable reviewer (HTTP 422) is left to the process's
   review-wait timer (§4). This closes the stall where Copilot won't spontaneously
   re-review and silently dismisses a re-request, so no `readiness-ready` ever fires.

Requires a GitHub token (`GITHUB_TOKEN`) or the host `gh` CLI. One cheap API call
per waiting PR per interval (plus at most one reviewer-state check + re-request per
nudge window).

## 11. Merge stage (`merge-loop.bpmn`)

With `NANO_PR_AUTO_MERGE` on (default), the `pr.finalize` worker does not stop at
`converged` — it starts a **second** durable process, `merge-loop`, keyed on the
same `prKey`, sharing the datasource and poller. It merges the PR, honouring
merge-queue branches and cross-PR dependencies, and reuses the review stage's
escalation machinery for anything it can't resolve autonomously.

A per-submit `autoMerge` setting on the `start/convergence-loop` request is the preferred
positive control: `false` pins that PR to review-only regardless of the global default, while
`true` enables the merge-loop after convergence only when `NANO_PR_AUTO_MERGE` is on. No per-submit
setting forces the merge stage on when the global toggle is off.

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
  exhausted, the agent reports `blocked` *and the PR is still blocked after a
  ground-truth reconcile*, or the branch is in `conflict` does it fall through to the
  human escalation path.

- **Stale / transient checks — re-attempt, don't escalate** (issue #348) — GitHub's CI
  concurrency **cancels** a superseded workflow run while a newer run on the *identical
  head SHA* takes over. Both land in the head's `statusCheckRollup` under the same check
  name — the stale one stamped `CANCELLED`, the live one green. This is a
  **CI-concurrency-cancellation drift class**, not a code defect, defended at three
  layers so it never pages a human:
  - **Derivation (root cause)** — the merge poller's check derivation collapses the
    rollup to the **newest run per `(headSha, checkName)`** (`latestRunPerCheck`) before
    classifying, so a `CANCELLED` run superseded by a newer green run is **not** counted
    as a failing gate. The phantom `blocked` never arises, so `fix-ci` is not even armed.
  - **Agent verdict** — when `fix-ci` pushes nothing because the failing checks are
    stale/transient (head already green), it returns `status: "reattempt"` (with
    `pushed: false`). That routes to `arm-merge` — the merge is simply re-queued from
    ground truth. The prompt reserves `blocked` for a genuine human decision (a missing
    secret, an un-fixable failure), never a self-healing PR.
  - **Reconcile-before-escalate guard** — even a *mislabelled* `blocked` self-heals: a
    `blocked` verdict with no push (`pushed != true`) reconciles **once** via ground
    truth (`gw-ci-blocked` → `ci-reconcile`, which re-arms the canonical merge poller and
    sets `ciBlockedReconciled`), and escalates only if the PR is **still** blocked on the
    re-derived state.

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
- **Mergeability** — the poller classifies GitHub's `mergeStateStatus`, but a
  first-class `isDraft` guard runs *first* (`classifyMergeability`, `app/github.ts`):
  a draft PR is `draft` regardless of `mergeStateStatus`. Otherwise, by status:
  `CLEAN`/`HAS_HOOKS`/`UNSTABLE`/`BEHIND` → `ready`; `DIRTY` → `conflict`;
  `BLOCKED` → `blocked` if a required check is failing, else keep waiting;
  `UNKNOWN`/empty (and any other status, including `DRAFT`) → keep polling (GitHub
  still computing). It
  publishes `merge-ready {mergeState}` for the settled verdicts. When the live
  poller is dead the `wait-mergeable-timeout` backstop's stall-probe re-derives
  mergeability; a still-unsettled `UNKNOWN`/`waiting` verdict then routes to a
  **bounded re-poll** (`wait-mergeable-repoll`, `NANO_PR_MERGEABLE_REPOLL_INTERVAL`)
  rather than escalating (bounded by `NANO_PR_MAX_MERGE_STALL_ROUNDS`), and an
  unclassified/default verdict routes to auto-rebase (`gw-rebase`, bounded by its
  own `NANO_PR_MAX_REBASE_ROUNDS` budget); once either budget is exhausted the loop
  escalates to a human (#774).
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
| `NANO_PR_WEBHOOK_SECRET` | — | optional shared secret (`x-hook-secret`) for guarded operations (e.g. `/app/api/agent`, `/app/api/version`, `/app/api/status`) |
| `NANO_PR_AUTO_MERGE` | 1 | run the merge stage after convergence (`0` = review-only; per-submit `autoMerge: false` override) |
| `NANO_PR_MERGE_METHOD` | squash | `squash` \| `merge` \| `rebase` |
| `NANO_PR_MERGE_ADMIN` | 0 | pass `--admin` on merge |
| `NANO_PR_REVIEW_WAIT_TIMEOUT` | PT30M | ISO-8601 wait before a stalled review escalates (timer arm of the `wait-review` event-based gateway); malformed → default |
| `NANO_PR_REVIEW_NUDGE_MINUTES` | 5 | cooldown between poller Copilot re-request nudges per PR (clamped 1–1440) |
| `NANO_PR_AGENT_SLA_TIMEOUT` | PT2H | ISO-8601 liveness bound on an external **agent** service task (see §12.1); seeded as `agentSlaTimeout` at every process start that hosts one. Malformed → default |

### 12.1 Agent-task liveness SLA (issue #849)

An external **agent** service task (`<zeebe:agentDefinition agentType="external"/>`) is a durable
wait on an external actor with **no human in the loop**: the worker renews the job's deadline for as
long as the agent process is alive, so an unstaffed capability or a hung/looping agent that never
fails its job would otherwise park the token forever (no incident, no escalation — the
`classify-scope` 7h27m incident, nanobpm/nano-bpm#1308). The agent-task SLA closes that gap with a
durable, in-process backstop — no external watchdog.

- **Mechanism.** Every process start that hosts an external agent task seeds the validated
  `agentSlaTimeout` process variable (`app/agentSla.ts` `AGENT_SLA_TIMEOUT`, env
  `NANO_PR_AGENT_SLA_TIMEOUT`, default `PT2H`). Each *bounded* agent task carries an **interrupting
  timer boundary** whose `<bpmn:timeDuration>=agentSlaTimeout` is evaluated at timer creation
  (FEEL-expression duration). When the SLA elapses the boundary fires, cancels the stuck job, and
  routes the token to the process's escalation path so a human is pulled in. It is deliberately much
  shorter than the human-decision escalation SLA (`NANO_ESCALATION_SLA_TIMEOUT`, PT24H) so a stuck
  agent surfaces quickly without interrupting a legitimately long task.
- **Bounded today:** the implement-cell (`implement-task`), the merge-cell's trial-merge
  (`trial-merge`), the merge-loop's `rebase` / `fix-ci`, and retro's `conformance` / `synthesize`.
  The implement-cell is reached by **both** parents — a standalone `feature` run and a plan-fanout
  wave slice — and each parent's callActivity maps `agentSlaTimeout` into the child explicitly.
- **Pre-seeded, not yet bounded:** the convergence-loop (`review-round` / `adversarial-review` /
  `classify-scope`) and plan-fanout (`plan` / `review-plan`) agent tasks sit on a back-edge loop
  whose boundary the auto-layouter cannot yet route (#867), so their SLA boundaries are
  intentionally deferred to #868. Plan-fanout's **inline** wave `trial-merge`
  (`plan-fanout.bpmn:524-542`) — distinct from the standalone `merge-cell` process, which has no
  callActivity caller — is likewise an external agent task with rerun back-edges and no
  `agentSlaTimeout` boundary, and is deferred to #868 alongside them. They are seeded now as
  preparation; the defect-class guard
  (`app/agentic/vocab/agent-sla-boundary.test.ts`) covers exactly the bounded subset so a regression
  on a *bounded* process is caught while the deferred ones stay out.
- **Escalation routing.** The boundary never drops the token on the floor: implement-cell routes
  `be_implement_sla` → `record-escalation-sla` (synthesises an SLA-specific question) → the shared
  `human-escalation` cell; merge-cell routes `be_trial_agent_sla` → `record-trial-merge-sla` (its dedicated SLA recorder,
  distinct from the normal-path `record-trial-merge`; persists a trial-merge audit row + answerable
  question for the timed-out attempt) → `gw-trial` → `trial-merge-decision`;
  retro routes each agent boundary → a `record-*-sla` task (persists a `plan_conformance` row at
  `review_status='reviewing'` so the always-following `conformance-ack` settles it) →
  `conformance-escalation`. Runtime coverage: `e2e/agent-sla-boundary.e2e.ts`.

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
  iterates the canonical list. It also emits `taskCount`, which the `gw-plan-empty`
  gateway reads: a taskful plan proceeds to plan-review; an **empty plan**
  (`{tasks:[]}`) is neither auto-terminated (which rendered "Done" over a still-live
  instance, #624) nor fed into the adversarial plan-review loop (a plan↔plan-review
  livelock, #623) — instead it parks at the **`empty-plan-escalation`** operator user
  task for a human directive: **Accept** a legitimate no-op epic (→ the terminal
  `EndTasklessDone` end; the poller reconciles the COMPLETED instance to `done`) or
  **Revise** (→ back to `plan` to re-plan, folding the operator's `notes` into
  `planFindings` so the guidance reaches the re-plan's `appendPrompt`, mirroring
  `plan-review-decision`). An empty plan stays NON-terminal
  (`planning`) with its planner `note` as the `outcome` while parked — terminal
  status follows engine liveness via `pollTasklessPlanTermination`, never the
  empty-plan signal (#624).
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

**Visibility**: the home page adds a **Plans** grid (`plan_tasks` child grid showing each
task's status and the PR it produced — `pr_key` cross-references the Pull requests grid for
convergence status). Epics bucket into Active / History on the **derived `plans.list_bucket`**
(issue #298), NOT raw `plans.status`: bucketing on raw `status` made an epic vanish from Active
the instant `status=done`, even though `done` only means "fan-out dispatched to convergence" —
its slice PRs may still be **converging**, or all merged (**landed**) but still needing the
integration→main promotion PR. `deriveEpicBucket` (app/delivery.ts) keeps a `done` epic in Active
until an operator **dismisses** it (`POST /actions/acknowledge-epic` stamps `plans.acknowledged_at`,
the twin of the feature-run tick-off); a still-`converging` epic is never dismissable, and
`failed`/`abandoned` epics fall to History directly. Projected at write time by the `plans` gateway.

**Epic domain phase** (issue #261): `plans.status` only distinguishes the process-instance
terminal (`dispatched` = "fan-out job done"), not the epic's *domain* lifecycle. The read model
therefore also carries a derived, display-only `plans.epic_phase` — **Planning → Reviewing →
Implementing (wave n/t) → Trial merging → Finalizing → Dispatched** — projected at write time from
`plan-fanout.bpmn`'s named activities via each spine worker's BPMN element id (`app/epicPhase.ts`,
the single binding; nwf is the first consumer of the urban phase-projection primitive, nano-ide#266).
The `Implementing` band is wave-labelled from the levelize records (`plan_tasks` waves). The epic /
epic-detail pages surface it as a **Phase** column. It never gates control flow (that stays driven by
the process `currentWave`/`waveCount`/`gate_wave`); a post-dispatch cross-instance rollup into
Converging/Merging is a later seam (nwf#245 / nano-ide#254).

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
  the `wait-wave-merged` catch event. The poller's `pollWaveGatesImpl` pass is
  **level-triggered**: it publishes the `wave-merged` message (correlated on `planKey`)
  once **every opened PR in that wave has merged** (`app/waves.ts` `waveMergeTargets`
  selects the PRs to wait on; `blocked`/`skipped`/keyless tasks clear vacuously) **and**
  it observes an OPEN `wait-wave-merged` subscription for the plan — so a merge that
  lands while the token is still upstream can't drop the signal. The poller **never**
  clears `gate_wave`; `record-wave` owns the marker's lifecycle (re-arming it to the next
  wave, or clearing it to NULL on the final wave). So a `dependsOn` means the dependent wave is not **implemented** until
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

## 13.3 Delivery-graph node escalation — Continue / Retry / reset (PR #863)

The delivery-graph compiler (`app/deliveryGraphCompiler.ts`, ADR 0005) compiles each
`agent`/`connector` node to a `start → serviceTask → end` subProcess guarded by a
**bounded `=nodeTimeout` boundary**. On timeout (or, for an `agent`, on a broken
producer contract — issue #731) the stalled node parks on a **human-completable
escalation user task** (`delivery-human-task__<el>__esc`, and the agent-only
`__contract` twin), surfaced in the Tasks inbox and answerable by a human or an agent
(ADR 0046). Every such escalation names **two exits** (the `delivery-escalation` form's
`decision` select):

- **Continue** (`decision="continue"`, the default) completes the node as resolved. If
  the node declares **exactly one** emit **and that emit is a downstream-required fact**,
  the form presents a typed-value field and maps
  the operator-supplied `value` onto the node's emit-source var (`factSourceVar`), so the
  subProcess output publishes the same `<el>_<fact>` a normal completion would —
  letting work finished out of band (a draft PR the stalled agent already opened) be
  handed onward instead of threading a null downstream. This applies to **both** `agent`
  and `connector` emits: a connector has no producer-contract gate, so its resume keys
  off the node's **own** declared `emits` (emit source = the fact's own name), never the
  agent-only gate metadata. The single-emit boundary is a hard cardinality rule: the
  form captures ONE value, so a node declaring **zero** emits has nothing to resume (the
  field stays blank) and a node declaring **two or more** emits is **not** value-resumable
  — one value cannot satisfy multiple distinct typed facts without corrupting them.
  **The value is also inert for a node whose sole emit is routing-only or unconsumed** —
  the resume keys off the **required** (downstream-consumed) emit set, not the raw declared
  set, so an exactly-one-emit node whose fact nothing downstream reads has no required
  resume target and its `value` is discarded (there is nothing to publish it to). For
  such a node the resume-valid flag is **hard-set to `false`**, so the post-escalation
  validation gate behaves as follows: if the node still owes a **required** emit, **Continue
  fails closed and loops back to the escalation** (it does NOT write nulls and does NOT
  advance to a fallback branch) — **Retry this step** is the only way to actually produce
  the facts; only a multi-emit node with **no required resume target** lets Continue proceed
  past the node to its default (fallback) branch. (A **wait** gate owing **two or more**
  emits is a special case: it has no Retry exit and its single value field can resume
  none of them, so its escalation grows **no** validation gate at all and Continue simply
  acknowledges and proceeds to the node end — see issue #863 — rather than looping forever.)
  Because the form
  captures `value` as textfield **text**, the single-emit resume **coerces/validates it to
  the emit's declared type** before publishing (`escalationResumeValueFeel`): a `boolean`
  emit accepts `"true"`/`"false"` **case-insensitively and surrounding-whitespace-trimmed**
  (the validity gate and the coercion share one `lower case(trim(string(value)))`
  normalization, so a value one accepts the other can never convert differently) and
  publishes a real boolean, a `number` emit parses via `number(trim(string(value)))`, and
  any other (text-valued) type passes through. An **invalid** entry
  publishes `null` — the defined failure path — so a required-emit producer gate escalates
  and a guarded split takes its default rather than routing on a mistyped value (a raw
  `"true"` string would silently skip a `= true` guard).
- **Retry this step** (`decision="retry"`) re-runs the node. A none intermediate throw
  event (never a scriptTask) resets the node-local scratch — the decision, the captured
  `value`/`escalationNote`, and (for an agent) the **full declared result set**
  (`AGENT_RESULT_LOCAL_VARS` — the self-reported `status`/`summary`/… **and** every other
  node-local result field such as `transcriptUrl`, `agentCheckpoint`, and the PR aliases)
  — or, **for a connector**, its fixed result metadata (`CONNECTOR_RESULT_LOCAL_VARS` —
  `connectorOutcome`/`connectorDedupeKey`/`connectorDetail`) — plus the previous attempt's
  emits — and appends the operator's `escalationNote` to the agent
  prompt as guidance for the next attempt (re-derived from the runner-seeded
  `nodeInputs.<el>.appendPrompt` baseline, so consecutive retries never accumulate stale
  guidance). The guidance control is the escalation-specific `escalationNote`, never the
  plain `note`: `note` is a worker **result** field (`plan.md` returns one) that
  nearest-scope propagation lands in the same subProcess scope, so reading it would feed a
  worker-produced note back as "operator guidance" on a retry submitted without one. Clearing
  the whole declared set (not just the status fields) stops a retried
  worker that omits an optional field from republishing the previous attempt's value
  downstream or surfacing it in the next escalation.

All retry/reset targets are **node-local** (declared on the subProcess by
`ioMappingLines`), so a node's result vars never leak to the root and two parallel nodes
declaring the same emit never cross-publish — with a few deliberate publish-onward
exceptions, all written under node-unique or intentionally-shared names rather than the
raw result var. The **outward data** exceptions: each declared emit is republished to the
root as `<el>_<fact>` (node-unique, so siblings never collide), and an agent's
`transcriptUrl` is propagated back to the root under the shared `transcriptUrl` name so
Nano Explorer can render the run→transcript link (app/deliveryGraphCompiler.ts:1872-1877).
That one shared name means parallel agents can overwrite the root `transcriptUrl` —
acceptable, since it is a display-only correlation link, not a result a downstream node
binds. In addition, the per-node **control signals** `<el>_contractMet` (the agent
contract-gate's proceed flag) and `<el>_retryRequested` (the per-escalation retry gate's
route flag) are **also root-scoped** — their gateways live outside the node's subProcess
and so cannot read node scope, and the `<el>_`-prefixed, node-unique names can never
collide across parallel nodes. So the node-local rule governs a node's *result/emit scratch*;
these node-unique control booleans are intentionally published to root so the routing
gateways can read them on either engine's scope semantics. A **preflight `assert`** on the inner leaf
task's input fails LOUD (raising an incident naming the missing `nodeInputs.<el>`)
before any job exists when the runner-seeded config was lost — see the `KNOWN
LIMITATION` in `serviceBodyLines` (fail-loud-only, nano-workforce#866). Resolving that
incident re-evaluates **only the leaf's inputs** — the subProcess-level config mappings
(`prompt`/`appendPrompt`/`nodeTimeout`, connector `target`/`payload`/`dedupeKey`) ran once
at subProcess entry and are **not** re-mapped on a leaf resolve, so the node would
activate **unconfigured**. The in-subprocess **"Retry this step"** loop does **not**
help here either: it loops directly back to the inner service task (to reset the
node-local scratch), bypassing the subProcess entry mappings, so it too leaves the
config null. **Recovery therefore requires re-entering the sub-process from OUTSIDE —
relaunch/re-enter the node so its subProcess input mappings re-evaluate against the
restored `nodeInputs`** — not merely resolving the incident or using "Retry this step".
The correct in-model fix is to run this check at sub-process *entry* (Camunda parity,
nano-bpm#1336); until then the preflight fails loud so the node never runs blind
*without* an incident, and the operator re-enters the sub-process to recover.

Because an `agent`/`connector` node's emit source **is the fact's own name**, declared
node-local in the same subProcess scope as the escalation form controls and the node's
seeded config, a fact name is not fully unrestricted: `validateDeliveryGraph` rejects an
emit named after a **reserved delivery variable** (`reservedDeliveryFactNames(kind)`,
app/deliveryGraph.ts) fail-closed at authoring time. The reserved set is **kind-aware**
(issue #863 review): the **escalation controls** (`decision`/`value`/`escalationNote` — an escalation
Continue would overwrite the fact, publishing `<el>_decision="continue"` instead of the
agent's routing value) and the shared late-binding/preflight **scaffolding**
(`boundFacts`/`nodeInputs`/`nodeInputsPresent`) are reserved for **every** kind, while a
**config variable** is reserved only for the kind whose own config it is — and only for
`agent`/`connector`, the kinds whose emit source is the fact's own name (the retry reset's
clear-the-emits pass would null the node's own configuration, so the retried node activates
unconfigured). A `wait`/`human` emit's source is a fixed intermediate (`detail`/
`humanEmitValue`/…), never the fact's own name, so those kinds reserve only the escalation
controls + scaffolding — a `wait` emitting `target` or a `human` emitting `prompt` is
allowed. The node-local **result** fields
(`AGENT_RESULT_LOCAL_VARS`/`CONNECTOR_RESULT_LOCAL_VARS`) are deliberately **not**
reserved — with **one exception**: an agent emitting `pr` (the canonical
`agent → connector[converge] → wait[pr]` shape) writes the same node-local value the
result field holds, and the retry reset correctly clears both — reserving them would
forbid that flagship pattern. The exception is the agent completion-control **`status`**:
the producer status gate reads that same node-local field as the node's completion status
and accepts only `done`/`opened`/`skipped`, so an agent emit named `status` carrying any
other routing value (`approved`, …) always escalates, and `status="done"` can never take an
`approved` branch — the emit contract and the gate conflict. `status` is therefore reserved
for an **`agent`** (a connector has no producer status gate, so a connector `status` emit
stays allowed); the rest of the result set remains unreserved.

## 14. Open questions / future

- **Provisioning the existing PR branch** — resolved: the `c8ctl` host-git
  integration provisions the repo and checks out the PR's head branch (it must
  already give the worker repo access to work at all). The **app** resolves the head
  branch and passes it in the `io.nanobpm.agentTask.repository.{url,ref}` envelope
  (a `createInstance` process variable — see `repoEnvelopeVars`), along with the
  branch-scoped, blobless clone-shaping fields (`singleBranch`, `filter`, optional
  `baseRef`) that let large monorepos provision within the clone timeout (#287); the
  harness is PR-agnostic and provisions from that envelope. The worker stays a pure
  provisioner.
- **readiness-ready via GitHub webhook** — same `readiness-ready` message, swappable faster trigger,
  when the app is publicly reachable. Deferred (poller-only for v1).
- **Supervised vs external worker** — the agent runs as an external
  `c8ctl nano work` daemon by default; a supervised in-server mode is possible
  later (ADR 0041 decision).
- **Autonomous D3** — shift-left + baseline-diff + auto-remediation so the trial-merge
  gate only escalates genuine cross-slice design conflicts (§13.2, issue #129).
- **Prompt versioning/hash** per PR for auditability.
- **Auth on the web UI** — the manifest `security` block (ADR 0028) if this is
  exposed beyond localhost.
