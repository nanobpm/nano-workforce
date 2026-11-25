// Deterministic unit coverage for `pollFrictionSweep` (issue #1100) — the friction sweep's opt-in
// switch and interval pacing (overlap is owned by the in-process lease, not the poller). Drives the exported poller against a stub EngineClient
// and a stub DataLayer (only `table("friction_sweeps").get` is read).
//
// `pollFrictionSweep` paces itself via a MODULE-LEVEL `lastFrictionTick`, so each test imports a
// FRESH (cache-busted) copy of `service.ts` to isolate that state.
import { test } from "node:test";
import { assertEquals, assertRejects } from "#test-assert";
import type { DataLayer, EngineClient } from "@nanobpm/urban";

function stubEngine(opts: { active?: string[]; failStart?: boolean } = {}) {
  const created: { processDefinitionId: string; variables: Record<string, unknown> }[] = [];
  const engine = {
    searchProcessInstances: (filter?: { processDefinitionId?: string; state?: string }) =>
      Promise.resolve(
        filter?.processDefinitionId === "friction-sweep" && filter?.state === "ACTIVE"
          ? (opts.active ?? []).map((k) => ({ processInstanceKey: k, state: "ACTIVE" }))
          : [],
      ),
    createInstance: (input: { processDefinitionId: string; variables: Record<string, unknown> }) => {
      if (opts.failStart) return Promise.reject(new Error("engine unavailable"));
      created.push(input);
      return Promise.resolve({ processInstanceKey: `PI-${created.length}` });
    },
  };
  return { engine: engine as unknown as EngineClient, created };
}

/** A DataLayer whose `friction_sweeps` table holds the given sweep_key → status rows. */
function stubData(rows: Record<string, string> = {}): DataLayer {
  const data = {
    table: () => ({
      get: (key: string) => Promise.resolve(rows[key] === undefined ? undefined : { sweep_key: key, status: rows[key] }),
    }),
  };
  return data as unknown as DataLayer;
}

async function freshPoller(): Promise<(data: DataLayer, engine: EngineClient) => Promise<void>> {
  const mod = await import(`./service.ts?iso=${Date.now()}-${Math.random()}`);
  return mod.pollFrictionSweep;
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

const ON = { NANO_FRICTION_REPO: "acme/friction", NANO_FRICTION_INTERVAL: "PT12H" };

test("pollFrictionSweep: NANO_FRICTION_REPO unset → no instance ever starts", async () => {
  const poll = await freshPoller();
  const { engine, created } = stubEngine();
  await withEnv({ NANO_FRICTION_REPO: undefined }, () => poll(stubData(), engine));
  await withEnv({ NANO_FRICTION_REPO: "   " }, () => poll(stubData(), engine));
  assertEquals(created.length, 0, "unset/blank repo → sweep off");
});

test("pollFrictionSweep: set → exactly one instance per interval", async () => {
  const poll = await freshPoller();
  const { engine, created } = stubEngine();
  await withEnv(ON, () => poll(stubData(), engine));
  assertEquals(created.length, 1, "the first tick starts a sweep");
  assertEquals(created[0].processDefinitionId, "friction-sweep");
  await withEnv(ON, () => poll(stubData(), engine));
  assertEquals(created.length, 1, "a tick inside the interval is suppressed");
});

test("pollFrictionSweep: the interval elapsing allows the next start", async () => {
  const poll = await freshPoller();
  const { engine, created } = stubEngine();
  const realNow = Date.now;
  const t0 = realNow();
  try {
    Date.now = () => t0;
    await withEnv(ON, () => poll(stubData(), engine));
    Date.now = () => t0 + 12 * 60 * 60 * 1000 - 1;
    await withEnv(ON, () => poll(stubData(), engine));
    assertEquals(created.length, 1, "just inside the interval → suppressed");
    Date.now = () => t0 + 12 * 60 * 60 * 1000;
    await withEnv(ON, () => poll(stubData(), engine));
    assertEquals(created.length, 2, "interval elapsed → next sweep");
  } finally {
    Date.now = realNow;
  }
});

test("pollFrictionSweep: an ACTIVE (possibly wedged) prior instance never blocks — the lease owns overlap", async () => {
  for (const rows of [{}, { "PI-PRIOR": "collected" }, { "PI-PRIOR": "filed" }] as Record<string, string>[]) {
    const poll = await freshPoller();
    const { engine, created } = stubEngine({ active: ["PI-PRIOR"] });
    await withEnv(ON, () => poll(stubData(rows), engine));
    assertEquals(created.length, 1, `an ACTIVE prior instance (${JSON.stringify(rows)}) must not wedge the sweep`);
  }
});

test("pollFrictionSweep: a failed start leaves the tick un-advanced so the next pass retries", async () => {
  const poll = await freshPoller();
  const failing = stubEngine({ failStart: true });
  await assertRejects(() => withEnv(ON, () => poll(stubData(), failing.engine)), Error, "engine unavailable");
  const healthy = stubEngine();
  await withEnv(ON, () => poll(stubData(), healthy.engine));
  assertEquals(healthy.created.length, 1, "the retry is not suppressed");
});

test("pollFrictionSweep: a zero/malformed interval falls back to the default, never free-runs", async () => {
  for (const iv of ["PT0S", "garbage"]) {
    const poll = await freshPoller();
    const { engine, created } = stubEngine();
    await withEnv({ ...ON, NANO_FRICTION_INTERVAL: iv }, () => poll(stubData(), engine));
    await withEnv({ ...ON, NANO_FRICTION_INTERVAL: iv }, () => poll(stubData(), engine));
    assertEquals(created.length, 1, `${iv}: the immediate re-tick is suppressed`);
  }
});
