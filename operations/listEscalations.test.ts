// Tests for GET /app/api/escalations operation `listEscalations` (epic #664, issue #666).
//
// The read tool that lists EVERY open native user-task escalation with its completable `userTaskKey`,
// so a tool-aware agent discovers keys on-tool instead of curling the un-projected `/tasks/api/tasks`
// inbox. It projects the ONE `user_tasks` read model (the same surface the Tasks inbox / Convergence
// page consume) via the pure `toEscalationView` derivation — no second source of truth.
//
// The headline round-trip test proves the acceptance criterion: an open escalation is listed by
// `listEscalations` with the EXACT `userTaskKey` that `completeUserTask` then resolves.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { noopLog } from "../test/log.ts";
import completeHandler from "./completeUserTask.ts";
import listHandler from "./listEscalations.ts";

// biome-ignore lint/suspicious/noExplicitAny: in-memory doubles, mirrors sibling op tests
function memApp(
  seedUserTasks: Record<string, unknown>[],
  openTasks: { userTaskKey: string; elementId?: string }[],
): {
  app: AppApi;
  // biome-ignore lint/suspicious/noExplicitAny: see above
  stores: Record<string, any[]>;
  completed: { userTaskKey: string; variables: Record<string, unknown> }[];
} {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const stores: Record<string, any[]> = { user_tasks: [...seedUserTasks] };
  const completed: { userTaskKey: string; variables: Record<string, unknown> }[] = [];
  function tbl(name: string, pk: string) {
    // biome-ignore lint/suspicious/noExplicitAny: see above
    const rows = (stores[name] ??= [] as any[]);
    return {
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async insert(row: any) {
        rows.push({ ...row });
        return rows.length;
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async get(id: any) {
        return rows.find((r) => r[pk] === id);
      },
      async all() {
        return [...rows];
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async find(where: any = {}) {
        return rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async delete(id: any) {
        const i = rows.findIndex((r) => r[pk] === id);
        if (i >= 0) rows.splice(i, 1);
      },
      // biome-ignore lint/suspicious/noExplicitAny: see above
      async update(id: any, patch: any) {
        const r = rows.find((row) => row[pk] === id);
        if (r) Object.assign(r, patch);
      },
    };
  }
  const engine = {
    openUserTasks: async () => openTasks,
    searchUserTasks: async () => openTasks,
    completeUserTask: async (userTaskKey: string, variables: Record<string, unknown>) => {
      completed.push({ userTaskKey, variables });
    },
  };
  const app = {
    data: { table: (n: string, pk: string) => tbl(n, pk) },
    engine,
    log: noopLog(),
    // biome-ignore lint/suspicious/noExplicitAny: test harness cast, mirrors sibling op tests
  } as any as AppApi;
  return { app, stores, completed };
}

// biome-ignore lint/suspicious/noExplicitAny: test harness cast, mirrors sibling op tests
async function callList(app: AppApi): Promise<any> {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  return (await listHandler({ req: { headers: new Headers() } as any, params: {}, query: {}, body: undefined } as any, app)) as any;
}

// biome-ignore lint/suspicious/noExplicitAny: test harness cast, mirrors sibling op tests
async function callComplete(app: AppApi, body: unknown): Promise<any> {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  return (await completeHandler({ req: {} as any, params: {}, query: {}, body } as any, app)) as any;
}

function utRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    user_task_key: "ut-x",
    element_id: "wait-answer",
    kind_label: "PR review",
    subject_type: "pr",
    subject_key: "acme/repo#7",
    subject_title: "Add widget",
    subject_url: "https://github.com/acme/repo/pull/7",
    question: "Which API version?",
    process_key: "pi-1",
    form_key: "form-pr",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

test("listEscalations: round-trip — the listed userTaskKey is exactly what completeUserTask resolves", async () => {
  const { app, stores, completed } = memApp(
    [utRow({ user_task_key: "ut-answer", element_id: "wait-answer" })],
    [{ userTaskKey: "ut-answer", elementId: "wait-answer" }],
  );

  const listed = await callList(app);
  assertEquals(listed.status, 200);
  assertEquals(listed.body.count, 1);
  const esc = listed.body.escalations[0];
  assertEquals(esc.userTaskKey, "ut-answer");
  assertEquals(esc.kind, "wait-answer");
  assertEquals(esc.prKey, "acme/repo#7");
  assertEquals(esc.question, "Which API version?");
  assertEquals(esc.formKey, "form-pr");

  // Answer the exact key the list handed back — it resolves via the canonical completer.
  const done = await callComplete(app, { userTaskKey: esc.userTaskKey, variables: { answer: "v2" } });
  assertEquals(done.status, 200);
  assertEquals(done.body.ok, true);
  assertEquals(done.body.elementId, "wait-answer");
  assertEquals(completed, [{ userTaskKey: "ut-answer", variables: { answer: "v2" } }]);
  // The answered task's read-model row is dropped, so a re-list no longer shows it.
  assertEquals(stores.user_tasks, []);
  const reListed = await callList(app);
  assertEquals(reListed.body.count, 0);
});

test("listEscalations: lists across all four escalation kinds, newest-updated first", async () => {
  const { app } = memApp(
    [
      utRow({ user_task_key: "ut-pr", element_id: "wait-answer", updated_at: "2026-01-04T00:00:00.000Z" }),
      utRow({
        user_task_key: "ut-plan",
        element_id: "plan-review-decision",
        kind_label: "Plan review",
        subject_type: "plan",
        subject_key: "acme/repo#99",
        updated_at: "2026-01-03T00:00:00.000Z",
      }),
      utRow({
        user_task_key: "ut-trial",
        element_id: "trial-merge-decision",
        kind_label: "Trial merge",
        subject_type: "plan",
        subject_key: "acme/repo#99",
        updated_at: "2026-01-02T00:00:00.000Z",
      }),
      utRow({
        user_task_key: "ut-feat",
        element_id: "feature-escalation",
        kind_label: "Feature escalation",
        subject_type: "feature",
        subject_key: "acme/repo#42",
        updated_at: "2026-01-01T00:00:00.000Z",
      }),
    ],
    [],
  );

  const res = await callList(app);
  assertEquals(res.status, 200);
  assertEquals(res.body.count, 4);
  assertEquals(
    res.body.escalations.map((e: { userTaskKey: string }) => e.userTaskKey),
    ["ut-pr", "ut-plan", "ut-trial", "ut-feat"],
  );
  // Non-PR subjects carry a null prKey; the PR subject carries the pr key.
  const byKey = Object.fromEntries(res.body.escalations.map((e: { userTaskKey: string }) => [e.userTaskKey, e]));
  assertEquals(byKey["ut-pr"].prKey, "acme/repo#7");
  assertEquals(byKey["ut-plan"].prKey, null);
  assertEquals(byKey["ut-feat"].subjectType, "feature");
});

test("listEscalations: empty when no open escalations", async () => {
  const { app } = memApp([], []);
  const res = await callList(app);
  assertEquals(res.status, 200);
  assertEquals(res.body, { count: 0, escalations: [] });
});

// The optional shared-secret guard is captured at module load from NANO_PR_WEBHOOK_SECRET, so
// cache-bust re-import the handler with the env set to exercise both the rejected (401, missing
// header) and authorized (200, correct header) paths deterministically — mirrors the read-door
// guard tests on sibling ops (listActivePrs, listLibrary).
test("listEscalations: shared-secret guard — 401 without x-hook-secret, 200 with it", async () => {
  const prev = process.env["NANO_PR_WEBHOOK_SECRET"];
  process.env["NANO_PR_WEBHOOK_SECRET"] = "s3cr3t";
  try {
    const mod = await import(`./listEscalations.ts?guard=${Date.now()}`);
    const guarded = mod.default as typeof listHandler;
    const { app } = memApp([], []);
    // biome-ignore lint/suspicious/noExplicitAny: test harness cast, mirrors sibling op tests
    const bad = (await guarded({ req: { headers: new Headers() } as any, params: {}, query: {}, body: undefined } as any, app)) as any;
    assertEquals(bad.status, 401);
    const ok = (await guarded(
      // biome-ignore lint/suspicious/noExplicitAny: test harness cast, mirrors sibling op tests
      { req: { headers: new Headers({ "x-hook-secret": "s3cr3t" }) } as any, params: {}, query: {}, body: undefined } as any,
      app,
      // biome-ignore lint/suspicious/noExplicitAny: test harness cast, mirrors sibling op tests
    )) as any;
    assertEquals(ok.status, 200);
    assert("count" in ok.body);
  } finally {
    if (prev === undefined) delete process.env["NANO_PR_WEBHOOK_SECRET"];
    else process.env["NANO_PR_WEBHOOK_SECRET"] = prev;
  }
});
