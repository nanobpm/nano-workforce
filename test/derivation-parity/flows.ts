// Code-first (`defineFlow`) ports of the hand-authored nano-workforce BPMN
// goldens in `resources/processes/*.bpmn`, for epic nanobpm/nano-ide#314 (S5,
// sub-issue #320). Each port must derive a BPMN model that is STRUCTURALLY equal
// to its golden under the S0 derivation-parity harness
// (`@nanobpm/workflow/test-support` — `normalize` / `assertDerivationParity`),
// proving the code-first and model-first representations agree.
//
// STATUS (per the human decision on the nano-ide#320 escalation — (c)+(a): land
// the structurally-derivable goldens at full whole-model parity, park the rest
// pending an upstream construct, and do NOT relax to node-surface parity):
//
//   • `retro` is a GREEN whole-model parity port (see below). The remaining seven
//     goldens are `blockedReason`-parked, in TWO distinct classes, each awaiting
//     an upstream `@nanobpm/workflow` (nano-ide) construct + re-release — never a
//     golden edit and never relaxed acceptance:
//
//     (1) MULTI top-level start/end (spine-demo, readiness-gate, feature,
//         merge-loop, plan-fanout, delivery-human). `@nanobpm/workflow` derives EXACTLY
//         ONE `<bpmn:startEvent id="Start">` + ONE `<bpmn:endEvent id="End">`,
//         converging every dangler into that single end (see `Compiler.compile`
//         in the package's `declarative.ts`). Needs a terminal/explicit-end
//         (+ multi-start) construct.
//
//     (2) ARBITRARY control-flow graph (convergence-loop). Single start/end —
//         so it clears class (1) — but its topology is NOT expressible with the
//         structured-only builder (`loop`/`switch`/`branch`), empirically proven
//         (see `derivation-parity.test.ts`): its loop head `review-round` is a
//         serviceTask that MERGES three back-edges directly (in=3), whereas
//         `loop()` always inserts an exclusive-gateway loop head (the task stays
//         in=1); `gw-status` is a single exclusive gateway with FOUR
//         heterogeneous-condition out-edges (two `=x = "v"`, one complex boolean,
//         one default) which no `switch`/`branch` emits; and `gw-escalated` is a
//         single gateway that is simultaneously a five-way merge and a two-way
//         split. Single start/end is necessary but NOT sufficient. Needs an
//         arbitrary-graph / explicit-join (named-target) builder — a SUPERSET of
//         the class-(1) gap.
//
// A resumed run flips any parked model to a real `flow` once the corresponding
// upstream construct lands and `@nanobpm/workflow` is bumped to carry it.

import { type DeclarativeFlow, defineFlow, envelope } from "@nanobpm/workflow";

/** One model's port entry: the golden basename plus EITHER the derived flow
 *  (when it can be reproduced) OR the reason it is blocked — never both and never
 *  neither. Modelled as a discriminated union so a partial/contradictory entry
 *  (both `flow` and `blockedReason`, or neither) fails to compile. */
export type PortEntry =
  | {
      /** The golden model basename under `resources/processes/<model>.bpmn`. */
      readonly model: string;
      /** The derived `defineFlow` — a structurally-faithful port exists. */
      readonly flow: DeclarativeFlow;
      readonly blockedReason?: never;
    }
  | {
      /** The golden model basename under `resources/processes/<model>.bpmn`. */
      readonly model: string;
      readonly flow?: never;
      /** Why whole-model parity is not yet achievable — precisely. */
      readonly blockedReason: string;
    };

// ── retro (GREEN — whole-model parity) ───────────────────────────────────────
// retro is a single-start/single-end model: a linear gather → conformance →
// record-conformance agent pipeline, a `deviations?` exclusive gateway guarding a
// conformance-escalation subgraph (nano-workforce #355/#356), then a shared
// synthesize → record tail. Every element ports with the stock builder:
// `w.task`+envelopes for the data-envelope service tasks, `w.task`+prompt for the
// two agent tasks (`senior:conformance`, `senior:retro`), `w.branch` for the
// `deviations?` gateway, `w.human` for the `conformance-escalation` userTask, and
// — since @nanobpm/workflow@0.13.0 landed the general service-task `io` construct
// (nano-ide#405) — `w.task`+`io` for `record-conformance-ack`'s general
// <zeebe:ioMapping> (inputs `=planKey`→planKey and
// `=if (is defined(note)) then note else null`→note).

/** The typed data envelopes retro's non-agent service tasks lift into the model
 *  (`nano:shape` + `io.nanobpm.dataEnvelope.in`), matching the golden's shapes. */
const RetroGatherIn = envelope("RetroGatherIn", { planKey: "string" });
const RetroRecordIn = envelope("RetroRecordIn", {
  planKey: "string",
  retroLearnings: { type: "integer", optional: true },
  status: { type: "string", optional: true },
  pr: { type: "string", optional: true },
  summary: { type: "string", optional: true },
});
const ConformanceRecordIn = envelope("ConformanceRecordIn", {
  planKey: "string",
  status: { type: "string", optional: true },
  commentUrl: { type: "string", optional: true },
  slicesMet: { type: "integer", optional: true },
  slicesReduced: { type: "integer", optional: true },
  slicesNotVerified: { type: "integer", optional: true },
  deviationsRaised: { type: "integer", optional: true },
  deviationsUnraised: { type: "integer", optional: true },
  hasDeviations: { type: "boolean", optional: true },
  summary: { type: "string", optional: true },
});

