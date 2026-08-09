// Unit tests for the epic retrospective stage (app/retro.ts, 016_plan_retro.sql).
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import { appendEntry } from "./blackboard.ts";
import { recordTaskDelta } from "./taskDelta.ts";
import {
  autoRetroEnabled,
  gatherRetro,
  isDigestEmpty,
  isPlanComplete,
  maybeStartRetro,
  planKeyForPr,
  recordRetro,
  renderRetroBrief,
} from "./retro.ts";

// In-memory record gateway matching the Table<T> subset retro.ts uses: insert/find/findOne/get/update.
// deno-lint-ignore no-explicit-any
function memData(): { data: DataLayer; stores: Record<string, any[]> } {
  // deno-lint-ignore no-explicit-any
  const stores: Record<string, any[]> = {};
  const seq: Record<string, number> = {};
  function tbl(name: string, pk = "id") {
    // deno-lint-ignore no-explicit-any
    const rows = (stores[name] ??= [] as any[]);
    // deno-lint-ignore no-explicit-any
    const match = (r: any, where: any) => Object.entries(where).every(([k, v]) => r[k] === v);
    return {
      // deno-lint-ignore no-explicit-any require-await
      async insert(row: any) {
        if (pk !== "id" && rows.some((r) => r[pk] === row[pk])) {
          throw new Error(`UNIQUE constraint failed: ${name}.${pk}`);
        }
        const id = (seq[name] = (seq[name] ?? 0) + 1);
        rows.push(pk === "id" ? { id, ...row } : { ...row });
        return pk === "id" ? id : row[pk];
      },
      // deno-lint-ignore no-explicit-any require-await
      async find(where: any = {}) {
        return rows.filter((r) => match(r, where));
      },
      // deno-lint-ignore no-explicit-any require-await
      async findOne(where: any = {}) {
        return rows.find((r) => match(r, where));
      },
      // deno-lint-ignore no-explicit-any require-await
      async get(id: any) {
        return rows.find((row) => row[pk] === id);
      },
      // deno-lint-ignore no-explicit-any require-await
      async update(id: any, patch: any) {
        const r = rows.find((row) => row[pk] === id);
        if (r) Object.assign(r, patch);
      },
    };
  }
  // deno-lint-ignore no-explicit-any
  const data = { table: (n: string, pk?: string) => tbl(n, pk) } as any as DataLayer;
  return { data, stores };
}

// A fake engine recording createInstance calls.
function fakeEngine(): { engine: EngineClient; started: { processDefinitionId: string; variables: Record<string, unknown> }[] } {
  const started: { processDefinitionId: string; variables: Record<string, unknown> }[] = [];
  // deno-lint-ignore no-explicit-any
  const engine = {
    // deno-lint-ignore no-explicit-any require-await
    async createInstance(req: any) {
      started.push({ processDefinitionId: req.processDefinitionId, variables: req.variables });
      return { processInstanceKey: `PI-${started.length}` };
    },
    // deno-lint-ignore no-explicit-any require-await
  } as any as EngineClient;
  return { engine, started };
}

const PLAN = "acme/widgets#7";

// deno-lint-ignore no-explicit-any
function seedPlan(stores: Record<string, any[]>, over: Record<string, unknown> = {}) {
  stores["plans"] = [{
    plan_key: PLAN,
    repo: "acme/widgets",
    issue_url: "https://github.com/acme/widgets/issues/7",
    title: "Widgets epic",
    status: "done",
    retro_started_at: null,
    ...over,
  }];
}

// deno-lint-ignore no-explicit-any
function seedTask(stores: Record<string, any[]>, task: Record<string, unknown>) {
  (stores["plan_tasks"] ??= []).push({ plan_key: PLAN, ...task });
}
// deno-lint-ignore no-explicit-any
function seedPr(stores: Record<string, any[]>, pr_key: string, status: string) {
  (stores["pull_requests"] ??= []).push({ pr_key, status });
}

Deno.test("autoRetroEnabled: on by default; disabled by 0/false/off/no", () => {
  const prev = process.env.NANO_AUTO_RETRO;
  try {
    delete process.env.NANO_AUTO_RETRO;
    assert(autoRetroEnabled());
    for (const v of ["0", "false", "off", "no", "FALSE"]) {
      process.env.NANO_AUTO_RETRO = v;
      assertEquals(autoRetroEnabled(), false, `"${v}" should disable`);
    }
    process.env.NANO_AUTO_RETRO = "1";
    assert(autoRetroEnabled());
  } finally {
    if (prev == null) delete process.env.NANO_AUTO_RETRO;
    else process.env.NANO_AUTO_RETRO = prev;
  }
});

