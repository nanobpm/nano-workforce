// Guard for the `instanceTracking` manifest bindings (nano.app.json). The reconciler flips a row
// whose engine instance is TERMINATED only when the row is in one of `activeStatuses`. A status
// that is genuinely in-flight but missing from that list would leave an operator-terminated (or
// crashed) run stuck "active" in the UI — the exact drift Copilot flagged on #96. This ties the
// manifest to the code's single source of truth for "done" (TERMINAL_STATUSES / PLAN_TERMINAL_
// STATUSES) so the two can't diverge silently.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { readFileSync } from "node:fs";
import { PR_ACTIVE_STATUSES, PLAN_ACTIVE_STATUSES, TERMINAL_STATUSES } from "./service.ts";
import { PLAN_TERMINAL_STATUSES } from "./plan.ts";

interface Binding {
  table: string;
  statusField?: string;
  activeStatuses?: string[];
  onTerminated: { set: Record<string, unknown> };
}

async function bindings(): Promise<Binding[]> {
  const manifest = JSON.parse(readFileSync(new URL("../nano.app.json", import.meta.url), "utf8"));
  return manifest.instanceTracking as Binding[];
}

function bindingFor(all: Binding[], table: string): Binding {
  const b = all.find((x) => x.table === table);
  assert(b, `no instanceTracking binding for ${table}`);
  return b;
}

test("instanceTracking: pull_requests activeStatuses excludes every terminal status", async () => {
  const b = bindingFor(await bindings(), "pull_requests");
  for (const terminal of TERMINAL_STATUSES) {
    assert(
      !b.activeStatuses?.includes(terminal),
      `terminal status "${terminal}" must not be listed active (it would let the reconciler clobber a settled row)`,
    );
  }
});

// Every in-flight status the merge train keys off must be reconcilable. These are the states a
// pull_requests row can hold while a live engine instance still backs it (see app/service.ts merge
// poller: converging/waiting_review/escalated + the merge-stage waiting_deps/waiting_merge/
// waiting_lane/queued/merging). If a new one is added to the flow, add it here AND to the manifest.
test("instanceTracking: pull_requests activeStatuses covers every in-flight status", async () => {
  const inFlight = [
    "converging",
    "waiting_review",
    "escalated",
    "waiting_deps",
    "waiting_merge",
    "waiting_lane",
    "queued",
    "merging",
  ];
  const b = bindingFor(await bindings(), "pull_requests");
  for (const s of inFlight) {
    assert(b.activeStatuses?.includes(s), `in-flight status "${s}" missing from activeStatuses`);
  }
  // No terminal status leaks into the in-flight universe we assert on.
  for (const s of inFlight) assert(!TERMINAL_STATUSES.includes(s));
});

test("instanceTracking: plans activeStatuses excludes every terminal status", async () => {
  const b = bindingFor(await bindings(), "plans");
  for (const terminal of PLAN_TERMINAL_STATUSES) {
    assert(!b.activeStatuses?.includes(terminal), `terminal status "${terminal}" must not be active`);
  }
});

test("instanceTracking: plans activeStatuses covers every in-flight status", async () => {
  const inFlight = ["planning", "dispatched"];
  const b = bindingFor(await bindings(), "plans");
  assertEquals([...(b.activeStatuses ?? [])].sort(), [...inFlight].sort());
});

// The app-side `pollUserTasks` scan constant is DERIVED from the manifest at load time (no hand-kept
// duplicate), so it must match the manifest binding exactly — this closes the drift surface Copilot
// flagged (a second hard-coded list that could silently diverge from the reconciler's activeStatuses).
test("PR_ACTIVE_STATUSES is derived from the manifest binding (no drift)", async () => {
  const b = bindingFor(await bindings(), "pull_requests");
  assertEquals([...PR_ACTIVE_STATUSES].sort(), [...(b.activeStatuses ?? [])].sort());
});

// Same guard for the plan scan: `pollUserTasks` no longer hard-codes ["planning","dispatched"] but
// derives PLAN_ACTIVE_STATUSES from the manifest, so the plan-escalation scan can't drift from the
// reconciler's activeStatuses any more than the PR scan can.
test("PLAN_ACTIVE_STATUSES is derived from the manifest binding (no drift)", async () => {
  const b = bindingFor(await bindings(), "plans");
  assertEquals([...PLAN_ACTIVE_STATUSES].sort(), [...(b.activeStatuses ?? [])].sort());
});
