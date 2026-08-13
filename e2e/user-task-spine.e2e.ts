// End-to-end proof for the user-task + form spine (epic #156, slice U0 — the keystone).
//
// Boots this whole Urban app in-process against the WASM engine and a virtual clock via
// `bootTestApp`, deploys the throwaway `spine-demo` process (a native `userTask` linked to
// `spine-demo.form`, whose completion drives a data-based decision gateway), and proves the
// round-trip every later escalation slice builds on:
//
//   start instance → the task is listed via the `taskInbox` surface route
//   (GET /tasks/api/tasks) → complete it with the typed form field via POST /tasks/api/complete
//   → the process resumes, and the TYPED variable routes the decision gateway before the instance
//   COMPLETES.
//
// The gateway is deliberate: a bare "the token advanced" assertion cannot tell a real typed
// submission apart from an empty one (the WASM engine folds a completed instance's variables away,
// so they are not observable post-completion). Routing the resume through a FEEL condition on the
// form's `decision` field makes "resumes WITH those variables" falsifiable — an empty/wrong value
// would take the gateway's default (reject) flow instead of the approve flow this test asserts. This
// mirrors the answer/abandon gateway the escalation slices (U2/U3) build on the same spine.
//
// Network isolation mirrors the sibling convergence e2e: the app's GitHub transport is forced to
// `token` mode with no token, so any best-effort GitHub read short-circuits instead of reaching out.
//
// Run with `npm run e2e` (a dedicated node:test invocation, kept out of the fast unit `npm test`).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";

// The app root is this repo's root (one level up from `e2e/`) — where nano.app.json + the
// resources/processes + resources/forms it deploys live.
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Provision the app's SQLite in a throwaway temp dir so the test never touches (or leaks into) the
// repo's real ./app.db, and every run starts from a freshly-migrated, empty schema.
const DB_DIR = mkdtempSync(join(tmpdir(), "nwf-u0-"));

// Force the app fully offline (github.ts reads process.env directly, not the harness env overlay):
// `token` mode with no GITHUB_TOKEN means every best-effort GitHub read short-circuits to null.
const GITHUB_ENV_OVERRIDES: Record<string, string> = {
  NANO_PR_GITHUB_TRANSPORT: "token",
  GITHUB_TOKEN: "",
};
const savedEnv = new Map<string, string | undefined>();

// The harness `env` overlay drives the runtime's `${NANO_APP_DB_URL}` resolution.
const HARNESS_ENV = {
  NANO_APP_DB_URL: `file:${join(DB_DIR, "app.db")}`,
} as const;

interface InboxTask {
  userTaskKey: string;
  elementId?: string;
  variables?: Record<string, unknown>;
}

interface TakenFlow {
  from: string;
  to: string;
}

/** The engine snapshot's cumulative taken sequence flows, as `from->to` strings. With a single
 *  instance in play this is exactly that instance's routing history. */
function takenFlows(app: TestApp): string[] {
  const snapshot = app.snapshot();
  const flows = Array.isArray(snapshot.takenSequenceFlows) ? snapshot.takenSequenceFlows : [];
  return flows
    .filter((f): f is TakenFlow => typeof f === "object" && f !== null && "from" in f && "to" in f)
    .map((f) => `${f.from}->${f.to}`);
}

describe("nano-workforce user-task spine (U0 keystone)", () => {
  let app: TestApp;

  before(async () => {
    for (const [k, v] of Object.entries(GITHUB_ENV_OVERRIDES)) {
      savedEnv.set(k, process.env[k]);
      process.env[k] = v;
    }
    app = await bootTestApp(APP_ROOT, { env: HARNESS_ENV });
  });

  after(async () => {
    await app?.stop();
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(DB_DIR, { recursive: true, force: true });
  });

  test("a userTask bearing a linked .form round-trips list → complete → resume with typed vars", async () => {
    // Boot deploys every model under `models` — including the throwaway spine-demo.bpmn and its
    // linked spine-demo.form. Start one instance of the spine process.
    const created = await app.engine.createInstance({ processDefinitionId: "spine-demo" });
    const processInstanceKey = created.processInstanceKey;
    assert.ok(processInstanceKey, "starting spine-demo returns a process instance key");

    // The instance parks on the native userTask. It is visible through the `taskInbox` surface's
    // JSON route (GET /tasks/api/tasks) — the manifest-enabled surface this slice lands.
    const listed = await app.callRoute<InboxTask[]>({
      method: "GET",
      path: "/tasks/api/tasks",
      query: { processInstanceKey },
    });
    assert.equal(listed.status, 200, "the taskInbox surface serves the task list");
    assert.equal(listed.body.length, 1, "exactly the one spine userTask is open");
    const task = listed.body[0];
    assert.equal(task.elementId, "decide", "the open task is the spine's `decide` userTask");
    assert.ok(task.userTaskKey, "the task carries a completable userTaskKey");

    // Complete it through the surface's completion route (POST /tasks/api/complete) with exactly the
    // typed field the linked .form declares (`decision`). This is the list → render → complete path
    // an operator drives through the inbox.
    const completed = await app.callRoute<{ ok: boolean }>({
      method: "POST",
      path: "/tasks/api/complete",
      body: JSON.stringify({ userTaskKey: task.userTaskKey, variables: { decision: "approve" } }),
    });
    assert.equal(completed.status, 200, "the completion route accepts the typed form submission");
    assert.equal(completed.body.ok, true, "the userTask was completed");

    // The typed variable resumed the token through the decision gateway: `decision = "approve"`
    // satisfied the FEEL condition, so the token took the approve flow (NOT the default reject flow).
    // This is the falsifiable core of "resumes WITH those variables" — an empty/wrong value would
    // have fallen through to `end-rejected`.
    const flows = takenFlows(app);
    assert.ok(
      flows.includes("gw-decision->end-approved"),
      `the typed decision routed to the approve end (flows: ${flows.join(", ")})`,
    );
    assert.ok(
      !flows.includes("gw-decision->end-rejected"),
      `the default reject flow was NOT taken (flows: ${flows.join(", ")})`,
    );

    // The token advanced start → userTask → gateway → end: the process resumes and reaches COMPLETED,
    // with no open task left behind.
    const instances = await app.engine.searchProcessInstances({
      processInstanceKeys: [processInstanceKey],
    });
    assert.equal(instances.length, 1, "the spine instance is still resolvable");
    assert.equal(instances[0].state, "COMPLETED", "the process resumed and completed");

    const remaining = await app.callRoute<InboxTask[]>({
      method: "GET",
      path: "/tasks/api/tasks",
      query: { processInstanceKey },
    });
    assert.equal(remaining.body.length, 0, "the completed task is no longer open");
  });
});
