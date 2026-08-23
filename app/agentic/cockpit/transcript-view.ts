// The cockpit "past sessions" view-model (ADR 0056, H3 read path / #222).
//
// A pure, deterministic projection of the app's transcript LIST report (`GET /agentic/transcripts`) —
// the durable transcripts an ephemeral agent flushed on job completion — onto the shape the cockpit's
// "past sessions" history list renders beside the LIVE supply list. Selecting a past session replays
// its stored transcript into the SAME persistent terminal region as a live drill-in (static playback
// of a closed stream), so the operator can review "what did that agent do" after it is gone.
//
// Like `./supply-view.ts` it is framework-free and side-effect-free: the same report always yields the
// same {@link TranscriptView}, so it renders identically embedded (App View) and standalone, and is
// unit-testable on Node with no browser.

/** One captured session as the app's transcript list reports it (mirrors `AgenticTranscript`). */
export interface TranscriptSummaryReport {
  readonly stream: string;
  readonly lifecycle: "ephemeral" | "long-lived";
  readonly status: "open" | "completed";
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly firstOffset?: number;
  readonly nextOffset: number;
  readonly byteLength: number;
  readonly chunkCount: number;
  readonly jobKey?: string;
  readonly processInstanceKey?: string;
  readonly bpmnProcessId?: string;
  readonly elementId?: string;
  readonly planKey?: string;
  readonly instance?: string;
  readonly identity?: string;
  readonly host?: string;
}

/** The transcript list report the cockpit polls (mirrors `AgenticTranscriptList`). */
export interface TranscriptListReport {
  readonly count: number;
  readonly generatedAt?: string;
  readonly retentionMs?: number;
  readonly transcripts: readonly TranscriptSummaryReport[];
}

/** One past-session row in the renderable history view. */
export interface TranscriptView {
  /** The relay stream id to replay (`job:<jobKey>` for a job stream). */
  readonly stream: string;
  /** A single stable human label for the session's process instance / plan (falls back to the stream). */
  readonly label: string;
  /** The Camunda-8 job key, when the stream encodes one. */
  readonly jobKey?: string;
  /** open (still capturing) vs completed (the ephemeral run flushed & sealed). */
  readonly status: "open" | "completed";
  /** Retention lifecycle. */
  readonly lifecycle: "ephemeral" | "long-lived";
  /** A human-readable captured size, e.g. "1.2 KB". */
  readonly size: string;
  /** The raw captured byte length. */
  readonly byteLength: number;
  /** When the session was captured — completedAt when sealed, else createdAt. */
  readonly capturedAt: string;
  readonly instance?: string;
  readonly identity?: string;
  readonly host?: string;
}

/** The full renderable "past sessions" view. */
export interface TranscriptsView {
  readonly sessions: readonly TranscriptView[];
  readonly count: number;
  /** A human-readable retention window (e.g. "24h"), or undefined when unknown. */
  readonly retention?: string;
}

/** A single stable human label for a captured session's process instance / plan (empty parts dropped). */
function sessionLabel(t: TranscriptSummaryReport): string {
  const parts: string[] = [];
  if (t.bpmnProcessId !== undefined) parts.push(t.bpmnProcessId);
  if (t.elementId !== undefined) parts.push(t.elementId);
  if (t.processInstanceKey !== undefined) parts.push(`inst ${t.processInstanceKey}`);
  if (t.planKey !== undefined) parts.push(t.planKey);
  if (parts.length > 0) return parts.join(" \u00b7 ");
  if (t.jobKey !== undefined) return `job ${t.jobKey}`;
  return t.stream;
}

/** Render a byte count as a compact human string (B / KB / MB), stable and locale-free. */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Render a retention window (ms) as a compact human string (e.g. "24h", "30m", "45s"). */
export function humanDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function sessionView(t: TranscriptSummaryReport): TranscriptView {
  return {
    stream: t.stream,
    label: sessionLabel(t),
    ...(t.jobKey !== undefined ? { jobKey: t.jobKey } : {}),
    status: t.status,
    lifecycle: t.lifecycle,
    size: humanBytes(t.byteLength),
    byteLength: t.byteLength,
    capturedAt: t.completedAt ?? t.createdAt,
    ...(t.instance !== undefined ? { instance: t.instance } : {}),
    ...(t.identity !== undefined ? { identity: t.identity } : {}),
    ...(t.host !== undefined ? { host: t.host } : {}),
  };
}

/**
 * Derive the renderable "past sessions" view from the app's transcript list report.
 *
 * Pure and total: it re-sorts sessions newest-captured-first (stable on stream id) so the view is
 * diff-friendly regardless of the report's incoming order; no input mutates and no I/O happens.
 */
export function transcriptsView(report: TranscriptListReport): TranscriptsView {
  const sessions = report.transcripts
    .map(sessionView)
    .sort((a, b) => {
      const byTime = b.capturedAt.localeCompare(a.capturedAt);
      return byTime !== 0 ? byTime : a.stream.localeCompare(b.stream);
    });
  const retention = humanDuration(report.retentionMs);
  return {
    sessions,
    count: sessions.length,
    ...(retention !== undefined ? { retention } : {}),
  };
}