Deno.test("planKeyForPr: resolves the plan a PR's task belongs to; undefined when unlinked", async () => {
  const { data, stores } = memData();
  seedTask(stores, { id: "t1", status: "opened", pr_key: "acme/widgets#10" });
  assertEquals(await planKeyForPr(data, "acme/widgets#10"), PLAN);
  assertEquals(await planKeyForPr(data, "acme/widgets#99"), undefined);
  assertEquals(await planKeyForPr(data, ""), undefined);
});

Deno.test("isPlanComplete: false while any task is still in flight", async () => {
  const { data, stores } = memData();
  seedTask(stores, { id: "t1", status: "opened", pr_key: "acme/widgets#10" });
  seedTask(stores, { id: "t2", status: "pending", pr_key: null });
  seedPr(stores, "acme/widgets#10", "merged");
  // t2 is pending with no PR → not done.
  assertEquals(await isPlanComplete(data, PLAN), false);
});

Deno.test("isPlanComplete: false when an opened task's PR is not yet terminal", async () => {
  const { data, stores } = memData();
  seedTask(stores, { id: "t1", status: "opened", pr_key: "acme/widgets#10" });
  seedPr(stores, "acme/widgets#10", "waiting_deps"); // in the merge stage, not terminal
  assertEquals(await isPlanComplete(data, PLAN), false);
});

Deno.test("isPlanComplete: true when every task is settled (terminal PR or skipped/blocked)", async () => {
  const { data, stores } = memData();
  seedTask(stores, { id: "t1", status: "opened", pr_key: "acme/widgets#10" });
  seedTask(stores, { id: "t2", status: "skipped", pr_key: null });
  seedTask(stores, { id: "t3", status: "opened", pr_key: "acme/widgets#11" });
  seedPr(stores, "acme/widgets#10", "merged");
  seedPr(stores, "acme/widgets#11", "converged");
  assertEquals(await isPlanComplete(data, PLAN), true);
});

Deno.test("isPlanComplete: an empty plan has nothing to retrospect", async () => {
  const { data } = memData();
  assertEquals(await isPlanComplete(data, PLAN), false);
});

Deno.test("gatherRetro: separates learnings from notes and folds in deltas", async () => {
  const { data, stores } = memData();
  seedPlan(stores);
  await appendEntry(data, PLAN, { author_task: "t1", kind: "learning", body: "regen the API surface before building" });
  await appendEntry(data, PLAN, { author_task: "t2", kind: "learning", body: "use nextest not cargo test" });
  await appendEntry(data, PLAN, { author_task: "t3", kind: "note", body: "just an FYI" });
  await recordTaskDelta(data, PLAN, "t1", {
    contractChange: "changed the envelope shape",
    newlyTouches: ["shared/env.ts"],
    affectsTasks: ["t2"],
    constraint: "envelope must carry results[]",
  });

  const d = await gatherRetro(data, PLAN);
  assertEquals(d.counts.learnings, 2);
  assertEquals(d.learnings.map((l) => l.author_task).sort(), ["t1", "t2"]);
  assertEquals(d.notes.length, 1);
  assertEquals(d.constraints.length, 1);
  assertEquals(d.contractChanges.length, 1);
  assert(d.touchedFiles.includes("shared/env.ts"));
  assertEquals(d.repo, "acme/widgets");
});

Deno.test("renderRetroBrief: renders learnings + constraints; states 'none' with no learnings", () => {
  const empty = renderRetroBrief({
    planKey: PLAN, repo: "acme/widgets", issueUrl: "", title: null,
    learnings: [], touchedFiles: [], contractChanges: [], constraints: [], notes: [],
    counts: { learnings: 0, deltas: 0, notes: 0 },
  });
  assertStringIncludes(empty, "none");

  const brief = renderRetroBrief({
    planKey: PLAN, repo: "acme/widgets", issueUrl: "https://x/7", title: "Epic",
    learnings: [{ author_task: "t1", body: "regen first", created_at: "now" }],
    touchedFiles: ["a.ts"],
    contractChanges: [{ taskId: "t1", change: "shape" }],
    constraints: [{ taskId: "t1", constraint: "must X" }],
    notes: [{ author_task: "t2", kind: "note", body: "watch the release lane" }],
    counts: { learnings: 1, deltas: 1, notes: 1 },
  });
  assertStringIncludes(brief, "regen first");
  assertStringIncludes(brief, "must X");
  assertStringIncludes(brief, "watch the release lane");
  assertStringIncludes(brief, "acme/widgets");
});

