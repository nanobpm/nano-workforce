// Derivation-parity suite for epic nanobpm/nano-ide#314 (S5, sub-issue #320).
//
// For every nano-workforce golden in `resources/processes/*.bpmn`, assert that
// its code-first `defineFlow` port (see `./flows.ts`) derives a BPMN model that
// is STRUCTURALLY EQUAL to the checked-in golden, using the S0 parity harness
// (`@nanobpm/workflow/test-support`). The harness normalizes both models (strips
// DI, canonicalizes ids/ordering) and diffs their semantic structure — nodes,
// sequence flows, message subscriptions, timer/boundary definitions, user tasks,
// and linked resources — with a legible red/green diff on mismatch.
//
// Ported models run a real `assertDerivationParity`; models still blocked by the
// upstream single-start/end compiler limitation (see `./flows.ts`) are reported
// as skipped WITH their precise reason, and a companion diagnostic proves the
// blocker is real by asserting the goldens' start/end multiplicity. No golden is
// modified to force a match — the derivation must reproduce the checked-in file.

import { test } from "node:test";
import { readFileSync } from "node:fs";
import { assert, assertEquals } from "#test-assert";
import { assertDerivationParity } from "@nanobpm/workflow/test-support";
import { PORTS } from "./flows.ts";

const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const goldenPath = (model: string): string => `${ROOT}resources/processes/${model}.bpmn`;

test("derivation parity — nano-workforce corpus", async (t) => {
  for (const port of PORTS) {
    const golden = goldenPath(port.model);
    const flow = port.flow;
    if (flow) {
      await t.test(`${port.model} derives its golden`, () => {
        assertDerivationParity(flow, golden);
      });
    } else {
      await t.test(`${port.model} (pending port)`, { skip: port.blockedReason ?? "pending" }, () => {});
    }
  }
});

// Every entry either derives its golden or documents why it cannot — so the
// corpus is fully accounted for and no model is silently dropped.
test("every corpus model is either ported or has a documented blocker", () => {
  const expected = [
    "retro",
    "spine-demo",
    "readiness-gate",
    "feature",
    "convergence-loop",
    "merge-loop",
    "plan-fanout",
  ];
  assertEquals(
    PORTS.map((p) => p.model),
    expected,
    "PORTS must cover all seven goldens in the epic's authoring order",
  );
  for (const port of PORTS) {
    assert(
      port.flow !== undefined || (port.blockedReason && port.blockedReason.length > 0),
      `${port.model} must either be ported (flow) or carry a blockedReason`,
    );
  }
});

// The blocker is not a guess: prove it against the goldens themselves. The five
// models marked blocked-by-compiler have MORE THAN ONE top-level start and/or
// end event, which the published `@nanobpm/workflow@0.12.0` compiler (a single
// `<startEvent id="Start">` + single `<endEvent id="End">`) cannot derive.
test("blocked goldens genuinely have multiple top-level start/end events", () => {
  const countTag = (xml: string, tag: string): number =>
    (xml.match(new RegExp(`<bpmn:${tag}\\b`, "g")) ?? []).length;

  const multiEndBlocked = new Set(["spine-demo", "readiness-gate", "feature", "merge-loop", "plan-fanout"]);
  for (const model of multiEndBlocked) {
    const xml = readFileSync(goldenPath(model), "utf8");
    const starts = countTag(xml, "startEvent");
    const ends = countTag(xml, "endEvent");
    assert(
      starts > 1 || ends > 1,
      `${model} is marked compiler-blocked but has ${starts} start(s)/${ends} end(s) — reclassify it`,
    );
  }

  // The two single-start/single-end goldens are the structurally-derivable ones.
  for (const model of ["retro", "convergence-loop"]) {
    const xml = readFileSync(goldenPath(model), "utf8");
    assertEquals(countTag(xml, "startEvent"), 1, `${model} should have one start event`);
    assertEquals(countTag(xml, "endEvent"), 1, `${model} should have one end event`);
  }
});
