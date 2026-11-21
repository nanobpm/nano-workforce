// Unit coverage for the nwf workers view (issue #989, `d8ctl nwf workers list`).
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWorkersView, deployedJobTypes, isExternalJobType, taskDefinitionTypes } from "./workersView.ts";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const worker = (instance: string, live: boolean, serves: string[]) => ({
  instance,
  identity: "leaf",
  host: `${instance}-host`,
  live,
  lastSeen: NOW - 1000,
  staleMs: 1000,
  serves,
});

test("taskDefinitionTypes reads every declared job type once", () => {
  const xml = `<bpmn:serviceTask><zeebe:taskDefinition type="senior:feature"/></bpmn:serviceTask>
    <bpmn:serviceTask><zeebe:taskDefinition type="pr.finalize" retries="3"/></bpmn:serviceTask>
    <bpmn:serviceTask><zeebe:taskDefinition type="senior:feature"/></bpmn:serviceTask>`;
  assert.deepEqual(taskDefinitionTypes(xml), ["senior:feature", "pr.finalize"]);
});

test("the deployed corpus has both external agent and internal pr.* job types", () => {
  const types = deployedJobTypes();
  assert.ok(types.includes("senior:feature"));
  assert.ok(types.some((t) => t.startsWith("pr.") && !isExternalJobType(t)));
});

test("per job type: workers, queue depth, oldest waiting age, starved", () => {
  const view = buildWorkersView({
    jobTypes: ["senior:feature", "senior:retro", "pr.finalize"],
    jobs: [
      { type: "senior:feature", processInstanceKey: "1" },
      { type: "senior:feature", processInstanceKey: "2", worker: "w1" },
      { type: "senior:retro", processInstanceKey: "3" },
      { type: "pr.finalize", processInstanceKey: "4" },
    ],
    workers: [worker("w1", true, ["senior"]), worker("w2", false, ["other"])],
    firstSeen: new Map([["1:senior:feature", new Date(NOW - 60_000).toISOString()]]),
    now: NOW,
    includeInternal: false,
  });
  const feature = view.items.find((i) => i.jobType === "senior:feature");
  assert.equal(feature?.queueDepth, 1);
  assert.equal(feature?.inProgress, 1);
  assert.equal(feature?.oldestWaitingAgeMs, 60_000);
  assert.equal(feature?.starved, false);
  assert.deepEqual(
    feature?.workers.map((w) => [w.workerId, w.status, w.busy, w.transport]),
    [["w1", "live", true, "agentic-channel"]],
  );
  const retro = view.items.find((i) => i.jobType === "senior:retro");
  assert.equal(retro?.starved, false); // w1 serves the senior rank
  assert.equal(view.items.some((i) => i.jobType === "pr.finalize"), false);
  assert.equal(view.internal.total, 1);
  assert.equal(view.internal.stale, 0);
  assert.equal(view.internal.workers, undefined);
});

test("waiting jobs with no live worker are starved; internal=true lists internal workers", () => {
  const view = buildWorkersView({
    jobTypes: ["pr.finalize"],
    jobs: [
      { type: "senior:custom", processInstanceKey: "9" },
      { type: "pr.finalize", processInstanceKey: "4" },
    ],
    workers: [worker("w2", false, ["senior"])],
    firstSeen: new Map(),
    now: NOW,
    includeInternal: true,
  });
  const custom = view.items.find((i) => i.jobType === "senior:custom");
  assert.equal(custom?.starved, true);
  assert.equal(custom?.oldestWaitingAgeMs, null);
  assert.equal(custom?.workers[0]?.status, "stale");
  assert.deepEqual(view.internal.workers, [{ jobType: "pr.finalize", status: "live", queueDepth: 1, inProgress: 0 }]);
});
