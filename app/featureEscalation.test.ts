// Read-model derivation test for the FEATURE-run escalation reconcile (issue #210 — feature-run
// escalations were invisible in the nwf UI). When a feature run escalates it parks on the native
// `feature-escalation` user task; `feature_runs` (which the pages read) stayed `running` with
// nothing to show. Two collaborators fix that: the `record-feature-escalation` service task persists
// the `status`-flip's companion `question` at escalation entry (it can read the process variable
// while it is still in scope), and `deriveFeatureEscalationPatch` — the pure source of truth tested
// here — reconciles the run's LIVENESS (status + completable-task pointer) that `pollFeatureEscalations`
// projects onto the row. The poller never touches `escalation_question`, so it can never clobber the
// service task's write during the self-healing window before the user task is observable.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import { deriveFeatureEscalationPatch } from "./feature.ts";
import { pollFeatureEscalations } from "./service.ts";

// biome-ignore lint/suspicious/noExplicitAny: tiny in-memory table double, mirrors featureDelivery.test.ts
function memData(): { data: DataLayer; stores: Record<string, any[]> } {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const stores: Record<string, any[]> = {};
  function tbl(name: string, pk = "id") {
    // biome-ignore lint/suspicious/noExplicitAny: see above
    const rows = (stores[name] ??= [] as any[]);
    // biome-ignore lint/suspicious/noExplicitAny: see above
    const match = (r: any, where: any) => Object.entries(where).every(([k, v]) => r[k] === v);
    return {
      async all() {
        return rows.slice();
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async get(id: any) {
        return rows.find((r) => r[pk] === id);
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async find(where: any = {}) {
        return rows.filter((r) => match(r, where));
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async insert(row: any) {
        rows.push({ ...row });
        return row[pk];
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async update(id: any, patch: any) {
        const r = rows.find((row) => row[pk] === id);
        if (r) Object.assign(r, patch);
      },
    };
  }
  const data = { table: (n: string, pk?: string) => tbl(n, pk) } as unknown as DataLayer;
  return { data, stores };
}

/** A fake engine whose open user tasks are keyed by processInstanceKey (the only field
 *  pollFeatureEscalations queries on). */
function fakeEngine(byInstance: Record<string, { userTaskKey: string; elementId?: string }[]>): EngineClient {
  return {
    searchUserTasks: (filter?: { processInstanceKey?: string }) =>
      Promise.resolve(filter?.processInstanceKey ? (byInstance[filter.processInstanceKey] ?? []) : []),
  } as unknown as EngineClient;
}

test("deriveFeatureEscalationPatch: a running run parked at feature-escalation flips to escalated + records the key", () => {
  const patch = deriveFeatureEscalationPatch(
    { status: "running", escalation_user_task_key: null },
    { userTaskKey: "ut-9" },
  );
  assertEquals(patch, { status: "escalated", escalation_user_task_key: "ut-9" });
});

test("deriveFeatureEscalationPatch: an already-escalated run with the key recorded yields no patch (idempotent)", () => {
  const patch = deriveFeatureEscalationPatch(
    { status: "escalated", escalation_user_task_key: "ut-9" },
    { userTaskKey: "ut-9" },
  );
  assertEquals(patch, null);
});

test("deriveFeatureEscalationPatch: an escalated run that un-parked resumes to running, pointer + question cleared", () => {
  const patch = deriveFeatureEscalationPatch({ status: "escalated", escalation_user_task_key: "ut-9" }, null);
  assertEquals(patch, { status: "running", escalation_user_task_key: null, escalation_question: null });
});

test("deriveFeatureEscalationPatch: a run past escalated with a stale pointer clears the pointer + question", () => {
  const patch = deriveFeatureEscalationPatch({ status: "awaiting_operator", escalation_user_task_key: "ut-9" }, null);
  assertEquals(patch, { escalation_user_task_key: null, escalation_question: null });
});

// Self-heal: a task completed out-of-band (external UI, bypassing the answer operation) leaves the
// run un-parked but with the pointer still recording the observed task. The poller clears BOTH the
// pointer and the now-stale question so the UI stops surfacing an Escalation on a resumed run.
test("deriveFeatureEscalationPatch: un-park after an out-of-band completion clears the stale question", () => {
  const patch = deriveFeatureEscalationPatch({ status: "escalated", escalation_user_task_key: "ut-9" }, null);
  assertEquals(patch?.escalation_question, null);
});

// The pre-observation self-healing window (record-feature-escalation has persisted the question but
// the task is not yet visible, so the pointer is still NULL): a premature "not parked" pass must NOT
// clobber the freshly-persisted question — only reset the transient status, re-flipped next pass.
test("deriveFeatureEscalationPatch: the pre-observation self-healing window never clears the question", () => {
  const patch = deriveFeatureEscalationPatch({ status: "escalated", escalation_user_task_key: null }, null);
  assertEquals(patch, { status: "running" });
});

test("deriveFeatureEscalationPatch: a clean running run not parked yields no patch", () => {
  const patch = deriveFeatureEscalationPatch({ status: "running", escalation_user_task_key: null }, null);
  assertEquals(patch, null);
});

test("pollFeatureEscalations: a parked run is flipped to escalated with the completable key (question left to the service task)", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#1", status: "running", process_key: "100", escalation_question: null, escalation_user_task_key: null },
  ];
  const engine = fakeEngine({ "100": [{ userTaskKey: "ut-1", elementId: "feature-escalation" }] });

  await pollFeatureEscalations(data, engine);

  assertEquals(stores.feature_runs[0].status, "escalated");
  assertEquals(stores.feature_runs[0].escalation_user_task_key, "ut-1");
  // The poller does not synthesise the question — that is the record-feature-escalation service task's.
  assertEquals(stores.feature_runs[0].escalation_question, null);
});

test("pollFeatureEscalations: an escalated run whose task is gone resumes to running, clears the pointer + stale question", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#2", status: "escalated", process_key: "200", escalation_question: "Q", escalation_user_task_key: "ut-2" },
  ];
  const engine = fakeEngine({ "200": [] });

  await pollFeatureEscalations(data, engine);

  assertEquals(stores.feature_runs[0].status, "running");
  assertEquals(stores.feature_runs[0].escalation_user_task_key, null);
  // The observed task is gone → self-heal the now-stale question so the UI stops surfacing it.
  assertEquals(stores.feature_runs[0].escalation_question, null);
});

