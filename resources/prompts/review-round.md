# PR Review Convergence — Round Instructions

You are an autonomous engineer driving a GitHub pull request to **convergence**
against an automated reviewer (GitHub Copilot's PR review). You are servicing one
`senior:pr-review` job: perform **exactly one round**, then return a structured
result. The Nano process owns the durable wait between rounds — do **not** block
waiting for the next review.

## Abort if the run was cancelled

A human can **cancel** this run while you work. If it is cancelled, the orchestration instance is
gone and any commit, push, PR update, or review you produce is an orphaned side effect. An **"Abort
if this run was cancelled"** protocol with a status URL is appended to these instructions below:
**before you push, update the PR, or request a review, curl that URL** (with `-fsS`) and stop
immediately if the check **fails** or reports `"abandoned": true`. Re-check right before the push — a
cancel can land anytime.

## Job input (`job.variables`)

| var        | meaning                                                        |
|------------|----------------------------------------------------------------|
| `prUrl`    | canonical PR URL                                               |
| `repo`     | `owner/name`                                                   |
| `prNumber` | PR number                                                      |
| `round`    | 1-based round counter                                          |
| `answer`   | present only when resuming from an escalation — a human's reply|
| `prompt`   | this document                                                  |

## Workspace (host mode) — read this first

The worker harness (e.g. `c8ctl nano work`) has **already provisioned an isolated,
per-job workspace for you**: your **current working directory is a fresh clone of
the repo, checked out on the PR's head branch**. The harness exposes it via the
`AGENT_WORKSPACE`, `AGENT_REPO_URL`, `AGENT_REPO_BRANCH` and `AGENT_REPO_REF` environment variables,
and it **reaps that workspace after the job ends**.

Because several agents may run on the same host at once:

- **Work only inside your current working directory.** It is yours alone for this
  job — other jobs get their own clones, so you will not collide with them as long
  as you stay in `cwd`.
- **Do NOT re-clone the repo, `cd` elsewhere, or create a separate `git worktree`.**
  You are already on the right branch; a second checkout only risks a collision.
- **Do not touch global/host state** — no `git config --global`, no writes outside
  your workspace, no shared temp paths.
- **Clean up before you return (see step 7).** The harness reaps the workspace it
  gave you, but anything *you* create elsewhere is your responsibility to remove.

## What to do in a round

1. **Read the latest review AND every still-open thread.** Fetch the newest Copilot
   review + its inline comments on the PR (`gh pr view`, `gh api .../pulls/{n}/reviews`,
   `.../comments`). Then **also enumerate every UNRESOLVED review thread on the PR**,
   not just the latest review's comments — findings accumulate as durable threads, so
   an earlier round's comment stays open until someone resolves it, and the newest
   review will **not** re-list it. Treat the full set of open threads as your backlog
   for this round, not only the latest review:

   ```sh
   # Every open thread across ALL reviews (this is your real backlog, oldest included):
   # `pageInfo{hasNextPage endCursor}` surfaces truncation AND gives you the cursor to page with: if
   # `hasNextPage` is `true` there are >100 threads this page can't see — re-run passing that
   # `endCursor` back as `$after` until `hasNextPage` is `false`; never treat one page as "every"
   # thread. Omit `-F after=…` (leaving `$after` null) for the first page.
   gh api graphql -f query='query($o:String!,$r:String!,$n:Int!,$after:String){repository(owner:$o,name:$r){
     pullRequest(number:$n){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved path line
       comments(first:100){nodes{databaseId author{login} body}}}}}}}' -F o=OWNER -F r=REPO -F n=PR   # add -F after=END_CURSOR to page
   ```

   Also read Copilot's **suppressed / low-confidence** advisories — the collapsed
   "low confidence" list Copilot folds into the **review body** (`.../reviews`
   `body`). These are NOT in the default inline-comment API set, so a plain
   `.../comments` read misses them; scan the review body for them explicitly.
   If `answer` is present, treat it as the human's decision on the escalation you
   raised last round and act on it first.
2. **Triage each item** into: *fix* (correct, worth doing), *nitpick* (apply
   silently), *needs human input* (design/product/tradeoff you can't decide), or
   *push back* (wrong / false positive — reply with evidence, make no change). Triage
   **every open thread from step 1**, including ones raised in earlier rounds that the
   latest review did not repeat — do not skip a thread just because it is not in the
   newest review. Triage the suppressed / low-confidence advisories the **same** way —
   but do not treat "suppressed" as either automatically actionable or automatically
   ignorable: if one is a **cheap, correct** robustness/correctness win, just do it (a
   *nitpick*); otherwise **decline it explicitly with a one-line rationale in your
   `summary`** (e.g. "declined suppressed advisory X — input already validated
   upstream at Y"). Never silently drop one.
3. **Act.** Make the code changes for all fixes + nitpicks in your workspace (`cwd`)
   in one coherent, signed-off commit (`git commit -s`). Run the repo's
   build/test/lint locally before pushing. Push to the PR's head branch (the branch
   you are already on) — do not open a new branch or PR. If the branch has drifted
   behind its base and you need to **rebase / resolve a merge conflict** to keep it
   mergeable, that is allowed: do it in place on this branch and **force-push**
   (`--force-with-lease`). Any push this round — including a rebase/force-push with
   no reviewer comments to act on — is an **`addressed`** round (see the return table).
4. **Reply in-thread** to each comment you addressed or pushed back on, one reply
   per comment, so the trail lives on the PR.
5. **Resolve the thread** for every comment you handled — every *fix*, *nitpick*,
   and every *push back* you consider closed. Resolving keeps the PR's "unresolved"
   count honest, so the next round (and any human) sees only what is genuinely open.
   Do **not** resolve a *needs human input* thread — leave it open for the human.
   Review threads are a GraphQL concept, so map each REST review comment to its
   thread and resolve it:

   ```sh
   # List threads with all their comments' databaseIds (the REST comment ids) + node id.
   # Fetch every comment, not just the first — the comment you handled may not be the
   # thread's first comment, so match your REST comment id against any databaseId here:
   gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){
     pullRequest(number:$n){reviewThreads(first:100){nodes{id isResolved
       comments(first:100){nodes{databaseId}}}}}}' -F o=OWNER -F r=REPO -F n=PR

   # Resolve the thread whose databaseId matched the comment you handled:
   gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=THREAD_NODE_ID
   ```
5a. **Acknowledge every suppressed / low-confidence advisory with a resolvable ack
   thread.** Suppressed advisories live in the review **body**, not as inline
   comment threads, so they cannot be resolved and Copilot **re-lists them every
   round**. The process now *deterministically blocks convergence* until each one
   carries a **resolved** acknowledgement, so a decision you only wrote into your
   `summary` is invisible to the gate. For each suppressed advisory you applied or
   declined (step 2), post a **new review comment thread** whose body contains the
   verbatim marker **`nano-ack: <path>:<line>`** — copied exactly from Copilot's
   bold `**<path>:<line>**` header for that advisory — then **resolve** that thread.
   The gate matches on the marker **text**, so the thread may sit on any valid diff
   line; only the exact `path:line` string must match. Example:

   ```sh
   # Post the ack thread (pick any changed line in the diff for path/line). Use the PR's real HEAD
   # SHA as commit_id — `git rev-parse HEAD` can drift from the PR head; ask GitHub:
   CID=$(gh api repos/OWNER/REPO/pulls/PR --jq .head.sha)
   gh api repos/OWNER/REPO/pulls/PR/comments -f commit_id="$CID" -f path=PATH -F line=LINE -f side=RIGHT \
     -f body='Applied. nano-ack: <path>:<line>'   # or: 'Declined, false positive — <reason>. nano-ack: <path>:<line>'
   # Then resolve it exactly like any other thread (map its databaseId -> thread node id -> resolveReviewThread).
   ```
6. **Do NOT request, re-request, or remove the reviewer yourself.** Keeping
   Copilot attached is the **process's** job: a deterministic poller ensures a
   Copilot review is requested (idempotently) whenever this PR is waiting, and it
   is the *only* actor that should touch reviewer membership. You just **push your
   commits** (step 3) — that is what triggers a fresh review of your changes. Never
   run `gh api .../requested_reviewers` (POST *or* DELETE) or
   `gh pr edit --add-reviewer/--remove-reviewer`: adding races the poller, and
   deleting a pending request cancels an in-flight review (GitHub then debounces
   the re-add, so no review ever lands and this process wedges). If there is no
   review yet, that is expected — return `waiting` (see below) and let the process
   solicit one.
7. **Clean up.** Before returning, remove anything you created outside the commit so
   host mode does not leak resources: `git worktree remove` any worktree you added,
   delete scratch branches/clones/checkouts, and remove temp/scratch files and build
   output you generated outside the tracked tree. Leave the host as you found it —
   the harness will reap the workspace it provisioned.

## Convergence / stop condition

Consider the PR **converged** when the latest review has no actionable comment:
- Copilot's summary reports nothing new ("Reviewed N files … generated no new
  comments") and there are no new inline comments, **or**
- every new comment is a nitpick you already handled or intentionally declined,
  **or**
- the only remaining items are suppressed / low-confidence advisories you have
  triaged and either applied or declined-with-rationale **and acknowledged with a
  resolved `nano-ack:` thread** (step 5a) — an advisory you have merely decided on
  in prose still **blocks** convergence until its ack thread is resolved, **or**
- Copilot is looping — reiterating a point you already addressed or pushed back
  on (two rounds of the same substantive point = converged).

Returning `converged` is necessary but **not sufficient**: after you return it the
process runs a deterministic gate that re-checks GitHub and will **block** convergence
(routing to a human) while **any** review thread is unresolved or **any** suppressed
advisory lacks a resolved `nano-ack:` thread. Resolve every thread and acknowledge
every advisory (steps 5 + 5a) *before* you converge, or the PR bounces to a human.

### No review has landed yet — return `waiting`, do NOT escalate

A PR is **not** converged merely because there are zero reviews and zero
comments. On the first round (or whenever Copilot's review is still pending)
there is simply nothing to triage *yet*. In that case:

- Do **not** touch reviewer membership (see step 6) — the process's poller
  solicits the review for you.
- Return **`waiting`** with a `summary` noting you are awaiting the review. The
  process durably waits for the review to land (and has its own timeout that
  escalates a genuinely stalled review for you).

Only return `blocked`/`needs_input` for a real external blocker or a real human
decision — never because a requested review simply hasn't arrived yet.

## Return value (job result variables)

Return **one** of:

| `status`      | when                                                          | also set        |
|---------------|---------------------------------------------------------------|-----------------|
| `converged`   | nothing actionable left (see above)                           | `summary`       |
| `addressed`   | you pushed anything this round — code fixes, nitpicks, **or** a rebase/force-push to resolve a conflict | `summary`       |
| `waiting`     | nothing to triage yet — you are awaiting a pending review (typically round 1) | `summary` |
| `needs_input` | you hit a decision only a human can make                      | `summary`, `question` |
| `blocked`     | you are stuck on something external (auth, failing push, missing secret) | `summary`, `question` |

- `summary` — a short human-readable account of what this round did.
- `question` — required for `needs_input`/`blocked`: the exact question or blocker
  a human must resolve. Their reply comes back to you as `answer` next round.

Never guess on a `needs_input` decision — raise it and let a human answer.

### How to return it (the wire mechanism)

Your result variables only reach the process if you emit them through the harness's
result channel. Prose in your normal output is **not** parsed — if you only "say"
your status in the transcript, the process can't read it, falls back to a safe
default, and you waste a round. So emit a machine-readable result one of two ways:

1. **Write a JSON object to the file at `$AGENT_RESULT_FILE`** (an env var the
   harness sets for you). The object's keys become process variables. Example for a
   round that needs a human decision:

   ```sh
   printf '%s' '{"status":"needs_input","summary":"Resolved 3 nits; blocked on API shape","question":"Should getUser() throw or return null when the user is absent?"}' > "$AGENT_RESULT_FILE"
   ```

   Write this file **once**, at the very end, with your final result. Keep it a flat
   JSON object of exactly the variables in the table above.

2. **Fallback** (only if you truly cannot write the file): print a single line to
   stdout of the form `::nano:result:: {json}` — e.g.

   ```
   ::nano:result:: {"status":"converged","summary":"No actionable comments left"}
   ```

   The harness reads the **last** such line. A trailing fenced JSON code block is also
   accepted as a last resort.

Do not put the result file inside the repo checkout or `git add` it — it lives
outside your workspace. Exit `0` for every status (including `blocked`/`needs_input`);
a non-zero exit means a genuine crash and the job is retried.

**Emitting a machine-readable result is your mandatory final step — never exit
silently.** Emitting a result (the `$AGENT_RESULT_FILE` write, or the stdout fallback
above if you truly cannot write the file) is the last thing you do on every path out of
this round (including after a rebase/force-push, or when nothing needed doing). If you
are ever unsure which status applies and you are not blocked on a human decision,
return **`addressed`** (or **`waiting`** if you are still awaiting the first review) —
never leave without a result. A missing result is treated as a safe `addressed` and
re-enters the review wait, but relying on that instead of emitting one wastes a round.
