# Derivation-parity suite (`defineFlow` ports of the nwf goldens)

Epic **nanobpm/nano-ide#314**, slice **S5 / #320**: port the seven hand-authored
nano-workforce BPMN goldens in `resources/processes/*.bpmn` to the code-first
`@nanobpm/workflow` `defineFlow` surface, and prove each derived model is
**structurally equal** to its golden with the S0 parity harness
(`@nanobpm/workflow/test-support` — `normalize` / `assertDerivationParity`).

- `flows.ts` — the code-first ports (one `defineFlow` per model) plus a `PORTS`
  registry that pairs each model with its port or its documented blocker.
- `derivation-parity.test.ts` — runs `assertDerivationParity` for every ported
  model, reports blocked models as skipped with their reason, and proves the
  blocker against the goldens themselves.

Run it with the repo suite (`npm test`) or directly:

```sh
node --experimental-strip-types --test test/derivation-parity/derivation-parity.test.ts
```

## Status

Per the human decision on the **#320 escalation** — _(c)+(a): land the
structurally-derivable goldens now at full whole-model parity, park the rest
behind an upstream construct, and do **not** relax to node-surface parity_:

| Model              | Top-level start/end | Status |
| ------------------ | ------------------- | ------ |
| `retro`            | 1 / 1               | ✅ green — whole-model parity |
| `convergence-loop` | 1 / 1               | ⛔ parked — class 2 (arbitrary graph) |
| `spine-demo`       | 1 / 2               | ⛔ parked — class 1 (multi start/end) |
| `readiness-gate`   | 1 / 5               | ⛔ parked — class 1 (multi start/end) |
| `feature`          | 2 / 2               | ⛔ parked — class 1 (multi start/end) |
| `merge-loop`       | 1 / 2               | ⛔ parked — class 1 (multi start/end) |
| `plan-fanout`      | 3 / 3               | ⛔ parked — class 1 (multi start/end) |

`retro` is a green whole-model parity port — a single-start/single-end agent
pipeline (gather → conformance → record-conformance) with a `deviations?`
conformance-escalation subgraph (#355/#356) and a shared synthesize → record
tail. Its `record-conformance-ack` service task carries a general
`<zeebe:ioMapping>` that the stock `task` builder could not emit until
`@nanobpm/workflow@0.13.0` landed the general service-task `io` construct
(nano-ide#405); every other element was always expressible (`w.task`+prompt,
`w.branch`, `w.human`, envelopes). The remaining six goldens are parked across
**two** distinct blocker classes, each awaiting an upstream `@nanobpm/workflow`
(nano-ide) construct + re-release (never a golden edit, never relaxed
acceptance).

## The blockers

### Class 1 — multiple top-level start/end events (5 models)

The published builder surface **`@nanobpm/workflow@0.12.0`** derives **exactly
one** top-level `<bpmn:startEvent id="Start">` and **exactly one**
`<bpmn:endEvent id="End">`, converging every top-level dangling branch into that
single end (`Compiler.compile` in the package's `declarative.ts`). There is no
terminal / explicit-end construct and no way to author multiple top-level start
events.

Five goldens have **multiple** top-level start and/or end events, so their
derived model can never be structurally equal under `normalize` (which
distinguishes `N` end events each with `in=1` from one end event with `in=N`).
The suite's `class-1 blocked goldens genuinely have multiple top-level start/end
events` diagnostic pins this against the goldens themselves.

### Class 2 — arbitrary control-flow graph (`convergence-loop`)

`convergence-loop` has a single start/end (it clears class 1) but its topology is
**not expressible** with `@nanobpm/workflow@0.12.0`'s structured-only builder
(`loop` / `switch` / `branch`). Single start/end is _necessary but not
sufficient_. Three golden features have no structured-builder derivation, each
pinned by a diagnostic in `derivation-parity.test.ts`:

1. **Task-level back-edge merge.** The loop head `review-round` is a
   `serviceTask` that merges **three** back-edges directly (`in=3`). But `loop()`
   always inserts an exclusive-gateway loop head that absorbs the back-edge, so
   the body task stays `in=1` — empirically demonstrated by the `loop() inserts a
   gateway head` test.
2. **Heterogeneous multi-way gateway.** `gw-status` is a single exclusive gateway
   with **four** heterogeneous-condition out-edges (two `=x = "v"` equalities, one
   complex boolean, one default). No `switch` (equalities + default) or `branch`
   (one condition + default) emits that.
3. **Shared merge+split gateway.** `gw-escalated` is a single exclusive gateway
   that is at once a **five-way merge and a two-way split**, reached by back-edges
   from five distinct points.

The fix is an **arbitrary-graph / explicit-join (named-target)** builder upstream
in `@nanobpm/workflow` — a **superset** of the class-1 gap.

## Resuming this slice

The follow-up upstream slices (opened in **nanobpm/nano-ide** per decision path
(a)) must add:

- a terminal / explicit-end (+ multi-start) construct (unblocks class 1), **and**
- an arbitrary-graph / explicit-join (named-target) builder (unblocks class 2 —
  `convergence-loop`).

(The class-3 general service-task `io` mapping has already landed —
`@nanobpm/workflow@0.13.0`, nano-ide#405 — unparking `retro` to whole-model
parity.)

Then, on a resumed run here:

1. Bump the `@nanobpm/workflow` dependency to the release that carries the
   construct(s).
2. In `flows.ts`, replace each parked entry's `blockedReason` with a real
   `flow: defineFlow(...)` port (author each model against exactly the features
   it uses — see the per-model feature map in the #320 brief).

No golden `.bpmn` file may be edited to force a match — the derivation must
reproduce the checked-in golden.

## CI regression guard (S6, nano-ide#321)

The unit suite above (run under `npm test`) does the DERIVE + structural DIFF for
every ported model. The **final regression guard** adds the third leg — DEPLOY —
and wires the whole corpus into CI as its own job:

    npm run check:derivation-parity        # scripts/check-derivation-parity.ts

For every model it derives the BPMN from its `defineFlow` port, structurally
diffs it against the checked-in golden via the **same** S0 harness
(`normalize` / `assertDerivationParity` — never reimplemented), and **deploys the
derived model to the in-process `@nanobpm/engine-wasm` engine**
(`@nanobpm/urban-testkit`), asserting the engine accepts it. Any structural drift
**or** deploy rejection fails the build. Parked models must each carry a
documented `blockedReason`, so the corpus can never silently lose coverage; a
parked model flips into the full derive → diff → deploy loop automatically the
moment its `flow` lands — no change to the gate.

Because most of the corpus is (currently) parked, the gate runs a **self-proving
canary** first: it proves a faithful derivation deploys and diffs green, a
drifted derivation is caught by the diff, and a corrupted model is rejected by
the engine — so the oracle's red path can never rot into a vacuous green. The
guard runs on every PR/push as the `derivation-parity` job in
`.github/workflows/ci.yml`.
