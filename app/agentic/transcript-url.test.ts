// Unit coverage for the transcript-URL SSOT (#543): the base a worker prepends and the full per-job
// URL it emits must derive from ONE path string and the ONE jobStream() encoder, so the seed the
// dispatcher hands each agent job, the endpoint route, and the tests can never drift apart.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { jobStream } from "./correlation.ts";
import {
  TRANSCRIPT_URL_BASE_VAR,
  TRANSCRIPT_URL_VAR,
  transcriptReadUrlFor,
  transcriptUrlBaseFor,
  transcriptUrlForJob,
} from "./transcript-url.ts";

const BASE = "https://nano.example.com";

test("the variable names are the stable wire contract Explorer and the worker agree on", () => {
  assertEquals(TRANSCRIPT_URL_VAR, "transcriptUrl");
  assertEquals(TRANSCRIPT_URL_BASE_VAR, "transcriptUrlBase");
});

test("transcriptUrlBaseFor: the seeded base is the app mount's transcript endpoint, trailing-slashed", () => {
  assertEquals(transcriptUrlBaseFor(BASE), `${BASE}/app/api/agentic/transcripts/`);
});

test("transcriptUrlForJob: the full URL is the base + the jobKey-scoped stream id", () => {
  const jobKey = "2251799813685249";
  assertEquals(transcriptUrlForJob(jobKey, BASE), `${BASE}/app/api/agentic/transcripts/${jobStream(jobKey)}`);
});

test("derivation: transcriptUrlForJob is exactly transcriptUrlBaseFor + jobStream — no second path source", () => {
  // This is the anti-drift invariant: the value a worker emits and the base the dispatcher seeds share
  // a single origin, so a route change in one place can never leave the other pointing at a 404.
  const jobKey = "job-abc";
  assertEquals(transcriptUrlForJob(jobKey, BASE), `${transcriptUrlBaseFor(BASE)}${jobStream(jobKey)}`);
});

// #744 — the proxy-safe single-stream READ form. A worker-instance stream id CONTAINS a slash
// (`34:<instance>/<jobKey>`); the Nano Console gateway proxy peels exactly one percent-encoding
// layer off the request before the app routes it, so an encoded slash (%2F) in a PATH segment
// arrives as a real / and splits the id into an extra segment — the app matches no route and
// answers 404 {"error":"no such operation"}. Carrying the id as a QUERY value makes the read
// structurally immune: a / is legal inside a query value, encoded or not.
const SLASH_STREAM = "34:joshs-macbook-pro-copilot-3d6ee882/13859";
const ENDPOINT = `${BASE}/app/api/agentic/transcripts`;

/** Non-empty path-segment count of a URL — what a route matcher counts. */
function pathSegments(u: string): number {
  return new URL(u).pathname.split("/").filter((s) => s !== "").length;
}

test("transcriptReadUrlFor: the stream id rides the query, never a path segment (#744)", () => {
  const url = new URL(transcriptReadUrlFor(ENDPOINT, SLASH_STREAM));
  assertEquals(url.pathname, "/app/api/agentic/transcripts");
  assertEquals(url.searchParams.get("stream"), SLASH_STREAM);
});

test("transcriptReadUrlFor: an explicit from offset appends as a query param", () => {
  const url = new URL(transcriptReadUrlFor(ENDPOINT, "job:6494", 42));
  assertEquals(url.searchParams.get("stream"), "job:6494");
  assertEquals(url.searchParams.get("from"), "42");
});

test("#744 failure class: a gateway peel of one encoding layer breaks an encoded slash in a PATH segment but not a query value", () => {
  // The legacy path form matches the `/app/api/agentic/transcripts/{stream}` route (5 segments)
  // ONLY while the %2F stays encoded.
  const pathForm = `${ENDPOINT}/${encodeURIComponent(SLASH_STREAM)}`;
  assertEquals(pathSegments(pathForm), 5);
  // The gateway peels exactly one percent-encoding layer before the app routes (#744 evidence):
  // %2F becomes a real /, the app sees 6 segments, no route matches → 404 → the cockpit's replay
  // fetch throws and the terminal region renders empty.
  assertEquals(pathSegments(decodeURIComponent(pathForm)), 6);

  // The query form is immune to the SAME peel: the pathname stays the collection route (4
  // segments) before and after decoding, and the slash-bearing id round-trips intact.
  const queryForm = transcriptReadUrlFor(ENDPOINT, SLASH_STREAM);
  assertEquals(pathSegments(queryForm), 4);
  const peeled = new URL(decodeURIComponent(queryForm));
  assertEquals(pathSegments(peeled.href), 4);
  assertEquals(peeled.searchParams.get("stream"), SLASH_STREAM);
});