/** The code-first port of `resources/processes/retro.bpmn`. */
const retroFlow: DeclarativeFlow = defineFlow(
  "retro",
  {
    gather: { in: RetroGatherIn },
    "record-conformance": { in: ConformanceRecordIn },
    record: { in: RetroRecordIn },
  },
  (w) => {
    w.task("gather", { jobType: "pr.retro-gather" });
    w.task("conformance", {
      jobType: "senior:conformance",
      prompt: { resourceId: "prompts/conformance.md", bindingType: "latest", append: "=conformanceDigest" },
    });
    w.task("record-conformance", { jobType: "pr.conformance-record" });
    w.branch("hasDeviations = true", {
      then: (b) => {
        b.human("conformance-escalation", {
          form: "conformance-escalation",
          candidateGroups: "operators",
        });
        b.task("record-conformance-ack", {
          jobType: "pr.conformance-ack",
          io: {
            input: [
              { source: "=planKey", target: "planKey" },
              { source: "=if (is defined(note)) then note else null", target: "note" },
            ],
          },
        });
      },
    });
    w.task("synthesize", {
      jobType: "senior:retro",
      prompt: { resourceId: "prompts/retro.md", bindingType: "latest", append: "=retroDigest" },
    });
    w.task("record", { jobType: "pr.retro-record" });
  },
);

/** The single-top-level-end/start compiler limitation, reused as the
 *  `blockedReason` for every golden that has more than one top-level start
 *  and/or end event. */
const MULTI_START_END_BLOCK =
  "blocked: the published @nanobpm/workflow compiler derives a single top-level start/end and " +
  "converges all danglers into one <endEvent id=\"End\">; this golden has " +
  "multiple top-level start and/or end events, which the published compiler " +
  "cannot reproduce. Awaits an upstream terminal/explicit-end (+ multi-start) " +
  "construct in @nanobpm/workflow (nano-ide).";

/** All ports, keyed by model, in the epic's stated authoring order. */
export const PORTS: readonly PortEntry[] = [
  { model: "retro", flow: retroFlow },
  {
    model: "spine-demo",
    blockedReason: `${MULTI_START_END_BLOCK} (spine-demo: 1 start, 2 ends)`,
  },
  {
    model: "readiness-gate",
    blockedReason: `${MULTI_START_END_BLOCK} (readiness-gate: 1 start, 5 ends)`,
  },
  {
    model: "feature",
    blockedReason: `${MULTI_START_END_BLOCK} (feature: 2 starts, 2 ends)`,
  },
  {
    model: "convergence-loop",
    blockedReason:
      "blocked (arbitrary control-flow graph): single top-level start/end, but " +
      "its topology is not expressible with the published @nanobpm/workflow's " +
      "structured-only builder (loop/switch/branch). Proven in the test suite: " +
      "the loop head `review-round` is a serviceTask that merges 3 back-edges " +
      "directly (in=3), but loop() always inserts an exclusive-gateway head " +
      "(task stays in=1); `gw-status` is one gateway with 4 heterogeneous-" +
      "condition out-edges (no switch/branch emits that); `gw-escalated` is one " +
      "gateway that is at once a 6-way merge and a 2-way split. Awaits an " +
      "arbitrary-graph / explicit-join (named-target) builder upstream in " +
      "@nanobpm/workflow (nano-ide) — a superset of the multi-start/end gap.",
  },
  {
    model: "merge-loop",
    blockedReason: `${MULTI_START_END_BLOCK} (merge-loop: 1 start, 2 ends)`,
  },
  {
    model: "plan-fanout",
    blockedReason: `${MULTI_START_END_BLOCK} (plan-fanout: 3 starts, 3 ends)`,
  },
  {
    model: "delivery-human",
    blockedReason: `${MULTI_START_END_BLOCK} (delivery-human: 1 start, 2 ends)`,
  },
  {
    model: "implement-cell",
    blockedReason:
      "blocked (call activity + multi-end): the published @nanobpm/workflow " +
      "builder emits neither a `callActivity` (this cell delegates escalation to " +
      "`human-escalation` via `zeebe:calledElement`) nor multiple top-level ends " +
      "(implement-cell: 1 start, 1 end but a call-activity body); a shared ADR 0006 " +
      "S4 fine-grained cell composed into feature/plan-fanout by callActivity.",
  },
  {
    model: "converge-cell",
    blockedReason:
      "blocked (shared S4 cell): a hand-authored ADR 0006 S4 fine-grained cell " +
      "(converge handoff) composed into feature by callActivity; not yet ported to " +
      "a @nanobpm/workflow `defineFlow`.",
  },
  {
    model: "merge-cell",
    blockedReason: `${MULTI_START_END_BLOCK} (merge-cell: 1 start, 2 ends)`,
  },
  {
    model: "wait-gate",
    blockedReason: `${MULTI_START_END_BLOCK} (wait-gate: 1 start, 2 ends)`,
  },
  {
    model: "human-escalation",
    blockedReason: `${MULTI_START_END_BLOCK} (human-escalation: 1 start, 3 ends)`,
  },
];
