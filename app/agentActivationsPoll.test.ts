// Issue #879: `pollAgentActivationsImpl` must persist, for every bounded agent job type, whether a
// worker ever leased the job — keyed by (processInstanceKey, jobType) — so a later SLA escalation can
// tell a never-activated (queue-starved) job from an activated one even after the boundary cancels it.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { getAgentJobActivation } from "./agentActivationLedger.ts";
import { pollAgentActivationsImpl } from "./service.ts";
import { memDataFor } from "../test/worldDb.ts";

// biome-ignore lint/suspicious/noExplicitAny: test stub over the engine job-search wire shape.
type JobItem = any;

function jobsFetch(items: JobItem[], opts: { ignoreTypeFilter?: boolean } = {}) {
  return (_url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    const t = body.filter?.type;
    const wanted: string[] | null = Array.isArray(t?.$in) ? t.$in : typeof t === "string" ? [t] : null;
    const out = opts.ignoreTypeFilter || wanted == null ? items : items.filter((j) => wanted.includes(j.type ?? ""));
    return Promise.resolve(
      new Response(JSON.stringify({ items: out }), { status: 200, headers: { "content-type": "application/json" } }),
    );
  };
}

const headers = { "content-type": "application/json" };

test("poll records a queued (unleased) agent job as not-yet-activated", async () => {
  const { data } = memDataFor(["119_agent_job_activations.sql"]);
  const prev = globalThis.fetch;
  globalThis.fetch = jobsFetch([
    { type: "senior:feature", processInstanceKey: "PI-10", state: "CREATED" },
  ]) as typeof fetch;
  try {
    await pollAgentActivationsImpl(data, "http://engine/v2", headers);
  } finally {
    globalThis.fetch = prev;
  }
  const row = await getAgentJobActivation(data, "PI-10", "senior:feature");
  assertEquals(row?.activated_at, null);
  assertEquals(row?.worker, null);
});

test("poll records an activation when a leasing worker appears, across passes", async () => {
  const { data } = memDataFor(["119_agent_job_activations.sql"]);
  const prev = globalThis.fetch;
  try {
    globalThis.fetch = jobsFetch([
      { type: "senior:trial-merge", processInstanceKey: "PI-11", state: "CREATED" },
    ]) as typeof fetch;
    await pollAgentActivationsImpl(data, "http://engine/v2", headers);
    assertEquals((await getAgentJobActivation(data, "PI-11", "senior:trial-merge"))?.activated_at, null);

    globalThis.fetch = jobsFetch([
      { type: "senior:trial-merge", processInstanceKey: "PI-11", worker: "agent-m", deadline: "2024-01-01T00:15:00Z", state: "CREATED" },
    ]) as typeof fetch;
    await pollAgentActivationsImpl(data, "http://engine/v2", headers);
    const row = await getAgentJobActivation(data, "PI-11", "senior:trial-merge");
    assertEquals(row?.worker, "agent-m");
    assertEquals(typeof row?.activated_at === "string", true);
  } finally {
    globalThis.fetch = prev;
  }
});

test("poll defensively excludes a non-agent job even if the wire $in filter is ignored", async () => {
  const { data } = memDataFor(["119_agent_job_activations.sql"]);
  const prev = globalThis.fetch;
  globalThis.fetch = jobsFetch(
    [{ type: "pr.capture-head", processInstanceKey: "PI-12", worker: "host-internal", state: "CREATED" }],
    { ignoreTypeFilter: true },
  ) as typeof fetch;
  try {
    await pollAgentActivationsImpl(data, "http://engine/v2", headers);
  } finally {
    globalThis.fetch = prev;
  }
  assertEquals(await getAgentJobActivation(data, "PI-12", "pr.capture-head"), undefined);
});

test("poll skips an item with no process instance to key on", async () => {
  const { data } = memDataFor(["119_agent_job_activations.sql"]);
  const prev = globalThis.fetch;
  globalThis.fetch = jobsFetch([{ type: "senior:feature", state: "CREATED" }]) as typeof fetch;
  try {
    await pollAgentActivationsImpl(data, "http://engine/v2", headers);
  } finally {
    globalThis.fetch = prev;
  }
  assertEquals(await getAgentJobActivation(data, "", "senior:feature"), undefined);
});

test("poll leaves the ledger untouched when the engine search fails", async () => {
  const { data } = memDataFor(["119_agent_job_activations.sql"]);
  const prev = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(new Response("boom", { status: 500 }))) as typeof fetch;
  try {
    await pollAgentActivationsImpl(data, "http://engine/v2", headers);
  } finally {
    globalThis.fetch = prev;
  }
  assertEquals(await getAgentJobActivation(data, "PI-13", "senior:feature"), undefined);
});
