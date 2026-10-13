// Deterministic unit coverage for `pollEscalationSteward` (issue #889 review) — the steward tick's
// pacing + master-switch path, previously untested. Drives the exported poller against a stub
// EngineClient and asserts the four branches that decide whether the steward runs at all:
//   • the master switch (`NANO_ESCALATION_STEWARD` off) — never starts an instance;
//   • interval pacing (`NANO_ESCALATION_STEWARD_INTERVAL`) — a tick inside the interval is suppressed;
//   • active-instance suppression — a still-ACTIVE prior run makes the tick a no-op;
//   • failed-start retry — a `createInstance` throw leaves the tick un-advanced so the next pass retries.
//
// `pollEscalationSteward` paces itself via a MODULE-LEVEL `lastStewardTick`, so each test imports a
// FRESH (cache-busted) copy of `service.ts` to isolate that state — otherwise one test's tick would
// suppress the next test's first tick through the shared interval clock.
import { test } from "node:test";
import { assertEquals, assertRejects } from "#test-assert";
import type { EngineClient } from "@nanobpm/urban";

/** A stub EngineClient capturing createInstance calls and reporting a configurable ACTIVE set. */
function stubEngine(opts: { active?: string[]; failStart?: boolean } = {}) {
  const created: { processDefinitionId: string; variables: Record<string, unknown> }[] = [];
  const engine = {
    searchProcessInstances: (filter?: { processDefinitionId?: string; state?: string }) =>
      Promise.resolve(
        filter?.processDefinitionId === "escalation-steward" && filter?.state === "ACTIVE"
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

/** Import a FRESH `service.ts` (isolated `lastStewardTick`) and return its poller. */
async function freshPoller(): Promise<(engine: EngineClient) => Promise<void>> {
  const mod = await import(`./service.ts?iso=${Date.now()}-${Math.random()}`);
  return mod.pollEscalationSteward;
}

/** Run `fn` with the given env vars set, restoring process.env afterwards. */
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

const STEWARD_ENV = { NANO_ESCALATION_STEWARD: "1", NANO_ESCALATION_STEWARD_INTERVAL: "PT30M" };

test("pollEscalationSteward: the master switch OFF never starts an instance", async () => {
  const poll = await freshPoller();
  const { engine, created } = stubEngine();
  await withEnv({ NANO_ESCALATION_STEWARD: "off" }, () => poll(engine));
  assertEquals(created.length, 0, "disabled → no instance started");
});

test("pollEscalationSteward: a still-ACTIVE prior run suppresses the tick (overlap guard)", async () => {
  const poll = await freshPoller();
  const { engine, created } = stubEngine({ active: ["PI-PRIOR"] });
  await withEnv(STEWARD_ENV, () => poll(engine));
  assertEquals(created.length, 0, "an active prior run suppresses the start");
});

test("pollEscalationSteward: a failed start leaves the tick un-advanced so the next pass retries immediately", async () => {
  const poll = await freshPoller();
  // First pass: the engine start THROWS. The tick must NOT advance (lastStewardTick stays 0), so a
  // second pass within the interval still attempts a start rather than suppressing retries.
  const failing = stubEngine({ failStart: true });
  await assertRejects(() => withEnv(STEWARD_ENV, () => poll(failing.engine)), Error, "engine unavailable");
  assertEquals(failing.created.length, 0, "the failed start recorded nothing");

  // Immediately retry (same module clock, well inside the interval) with a now-healthy engine: the
  // un-advanced tick lets the start straight through.
  const healthy = stubEngine();
  await withEnv(STEWARD_ENV, () => poll(healthy.engine));
  assertEquals(healthy.created.length, 1, "the retry is not suppressed by the failed attempt");
  assertEquals(healthy.created[0].processDefinitionId, "escalation-steward");
});

test("pollEscalationSteward: interval pacing suppresses a tick that lands inside the interval", async () => {
  const poll = await freshPoller();
  const { engine, created } = stubEngine();
  // First tick starts an instance and advances the module clock.
  await withEnv(STEWARD_ENV, () => poll(engine));
  assertEquals(created.length, 1, "the first tick starts an instance");
  // A second tick immediately after (well inside the 30-min interval) is suppressed by pacing.
  await withEnv(STEWARD_ENV, () => poll(engine));
  assertEquals(created.length, 1, "a tick inside the interval is suppressed");
});

test("pollEscalationSteward: a zero/negative interval is clamped so the steward never free-runs every poll", async () => {
  const poll = await freshPoller();
  const { engine, created } = stubEngine();
  // PT0S parses to 0 → clamped to the 30-min default. The first tick starts; the immediate second is
  // still suppressed by the clamped interval (a 0-interval must never start every poll).
  await withEnv({ NANO_ESCALATION_STEWARD: "1", NANO_ESCALATION_STEWARD_INTERVAL: "PT0S" }, () => poll(engine));
  assertEquals(created.length, 1, "the first tick starts even with a zero interval");
  await withEnv({ NANO_ESCALATION_STEWARD: "1", NANO_ESCALATION_STEWARD_INTERVAL: "PT0S" }, () => poll(engine));
  assertEquals(created.length, 1, "a zero interval is clamped — the immediate re-tick is suppressed");
});

test("pollEscalationSteward: the steward start seeds the canonical agentSlaTimeout so its agent boundary can fire", async () => {
  const poll = await freshPoller();
  const { engine, created } = stubEngine();
  await withEnv(STEWARD_ENV, () => poll(engine));
  assertEquals(created.length, 1, "the tick starts an instance");
  // The `be_steward_sla` interrupting timer boundary (escalation-steward.bpmn) evaluates
  // `<bpmn:timeDuration>=agentSlaTimeout</…>` at timer creation (FEEL). If the start does not seed
  // `agentSlaTimeout` the boundary can never arm and a hung steward agent parks the instance ACTIVE
  // forever — the overlap guard then suppresses every later tick (issue #889 review). Assert the
  // seeded variable is a non-blank ISO-8601 duration (the canonical AGENT_SLA_TIMEOUT default).
  const seeded = created[0].variables.agentSlaTimeout;
  assertEquals(typeof seeded, "string", "agentSlaTimeout is seeded as a string");
  assertEquals(/^P/.test(seeded), true, `agentSlaTimeout is an ISO-8601 duration (got ${JSON.stringify(seeded)})`);
});
