// The escalation-bridge acceptance tests (issue #559, ADR 0056). They drive the REAL in-repo operator
// path end to end with in-memory fakes:
//   escalate-policy permission REQUEST → a Tasks-inbox row raised (the new ACP_PERMISSION_ELEMENT kind) →
//   an operator Allow/Deny answered through the canonical `completeEscalationAsHuman` door →
//   a permission RESOLUTION frame sent down the relay CONTROL lane with the matching callId/optionId/allowed.
// A focused unit test proves the exported `onPermissionResolve` adapter converges on the SAME frame, and
// a yolo/opt-out test proves the bridge is bypassed by default.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import {
  buildPermissionResolutionFrame,
  completePermissionEscalationAsHuman,
  createOnPermissionResolve,
  optionKindAllows,
  type PermissionBridgeDeps,
  permissionEscalationEnabled,
  permissionOptionAllows,
  permissionQuestion,
  permissionUserTaskRow,
} from "./permission-bridge.ts";
import { jobStream } from "./correlation.ts";
import {
  type DerivedPermission,
  parseTranscriptEvent,
  type PermissionResolutionEvent,
} from "./transcript-events.ts";

// ── In-memory fakes (mirroring the shared patterns in app/agentCompletion.test.ts) ────────────────

/** A minimal in-memory `Table<T>` with AUTOINCREMENT ids on insert and structural find/get/delete. */
function memTable(rows: any[], key: string) {
  let seq = rows.reduce((m, r) => Math.max(m, Number(r[key]) || 0), 0);
  return {
    insert: (row: any) => {
      const id = ++seq;
      const stored = key === "id" ? { ...row, id } : { ...row };
      rows.push(stored);
      return Promise.resolve(key === "id" ? id : stored[key]);
    },
    get: (k: any) => Promise.resolve(rows.find((r) => r[key] === k)),
    find: (q: any = {}) => Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
    findOne: (q: any = {}) => Promise.resolve(rows.find((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
    update: (k: any, patch: any) => {
      const r = rows.find((x) => x[key] === k);
      if (r) Object.assign(r, patch);
      return Promise.resolve(r ? 1 : 0);
    },
    delete: (k: any) => {
      const i = rows.findIndex((r) => r[key] === k);
      if (i >= 0) rows.splice(i, 1);
      return Promise.resolve(i >= 0 ? 1 : 0);
    },
    count: (q: any = {}) => Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v)).length),
    all: () => Promise.resolve(rows.slice()),
  };
}

function memData(stores: Record<string, { rows: any[]; key: string }>) {
  return {
    table: (name: string, key: string) => memTable(stores[name]?.rows ?? [], stores[name]?.key ?? key),
  } as any;
}

/** A stub engine that records every `completeUserTask` against a seeded set of open user tasks (the
 *  completer resolves via `openUserTasks`, CREATED only). */
function fakeEngine(openTasks: Array<{ userTaskKey: string; elementId?: string }>) {
  const completed: Array<{ userTaskKey: string; variables?: Record<string, unknown> }> = [];
  const engine = {
    openUserTasks: () => Promise.resolve(openTasks),
    searchUserTasks: () => Promise.reject(new Error("completer must resolve via openUserTasks")),
    completeUserTask: (userTaskKey: string, variables?: Record<string, unknown>) => {
      completed.push({ userTaskKey, variables });
      return Promise.resolve();
    },
  } as any;
  return { engine, completed };
}

/** A relay-send spy: records every frame the bridge emits. */
function sendSpy() {
  const frames: any[] = [];
  const deps: PermissionBridgeDeps = { send: (frame) => frames.push(frame) };
  return { deps, frames };
}

/** Decode a produced resolution chunk back through the ONE parser (never re-parsing bytes by hand). */
function decodeResolution(frame: any): PermissionResolutionEvent {
  const chunk = frame.payload.chunk as string;
  const event = parseTranscriptEvent({ offset: 0, chunk });
  assert(event.kind === "permission" && event.phase === "resolution", "expected a permission RESOLUTION");
  return event;
}

/** An escalate-policy permission REQUEST offering Allow (allow-once) and Deny (reject-once). */
function escalateRequest(callId = "job-1"): DerivedPermission {
  return {
    callId,
    policy: "escalate",
    options: [
      { optionId: "allow", name: "Allow", kind: "allow-once" },
      { optionId: "deny", name: "Deny", kind: "reject-once" },
    ],
    toolName: "write_file",
    title: "Write /etc/hosts",
    reason: "The agent wants to modify a protected file.",
    offset: 3,
  };
}

