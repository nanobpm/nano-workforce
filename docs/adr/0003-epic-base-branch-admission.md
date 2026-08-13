# ADR 0003 — Epic base-branch admission: explicit, auto-created, and guarded

Status: **Proposed.**
Date: 2026-08-13.

> **Scope note.** A **nano-workforce-local** ADR — it governs how *this app* admits an epic for
> execution. Platform-wide ADRs live in `Magikcraft/nano-bpm/docs/adr` (referenced by number + repo).
> Continues nano-workforce's series after ADR 0002.

Relates to:
nano-workforce **ADR 0001** (cross-repo epics + integration branches — this ADR hardens *how* an epic's
integration branch is chosen, created, and protected),
nano-workforce **ADR 0002** (escalations are user tasks — the confirm / shared-base gates are human
decisions that *could* later surface as user tasks; see Open questions),
nano-bpm **ADR 0058** (the OpenAPI endpoint surface — `startPlanFanout` is a spec operation whose request
schema this ADR changes),
migration `019_plan_base_branch.sql` (the `plans.base_branch` column, whose example is `epic/agent-protocol`),
and in this repo: `operations/startPlanFanout.ts` (the launch operation), `app/plan.ts`
(`startPlan`, `normalizeBaseBranch`, `renderBaseBranchBrief`, `PLAN_TERMINAL_STATUSES`), `app/baseGuard.ts`
+ `app/github.ts` (`baseBranchLanded`, `fetchDefaultBranch`), and `resources/processes/plan-fanout.bpmn`.

## Context

An epic is launched through the `startPlanFanout` operation, which calls `startPlan(data, engine, parsed,
baseBranch)`. The `base_branch` (migration 019) tells every fanned-out task agent to branch off it and open
its PR against it (`renderBaseBranchBrief`), landing the whole epic on a long-lived integration branch that
reaches the default branch — and any merge-to-default side effect such as auto-publishing — only when the
integration branch is deliberately merged.

Four gaps make this a footgun surface:

1. **Implicit default.** `normalizeBaseBranch` maps a blank/absent value to `null`, silently meaning "target
   the repository default branch." An operator who *meant* to name an integration branch but omitted it
   lands every task straight onto the default branch (e.g. `main`) with **no integration buffer** — and
   any merge-to-default side effect fires per task.
2. **No branch creation.** Nothing creates the integration branch. `baseGuard`/`baseBranchLanded` only
   *read* (`gh pr list`, `fetchPrBase`, `fetchDefaultBranch`). So if the named branch doesn't exist, the
   **first task's** `git fetch origin <branch>` / `gh pr create --base <branch>` fails — a late, per-task
   failure instead of a clean admission error.
3. **No typo guard.** A mistyped branch name is indistinguishable from an intended new one; without
   creation it fails late, and *with* naive creation it would silently spawn a wrong-rooted branch.
4. **No collision guard.** Two in-flight epics can target the **same** integration branch, interleaving
   commits and poisoning each other's base — with no warning.

The pieces to fix this already exist: `fetchDefaultBranch` (default-branch identity), `PLAN_TERMINAL_STATUSES`
(`done|failed|abandoned` → the complement is "active"), a strict `isPlausibleBranchName` allowlist, and the
`019` example convention `epic/*`.

## Decision

**Every epic launch must state its base branch explicitly, and `startPlanFanout` admits it through one
fail-fast gate** — `admitPlan(...)` — run before any task fans out, backed by a durable `ensure-base-branch`
head step in `plan-fanout.bpmn`. The gate has four ordered rules:

### 1. Required + explicit — no implicit default

`baseBranch` becomes a **required** field of `StartPlanFanoutRequest`. `normalizeBaseBranch` **rejects** a
blank/absent value (`MissingBaseBranchError` → HTTP 400) instead of returning `null`. "Land on the default
branch" is now a **conscious, named, confirmed** choice (rule 3), never a silent fallback. The
`base_branch == null ? default : brief` fork in the launch/prompt path is removed; `renderBaseBranchBrief`
is always rendered. (`plans.base_branch` stays nullable in the DB **only** to grandfather pre-migration
rows; new launches always set it.)

