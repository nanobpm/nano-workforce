# ADR 0004 — Coordinate shared contracts through a durable registry + a blackboard signal + a reconciliation pass

Status: **Proposed.**
Date: 2026-08-14.

> **Scope note.** A **nano-workforce-local** ADR — it governs how *this app* coordinates cross-cutting
> contracts across parallel/sliced agent work. Platform-wide ADRs live in
> `Magikcraft/nano-bpm/docs/adr` (referenced by number + repo). Continues nano-workforce's series after
> ADR 0001–0003.

Relates to:
issue **#227** (the framing + spec this ADR records the decision for),
issue **#223** (the concrete `NANO_PR_*` env-key synonym cleanup — this ADR makes its cascade impossible
to reintroduce),
nano-ide **#234 / #236** (the relay producer/hub wire-shape drift — the same failure mode in a wire
contract),
issues **#214** (real-entrypoint integration test) and **#217** (retro verifies acceptance) — the
after-the-fact verification this ADR complements with an authoring-time preventive,
and in this repo: `app/contracts.ts` (the registry + typed env schema + declaration-conflict
detection), `app/contractReconcile.ts` (the reconciliation pass), `app/blackboard.ts`
(the `contract` kind + coordination brief), `operations/appendBlackboard.ts`,
`scripts/check-contracts.ts` (the CI gate) and `scripts/reconcile-contracts.ts` (the advisory pass).

## Context

Parallel and sliced agent work keeps producing **two divergent representations of a single contract**,
with no mechanism that binds them at authoring time. Two live examples of the *same* failure mode:

1. **Config-key synonym** — `publicBaseUrl()` read `NANO_PR_PUBLIC_BASE_URL` and fell back to a phantom
   `NANO_PR_BASE_URL` (introduced in the same commit, #53/2dcfb8a; nothing set it, the unit test even
   exercised the wrong name). Two names for one value (#223).
2. **Wire-shape drift** — a relay *producer* kept emitting the legacy `{stream, offset, chunk}` frame
   while the *hub* had adopted an op-tagged `{op:"produce", …}` sub-protocol; the hub rejected every
   worker terminal chunk. Every isolated slice test was green because each side tested against its own
   fake (nano-ide #234/#236).

The through-line: **a contract (an env key, a wire shape, a shared type name, a capability-URL scheme) is
authored independently by parallel workers, each against a mock or a local assumption, and the divergence
is discovered only at runtime.** Existing issues are *after-the-fact verification* (#214, #217) or fix a
*single symptom* (#223). None coordinate the shared contract surface **while** siblings are authoring it,
nor reconcile the accumulated blackboard for duplicate/synonymous declarations.

## Decision

Coordinate shared contracts with **three complementary mechanisms**, at deliberately different lifetimes.

### 1. A durable, executable contract registry (source of truth)

`app/contracts.ts` is a committed, reviewed, first-class registry of cross-cutting contracts —
env/config keys, wire-frame shapes, shared exported type/interface names, and capability-URL schemes —
each with an **owner** + **semantics**. It is *executable where possible*:

- **Env/config keys are parsed through ONE typed schema** (`ENV_CONTRACTS` + `readEnv`/`readEnvOr`).
  `readEnv(key)` takes a compile-time-checked `EnvKey`, so a synonymous or misspelled key is a **type
  error**, never a silent runtime fallback. Each entry may record `rejectedSynonyms` — names we
  deliberately retired (e.g. `NANO_PR_BASE_URL`); their reappearance in code is a **CI failure**
  (`scripts/check-contracts.ts`). The base-URL boundary is the migrated reference: `publicBaseUrl()` now
  reads the schema and the phantom fallback is gone, so the #223 cascade **cannot be reintroduced**.
- **Wire/type/capability-URL contracts** are declared alongside so ONE registry answers "does a contract
  for X already exist?" for every category. The blackboard's `BlackboardEntry` snake_case shape and the
  blackboard capability-URL scheme are the seed entries.

### 2. A blackboard `contract` kind (the live, in-flight signal)

`app/blackboard.ts` adds an app-recognised `contract` kind, **derived** from the shared store's kinds
(`APP_BLACKBOARD_KINDS = [...BLACKBOARD_KINDS, "contract"]`) so the two never drift. An agent posts a
`contract` entry ("I am introducing / consuming env key / wire op / type X") **as soon as it is true**,
so siblings in a wave see a new contract *before* they independently invent a synonym. The coordination
brief (`renderCoordinationBrief`) now requires: before introducing a new env key / wire field / shared
type, **consult the registry and the blackboard `contract` entries**; if a semantically-equivalent one
exists, **reuse it**; otherwise declare it in both. The registry is the durable truth; the blackboard is
the live signal. **Neither alone suffices.**

### 3. A de-duplication / reconciliation pass

- **Write-time.** A `contract` POST runs near-duplicate *declaration* detection
  (`detectDeclarationConflicts`, surfaced through `operations/appendBlackboard.ts` alongside the existing
  `file-claim` conflict reporting): it flags a **synonym** (same semantics, different name), a
  **contradiction** (same name, different meaning), or a **rejected synonym**, so the writer reconciles
  at authoring time.
- **Reconciliation pass** (`app/contractReconcile.ts`, a sibling to the L2 retro). It reads the *whole*
  blackboard + the registry and flags synonyms, contradictions, and **mock-vs-real skew** (a contract
  signalled in-flight that never landed in the durable registry). Advisory: it emits a report as an
  escalation / merge candidate (`npm run reconcile:contracts`) rather than silently accumulating. The
  mechanically-enforceable, registry-only half is the hard CI gate `npm run check:contracts`.

## Consequences

- The #223 failure mode is **categorically** closed for env keys: the synonym is a compile error and a
  rejected synonym is a CI failure — not a runtime fallback.
- A new cross-cutting contract has ONE place to be declared and ONE way to be read; the coordination brief
  routes agents through it, and the reconciliation pass catches what slips through.
- A CI gate (`check:contracts`) and an advisory pass (`reconcile:contracts`) make the coordination
  observable rather than a hope.

## Open questions / follow-ups

- **Promote the `contract` kind into `@nanobpm/agentic/blackboard`.** The shared store's normaliser coerces
  unknown kinds to `note`; the app persists `contract` by patching the row after the store's insert
  (reusing the store's append so the idempotency logic is not duplicated). The durable home for this kind
  is the shared package — a follow-up version bump removes the app-local patch.
- **Migrate the remaining env call sites** (`app/service.ts`, `app/plan.ts`, `main.ts`, …) onto
  `readEnv`/`readEnvOr`. The registry already declares every config key and the CI gate enforces
  declaration; routing every read through the typed schema is a mechanical follow-up.
- **Wire the reconciliation pass into the retro process** as an automatic cross-epic step, rather than an
  operator-run script.