test("pollFeatureEscalations: a re-observed parked run keeps its persisted question, only filling the key", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#3", status: "escalated", process_key: "300", escalation_question: "kept", escalation_user_task_key: null },
  ];
  const engine = fakeEngine({ "300": [{ userTaskKey: "ut-3", elementId: "feature-escalation" }] });

  await pollFeatureEscalations(data, engine);

  assertEquals(stores.feature_runs[0].status, "escalated");
  assertEquals(stores.feature_runs[0].escalation_user_task_key, "ut-3");
  assertEquals(stores.feature_runs[0].escalation_question, "kept");
});

test("pollFeatureEscalations: only touches running/escalated runs, and never one without a process_key", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#4", status: "opened", process_key: "400", escalation_question: null, escalation_user_task_key: null },
    { feature_key: "o/r#5", status: "running", process_key: null, escalation_question: null, escalation_user_task_key: null },
  ];
  const engine = fakeEngine({ "400": [{ userTaskKey: "ut-4", elementId: "feature-escalation" }] });

  await pollFeatureEscalations(data, engine);

  // opened is terminal → not a candidate; running with no process_key → skipped.
  assertEquals(stores.feature_runs[0].status, "opened");
  assertEquals(stores.feature_runs[0].escalation_user_task_key, null);
  assertEquals(stores.feature_runs[1].status, "running");
});

test("pollFeatureEscalations: a parked non-escalation task (feature-blocked) does not flip the run", async () => {
  const { data, stores } = memData();
  stores.feature_runs = [
    { feature_key: "o/r#6", status: "running", process_key: "600", escalation_question: null, escalation_user_task_key: null },
  ];
  const engine = fakeEngine({ "600": [{ userTaskKey: "ut-6", elementId: "feature-blocked" }] });

  await pollFeatureEscalations(data, engine);

  assertEquals(stores.feature_runs[0].status, "running");
  assertEquals(stores.feature_runs[0].escalation_user_task_key, null);
});
