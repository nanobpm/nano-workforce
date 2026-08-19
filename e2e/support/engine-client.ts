import type { EngineClient } from "@nanobpm/urban";
import type { TestApp } from "@nanobpm/urban-testkit";

// urban 0.49.0 (ADR 0062) added `EngineClient.getForm`, but the published
// @nanobpm/urban-testkit (0.4.0) predates it, so its `WasmEngineClient` neither
// declares nor implements the method. These hermetic e2e flows drive user-task
// completion directly (`completeUserTask`) and never resolve a form schema, so we
// complete the contract with a null-returning `getForm` — the documented "no
// matching form" path — until a testkit release catches up with urban's engine
// seam. Scoped to the test harness; production adapters implement `getForm` for real.
//
// The same lag applies to `EngineClient.openUserTasks` (issue #294 moved the pollers onto it):
// @nanobpm/urban-testkit@0.5.0's `WasmEngineClient` implements `searchUserTasks` but not the
// open-task-scoped `openUserTasks`, so a poller call throws `not a function` (swallowed by the
// poller's try/catch) and the read-model denormalisation silently no-ops. Polyfill it here as
// `searchUserTasks({ state: "CREATED" })` — byte-for-byte what urban's real `openUserTasks` does
// (nanosdk `SdkEngineClient.openUserTasks`) — so the E2E exercises the same open-task query as
// production, until a testkit release ships `openUserTasks`. Fix filed: nano-workforce#309;
// categorical (testkit) fix upstream in nanobpm/nano-ide.
export function asEngineClient(engine: TestApp["engine"]): EngineClient {
  const e = engine as unknown as EngineClient & {
    getForm?: EngineClient["getForm"];
    openUserTasks?: EngineClient["openUserTasks"];
  };
  if (typeof e.getForm !== "function") {
    e.getForm = async () => null;
  }
  if (typeof e.openUserTasks !== "function") {
    e.openUserTasks = (filter) => e.searchUserTasks({ ...filter, state: "CREATED" });
  }
  return e;
}
