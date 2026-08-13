# ADR 0001 — Cross-repo epics, release-ordered integration, and generic artifact wait-gates

Status: **Proposed.**
Date: 2026-08-13.

> **Scope note.** This is a **nano-workforce-local** ADR — it governs how *this app's* agent
> workforce decomposes and integrates epics. The platform-wide ADRs live in
> `Magikcraft/nano-bpm/docs/adr` (referenced here by their number + repo, e.g. "nano-bpm ADR 0056").
> nano-workforce's own decisions start their own series here at 0001.

Relates to:
nano-bpm **ADR 0051** (nano-workforce — the crew orchestrator this app implements),
nano-bpm **ADR 0056** (the Nano agentic protocol — the first consumer/producer *pair* that forced this
question: the hub epic https://github.com/nanobpm/nano-workforce/issues/142 and the worker epic
https://github.com/jwulf/c8ctl-plugin-nano/issues/38 live in **different repos** yet share one
published contract),
the **review-ready poller** in `main.ts` (a bespoke "wait for an external condition, then correlate a
message" loop — the seed this ADR generalizes into a first-class wait-gate),
and nano-bpm **ADR 0059** (the app-hosted OpenAPI hook surface these gates would be signalled through).

## Context

nano-workforce executes an epic as a **single-repo** unit, and every load-bearing piece assumes it:

- **The repo is epic-level, not task-level.** `Plan.repo` carries the repository; `PlanTask`
  (`app/plan.ts`) has **no** `repo` field. Fan-out clones *the epic's* repo for every slice.
- **Integration converges on one base branch in one repo.** The epic lands on a base branch; slices
  PR into it; the merge-loop trial-merges the set and merges the epic (nano-bpm ADR 0051 machinery:
  wave gates, base-branch guards, merge-loop reconciliation).
- **There is no "publish" step and no "wait for the outside world" primitive.** The only wait nwf does
  is the hand-rolled review-ready poller in `main.ts`, which polls GitHub and correlates a
  `review-ready` message. It is not reusable and knows only about PR reviews.

But real delivery in this ecosystem is **cross-repo by construction**. Shared libraries
(`@nanobpm/urban`, `@nanobpm/agentic`) are published from one repo and consumed downstream (this app,
c8ctl). The `urban → nano-workforce → c8ctl` chain is exactly a producer→consumer graph across repos
with an npm publish in the middle. Building the agentic visibility plane surfaced three concrete gaps:
(a) no per-task repo, (b) no release/publish step, (c) no wait-for-external-artifact primitive.

The temptation is to answer all three at once by making nwf a cross-repo, release-orchestrating
engine. That is a real redesign of the integration model and its highest-risk parts. Before paying for
it, note that **most cross-repo coupling in practice is a *versioned contract*, not a merge order** —
and a contract can be consumed *after* it is published, with no live cross-repo sequencing at all.

## Decision

### 1. Prefer contract-coupled per-repo epics over cross-repo epics (the default)

When two sides of a feature share a **versioned contract** — a published package plus a **conformance
corpus** both sides are held to — split the work into **one single-repo epic per repo**, each building
against the **already-published** contract. They coordinate through the contract, never through a merge
order. Neither epic waits on the other's code.

The agentic visibility plane is exactly this and ships this way, as **two** epics:

- **producer:** https://github.com/jwulf/c8ctl-plugin-nano/issues/38 (`nano work` → REGISTER/SERVE/relay);
- **hub + cockpit:** https://github.com/nanobpm/nano-workforce/issues/142.

Both consume the published `@nanobpm/agentic` and are held to `@nanobpm/agentic/protocol/conformance`.
This keeps nwf's proven single-repo integration model **entirely intact** and is the default posture
for any producer/consumer pair that can be expressed against a stable contract.

### 2. A generic artifact-readiness wait-gate (not npm-specific)

Generalize the review-ready poller into a **first-class, durable wait-gate**: a service task that
**polls a declared readiness probe with backoff until it is satisfied or a timeout escalates**, then
lets the flow proceed (or correlates a message). It is modeled on the engine (timer + receive), so a
worker or hub restart **resumes** the wait rather than losing it.

The probe is **declared as data, not code** — a `ReadinessProbe` descriptor with a `kind` and pluggable
matchers, so authors add readiness sources without editing the BPMN or the worker:

```jsonc
// ReadinessProbe — the gate is agnostic to what "ready" means.
{
  "kind": "http",                       // http | command | npm | oci | git-ref | github-release | github-check | file
  "target": "https://example/health",  // URL | shell command | "pkg@version" | "image:tag" | "owner/repo@ref" | path
  "match": { "status": 200 },           // per-kind predicate (status/body, exit code/stdout, version present, digest, …)
  "poll":  { "everyMs": 15000, "timeoutMs": 1800000, "backoff": "exponential" },
  "onTimeout": "escalate"               // escalate (default) | fail | continue
}
```

Invariants:

- **Never npm-specific.** `npm` is *one* kind among many; `command` is the escape hatch that subsumes
  almost anything (`gh`, `curl`, `docker manifest inspect`, a custom probe) for cases no built-in kind
  covers. Adding a kind is a new matcher, not a schema change.
- **Bounded.** A probe that never goes green must **time out and escalate** (mirroring the per-task
  escalation path) — a hanging probe can never wedge a plan.
- **Idempotent / resumable.** The gate only *reads* readiness; it holds no state a re-run could corrupt,
  so a restarted worker simply re-probes.

This is immediately useful well beyond releases: waiting on CI, a downstream deploy, an external
system, a human approval, or a produced artifact.

### 3. The shared-library bump stays a manual maintainer seam — for now

A downstream version bump (e.g. `@nanobpm/urban` → this app) after an upstream release is handled by a
maintainer **outside** the epic, until §4 lands. It is cheap, low-risk, and rare relative to the
intra-repo work of an epic. This is the deliberate, documented seam that lets §1 stay simple: the
*only* cross-repo dependency in the agentic plane (nano-ide `UrbanApp.httpServer`,
https://github.com/nanobpm/nano-ide/issues/221 → an `@nanobpm/urban` release → a bump here) is a
one-line human step, not a reason to build a cross-repo engine.

### 4. Release-ordered cross-repo integration (the "release DAG") — deferred, sketched

Some future work genuinely cannot decouple: a consumer needs a producer's **new** release *mid-epic*.
For those cases only, model integration as a **DAG across independent per-repo merge trains**:

```
producer PRs → merge → publish → [artifact wait-gate §2] → consumer PRs open/build → merge
```

This replaces the single-epic-branch assumption **for those cases**, and requires, in order:

1. **Per-task repo.** Add `repo` to `PlanTask`, derive it from each sub-issue (`parseIssue` already
   yields `owner/repo`), and thread it into the `io.nanobpm.agentTask.repository` clone header. The
   merge/review/finalize workers are *already* repo-parameterized (they take `repo` per PR and load the
   merge protocol per repo), so this is mostly plan/task plumbing.
2. **A release task type.** bump version → merge → **§2 wait-gate on artifact availability** → signal
   downstream. Publish is at-least-once; the task must tolerate a re-run (mirror the idempotent
   `scripts/publish.mjs` "skip already-published" discipline).
3. **Cross-train ordering.** A meta-plan (or a first-class multi-repo epic) that sequences the per-repo
   trains and their gates.

This is its **own follow-up epic with its own design**. Do **not** build it speculatively — §1 removes
the need for the foreseeable roadmap, and §2 is the reusable building block it will stand on.

## Consequences

- The agentic visibility plane ships **now** as two single-repo epics; nwf's integration model
  (base-branch, trial-merge, merge-loop, wave gates) is untouched and unrisked.
- nwf gains a durable **"wait for the world"** primitive it currently fakes with the bespoke review
  poller; the poller can later be re-expressed as one `github-check`/`http` gate.
- New surface to own: the `ReadinessProbe` kinds. A malformed or hanging probe is bounded by the
  mandatory timeout+escalation, so it cannot stall a plan.
- Shared-library bumps stay manual until §4 — an accepted cost given their frequency.
- When §4 is eventually built, §1 + §2 mean it is *additive* (a new integration topology + a release
  task) rather than a rewrite.

## Open questions

- **Probe extensibility model:** a curated registry of `kind`s vs leaning on the `command` escape hatch
  for the long tail — and how a probe's credentials/secrets are supplied without leaking into logs.
- **Where cross-train ordering lives (§4):** a meta-plan across existing epics, or a genuine
  first-class multi-repo epic with per-task repos.
- **Per-repo divergence when per-task repo lands:** merge protocol, required checks, Copilot-review
  provisioning (not available on every repo), and push auth all differ per repo.
- **Gate signalling:** in-flow receive task vs an out-of-band message correlated by an app-side poller
  (the review-ready shape) — likely both, chosen per use.