Deno.test("isDigestEmpty: true only when there are no learnings, deltas, or notes", () => {
  const base = { planKey: PLAN, repo: "", issueUrl: "", title: null, learnings: [], touchedFiles: [], contractChanges: [], constraints: [], notes: [] };
  assert(isDigestEmpty({ ...base, counts: { learnings: 0, deltas: 0, notes: 0 } }));
  assert(!isDigestEmpty({ ...base, counts: { learnings: 1, deltas: 0, notes: 0 } }));
  assert(!isDigestEmpty({ ...base, counts: { learnings: 0, deltas: 2, notes: 0 } }));
  assert(!isDigestEmpty({ ...base, counts: { learnings: 0, deltas: 0, notes: 1 } }));
});

Deno.test("recordRetro: inserts then updates the same plan_key row in place", async () => {
  const { data, stores } = memData();
  await recordRetro(data, PLAN, { status: "filed", prKey: "acme/widgets#20", learnings: 3, summary: "promoted 2" });
  assertEquals(stores["plan_retros"].length, 1);
  assertEquals(stores["plan_retros"][0].status, "filed");
  assertEquals(stores["plan_retros"][0].pr_key, "acme/widgets#20");

  await recordRetro(data, PLAN, { status: "skipped", summary: "nothing to promote" });
  assertEquals(stores["plan_retros"].length, 1, "same plan_key must not duplicate");
  assertEquals(stores["plan_retros"][0].status, "skipped");
  assertEquals(stores["plan_retros"][0].pr_key, null);
});

Deno.test("recordRetro: rethrows a non-unique (FOREIGN KEY) constraint error instead of swallowing it", async () => {
  // A FK failure (e.g. plan_key missing in plans) must NOT be treated as a benign duplicate and
  // fall through to a silent update — that would make the write look successful while doing nothing.
  let updated = false;
  const table = {
    // deno-lint-ignore require-await
    async insert() {
      throw new Error("FOREIGN KEY constraint failed");
    },
    // deno-lint-ignore require-await
    async update() {
      updated = true;
    },
    // deno-lint-ignore require-await
    async get() {
      return undefined;
    },
  };
  // deno-lint-ignore no-explicit-any
  const data = { table: () => table } as any as DataLayer;
  let threw = false;
  try {
    await recordRetro(data, PLAN, { status: "filed", prKey: "acme/widgets#20" });
  } catch (err) {
    threw = true;
    assertStringIncludes(String(err), "FOREIGN KEY");
  }
  assert(threw, "the FK error must propagate");
  assertEquals(updated, false, "must not silently fall back to update on a non-unique error");
});

Deno.test("maybeStartRetro: starts the retro exactly once when the last PR lands with material", async () => {
  const { data, stores } = memData();
  seedPlan(stores);
  seedTask(stores, { id: "t1", status: "opened", pr_key: "acme/widgets#10" });
  seedTask(stores, { id: "t2", status: "opened", pr_key: "acme/widgets#11" });
  seedPr(stores, "acme/widgets#10", "merged");
  seedPr(stores, "acme/widgets#11", "merged");
  await appendEntry(data, PLAN, { author_task: "t1", kind: "learning", body: "regen first" });
  const { engine, started } = fakeEngine();

  const r1 = await maybeStartRetro(data, engine, "acme/widgets#11");
  assertEquals(r1.started, true);
  assertEquals(r1.planKey, PLAN);
  assertEquals(started.length, 1);
  assertEquals(started[0].processDefinitionId, "retro");
  assertEquals(started[0].variables.planKey, PLAN);
  assert(stores["plans"][0].retro_started_at, "retro_started_at must be stamped");
  assertEquals(stores["plan_retro_starts"].length, 1);

  // A sibling terminal PR of the same plan must NOT start a second retro.
  const r2 = await maybeStartRetro(data, engine, "acme/widgets#10");
  assertEquals(r2.started, false);
  assertEquals(r2.reason, "already-started");
  assertEquals(started.length, 1, "fire-once guard");
});

