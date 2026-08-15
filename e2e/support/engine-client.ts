import type { EngineClient } from "@nanobpm/urban";
import type { TestApp } from "@nanobpm/urban-testkit";

// urban 0.49.0 (ADR 0062) added `EngineClient.getForm`, but the published
// @nanobpm/urban-testkit (0.4.0) predates it, so its `WasmEngineClient` neither
// declares nor implements the method. These hermetic e2e flows drive user-task
// completion directly (`completeUserTask`) and never resolve a form schema, so we
// complete the contract with a null-returning `getForm` — the documented "no
// matching form" path — until a testkit release catches up with urban's engine
// seam. Scoped to the test harness; production adapters implement `getForm` for real.
export function asEngineClient(engine: TestApp["engine"]): EngineClient {
  const e = engine as unknown as EngineClient & { getForm?: EngineClient["getForm"] };
  if (typeof e.getForm !== "function") {
    e.getForm = async () => null;
  }
  return e;
}
