// nano-workforce — the transcript READ projection (ADR 0056, H3 / #146, read path #222).
//
// The write path (relay.family.ts) flushes an ephemeral agent's PTY stream to a durable transcript on
// job completion; this module is the READ counterpart the advisory `GET /agentic/transcripts*`
// endpoints share. It projects a {@link TranscriptStore} row (+ its retained chunks) onto the wire
// shape and enriches it with the H6 correlation (`app/agentic/correlation.ts`) so a captured session
// lines up with "that process instance / this plan" — even after the ephemeral agent has exited.
//
// Correlation is BEST-EFFORT and advisory: the correlation registry is in-memory and only holds
// currently-linked jobs, so a completed session's process-instance / plan context is present only
// while the job is still live. The jobKey itself is always recoverable — it is encoded in the stream
// id (`job:<jobKey>`), so a past session is never anonymous even once its correlation has been released.
//
// Pure and side-effect-free apart from reading the store: no I/O beyond the injected store, so it is
// unit-testable on the injected env (Node, no browser), and never touches the engine or a BPMN flow.

import type { TranscriptChunk, TranscriptStore, TranscriptStream } from "@nanobpm/agentic/transcript";
import type { AgenticTranscript, AgenticTranscriptData } from "../../nano-generated/api-io.d.ts";
import { type CorrelationRegistry, jobKeyOfStream } from "./correlation.ts";
import type { AgenticCorrelationStore } from "./correlation-store.ts";
import { utf8ByteLength } from "./transcript-events.ts";

/** Total captured bytes across a set of retained chunks (UTF-8, the on-the-wire terminal encoding). */
export function byteLengthOf(chunks: readonly TranscriptChunk[]): number {
  let total = 0;
  for (const c of chunks) total += utf8ByteLength(c.chunk);
  return total;
}

/** The correlation fields (jobKey + engine context + worker attribution) a stream id resolves to, best-effort. */
interface CorrelationFields {
  jobKey?: string;
  processInstanceKey?: string;
  bpmnProcessId?: string;
  elementId?: string;
  planKey?: string;
  /** The worker instance that ran the job (durable — survives release / restart). */
  instance?: string;
  /** The worker's durable identity, when recorded. */
  identity?: string;
  /** The worker's host, when recorded. */
  host?: string;
}

/**
 * Resolve a stream id to its correlation fields. The jobKey is always decoded from a `job:<jobKey>`
 * stream id. Engine context (process instance / plan) + worker attribution (instance / identity /
 * host) come from the LIVE registry while the job is still linked, and fall back to the DURABLE store
 * (`AgenticCorrelationStore`) once the job has completed and its live correlation was released — so a
 * PAST session stays attributable to its worker after the worker exits or the process restarts.
 * Non-job streams yield an empty object.
 */
export function correlationFieldsFor(
  stream: string,
  correlation: CorrelationRegistry | undefined,
  durable?: AgenticCorrelationStore | undefined,
): CorrelationFields {
  const jobKey = jobKeyOfStream(stream);
  if (jobKey === undefined) return {};
  const fields: CorrelationFields = { jobKey };
  const context = correlation?.resolve(jobKey);
  if (context) {
    if (context.processInstanceKey !== undefined) fields.processInstanceKey = context.processInstanceKey;
    if (context.bpmnProcessId !== undefined) fields.bpmnProcessId = context.bpmnProcessId;
    if (context.elementId !== undefined) fields.elementId = context.elementId;
    if (context.planKey !== undefined) fields.planKey = context.planKey;
  }
  // Durable fallback: fill any field the live registry did not supply (a released past session, or a
  // worker-attribution field the in-memory registry never carried). Live values take precedence.
  const row = durable?.get(jobKey);
  if (row) {
    if (fields.processInstanceKey === undefined && row.processInstanceKey !== undefined) {
      fields.processInstanceKey = row.processInstanceKey;
    }
    if (fields.bpmnProcessId === undefined && row.bpmnProcessId !== undefined) fields.bpmnProcessId = row.bpmnProcessId;
    if (fields.elementId === undefined && row.elementId !== undefined) fields.elementId = row.elementId;
    if (fields.planKey === undefined && row.planKey !== undefined) fields.planKey = row.planKey;
    if (row.instance !== undefined) fields.instance = row.instance;
    if (row.identity !== undefined) fields.identity = row.identity;
    if (row.host !== undefined) fields.host = row.host;
  }
  return fields;
}

