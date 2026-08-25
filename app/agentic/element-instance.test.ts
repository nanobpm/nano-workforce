// Acceptance test for the #544 element-instance resolver (app/agentic/element-instance.ts).
//
// The load-bearing case is the one the issue names: correlation must resolve the CORRECT element
// instance across a RETRIED / LOOPING job — where the same static BPMN `elementId` occupies several
// distinct element instances, each with its own jobKey. Keying on `elementId` would be ambiguous;
// keying on `jobKey` (engine-unique per activation) is not. These tests drive the resolver against a
// fake wait-state reader and assert each jobKey resolves to its own occupancy's `elementInstanceKey`.
import { test } from "node:test";
import type { ElementInstanceWaitState, ElementInstanceWaitStateFilter } from "@nanobpm/urban";
import { assertEquals } from "#test-assert";
import {
  type ElementInstanceWaitStateReader,
  resolveElementInstanceKey,
} from "./element-instance.ts";

/** A fake engine wait-state read model: returns the configured parks, honouring the filter. */
function fakeReader(
  parks: readonly ElementInstanceWaitState[],
): ElementInstanceWaitStateReader & { calls: ElementInstanceWaitStateFilter[] } {
  const calls: ElementInstanceWaitStateFilter[] = [];
  return {
    calls,
    searchElementInstanceWaitStates: (filter: ElementInstanceWaitStateFilter = {}) => {
      calls.push(filter);
      const matched = parks.filter((p) => {
        if (filter.waitStateType !== undefined && p.waitStateType !== filter.waitStateType) return false;
        if (filter.processInstanceKey !== undefined && p.processInstanceKey !== filter.processInstanceKey) {
          return false;
        }
        if (filter.elementId !== undefined && p.elementId !== filter.elementId) return false;
        return true;
      });
      return Promise.resolve(matched);
    },
  };
}

/** Build a JOB wait-state park (a service task awaiting a worker). */
function jobPark(over: {
  elementInstanceKey: string;
  jobKey: string;
  processInstanceKey?: string;
  elementId?: string;
}): ElementInstanceWaitState {
  return {
    elementInstanceKey: over.elementInstanceKey,
    processInstanceKey: over.processInstanceKey ?? "pi-1",
    elementId: over.elementId ?? "agent",
    waitStateType: "JOB",
    jobType: "senior:feature",
    jobKey: over.jobKey,
  };
}

test("resolves the element instance whose JOB park carries the matching jobKey", async () => {
  const reader = fakeReader([jobPark({ elementInstanceKey: "ei-100", jobKey: "job-abc" })]);
  assertEquals(await resolveElementInstanceKey(reader, "job-abc"), "ei-100");
});

test("looping/retried job: same elementId across iterations resolves each jobKey to its own instance", async () => {
  // Three live parks for the SAME static element `agent` in the SAME process instance — the shape a
  // retried / looping activity produces: distinct element instances, distinct jobKeys, one elementId.
  const reader = fakeReader([
    jobPark({ elementInstanceKey: "ei-1", jobKey: "job-iter-1", elementId: "agent" }),
    jobPark({ elementInstanceKey: "ei-2", jobKey: "job-iter-2", elementId: "agent" }),
    jobPark({ elementInstanceKey: "ei-3", jobKey: "job-iter-3", elementId: "agent" }),
  ]);

  // Keying on elementId would be ambiguous (all three share `agent`); keying on jobKey is exact.
  assertEquals(await resolveElementInstanceKey(reader, "job-iter-1"), "ei-1");
  assertEquals(await resolveElementInstanceKey(reader, "job-iter-2"), "ei-2");
  assertEquals(await resolveElementInstanceKey(reader, "job-iter-3"), "ei-3");
});

test("scopes the engine search to JOB parks, and to the process instance when known", async () => {
  const reader = fakeReader([
    jobPark({ elementInstanceKey: "ei-a", jobKey: "job-a", processInstanceKey: "pi-1" }),
    jobPark({ elementInstanceKey: "ei-b", jobKey: "job-b", processInstanceKey: "pi-2" }),
  ]);
  assertEquals(await resolveElementInstanceKey(reader, "job-b", { processInstanceKey: "pi-2" }), "ei-b");
  assertEquals(reader.calls.length, 1);
  assertEquals(reader.calls[0].waitStateType, "JOB");
  assertEquals(reader.calls[0].processInstanceKey, "pi-2");
});

test("unscoped resolution still matches on jobKey across process instances", async () => {
  const reader = fakeReader([
    jobPark({ elementInstanceKey: "ei-a", jobKey: "job-a", processInstanceKey: "pi-1" }),
    jobPark({ elementInstanceKey: "ei-b", jobKey: "job-b", processInstanceKey: "pi-2" }),
  ]);
  assertEquals(await resolveElementInstanceKey(reader, "job-b"), "ei-b");
  assertEquals(reader.calls[0].processInstanceKey, undefined);
});

test("returns undefined when the job is not parked (completed / released) or jobKey is empty", async () => {
  const reader = fakeReader([jobPark({ elementInstanceKey: "ei-1", jobKey: "job-live" })]);
  assertEquals(await resolveElementInstanceKey(reader, "job-gone"), undefined);
  assertEquals(await resolveElementInstanceKey(reader, ""), undefined);
});

test("ignores a non-JOB park that happens to share the process instance", async () => {
  const parks: ElementInstanceWaitState[] = [
    { elementInstanceKey: "ei-msg", processInstanceKey: "pi-1", elementId: "wait", waitStateType: "MESSAGE", messageName: "m" },
    jobPark({ elementInstanceKey: "ei-job", jobKey: "job-x", processInstanceKey: "pi-1" }),
  ];
  // Even if the engine ignored the JOB filter, only the JOB park's jobKey can match.
  const reader: ElementInstanceWaitStateReader = {
    searchElementInstanceWaitStates: () => Promise.resolve(parks),
  };
  assertEquals(await resolveElementInstanceKey(reader, "job-x"), "ei-job");
});