// ── Acceptance: the full real-operator path, Allow and Deny ────────────────────────────────────────

test("escalate REQUEST → Tasks-inbox row → operator ALLOW via the completion door → RESOLUTION down the control lane", async () => {
  const request = escalateRequest("job-allow");
  const stream = jobStream(request.callId);

  // 1. The request surfaces as an answerable Tasks-inbox row of the new permission kind.
  const row = permissionUserTaskRow(request, { userTaskKey: "ut-perm-1", subjectKey: "hire-42" }, { enabled: true });
  assert(row !== null, "an escalate-policy request must raise a row");
  assertEquals(row.element_id, "acp-permission");
  assertEquals(row.kind_label, "Agent permission");
  assertEquals(row.subject_type, "agent");
  assertEquals(row.user_task_key, "ut-perm-1");
  assert(row.question?.includes("Write /etc/hosts"), "the row carries the request's title/reason as the question");
  assert(row.question?.includes("modify a protected file"), "the row carries the request's reason");

  // 2. The operator answers Allow through the ONE canonical completion door.
  const stores = { task_completions: { rows: [] as any[], key: "id" } };
  const data = memData(stores);
  const { engine, completed } = fakeEngine([{ userTaskKey: "ut-perm-1", elementId: "acp-permission" }]);
  const { deps, frames } = sendSpy();

  const result = await completePermissionEscalationAsHuman(data, engine, deps, {
    permission: request,
    userTaskKey: "ut-perm-1",
    optionId: "allow",
    operatorId: "op:ada",
  });

  // The completion took through the canonical door (recorded attribution + engine completion).
  assertEquals(result.completion.ok, true);
  assertEquals(result.completion.elementId, "acp-permission");
  assertEquals(completed.length, 1);
  assertEquals(completed[0].userTaskKey, "ut-perm-1");
  assertEquals(completed[0].variables, { optionId: "allow", allowed: true });
  assertEquals(stores.task_completions.rows.length, 1);
  assertEquals(stores.task_completions.rows[0].actor_kind, "human");

  // 3. A RESOLUTION frame flowed back down the relay CONTROL lane, releasing the blocked request.
  assertEquals(frames.length, 1);
  assertEquals(frames[0].lane, "control");
  assertEquals(frames[0].family, "relay");
  assertEquals(frames[0].payload.op, "produce");
  assertEquals(frames[0].payload.stream, stream);
  const resolution = decodeResolution(frames[0]);
  assertEquals(resolution.callId, "job-allow");
  assertEquals(resolution.optionId, "allow");
  assertEquals(resolution.allowed, true);
  assertEquals(resolution.by, "operator");
});

test("escalate REQUEST → operator DENY via the completion door → RESOLUTION allowed=false down the control lane", async () => {
  const request = escalateRequest("job-deny");
  const stores = { task_completions: { rows: [] as any[], key: "id" } };
  const data = memData(stores);
  const { engine, completed } = fakeEngine([{ userTaskKey: "ut-perm-2", elementId: "acp-permission" }]);
  const { deps, frames } = sendSpy();

  const result = await completePermissionEscalationAsHuman(data, engine, deps, {
    permission: request,
    userTaskKey: "ut-perm-2",
    optionId: "deny",
    operatorId: "op:ada",
  });

  assertEquals(result.completion.ok, true);
  assertEquals(completed[0].variables, { optionId: "deny", allowed: false });
  assertEquals(frames.length, 1);
  const resolution = decodeResolution(frames[0]);
  assertEquals(resolution.callId, "job-deny");
  assertEquals(resolution.optionId, "deny");
  assertEquals(resolution.allowed, false);
  assertEquals(resolution.by, "operator");
});

test("a failed completion (no open task) NEVER sends a resolution — the block is only released on a real answer", async () => {
  const request = escalateRequest("job-missing");
  const stores = { task_completions: { rows: [] as any[], key: "id" } };
  const data = memData(stores);
  const { engine } = fakeEngine([]); // no open task with this key
  const { deps, frames } = sendSpy();

  const result = await completePermissionEscalationAsHuman(data, engine, deps, {
    permission: request,
    userTaskKey: "ut-nope",
    optionId: "allow",
    operatorId: "op:ada",
  });

  assertEquals(result.completion.ok, false);
  assertEquals(result.resolution, undefined);
  assertEquals(frames.length, 0);
});

// ── Convergence: the onPermissionResolve adapter and the completion door build the SAME frame ───────

