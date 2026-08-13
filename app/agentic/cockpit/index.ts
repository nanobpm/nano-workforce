// The SUPPLY-only agentic cockpit (ADR 0056, H5 / #148) — the app-side core the Urban page + browser
// shells boot. It renders the live worker/supply list (family, host, current jobs, liveness) from the
// H1 registry snapshot and streams a drilled-in worker's terminal over the H3 relay, reusing the
// packaged `@nanobpm/agentic/cockpit` relay client + resume-from-offset terminal session.
//
// The DEMAND×supply matrix, missing-agent-type reds, and diversity-SLO lights are OUT OF SCOPE for
// this epic (#142) and deferred to the paired enrolment epic #152.
export {
  bootSupplyCockpit,
  type CreateTerminal,
  type SupplyCockpitEnv,
  type SupplyCockpitHandle,
  type TimerHandle,
} from "./supply-boot.ts";
export {
  type RenderSupplyOptions,
  renderSupply,
  type SupplyDom,
} from "./supply-render.ts";
export {
  type Liveness,
  type SupplyLeafReport,
  type SupplyLeafView,
  type SupplyReport,
  type SupplyView,
  type SupplyViewOptions,
  type SupplyWorkerReport,
  type SupplyWorkerView,
  supplyView,
} from "./supply-view.ts";
