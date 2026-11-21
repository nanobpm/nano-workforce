// Unit coverage for the nwf workers view (issue #989, `d8ctl nwf workers list`).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildWorkersView,
  collectCreatedJobs,
  deployedJobTypes,
  isExternalJobType,
  registeredWorkerTypes,
  taskDefinitionTypes,
  type WorkersViewJob,
} from "./workersView.ts";

const INTERNAL = ["pr.finalize"];

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

test("the deployed corpus has both external agent and internal (registered-worker) job types", () => {
  const types = deployedJobTypes();
  const internal = new Set(registeredWorkerTypes());
  assert.ok(types.includes("senior:feature"));
  assert.ok(isExternalJobType("senior:feature", internal));
  assert.ok(types.some((t) => t.startsWith("pr.") && !isExternalJobType(t, internal)));
});

test("internal = registered worker task types: an arbitrary non-colon delivery-graph type (`j`) stays EXTERNAL and visible", () => {
  const internal = new Set(registeredWorkerTypes());
  assert.ok(internal.has("pr.finalize"));
  assert.equal(isExternalJobType("j", internal), true);
  const view = buildWorkersView({
    jobTypes: [],
    internalTypes: [...internal],
    jobs: [{ type: "j", processInstanceKey: "7", jobKey: "70" }],
    workers: [],
    firstSeen: new Map(),
    now: NOW,
    includeInternal: false,
  });
  const j = view.items.find((i) => i.jobType === "j");
  assert.equal(j?.queueDepth, 1);
  assert.equal(j?.starved, true);
});

test("age: a ledger row tracking a PRIOR attempt's job key is not applied to the retry (unknown age)", () => {
  const view = buildWorkersView({
    jobTypes: ["senior:feature"],
    internalTypes: INTERNAL,
    jobs: [{ type: "senior:feature", processInstanceKey: "1", jobKey: "new" }],
    workers: [],
    firstSeen: new Map([["1:senior:feature", { jobKey: "old", firstSeenAt: new Date(NOW - 60_000).toISOString() }]]),
    now: NOW,
    includeInternal: false,
  });
  assert.equal(view.items[0]?.oldestWaitingAgeMs, null);
});

test("supply unavailable (no presence channel): starved is null, never a false `no workers` claim", () => {
  const view = buildWorkersView({
    jobTypes: ["senior:feature"],
    internalTypes: INTERNAL,
    jobs: [{ type: "senior:feature", processInstanceKey: "1", jobKey: "1" }],
    workers: null,
    firstSeen: new Map(),
    now: NOW,
    includeInternal: false,
  });
  assert.equal(view.supplyVisible, false);
  assert.equal(view.items[0]?.starved, null);
  assert.equal(view.items[0]?.queueDepth, 1);
});

test("a type with a leased job is being served, so it is not starved even with no visible worker", () => {
  const view = buildWorkersView({
    jobTypes: ["senior:feature"],
    internalTypes: INTERNAL,
    jobs: [
      { type: "senior:feature", processInstanceKey: "1", jobKey: "1" },
      { type: "senior:feature", processInstanceKey: "2", jobKey: "2", worker: "off-channel" },
    ],
    workers: [],
    firstSeen: new Map(),
    now: NOW,
    includeInternal: false,
  });
  assert.equal(view.items[0]?.starved, false);
});

test("collectCreatedJobs searches each type separately (one busy type cannot crowd others off a page) and discovers undeclared types", async () => {
  const PAGE = 2;
  const db: WorkersViewJob[] = [
    ...[1, 2, 3, 4].map((n) => ({ type: "senior:busy", processInstanceKey: `${n}` })),
    { type: "senior:quiet", processInstanceKey: "9" },
  ];
  const calls: (string | undefined)[] = [];
  const jobs = await collectCreatedJobs(async (f) => {
    calls.push(f.type);
    return db.filter((j) => f.type === undefined || j.type === f.type).slice(0, PAGE);
  }, ["senior:quiet"]);
  assert.ok(jobs.some((j) => j.type === "senior:quiet"));
  assert.ok(calls.includes("senior:quiet"));
});

test("collectCreatedJobs propagates a search failure (never an empty queue)", async () => {
  await assert.rejects(collectCreatedJobs(async () => { throw new Error("engine down"); }, ["senior:feature"]), /engine down/);
});

test("per job type: workers, queue depth, oldest waiting age, starved", () => {
  const view = buildWorkersView({
    jobTypes: ["senior:feature", "senior:retro", "pr.finalize"],
    internalTypes: INTERNAL,
    jobs: [
      { type: "senior:feature", processInstanceKey: "1", jobKey: "11" },
      { type: "senior:feature", processInstanceKey: "2", worker: "w1" },
      { type: "senior:retro", processInstanceKey: "3" },
      { type: "pr.finalize", processInstanceKey: "4" },
    ],
    workers: [worker("w1", true, ["senior"]), worker("w2", false, ["other"])],
    firstSeen: new Map([["1:senior:feature", { jobKey: "11", firstSeenAt: new Date(NOW - 60_000).toISOString() }]]),
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
    internalTypes: INTERNAL,
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