Deno.test("maybeStartRetro: a createInstance failure records a blocked retro (fire-once guard already consumed)", async () => {
  const { data, stores } = memData();
  seedPlan(stores);
  seedTask(stores, { id: "t1", status: "opened", pr_key: "acme/widgets#10" });
  seedPr(stores, "acme/widgets#10", "merged");
  await appendEntry(data, PLAN, { author_task: "t1", kind: "learning", body: "regen first" });
  // deno-lint-ignore no-explicit-any require-await
  const engine = { async createInstance() { throw new Error("gateway down"); } } as any as EngineClient;

  const r = await maybeStartRetro(data, engine, "acme/widgets#10");
  assertEquals(r, { started: false, planKey: PLAN, reason: "start-failed" });
  // The guard is consumed (stamp + claim), so it will never retry...
  assert(stores["plans"][0].retro_started_at, "retro_started_at is stamped");
  assertEquals(stores["plan_retro_starts"].length, 1);
  // ...but the failure is now visible as a blocked retro rather than a silent gap.
  assertEquals(stores["plan_retros"].length, 1);
  assertEquals(stores["plan_retros"][0].status, "blocked");
  assertEquals(stores["plan_retros"][0].pr_key, null);
  assertStringIncludes(String(stores["plan_retros"][0].summary), "gateway down");
});

Deno.test("maybeStartRetro: a pre-claimed retro start does not start a duplicate process", async () => {
  const { data, stores } = memData();
  seedPlan(stores);
  seedTask(stores, { id: "t1", status: "opened", pr_key: "acme/widgets#10" });
  seedPr(stores, "acme/widgets#10", "merged");
  stores["plan_retro_starts"] = [{ plan_key: PLAN, started_at: "already" }];
  await appendEntry(data, PLAN, { author_task: "t1", kind: "learning", body: "regen first" });
  const { engine, started } = fakeEngine();

  const r = await maybeStartRetro(data, engine, "acme/widgets#10");
  assertEquals(r, { started: false, planKey: PLAN, reason: "already-started" });
  assertEquals(started.length, 0);
  assertEquals(stores["plans"][0].retro_started_at, null);
});

Deno.test("maybeStartRetro: bails while the plan is incomplete", async () => {
  const { data, stores } = memData();
  seedPlan(stores);
  seedTask(stores, { id: "t1", status: "opened", pr_key: "acme/widgets#10" });
  seedTask(stores, { id: "t2", status: "pending", pr_key: null });
  seedPr(stores, "acme/widgets#10", "merged");
  const { engine, started } = fakeEngine();

  const r = await maybeStartRetro(data, engine, "acme/widgets#10");
  assertEquals(r.started, false);
  assertEquals(r.reason, "incomplete");
  assertEquals(started.length, 0);
  assertEquals(stores["plans"][0].retro_started_at, null, "must not stamp an incomplete plan");
});

Deno.test("maybeStartRetro: complete but empty → records a skipped retro, does not start the process", async () => {
  const { data, stores } = memData();
  seedPlan(stores);
  seedTask(stores, { id: "t1", status: "opened", pr_key: "acme/widgets#10" });
  seedPr(stores, "acme/widgets#10", "merged");
  const { engine, started } = fakeEngine();

  const r = await maybeStartRetro(data, engine, "acme/widgets#10");
  assertEquals(r.started, false);
  assertEquals(r.reason, "nothing-to-retro");
  assertEquals(started.length, 0);
  assert(stores["plans"][0].retro_started_at, "stamped so we don't re-check forever");
  assertEquals(stores["plan_retros"][0].status, "skipped");
});

Deno.test("maybeStartRetro: a PR not part of any plan is a no-op", async () => {
  const { data } = memData();
  const { engine, started } = fakeEngine();
  const r = await maybeStartRetro(data, engine, "acme/widgets#99");
  assertEquals(r.started, false);
  assertEquals(r.reason, "no-plan");
  assertEquals(started.length, 0);
});

Deno.test("maybeStartRetro: honours NANO_AUTO_RETRO=0", async () => {
  const prev = process.env.NANO_AUTO_RETRO;
  process.env.NANO_AUTO_RETRO = "0";
  try {
    const { data, stores } = memData();
    seedPlan(stores);
    seedTask(stores, { id: "t1", status: "opened", pr_key: "acme/widgets#10" });
    seedPr(stores, "acme/widgets#10", "merged");
    await appendEntry(data, PLAN, { author_task: "t1", kind: "learning", body: "x" });
    const { engine, started } = fakeEngine();
    const r = await maybeStartRetro(data, engine, "acme/widgets#10");
    assertEquals(r.started, false);
    assertEquals(r.reason, "disabled");
    assertEquals(started.length, 0);
  } finally {
    if (prev == null) delete process.env.NANO_AUTO_RETRO;
    else process.env.NANO_AUTO_RETRO = prev;
  }
});
