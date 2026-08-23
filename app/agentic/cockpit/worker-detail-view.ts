import type { JobCorrelationView, SupplyView, SupplyWorkerView } from "./supply-view.ts";

export interface WorkerCurrentJobView {
  readonly jobKey: string;
  readonly stream: string;
  readonly label: string;
}

export interface FoundWorkerDetailView {
  readonly kind: "found";
  readonly worker: SupplyWorkerView;
  readonly currentJob?: WorkerCurrentJobView;
}

export interface MissingWorkerDetailView {
  readonly kind: "missing";
  readonly instance: string;
}

export type WorkerDetailView = FoundWorkerDetailView | MissingWorkerDetailView;

function currentJob(worker: SupplyWorkerView): WorkerCurrentJobView | undefined {
  const correlation: JobCorrelationView | undefined = worker.correlations[0];
  if (correlation !== undefined) {
    return { jobKey: correlation.jobKey, stream: correlation.stream, label: correlation.label };
  }
  const jobKey = worker.jobKeys[0];
  if (jobKey === undefined) return undefined;
  return { jobKey, stream: worker.stream, label: `job ${jobKey}` };
}

export function workerDetailView(view: SupplyView, instance: string): WorkerDetailView {
  const worker = view.workers.find((w) => w.instance === instance);
  if (worker === undefined) return { kind: "missing", instance };
  return {
    kind: "found",
    worker,
    ...(() => {
      const job = currentJob(worker);
      return job === undefined ? {} : { currentJob: job };
    })(),
  };
}
