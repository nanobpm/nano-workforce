// Unit coverage for the transcript-URL SSOT (#543): the base a worker prepends and the full per-job
// URL it emits must derive from ONE path string and the ONE jobStream() encoder, so the seed the
// dispatcher hands each agent job, the endpoint route, and the tests can never drift apart.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { jobStream } from "./correlation.ts";
import {
  TRANSCRIPT_URL_BASE_VAR,
  TRANSCRIPT_URL_VAR,
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
