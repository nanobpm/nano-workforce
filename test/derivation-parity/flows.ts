// Code-first (`defineFlow`) ports of the hand-authored nano-workforce BPMN
// goldens in `resources/processes/*.bpmn`, for epic nanobpm/nano-ide#314 (S5,
// sub-issue #320). Each port must derive a BPMN model that is STRUCTURALLY equal
// to its golden under the S0 derivation-parity harness
// (`@nanobpm/workflow/test-support` — `normalize` / `assertDerivationParity`),
// proving the code-first and model-first representations agree.
//
// STATUS / BLOCKER (see `README.md` in this directory and the escalation on
// nano-ide#320): the published builder surface `@nanobpm/workflow@0.12.0`
// derives EXACTLY ONE top-level `<bpmn:startEvent id="Start">` and EXACTLY ONE
// `<bpmn:endEvent id="End">`, converging every top-level dangling branch into
// that single end (see `Compiler.compile` in the package's `declarative.ts`).
// Five of the seven goldens have MULTIPLE top-level start and/or end events and
// therefore cannot reach whole-model structural parity until the workflow
// compiler grows a terminal / explicit-end (and multi-start) construct — a
// change that lives in the upstream `@nanobpm/workflow` package (nano-ide), not
// here. Those five are marked `blockedReason` below so the suite documents
// exactly why, and a resumed run can flip them to a real port once the upstream
// construct lands (or the acceptance is relaxed to node-surface parity).

import { defineFlow, envelope } from "@nanobpm/workflow";
import type { DeclarativeFlow } from "@nanobpm/workflow";

/** One model's port entry: the golden basename, the derived flow (when it can be
 *  reproduced), and — when it cannot yet — the reason it is blocked. */
export interface PortEntry {
  /** The golden model basename under `resources/processes/<model>.bpmn`. */
  readonly model: string;
  /** The derived `defineFlow`, when a structurally-faithful port exists. */
  readonly flow?: DeclarativeFlow;
  /** Present when whole-model parity is not yet achievable — why, precisely. */
  readonly blockedReason?: string;
}

// ── retro ────────────────────────────────────────────────────────────────────
// A linear agent pipeline (single start, single end): gather → synthesize
// (agent, prompt-bound) → record. Exercises the S4 agent linked-resource prompt
// binding (`w.task(..., { prompt })`) and typed data envelopes lifted to the
// per-task `io.nanobpm.dataEnvelope.in` properties.

const RetroGatherIn = envelope("RetroGatherIn", { planKey: "string" });
const RetroRecordIn = envelope("RetroRecordIn", {
  planKey: "string",
  retroLearnings: { type: "integer", optional: true },
  status: { type: "string", optional: true },
  pr: { type: "string", optional: true },
  summary: { type: "string", optional: true },
});

const retro = defineFlow(
  "retro",
  {
    gather: { in: RetroGatherIn },
    record: { in: RetroRecordIn },
  },
  (w) => {
    w.task("gather", { jobType: "pr.retro-gather" });
    w.task("synthesize", {
      jobType: "senior:retro",
      prompt: { resourceId: "retro.md", bindingType: "latest", append: "=retroDigest" },
    });
    w.task("record", { jobType: "pr.retro-record" });
  },
);

/** The single-top-level-end/start compiler limitation, reused as the
 *  `blockedReason` for every golden that has more than one top-level start
 *  and/or end event. */
const MULTI_END_BLOCK =
  "blocked: @nanobpm/workflow@0.12.0 derives a single top-level start/end and " +
  "converges all danglers into one <endEvent id=\"End\">; this golden has " +
  "multiple top-level start and/or end events, which the published compiler " +
  "cannot reproduce. Awaits an upstream terminal/explicit-end (+ multi-start) " +
  "construct in @nanobpm/workflow (nano-ide) or relaxed node-surface acceptance.";

/** All seven ports, keyed by model, in the epic's stated authoring order. */
export const PORTS: readonly PortEntry[] = [
  { model: "retro", flow: retro },
  {
    model: "spine-demo",
    blockedReason: `${MULTI_END_BLOCK} (spine-demo: 1 start, 2 ends)`,
  },
  {
    model: "readiness-gate",
    blockedReason: `${MULTI_END_BLOCK} (readiness-gate: 1 start, 5 ends)`,
  },
  {
    model: "feature",
    blockedReason: `${MULTI_END_BLOCK} (feature: 2 starts, 2 ends)`,
  },
  {
    model: "convergence-loop",
    blockedReason:
      "not yet ported: single start/end (structurally derivable) but a complex " +
      "loop whose head `review-round` is re-entered from three points across " +
      "five exclusive gateways; a faithful structured-loop port is pending. " +
      "Not blocked by the compiler start/end limitation.",
  },
  {
    model: "merge-loop",
    blockedReason: `${MULTI_END_BLOCK} (merge-loop: 1 start, 2 ends)`,
  },
  {
    model: "plan-fanout",
    blockedReason: `${MULTI_END_BLOCK} (plan-fanout: 3 starts, 3 ends)`,
  },
];
