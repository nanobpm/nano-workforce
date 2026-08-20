// check-derivation-parity — the FINAL regression guard for epic nanobpm/nano-ide#314 (S6, #321).
//
// This is the compounding oracle that keeps the code-first (`defineFlow`) and model-first (`.bpmn`)
// representations of the nano-workforce corpus in lockstep. For EVERY golden under
// `resources/processes/*.bpmn` it runs the full derive → diff → deploy loop:
//
//   (a) DERIVE  — take the golden's `defineFlow` port (test/derivation-parity/flows.ts) and derive
//                 its BPMN with `@nanobpm/workflow`.
//   (b) DIFF    — structurally compare the derived model against the checked-in golden using the S0
//                 parity harness (`@nanobpm/workflow/test-support`'s `normalize` / `assertDerivation-
//                 Parity`). The normalization/diff is NEVER reimplemented here — this gate only calls
//                 the shared harness, so the code-first check can't drift from the unit suite's.
//   (c) DEPLOY  — deploy the derived model to the in-process `@nanobpm/engine-wasm` engine (via
//                 `@nanobpm/urban-testkit`) and assert the engine ACCEPTS it.
//
// Any structural drift (b) OR deploy rejection (c) fails the build.
//
// PARKED MODELS ARE ACCOUNTED FOR, NOT IGNORED. The corpus is currently fully parked behind
// upstream `@nanobpm/workflow` constructs (see test/derivation-parity/flows.ts for the three blocker
// classes). Each parked model must carry a documented `blockedReason`; a model that is neither
// ported nor documented fails this gate, so the corpus can never silently lose coverage. As each
// parked model flips to a real `flow` upstream, it is automatically pulled into the full
// derive → diff → deploy loop here with NO change to this script.
//
// SELF-PROVING CANARY. Because the corpus is (today) all-parked, a gate that merely iterated it
// would be a vacuous green — it could rot without anyone noticing. So before touching the corpus we
// run a CANARY that proves the oracle's RED path genuinely fires: a faithful derived flow deploys
// green and diffs green, a drifted derivation is CAUGHT by the diff, and a corrupted model is
// REJECTED by the engine. If any red path fails to fire (the diff misses drift, or the engine
// accepts garbage), the gate fails — the oracle must be able to say no.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWasmEngineClient } from "@nanobpm/urban-testkit";
import type { DeclarativeFlow } from "@nanobpm/workflow";
import { declarativeToBpmn, defineFlow, toDeployableBpmn } from "@nanobpm/workflow";
import { assertDerivationParity } from "@nanobpm/workflow/test-support";
import { PORTS } from "../test/derivation-parity/flows.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const goldenPath = (model: string): string => join(REPO_ROOT, "resources", "processes", `${model}.bpmn`);

type WasmEngine = Awaited<ReturnType<typeof createWasmEngineClient>>;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Deploy a derived flow's *deployable* BPMN (semantic model + auto-layout DI) to the wasm engine
 *  and assert acceptance. Throws when the engine rejects the model or reports nothing deployed. */
async function deployDerived(engine: WasmEngine, id: string, flow: DeclarativeFlow): Promise<void> {
  const xml = await toDeployableBpmn(flow);
  const result = await engine.deployResources([{ name: `${id}.bpmn`, content: xml, contentType: "application/xml" }]);
  if (!result || result.deployed < 1) {
    throw new Error(`engine did not accept derived "${id}" (deployed=${result?.deployed ?? 0})`);
  }
}

/** Prove the derive → diff → deploy oracle can actually say NO, so an all-parked corpus can't let
 *  this gate rot into a vacuous green. Pushes a line onto `errors` for any red path that fails to
 *  fire. */
async function proveOracleFiresRed(engine: WasmEngine, errors: string[]): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-parity-canary-"));
  try {
    const canary = defineFlow("parity-canary", (w) => {
      w.task("step-a", { jobType: "senior:noop" });
    });
    const golden = join(dir, "parity-canary.bpmn");
    writeFileSync(golden, declarativeToBpmn(canary), "utf8");

    // DIFF, green: a faithful derivation matches its own golden.
    try {
      assertDerivationParity(canary, golden);
    } catch (e) {
      errors.push(`  canary: a faithful derivation was reported as drift — the diff is broken (${errMsg(e)})`);
    }

    // DIFF, red: a structurally different derivation MUST be caught.
    const drifted = defineFlow("parity-canary", (w) => {
      w.task("step-a", { jobType: "senior:noop" });
      w.task("step-b", { jobType: "senior:noop" });
    });
    let structuralFired = false;
    try {
      assertDerivationParity(drifted, golden);
    } catch {
      structuralFired = true;
    }
    if (!structuralFired) {
      errors.push("  canary: the structural-drift oracle did NOT fire (an added node slipped past the diff)");
    }

    // DEPLOY, green: a valid derived model is accepted by the engine.
    try {
      await deployDerived(engine, "parity-canary", canary);
    } catch (e) {
      errors.push(`  canary: the engine rejected a VALID derived model — the deploy oracle is broken (${errMsg(e)})`);
    }

    // DEPLOY, red: a corrupted model MUST be rejected.
    let deployFired = false;
    try {
      await engine.deployResources([{ name: "corrupt.bpmn", content: "<not-bpmn/>", contentType: "application/xml" }]);
    } catch {
      deployFired = true;
    }
    if (!deployFired) {
      errors.push("  canary: the deploy-rejection oracle did NOT fire (the engine accepted invalid BPMN)");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const errors: string[] = [];
  const engine = await createWasmEngineClient();

  let ported = 0;
  let deployed = 0;
  let parked = 0;

  try {
    await proveOracleFiresRed(engine, errors);

    for (const port of PORTS) {
      if (port.flow) {
        ported++;
        const golden = goldenPath(port.model);
        try {
          assertDerivationParity(port.flow, golden);
        } catch (e) {
          errors.push(`  ${port.model}: STRUCTURAL DRIFT vs golden — ${errMsg(e)}`);
          continue; // a model that doesn't derive its golden can't be trusted to deploy meaningfully
        }
        try {
          await deployDerived(engine, port.model, port.flow);
          deployed++;
        } catch (e) {
          errors.push(`  ${port.model}: DEPLOY REJECTED by wasm engine — ${errMsg(e)}`);
        }
      } else {
        parked++;
        if (!port.blockedReason || port.blockedReason.trim().length === 0) {
          errors.push(
            `  ${port.model}: neither ported (no flow) nor documented (no blockedReason) — every ` +
              `corpus model must derive its golden or carry a precise blocker.`,
          );
        }
      }
    }
  } finally {
    // Release the underlying WASM engine resources so repeated runs (local / CI matrix) don't leak.
    await engine.close();
  }

  if (errors.length > 0) {
    console.error(`check-derivation-parity: the nano-workforce corpus failed its derivation-parity guard:\n${errors.join("\n")}`);
    process.exit(1);
  }

  console.log(
    `check-derivation-parity: OK (${PORTS.length} corpus models — ${ported} ported ` +
      `[${deployed} deploy-accepted by the wasm engine], ${parked} documented-parked; oracle red paths verified).`,
  );
}

if (import.meta.main) main();