### 2. Create-if-missing, idempotently — with an `epic/*` guard

`ensureBaseBranch(repo, branch, token)`:
- **Exists** → no-op (never reset — a reset would nuke in-flight task PRs stacked on it; a stacked epic's
  base already exists and is left alone).
- **Missing and matches `epic/*`** → create `refs/heads/<branch>` off the **default branch HEAD**.
- **Missing and *not* `epic/*`** → **reject** (`BaseBranchMustExistError`): a non-`epic/*` branch must
  already exist, so a typo can't silently spawn a wrong-rooted branch. (`epic/*` is the `019` convention.)

Runs at admission (fail fast) **and** as a head `ensure-base-branch` service task in `plan-fanout.bpmn` so
it is durable + retriable even on a re-plan.

### 3. Confirm-default — naming the default branch is deliberate

If the explicit target **equals the repository default** (via `fetchDefaultBranch`), admission requires an
explicit `confirmDefaultBase: true`, else **reject** (`DefaultBaseNotConfirmedError` → 400) with a message
spelling out the consequence ("every task lands directly on `<default>` with no integration branch; any
merge-to-default side effect fires per task"). This is the single guardrail on the one dangerous explicit
value.

### 4. Shared-base guard — one integration branch, one epic

If another plan whose `status ∉ PLAN_TERMINAL_STATUSES` (i.e. **active**) targets the **same repo + same
base branch**, admission **rejects** (`SharedBaseError` → 409) unless `allowSharedBase: true`. **Exempt: the
default branch** — many epics target the default concurrently and don't collide (each task PR is
independent). The guard fires only for a **shared custom integration branch**, the genuinely dangerous case.

### Recommended defaults (confirm before build)

- **Hard-require flags**, not soft warnings, for rules 3 and 4: a warning in a headless submit flow is
  ignorable; a required `confirmDefaultBase` / `allowSharedBase` is a "warn you can't skip."
- **`epic/*` auto-create guard** (rule 2): auto-create only `epic/*`; any other non-existent name is a
  400. Matches the `019` convention.

## Consequences

- **A footgun class disappears:** no silent land-on-main, no first-task-fails-on-missing-branch, no typo'd
  wrong-rooted branch, no two-epics-one-branch interleave — all become clean admission errors.
- **Breaking API + launch-path change.** `StartPlanFanoutRequest.baseBranch` is now required; any
  fire-and-forget caller/CLI/epic template that omitted it will (intentionally) 400. The OpenAPI spec +
  generated types (`nano-generated/api-io.d.ts`, controller) regenerate; the submit surface + docs update.
- **Back-compat:** pre-migration / in-flight `base_branch = null` plans are **grandfathered** (the column
  stays nullable; the required-ness is enforced at *admission* of new launches, not by a DB `NOT NULL`).
- **New write permission exercised:** ref creation (already held by the token that pushes task branches).
- **Ties into ADR 0001/0002:** this is the admission half of the integration-branch story (0001), and its
  human gates could later be modeled as user tasks (0002) rather than flags — see Open questions.

## Open questions

- **Gates as user tasks (ADR 0002)?** Should `confirmDefaultBase` / shared-base become an inbox **user
  task** ("Epic X wants to target `main` / share `epic/y` — approve?") instead of a submit-time flag? For
  *pre-fan-out* admission a synchronous flag is simpler and fail-fast; a user task fits only if we want a
  human in the launch loop. Deferred.
- **Auto-create root.** Always off default HEAD — correct for a fresh integration branch. Should a stacked
  epic be able to declare `stackOn: <branch>` so its base is auto-created off *another* epic's branch
  rather than default? (Today: that base must pre-exist.)
- **Convention scope.** Is `epic/*` the only auto-createable prefix, or should the app config own the
  allowlist?
- **Grandfathered nulls.** Leave historical `null` rows as-is, or backfill them to the (then-current)
  default branch for a uniform read model?
