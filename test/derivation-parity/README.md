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

| Model              | Top-level start/end | Status |
| ------------------ | ------------------- | ------ |
| `retro`            | 1 / 1               | ✅ ported — green parity |
| `convergence-loop` | 1 / 1               | ⏳ pending (complex loop; not compiler-blocked) |
| `spine-demo`       | 1 / 2               | ⛔ compiler-blocked |
| `readiness-gate`   | 1 / 5               | ⛔ compiler-blocked |
| `feature`          | 2 / 2               | ⛔ compiler-blocked |
| `merge-loop`       | 1 / 2               | ⛔ compiler-blocked |
| `plan-fanout`      | 3 / 3               | ⛔ compiler-blocked |

## The blocker

The published builder surface **`@nanobpm/workflow@0.12.0`** (consumed here as a
dependency) derives **exactly one** top-level `<bpmn:startEvent id="Start">` and
**exactly one** `<bpmn:endEvent id="End">`, converging every top-level dangling
branch into that single end (`Compiler.compile` in the package's
`declarative.ts`). There is no terminal / explicit-end construct and no way to
author multiple top-level start events.

Five of the seven goldens have **multiple** top-level start and/or end events, so
their derived model can never be structurally equal to the golden under
`normalize` (which distinguishes `N` end events each with `in=1` from one end
event with `in=N`). This is verified empirically — e.g. `spine-demo` derives
`endEvent<in=2>` where the golden has two `endEvent<in=1>` — and the suite's
`blocked goldens genuinely have multiple top-level start/end events` diagnostic
pins it.

The fix lives **upstream** in `@nanobpm/workflow` (the nano-ide repo), not here:
the compiler needs a terminal / explicit-end (and multi-start) construct, then a
release. This slice is **escalated on #320** for that decision.

## Resuming this slice

Once the upstream construct lands (or the acceptance is relaxed to node-surface
parity for the multi-end models):

1. Bump the `@nanobpm/workflow` dependency to the release that carries the
   construct.
2. In `flows.ts`, replace each blocked entry's `blockedReason` with a real
   `flow: defineFlow(...)` port (author each model against exactly the features
   it uses — see the per-model feature map in the #320 brief).
3. `convergence-loop` is **not** blocked by the start/end limitation (it is a
   single-start/single-end model); it awaits a faithful structured-loop port of
   its five-gateway, three-re-entry loop head.

No golden `.bpmn` file may be edited to force a match — the derivation must
reproduce the checked-in golden.
