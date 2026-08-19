import type { EngineClient } from "@nanobpm/urban";
import type { TestApp } from "@nanobpm/urban-testkit";

// `@nanobpm/urban-testkit`'s `WasmEngineClient` has historically lagged urban's `EngineClient`
// interface: a method lands on the real seam a release or two before the testkit fake grows it. Both
// guards below defensively COMPLETE the contract for any method the *installed* testkit hasn't
// implemented yet — each is an idempotent `if (typeof … !== "function")`, so it no-ops the moment a
// testkit release ships the real method (no version pins to drift). Scoped to the test harness;
// production adapters (`SdkEngineClient`) implement both for real.
//
//  - `getForm` (urban 0.49.0, ADR 0062): the original instance of this lag. Now implemented by the
//    pinned testkit (0.5.0), so this guard is a no-op there; kept as defence against version skew.
//    These hermetic flows drive completion directly and never resolve a form schema, so the fallback
//    returns `null` — the documented "no matching form" path.
//  - `openUserTasks` (issue #294 moved the pollers onto it): the CURRENT gap — testkit 0.5.0 has
//    `searchUserTasks` but not the open-task-scoped `openUserTasks`, so a poller call throws
//    `not a function` (swallowed by the poller's try/catch) and the read-model denormalisation
//    silently no-ops. Polyfill it as `searchUserTasks({ state: "CREATED" })` — byte-for-byte what
//    urban's real `SdkEngineClient.openUserTasks` does, so the two cannot drift. Fix: nano-workforce
//    #309; categorical (testkit) fix upstream in nanobpm/nano-ide#341.
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
