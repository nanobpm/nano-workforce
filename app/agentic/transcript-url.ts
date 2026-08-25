// nano-workforce — the agent-job transcript URL contract (ADR 0006 §4b, Stage 0 / #543).
//
// The zero-infra correlation slice: on agentic job completion the completing worker emits a
// `transcriptUrl` output variable pointing at the durable HTTP transcript endpoint for its own
// `jobKey`, so Nano Explorer's variables panel links a process run to its agent transcript with no
// Explorer change and no new correlation infra (that sharper element-instance keying is Stage 1,
// #544). This module is the SINGLE SOURCE OF TRUTH for that URL's shape so the endpoint route
// (`operations/getAgenticTranscript.ts`, `GET /app/api/agentic/transcripts/{stream}`), the seed the
// dispatcher hands each agent job, and the tests never drift apart.
//
// The value is worker-supplied because only the completing worker knows its own `jobKey` (the engine
// exposes no job/element/process key to an output-mapping FEEL context — it is job metadata, not a
// variable). So the app SEEDS the base URL onto the agent job (`transcriptUrlBase`) and the worker
// appends its jobKey-scoped stream id, keeping the fleet worker app-agnostic (a bare concatenation)
// while this module owns every path segment.

import { publicBaseUrl } from "../blackboard.ts";
import { jobStream } from "./correlation.ts";

/** The job-output variable a completed agent job carries its transcript URL on (rendered by Explorer). */
export const TRANSCRIPT_URL_VAR = "transcriptUrl";

/** The input variable the dispatcher seeds onto an agent job so the worker can build {@link TRANSCRIPT_URL_VAR}
 *  by appending its own jobKey-scoped stream — the worker never needs to know the app's mount path. */
export const TRANSCRIPT_URL_BASE_VAR = "transcriptUrlBase";

/** The control-API path (under the app mount) the transcript stream endpoint is served at, ending in a
 *  trailing slash so a `{stream}` id appends cleanly. Mirrors `operations/getAgenticTranscript.ts`
 *  (`GET /app/api/agentic/transcripts/{stream}`) — the ONE place this path string is authored. */
const TRANSCRIPT_STREAM_PATH = "/app/api/agentic/transcripts/";

/**
 * The externally-reachable base a worker prepends to its jobKey-scoped stream id to form the
 * transcript URL: `<publicBaseUrl>/app/api/agentic/transcripts/`. The worker appends `job:<jobKey>`
 * ({@link jobStream}). Trailing slash included so the concatenation is a bare append.
 */
export function transcriptUrlBaseFor(base: string = publicBaseUrl()): string {
  return `${base}${TRANSCRIPT_STREAM_PATH}`;
}

/**
 * The full durable transcript URL for a completed job's `jobKey` — the value a worker emits on
 * {@link TRANSCRIPT_URL_VAR}. Derived from {@link transcriptUrlBaseFor} + {@link jobStream} so it can
 * never disagree with the base the dispatcher seeds or the endpoint route it resolves to.
 */
export function transcriptUrlForJob(jobKey: string, base: string = publicBaseUrl()): string {
  return `${transcriptUrlBaseFor(base)}${jobStream(jobKey)}`;
}
