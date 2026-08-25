// nano-workforce — the agent-job transcript URL contract (ADR 0006 §4b, Stage 0 / #543).
//
// The zero-infra correlation slice: on agentic job completion the completing worker emits a
// `transcriptUrl` output variable pointing at the durable HTTP transcript endpoint for its own
// `jobKey`, so Nano Explorer's variables panel links a process run to its agent transcript with no
// Explorer change and no new correlation infra (that sharper element-instance keying is Stage 1,
// #544). This module is the SINGLE SOURCE OF TRUTH for that URL's shape: the seed the dispatcher hands
// each agent job, the value the worker emits, and the tests all derive from it, so they cannot drift
// from one another. It is authored to match the endpoint route the `getAgenticTranscript` operation
// serves (`GET /app/api/agentic/transcripts/{stream}` in `openapi.yaml`) — see {@link TRANSCRIPT_STREAM_PATH}.
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
 *  trailing slash so a `{stream}` id appends cleanly. This is the app-tier authoring used to BUILD the
 *  transcript URL (the seed the dispatcher hands each agent job, the value the worker emits, and the
 *  tests) — the single origin those derive from, so they cannot drift from one another. It is NOT the
 *  sole authoring of the route string itself: the endpoint route is declared by the `getAgenticTranscript`
 *  operation (`GET /app/api/agentic/transcripts/{stream}` in `openapi.yaml`), and the cockpit embed
 *  carries its own module-anchored default (`pages/cockpit/mount.js`). Keep this value in step with that
 *  route. */
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
