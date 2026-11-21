// Guard over the defect CLASS of issue #994: every tracked run kind must map the same lifecycle event
// to the same terminal status, derived from ONE canonical source (app/runTerminal.ts). A new binding
// with its own divergent `onTerminated`, or an unclassified binding, fails here.

import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { deriveDeliveryPhase } from "./deliveryGraphRun.ts";
import { engineBackedBindings } from "./instanceTracking.ts";
import {
  BOOKKEEPING_TRACKED_TABLES,
  effectiveTerminalStatus,
  RUN_TERMINAL_STATUS,
  RUN_TRACKED_TABLES,
} from "./runTerminal.ts";

const isRun = (t: string) => RUN_TRACKED_TABLES.some((r) => r === t);
const isBookkeeping = (t: string) => BOOKKEEPING_TRACKED_TABLES.some((r) => r === t);

test("every instanceTracking binding is classified as a run kind or bookkeeping (a new kind must opt in)", () => {
  for (const b of engineBackedBindings()) {
    assert(
      isRun(b.table) !== isBookkeeping(b.table),
      `instanceTracking table "${b.table}" must be listed in exactly one of RUN_TRACKED_TABLES / BOOKKEEPING_TRACKED_TABLES (app/runTerminal.ts)`,
    );
  }
  for (const t of RUN_TRACKED_TABLES) {
    assert(engineBackedBindings().some((b) => b.table === t), `RUN_TRACKED_TABLES lists "${t}" but nano.app.json has no binding`);
  }
});

test("every run kind maps an engine TERMINATED to the ONE canonical out-of-band-terminate status (never `failed`)", () => {
  for (const b of engineBackedBindings().filter((x) => isRun(x.table))) {
    const statusField = b.statusField ?? "status";
    assertEquals(
      b.onTerminated?.set?.[statusField],
      RUN_TERMINAL_STATUS.outOfBandTerminate,
      `${b.table}: onTerminated must derive from RUN_TERMINAL_STATUS.outOfBandTerminate, not a per-kind choice`,
    );
  }
  assert(
    !Object.values(RUN_TERMINAL_STATUS).some((v, _i, all) => all.indexOf(v) !== all.lastIndexOf(v)),
    "each lifecycle event maps to a DISTINCT terminal status",
  );
});

test("the delivery-graph phase poller's TERMINATED safety net agrees with the canonical edge", () => {
  assertEquals(deriveDeliveryPhase("TERMINATED", [], {}).status, RUN_TERMINAL_STATUS.outOfBandTerminate);
});

test("operator cancel folds the terminated edge to `cancelled`; nothing else is promoted", () => {
  for (const b of engineBackedBindings().filter((x) => isRun(x.table))) {
    const terminated = String(b.onTerminated?.set?.[b.statusField ?? "status"]);
    assertEquals(effectiveTerminalStatus(terminated, "2026-11-21T00:00:00Z"), RUN_TERMINAL_STATUS.operatorCancel, b.table);
    assertEquals(effectiveTerminalStatus(terminated, null), RUN_TERMINAL_STATUS.outOfBandTerminate, b.table);
  }
  // A cancellation record never relabels a real failure, a completion, or a live run.
  assertEquals(effectiveTerminalStatus(RUN_TERMINAL_STATUS.incidentFailure, "t"), RUN_TERMINAL_STATUS.incidentFailure);
  assertEquals(effectiveTerminalStatus("done", "t"), "done");
  assertEquals(effectiveTerminalStatus("running", "t"), "running");
});
