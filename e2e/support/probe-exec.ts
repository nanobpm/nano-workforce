// Deterministic readiness-probe exec for e2es driven by the testkit's VIRTUAL clock (issue #450).
//
// Production `defaultProbeExec` (app/readiness.ts) runs a `command` probe as a REAL
// `node:child_process` subprocess. That subprocess resolves on the wall clock, spanning macrotasks
// the urban-testkit's virtual-clock `settle()`/`drain()` fixpoint cannot deterministically await —
// so `settle()` can return BEFORE the probe publishes `readiness-ready`, and a gate-flow assertion
// (e.g. `pf_gw->pf_end`) races the subprocess. That race is the flake behind feature-preflight /
// plan-fanout-preflight failing intermittently (green probe logged, gate flow not yet taken).
//
// This seam injects a synchronous, in-memory `ProbeExec` (via the worker's `__setProbeExecForTest`)
// so the probe resolves WITHIN the drain fixpoint — no real spawn, no wall-clock race. It maps the
// hermetic shell builtins the gate e2es use to a deterministic `CommandResult` — `true` → exit 0
// (green), `false` → exit 1 (never green) — mirroring the real commands exactly, with zero real time.
//
// Any OTHER command, or any HTTP call, is an unintended probe escape: `probeSingleShot` folds a
// thrown/rejected probe error into a silent "not ready", so an escape would be INVISIBLE and could
// let a bounded not-ready scenario still pass, masking a regression. Every escape is recorded and
// asserted-none in teardown, failing the suite loudly instead of swallowing it.
//
// Single source of truth shared by every readiness-gate e2e (readiness-gate, feature-preflight,
// plan-fanout-preflight, delivery-graph, inter-epic-dependency) so the deterministic-exec contract
// can never drift between them.
import assert from "node:assert/strict";
import { type CommandResult, type ProbeExec, redactString } from "../../app/readiness.ts";
import { __setProbeExecForTest } from "../../workers/readiness-probe/worker.ts";

export interface DeterministicProbeSeam {
  /** Install the deterministic exec — call once in the suite's `before`. */
  install(): void;
  /** Restore the prior exec and assert no probe escaped the hermetic `true`/`false` builtins — call
   *  once in the suite's `after`. */
  restoreAndAssertHermetic(): void;
}

/** Build a deterministic probe seam scoped to one suite. `label` is used in the escape assertion
 *  message and the unexpected-HTTP error, so a failure names the offending suite. */
export function deterministicProbeSeam(label: string): DeterministicProbeSeam {
  const escapes: string[] = [];
  const exec: ProbeExec = {
    run(command: string): Promise<CommandResult> {
      const cmd = command.trim();
      if (cmd !== "true" && cmd !== "false") {
        // A `command` target is an arbitrary shell snippet that can embed a secret, so — exactly as
        // production `redactTarget` does (app/readiness.ts, ADR 0004 pinned decision 2) — record only
        // a fixed placeholder, never the raw command, so an escape can't leak credentials into the
        // teardown assertion at `restoreAndAssertHermetic()`.
        escapes.push("command: <redacted>");
        return Promise.resolve({ code: 127, stdout: "", stderr: "" });
      }
      return Promise.resolve({ code: cmd === "true" ? 0 : 1, stdout: "", stderr: "" });
    },
    httpGet(url: string): Promise<never> {
      // A probe URL can carry a token in its userinfo or query string; strip those before recording.
      escapes.push(`http: ${redactString(url)}`);
      return Promise.reject(new Error(`${label}: unexpected real HTTP probe (command probes only)`));
    },
  };
  let saved: ProbeExec | undefined;
  return {
    install() {
      saved = __setProbeExecForTest(exec);
    },
    restoreAndAssertHermetic() {
      // Restore the prior exec first — the seam must never outlive this suite.
      __setProbeExecForTest(saved);
      assert.deepEqual(escapes, [], `${label} saw unexpected probe I/O: ${escapes.join(", ")}`);
    },
  };
}
