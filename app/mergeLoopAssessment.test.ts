// Engine-backed coverage for the "Needs a closer look" human assessment on the merge loop (issue
// #1037). Deploys the committed merge-loop into the real WASM engine and binds `pr.merge` to the REAL
// worker (`workers/merge/worker.ts`, GitHub readers stubbed), so the closer-look verdict is driven
// through the BPMN rather than a canned `{ mergeStatus }` responder. Asserts the observable invariant
// the issue promises: exactly ONE escalation, no further merge attempt while it is unanswered (even
// as the poller keeps signalling merge-ready and the merge timers fire), a machine answer never lands
// the head, and a human-attributed accept lands it.
import { after, test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { readFileSync } from "node:fs";
import { assertThatInstance, byProcessId, createWasmEngineClient, type WasmEngineClient } from "@nanobpm/urban-testkit";
import { makeHandler } from "../workers/merge/worker.ts";
import { completeUserTaskAttributed } from "./agentCompletion.ts";
import { _clearMergeProtocolCache } from "./mergeProtocol.ts";
import { noopLog } from "../test/log.ts";

const MODEL = readFileSync("resources/processes/merge-loop.bpmn", "utf8");
const HEAD = "68de21c0aaaabbbbccccddddeeeeffff00001111";
const CLOSER_LOOK =
  "## Pull request overview\n\n### 🔵 Needs a closer look\n\nHuman assessment is needed for probe exhaustion.\n\n<details><summary>No open issues</summary>\n</details>";
const THIRTY_MIN = 30 * 60 * 1000;

const VARS: Record<string, unknown> = {
  prKey: "acme/app#1",
  repo: "acme/app",
  prNumber: 1,
  prUrl: "https://github.com/acme/app/pull/1",
  ciFixMax: 3,
  rebaseMax: 3,
  mergeRetryMax: 3,
  ciFixRound: 0,
  rebaseRound: 0,
  mergeRetryRound: 0,
  agentSlaTimeout: "PT30M",
  landedWaitTimeout: "PT30M",
  mergeableWaitTimeout: "PT30M",
  mergeableRepollInterval: "PT2M",
  mergeStallRounds: 0,
  mergeStallMax: 3,
  reviewRequestRound: 0,
  reviewRequestMax: 3,
  reviewRequestWait: "PT10M",
  reviewRequest: null,
  reviewHead: null,
  abandonBrief: "",
  failingChecksList: null,
  status: null,
  mergeState: null,
  mergeStatus: null,
  ciBlockedReconciled: null,
  failingChecks: 0,
  reviewThreads: null,
  pendingChecks: null,
  round: 2,
  abandonUrl: null,
};

/** A minimal in-memory DataLayer: AUTOINCREMENT ids, structural find, get, update, delete. */
function memData() {
  const stores: Record<string, Record<string, unknown>[]> = {};
  const table = (name: string, key: string) => {
    const store = (stores[name] ??= []);
    return {
      get: (k: unknown) => Promise.resolve(store.find((r) => r[key] === k) ?? null),
      all: () => Promise.resolve([...store]),
      find: (q: Record<string, unknown>) => Promise.resolve(store.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
      findOne: (q: Record<string, unknown>) =>
        Promise.resolve(store.find((r) => Object.entries(q).every(([f, v]) => r[f] === v)) ?? null),
      insert: (row: Record<string, unknown>) => {
        const id = store.length + 1;
        store.push({ id, ...row });
        return Promise.resolve(id);
      },
      update: (k: unknown, patch: Record<string, unknown>) => {
        const row = store.find((r) => r[key] === k);
        if (row) Object.assign(row, patch);
        return Promise.resolve(row);
      },
      delete: (k: unknown) => {
        const i = store.findIndex((r) => r[key] === k);
        if (i >= 0) store.splice(i, 1);
        return Promise.resolve();
      },
    };
  };
  return { data: { table } as any, stores };
}

const engines: WasmEngineClient[] = [];
after(async () => {
  await Promise.all(engines.map((e) => e.close()));
});

async function boot() {
  const { data, stores } = memData();
  const engine = await createWasmEngineClient();
  engines.push(engine);
  (engine as unknown as { engine: WasmEngineClient }).engine = engine;
  await engine.deployResources([{ name: "merge-loop.bpmn", content: MODEL, contentType: "text/xml" }]);
  const counts = { merge: 0, escalations: 0, landed: 0 };
  const merge = makeHandler({
    readReview: async () => ({ body: CLOSER_LOOK, commitId: HEAD }),
    readHeadSha: async () => HEAD,
    readThreads: async () => [],
    readComments: async () => [],
  });
  const app = { data, log: noopLog(), engine: {} } as any;
  await engine.registerWorker("pr.merge", async (job) => {
    counts.merge += 1;
    return (await merge(job as any, app)) as Record<string, unknown>;
  });
  await engine.registerWorker("pr.persist-escalation", () => {
    counts.escalations += 1;
    return { escalated: true };
  });
  await engine.registerWorker("pr.mark-merged", () => {
    counts.landed += 1;
    return {};
  });
  for (const t of ["pr.arm-merge", "pr.record-dependency", "pr.answer-escalation", "pr.reconverge"]) {
    await engine.registerWorker(t, () => ({}));
  }
  await engine.registerWorker("pr.landed-probe", () => ({ landedVerdict: "waiting" }));
  await engine.registerWorker("pr.request-review", () => ({ reviewRequest: "requested" }));
  await engine.registerWorker("pr.merge-stall-probe", () => ({ mergeState: "ready" }));
  await engine.createInstance({ processDefinitionId: "merge-loop", awaitCompletion: false, variables: VARS });
  return { engine, data, stores, counts };
}

async function withGithub(run: (calls: { url: string; method: string }[]) => Promise<void>): Promise<void> {
  const prev = { t: process.env.NANO_PR_GITHUB_TRANSPORT, k: process.env.GITHUB_TOKEN, f: globalThis.fetch };
  const calls: { url: string; method: string }[] = [];
  process.env.NANO_PR_GITHUB_TRANSPORT = "token";
  process.env.GITHUB_TOKEN = "test-token";
  _clearMergeProtocolCache();
  // biome-ignore lint/plugin: test stub for the fetch boundary
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    if (/\/pulls\/\d+\/merge$/.test(url)) return new Response(JSON.stringify({ merged: true }), { status: 200 });
    if (/\/pulls\/\d+$/.test(url)) return new Response(JSON.stringify({ merged: false, mergeable_state: "clean", head: { sha: HEAD } }));
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    if (prev.t === undefined) delete process.env.NANO_PR_GITHUB_TRANSPORT;
    else process.env.NANO_PR_GITHUB_TRANSPORT = prev.t;
    if (prev.k === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prev.k;
    globalThis.fetch = prev.f;
    _clearMergeProtocolCache();
  }
}

const landed = (calls: { url: string; method: string }[]) => calls.some((c) => /\/pulls\/\d+\/merge$/.test(c.url) && c.method === "PUT");

async function openAnswerTask(engine: WasmEngineClient): Promise<{ userTaskKey: string; processInstanceKey: string }> {
  const tasks = await engine.openUserTasks({});
  const t = tasks.find((x) => x.elementId === "wait-merge-answer");
  assert(t, "expected an open wait-merge-answer user task");
  return { userTaskKey: t.userTaskKey, processInstanceKey: String(t.processInstanceKey ?? "") };
}

/** Drive the closer-look verdict to its park, then keep the poller signalling + timers firing. */
async function parkOnAssessment(engine: WasmEngineClient) {
  await engine.publishMessage({ name: "deps-cleared", correlationKey: "acme/app#1" });
  await engine.publishMessage({ name: "merge-ready", correlationKey: "acme/app#1", variables: { mergeState: "ready" } });
  for (let i = 0; i < 3; i++) {
    await engine.publishMessage({ name: "merge-ready", correlationKey: "acme/app#1", variables: { mergeState: "ready" } });
    await engine.advanceTime(THIRTY_MIN + 1);
  }
}

test("closer-look verdict through the merge-loop: ONE escalation, no further attempts until a HUMAN accepts (#1037)", async () => {
  await withGithub(async (calls) => {
    const { engine, data, counts } = await boot();
    await parkOnAssessment(engine);
    assertEquals(counts.merge, 1, "exactly one pr.merge attempt while the assessment is unanswered");
    assertEquals(counts.escalations, 1, "exactly one escalation");
    assertEquals(landed(calls), false);

    // A human accepts through the attributed door → the re-armed attempt lands that head.
    const task = await openAnswerTask(engine);
    await completeUserTaskAttributed(data, engine, { ...task, elementId: "wait-merge-answer", variables: { answer: "accept" } }, { kind: "human", id: "jwulf" });
    await engine.publishMessage({ name: "merge-ready", correlationKey: "acme/app#1", variables: { mergeState: "ready" } });
    assertEquals(counts.merge, 2);
    assertEquals(counts.escalations, 1, "accepting never re-escalates");
    assertEquals(landed(calls), true);
    assertThatInstance(engine, byProcessId("merge-loop")).hasCompleted().hasNoIncident().hasCompletedElements("mark-merged");
  });
});

test("closer-look verdict through the merge-loop: an AGENT accept never lands the head (#1037)", async () => {
  await withGithub(async (calls) => {
    const { engine, data, counts } = await boot();
    await parkOnAssessment(engine);
    const task = await openAnswerTask(engine);
    await completeUserTaskAttributed(data, engine, { ...task, elementId: "wait-merge-answer", variables: { answer: "accept" } }, { kind: "agent", id: "steward" });
    await engine.publishMessage({ name: "merge-ready", correlationKey: "acme/app#1", variables: { mergeState: "ready" } });
    assertEquals(counts.merge, 2);
    assertEquals(landed(calls), false, "a machine answer is not a human assessment");
    assertEquals(counts.escalations, 2, "the head re-parks on the human assessment");
    await openAnswerTask(engine);
  });
});