/** Project a stored transcript's metadata (+ its retained chunks) onto the list wire shape. */
export function toTranscript(
  meta: TranscriptStream,
  store: TranscriptStore,
  correlation: CorrelationRegistry | undefined,
  durable?: AgenticCorrelationStore | undefined,
): AgenticTranscript {
  const chunks = store.read(meta.stream);
  const out: AgenticTranscript = {
    stream: meta.stream,
    lifecycle: meta.lifecycle,
    status: meta.status,
    createdAt: meta.createdAt,
    nextOffset: meta.nextOffset,
    byteLength: byteLengthOf(chunks),
    chunkCount: chunks.length,
  };
  if (meta.completedAt !== undefined) out.completedAt = meta.completedAt;
  if (meta.firstOffset !== undefined) out.firstOffset = meta.firstOffset;
  const fields = correlationFieldsFor(meta.stream, correlation, durable);
  if (fields.jobKey !== undefined) out.jobKey = fields.jobKey;
  if (fields.processInstanceKey !== undefined) out.processInstanceKey = fields.processInstanceKey;
  if (fields.bpmnProcessId !== undefined) out.bpmnProcessId = fields.bpmnProcessId;
  if (fields.elementId !== undefined) out.elementId = fields.elementId;
  if (fields.planKey !== undefined) out.planKey = fields.planKey;
  if (fields.instance !== undefined) out.instance = fields.instance;
  if (fields.identity !== undefined) out.identity = fields.identity;
  if (fields.host !== undefined) out.host = fields.host;
  return out;
}

/** The filters {@link listTranscripts} understands (all optional; an empty filter returns everything). */
export interface TranscriptFilter {
  readonly jobKey?: string;
  readonly processInstanceKey?: string;
  readonly planKey?: string;
  /** The worker instance that ran the session (durable attribution) — powers the worker-history view. */
  readonly instance?: string;
  /** ISO-8601 lower bound (inclusive) on the session's createdAt. */
  readonly since?: string;
  /** ISO-8601 upper bound (inclusive) on the session's createdAt. */
  readonly until?: string;
}

/**
 * List every captured session projected to the wire shape, sorted newest-first by createdAt (then by
 * stream for a stable tie-break), after applying the (advisory) filters. jobKey / process-instance /
 * plan / instance filters match the correlation-enriched fields; since/until bound createdAt.
 */
export function listTranscripts(
  store: TranscriptStore,
  correlation: CorrelationRegistry | undefined,
  filter: TranscriptFilter = {},
  durable?: AgenticCorrelationStore | undefined,
): AgenticTranscript[] {
  const sinceMs = filter.since !== undefined ? Date.parse(filter.since) : undefined;
  const untilMs = filter.until !== undefined ? Date.parse(filter.until) : undefined;
  const rows = store
    .list()
    .map((meta) => toTranscript(meta, store, correlation, durable))
    .filter((t) => {
      if (filter.jobKey !== undefined && t.jobKey !== filter.jobKey) return false;
      if (filter.processInstanceKey !== undefined && t.processInstanceKey !== filter.processInstanceKey) return false;
      if (filter.planKey !== undefined && t.planKey !== filter.planKey) return false;
      if (filter.instance !== undefined && t.instance !== filter.instance) return false;
      const createdMs = Date.parse(t.createdAt);
      if (sinceMs !== undefined && Number.isFinite(createdMs) && createdMs < sinceMs) return false;
      if (untilMs !== undefined && Number.isFinite(createdMs) && createdMs > untilMs) return false;
      return true;
    });
  // Newest session first (a "past sessions" feed reads best most-recent-first); stable on stream id.
  rows.sort((a, b) => {
    const byTime = b.createdAt.localeCompare(a.createdAt);
    return byTime !== 0 ? byTime : a.stream.localeCompare(b.stream);
  });
  return rows;
}

/**
 * Fetch a stored transcript's bytes from offset `from` (inclusive), projected onto the range/offset
 * wire shape — the SAME resume-from-offset contract the live terminal renders, so the cockpit replays
 * a closed stream through its existing renderer. Returns undefined when the stream has no transcript.
 */
export function readTranscriptFrom(
  stream: string,
  from: number,
  store: TranscriptStore,
  correlation: CorrelationRegistry | undefined,
  durable?: AgenticCorrelationStore | undefined,
): AgenticTranscriptData | undefined {
  const meta = store.get(stream);
  if (meta === undefined) return undefined;
  const slice = store.since(stream, from);
  const entries = slice.entries.map((c) => ({ offset: c.offset, chunk: c.chunk }));
  const out: AgenticTranscriptData = {
    stream: meta.stream,
    lifecycle: meta.lifecycle,
    status: meta.status,
    createdAt: meta.createdAt,
    nextOffset: slice.nextOffset,
    byteLength: byteLengthOf(slice.entries),
    chunkCount: entries.length,
    from,
    gap: slice.gap,
    entries,
  };
  if (meta.completedAt !== undefined) out.completedAt = meta.completedAt;
  const fields = correlationFieldsFor(meta.stream, correlation, durable);
  if (fields.jobKey !== undefined) out.jobKey = fields.jobKey;
  if (fields.processInstanceKey !== undefined) out.processInstanceKey = fields.processInstanceKey;
  if (fields.bpmnProcessId !== undefined) out.bpmnProcessId = fields.bpmnProcessId;
  if (fields.elementId !== undefined) out.elementId = fields.elementId;
  if (fields.planKey !== undefined) out.planKey = fields.planKey;
  if (fields.instance !== undefined) out.instance = fields.instance;
  if (fields.identity !== undefined) out.identity = fields.identity;
  if (fields.host !== undefined) out.host = fields.host;
  return out;
}