test("the exported onPermissionResolve adapter produces the SAME relay RESOLUTION as the completion door", async () => {
  const request = escalateRequest("job-converge");
  const stream = jobStream(request.callId);

  // Path A: the completion-door path.
  const stores = { task_completions: { rows: [] as any[], key: "id" } };
  const data = memData(stores);
  const { engine } = fakeEngine([{ userTaskKey: "ut-perm-3", elementId: "acp-permission" }]);
  const doorSpy = sendSpy();
  await completePermissionEscalationAsHuman(data, engine, doorSpy.deps, {
    permission: request,
    userTaskKey: "ut-perm-3",
    optionId: "allow",
    operatorId: "op:ada",
  });

  // Path B: the exported cockpit seam adapter, invoked with the cockpit-derived {callId, optionId, allowed}.
  const seamSpy = sendSpy();
  const onPermissionResolve = createOnPermissionResolve(seamSpy.deps);
  onPermissionResolve({ callId: request.callId, optionId: "allow", allowed: true });

  assertEquals(doorSpy.frames.length, 1);
  assertEquals(seamSpy.frames.length, 1);
  // Byte-identical frames: same lane, family, seq, and produce payload (stream + encoded chunk).
  assertEquals(seamSpy.frames[0], doorSpy.frames[0]);
  assertEquals(seamSpy.frames[0].payload.stream, stream);
  // And they equal the pure builder's frame for the same decision + stream.
  const pure = buildPermissionResolutionFrame(stream, { callId: request.callId, optionId: "allow", allowed: true, by: "operator" });
  assertEquals(doorSpy.frames[0], pure.frame);
});

// ── yolo / opt-out: the bridge is bypassed by default ──────────────────────────────────────────────

test("a yolo-policy request NEVER raises a user task and never emits a bridge resolution", () => {
  const yolo: DerivedPermission = {
    callId: "job-yolo",
    policy: "yolo",
    options: [{ optionId: "allow", name: "Allow", kind: "allow-once" }],
    offset: 1,
  };
  // No row for yolo, even when the bridge is enabled (yolo auto-allows elsewhere; the bridge is inert).
  assertEquals(permissionUserTaskRow(yolo, { userTaskKey: "ut-y", subjectKey: "hire-1" }, { enabled: true }), null);
  // No completion door is invoked for yolo, so no send edge fires — nothing to assert beyond the null row:
  // the bridge only ever emits from `completePermissionEscalationAsHuman`/`createOnPermissionResolve`.
});

test("the bridge is opt-in: a disabled bridge raises no row even for an escalate-policy request", () => {
  const request = escalateRequest("job-off");
  assertEquals(permissionUserTaskRow(request, { userTaskKey: "ut-off", subjectKey: "hire-1" }, { enabled: false }), null);
});

test("permissionEscalationEnabled defaults OFF and honours the truthy forms of the master switch", () => {
  assertEquals(permissionEscalationEnabled({}), false);
  assertEquals(permissionEscalationEnabled({ NANO_WORKFORCE_PERMISSION_ESCALATION: "off" }), false);
  assertEquals(permissionEscalationEnabled({ NANO_WORKFORCE_PERMISSION_ESCALATION: "false" }), false);
  for (const on of ["1", "true", "on", "yes", "TRUE", "On"]) {
    assertEquals(permissionEscalationEnabled({ NANO_WORKFORCE_PERMISSION_ESCALATION: on }), true, `expected ${on} to enable`);
  }
});

// ── Pure derivations ────────────────────────────────────────────────────────────────────────────

test("optionKindAllows / permissionOptionAllows derive allow vs reject from the option kind (fail-closed)", () => {
  assertEquals(optionKindAllows("allow-once"), true);
  assertEquals(optionKindAllows("allow-always"), true);
  assertEquals(optionKindAllows("reject-once"), false);
  assertEquals(optionKindAllows("reject-always"), false);
  const request = escalateRequest();
  assertEquals(permissionOptionAllows(request, "allow"), true);
  assertEquals(permissionOptionAllows(request, "deny"), false);
  assertEquals(permissionOptionAllows(request, "unknown-option"), false); // fail-closed
});

test("permissionQuestion folds title + reason, falling back to the tool name", () => {
  assertEquals(
    permissionQuestion(escalateRequest()),
    "Write /etc/hosts — The agent wants to modify a protected file.",
  );
  assertEquals(
    permissionQuestion({ callId: "c", policy: "escalate", options: [], toolName: "run_shell", offset: 0 }),
    "Permission requested for run_shell",
  );
});
