// Unit coverage for the transcript-URL SSOT (#543): the base a worker prepends and the full per-job
// URL it emits must derive from ONE path string and the ONE jobStream() encoder, so the seed the
// dispatcher hands each agent job, the endpoint route, and the tests can never drift apart.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { jobStream } from "./correlation.ts";
import {
  TRANSCRIPT_URL_BASE_VAR,
  TRANSCRIPT_URL_VAR,
  transcriptReadUrl,
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

const READ_ENDPOINT = "http://app.test/app/api/agentic/transcripts";

test("transcriptReadUrl: a slash-free stream id rides the query string, not a path segment (#744)", () => {
  // The proxy-safe read form: the stream id is a `stream` query param, so the endpoint pathname stays
  // exactly the transcripts collection — no extra path segment for a gateway proxy to (mis)route.
  const url = transcriptReadUrl(READ_ENDPOINT, "job:6494");
  assertEquals(url, `${READ_ENDPOINT}?stream=job%3A6494`);
  assertEquals(new URL(url).pathname, "/app/api/agentic/transcripts");
  assertEquals(new URL(url).searchParams.get("stream"), "job:6494");
});

test("transcriptReadUrl: a SLASH-BEARING past-session id survives as a query value, never a path split (#744)", () => {
  // The exact failure class from #744: a past-session stream id containing a `/`. In a path segment its
  // `%2F` is decoded back to a real `/` by the console gateway proxy → an extra path segment → 404. As a
  // query VALUE the `/` is never a path separator, so the id reaches the app intact behind any proxy.
  const stream = "34:joshs-macbook-pro-copilot-3d6ee882/13859";
  const url = transcriptReadUrl(READ_ENDPOINT, stream);
  const parsed = new URL(url);
  // The slash is encoded and confined to the query — the pathname carries NO part of the stream id.
  assertEquals(parsed.pathname, "/app/api/agentic/transcripts");
  assert(!parsed.pathname.includes("13859"), "the stream id must not leak into the path");
  assert(url.includes("%2F"), "the embedded slash is percent-encoded in the query string");
  // And it round-trips: the app decodes the query param back to the original slash-bearing id.
  assertEquals(parsed.searchParams.get("stream"), stream);
});

test("transcriptReadUrl: a positive `from` offset is appended; 0/undefined is omitted (endpoint default)", () => {
  assertEquals(transcriptReadUrl(READ_ENDPOINT, "job:1", 42), `${READ_ENDPOINT}?stream=job%3A1&from=42`);
  assertEquals(transcriptReadUrl(READ_ENDPOINT, "job:1", 0), `${READ_ENDPOINT}?stream=job%3A1`);
  assertEquals(transcriptReadUrl(READ_ENDPOINT, "job:1", undefined), `${READ_ENDPOINT}?stream=job%3A1`);
});
