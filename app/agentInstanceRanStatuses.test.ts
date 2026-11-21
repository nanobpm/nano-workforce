// Contract test (#988): the agent-instance status vocabulary nwf accepts as "the agent ran" vs. the
// statuses the worker plugin (c8ctl-plugin-nano) actually emits. The husk classifier silently broke
// when plugin #318 started leaving a finished instance `IDLE` instead of `COMPLETED`; pinning the
// vocabulary here makes the NEXT lifecycle change fail CI instead of mass-escalating false husks.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import {
  AGENT_INSTANCE_IN_FLIGHT_STATUSES,
  AGENT_INSTANCE_SETTLED_STATUSES,
  agentInstanceRan,
} from "./roundProgress.ts";

/** Statuses c8ctl-plugin-nano (>= v1.74.0, PR #318) drives an AgentInstance through. A finished job
 * ends at `IDLE`; the engine moves it to `COMPLETED` on process end. Update this list — and the
 * classifier — together when the plugin lifecycle changes. */
const PLUGIN_EMITTED_STATUSES = {
  inFlight: ["INITIALIZING", "THINKING", "TOOL_CALLING"],
  finished: ["IDLE", "COMPLETED", "FAILED", "TERMINATED"],
};

test("every plugin-emitted status is classified (no unknown vocabulary)", () => {
  for (const s of [...PLUGIN_EMITTED_STATUSES.inFlight, ...PLUGIN_EMITTED_STATUSES.finished]) {
    assert(
      AGENT_INSTANCE_SETTLED_STATUSES.includes(s) || AGENT_INSTANCE_IN_FLIGHT_STATUSES.includes(s),
      `plugin status ${s} is not in nwf's agent-instance vocabulary`,
    );
  }
});

test("a finished plugin status reads as 'the agent ran'; an in-flight one reads as a husk", () => {
  for (const s of PLUGIN_EMITTED_STATUSES.finished) assertEquals(agentInstanceRan({ status: s }), true, s);
  for (const s of PLUGIN_EMITTED_STATUSES.inFlight) assertEquals(agentInstanceRan({ status: s }), false, s);
});

test("status matching is case-insensitive and a completionDate always counts", () => {
  assertEquals(agentInstanceRan({ status: "idle" }), true);
  assertEquals(agentInstanceRan({ status: "completed" }), true);
  assertEquals(agentInstanceRan({ status: "THINKING", completionDate: "2026-11-21T00:00:00Z" }), true);
  assertEquals(agentInstanceRan({ status: "" }), false);
  assertEquals(agentInstanceRan({ status: null }), false);
});

test("an IDLE instance that never called the model is still a husk", () => {
  assertEquals(agentInstanceRan({ status: "IDLE", metrics: { modelCalls: 0 } }), false);
  assertEquals(agentInstanceRan({ status: "IDLE", metrics: { modelCalls: 2 } }), true);
});
