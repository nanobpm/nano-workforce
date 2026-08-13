// The SUPPLY-only cockpit view-model (ADR 0056, H5 / #148).
//
// A pure, deterministic projection of the app's SUPPLY report — the live worker registry (H1 #144)
// carried over the agentic channel — onto the shape the supply cockpit renders: a per-leaf-token
// list of connected workers with family, host, current jobs, and liveness.
//
// This is DELIBERATELY the supply half only. The DEMAND×supply matrix, the missing-agent-type reds,
// and the diversity-SLO lights (the packaged `@nanobpm/agentic/cockpit` view/render draws those from
// a `DemandSupplyReport`) are OUT OF SCOPE for this epic (#142) — they depend on the vocab /
// capability→SERVE / diversity-SLO machinery deferred to the paired enrolment epic #152. So this
// module models a supply-only report and never fabricates demand data.
//
// Like the packaged `cockpit/view.ts` it is framework-free and side-effect-free: the same report
// always yields the same {@link SupplyView}, so it is safe to snapshot in a test and to render
// identically whether the page is embedded in the console (App View, ADR 0057) or served standalone.

/** A worker's coarse liveness grade, rendered as a coloured dot. */
export type Liveness = "live" | "stale" | "down";

/** One connected worker as the app's supply feed reports it (mirrors the H1 registry snapshot row). */
export interface SupplyWorkerReport {
  /** The worker instance id. */
  readonly instance: string;
  /** The authenticated ADR 0028 principal — the leaf token this worker registered under. */
  readonly identity: string;
  /**
   * The relay stream to drill into for this worker's live terminal. The supply endpoint defaults it
   * to the worker instance; the correlation slice (H6 #149) may repoint it at a jobKey-keyed stream.
   */
  readonly stream: string;
  /** Declared family (enrolment attribute), if any. */
  readonly family?: string;
  /** Declared host (where the worker runs), if any. */
  readonly host?: string;
  /** The jobKeys the worker is currently processing (empty until H6 wires the resolver). */
  readonly jobKeys: readonly string[];
  /** Whether the worker's channel connection is still open. */
  readonly live: boolean;
  /** How long since the worker's last liveness refresh, in ms. */
  readonly staleMs: number;
}

/** The supply registered under one leaf token. */
export interface SupplyLeafReport {
  readonly token: string;
  readonly workers: readonly SupplyWorkerReport[];
}

/** The supply-only report the cockpit polls (no demand fields — those are enrolment epic #152). */
export interface SupplyReport {
  /** Supply grouped by leaf token. */
  readonly leaves: readonly SupplyLeafReport[];
  /** Every connected worker, flat. */
  readonly workers: readonly SupplyWorkerReport[];
  /** The number of connected workers. */
  readonly count: number;
  /** When the snapshot was taken, ISO-8601 (optional). */
  readonly generatedAt?: string;
}

/** One worker row in the renderable supply view. */
export interface SupplyWorkerView {
  readonly instance: string;
  readonly identity: string;
  /** The relay stream to open when the operator drills into this worker. */
  readonly stream: string;
  /** Declared family, or `"—"` when absent (so the cell always renders something stable). */
  readonly family: string;
  /** Declared host, or `"—"` when absent. */
  readonly host: string;
  /** The worker's current jobKeys, sorted. */
  readonly jobKeys: readonly string[];
  /** The number of current jobs. */
  readonly jobs: number;
  /** The coarse liveness grade for the status dot. */
  readonly liveness: Liveness;
  /** How long since the last liveness refresh, in ms. */
  readonly staleMs: number;
}

/** One leaf-token section in the renderable supply view. */
export interface SupplyLeafView {
  readonly token: string;
  readonly workers: readonly SupplyWorkerView[];
  /** Workers under this leaf currently graded `live`. */
  readonly liveCount: number;
  /** Total workers under this leaf. */
  readonly total: number;
}

/** The full renderable supply view. */
export interface SupplyView {
  /** Supply grouped by leaf token, sorted by token. */
  readonly leaves: readonly SupplyLeafView[];
  /** Every worker, flat, sorted by instance. */
  readonly workers: readonly SupplyWorkerView[];
  /** The number of workers. */
  readonly count: number;
  /** The number of workers graded `live`. */
  readonly live: number;
}

/** Options for {@link supplyView}. */
export interface SupplyViewOptions {
  /**
   * A live worker whose last refresh is older than this (ms) is graded `stale` rather than `live`.
   * A disconnected worker is always `down`. Default 15000.
   */
  readonly staleAfterMs?: number;
}

const DEFAULT_STALE_AFTER_MS = 15_000;

function liveness(worker: SupplyWorkerReport, staleAfterMs: number): Liveness {
  if (!worker.live) return "down";
  return worker.staleMs >= staleAfterMs ? "stale" : "live";
}

function workerView(worker: SupplyWorkerReport, staleAfterMs: number): SupplyWorkerView {
  const jobKeys = [...worker.jobKeys].sort((a, b) => a.localeCompare(b));
  return {
    instance: worker.instance,
    identity: worker.identity,
    stream: worker.stream,
    family: worker.family ?? "—",
    host: worker.host ?? "—",
    jobKeys,
    jobs: jobKeys.length,
    liveness: liveness(worker, staleAfterMs),
    staleMs: worker.staleMs,
  };
}

const byInstance = (a: SupplyWorkerView, b: SupplyWorkerView) => a.instance.localeCompare(b.instance);

/**
 * Derive the renderable supply view from the app's supply-only report.
 *
 * Pure and total: it re-sorts leaves by token and workers by instance so the derived view is stable
 * and diff-friendly regardless of the report's incoming order; no input mutates and no I/O happens.
 */
export function supplyView(report: SupplyReport, options: SupplyViewOptions = {}): SupplyView {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  const leaves: SupplyLeafView[] = report.leaves
    .map((leaf) => {
      const workers = leaf.workers.map((w) => workerView(w, staleAfterMs)).sort(byInstance);
      return {
        token: leaf.token,
        workers,
        liveCount: workers.filter((w) => w.liveness === "live").length,
        total: workers.length,
      };
    })
    .sort((a, b) => a.token.localeCompare(b.token));

  const workers = report.workers.map((w) => workerView(w, staleAfterMs)).sort(byInstance);

  return {
    leaves,
    workers,
    count: workers.length,
    live: workers.filter((w) => w.liveness === "live").length,
  };
}
