// Unit tests for the H6 correlation family module (ADR 0056, #149).
//
// The family installs the correlation-registry singleton on mount and clears it on teardown — the seam
// through which the supply report (H5) and cockpit read a worker's process instance / plan. Unlike
// presence/relay it owns no channel message family, so these tests exercise the mount/teardown
// lifecycle and the singleton it manages, driven with a minimal AgenticContext.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { currentCorrelation } from "../correlation.ts";
import type { AgenticContext } from "../registry.ts";
import { noopLog } from "../../../test/log.ts";
import { CORRELATION_FAMILY, family } from "./correlation.family.ts";

function ctx(): AgenticContext {
  return {
    hub: undefined as never,
    registry: undefined as never,
    transport: undefined as never,
    data: undefined,
    log: noopLog(),
  };
}

test("the correlation family declares its stable name", () => {
  assertEquals(family.name, CORRELATION_FAMILY);
  assertEquals(family.name, "correlation");
});

test("mount installs a fresh correlation registry singleton; teardown clears it", () => {
  assertEquals(currentCorrelation(), undefined);
  family.mount(ctx());
  const reg = currentCorrelation();
  assert(reg !== undefined, "mount installs the singleton");
  reg.link("wk-a", "6494", { planKey: "o/r#142" });
  assertEquals(reg.count(), 1);
  family.teardown?.();
  assertEquals(currentCorrelation(), undefined);
});

test("re-mount installs a fresh (empty) registry, not the torn-down one", () => {
  family.mount(ctx());
  currentCorrelation()?.link("wk-a", "1");
  family.teardown?.();
  family.mount(ctx());
  assertEquals(currentCorrelation()?.count(), 0);
  family.teardown?.();
});
