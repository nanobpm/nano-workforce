// The SUPPLY-only agentic cockpit (ADR 0056, H5 / #148) — the app-side core the Urban page + browser
// shells boot. It renders the live worker/supply list (family, host, current jobs, liveness) from the
// H1 registry snapshot and streams a drilled-in worker's terminal over the H3 relay, reusing the
// packaged `@nanobpm/agentic/cockpit` relay client + resume-from-offset terminal session.
//
// The DEMAND×supply matrix, missing-agent-type reds, and diversity-SLO lights are OUT OF SCOPE for
// this epic (#142) and deferred to the paired enrolment epic #152.
export {
  type CockpitRoute,
  parseCockpitRoute,
} from "./cockpit-route.ts";
export {
  bootSupplyCockpit,
  type CreateTerminal,
  type SupplyCockpitEnv,
  type SupplyCockpitHandle,
  type TerminalMode,
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
export {
  type DerivedTranscriptDom,
  deriveTranscript,
  type RenderDerivedTranscriptOptions,
  renderDerivedTranscript,
} from "./transcript-derive.ts";
export {
  type RenderTranscriptsOptions,
  renderTranscripts,
  replayTranscript,
  type TranscriptChunkReport,
  type TranscriptDataReport,
  type TranscriptsDom,
} from "./transcript-render.ts";
export {
  humanBytes,
  humanDuration,
  type TranscriptListReport,
  type TranscriptSummaryReport,
  type TranscriptsView,
  type TranscriptView,
  transcriptsView,
} from "./transcript-view.ts";
export {
  type RenderWorkerDetailOptions,
  renderWorkerDetail,
  type WorkerDetailDom,
} from "./worker-detail-render.ts";
export {
  type FoundWorkerDetailView,
  type MissingWorkerDetailView,
  type WorkerCurrentJobView,
  type WorkerDetailView,
  workerDetailView,
} from "./worker-detail-view.ts";
