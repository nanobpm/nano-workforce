// Adversarial completeness / regression suite for the INTER-EPIC dependency feature (issue #292,
// slice S5). Where the per-slice tests each prove one layer, THIS suite pins the whole feature to its
// worked example end to end and fails loudly if ANY of the eight load-bearing guarantees regresses:
//
//   producer epic `owner/repo#1` publishes a capability (a Release of `@scope/pkg` whose provenance
//   carries `#1`)  →  consumer epic `owner/repo#2` depends on it via the edge
//   { consumer: #2, producer: #1, package: @scope/pkg, capabilityRef: #1 }.
//
// Each test is labelled `S5 Pn` for the property it guards. The properties that are fundamentally
// ENGINE behaviours (a red gate HOLDS wave 0; a never-publishing producer escalates on a bounded
// timer; the SLA auto-abandon prevents an eternal hang) are proven on the real `plan-fanout.bpmn` in
// the sibling e2e (e2e/inter-epic-dependency.e2e.ts); here we drive the real admission door, the pure
// planner lowering, the capability resolver, and the operator projection — deterministic, no network.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import type { AppApi, DataLayer, EngineClient } from "@nanobpm/urban";
import { resetDefaultBranchCache } from "./github.ts";
import type { PlanDep } from "./plan.ts";
import { EpicSetValidationError, validateEpicSet } from "./plan.ts";
import { capabilityProbeForEdge, deriveEpicSchedule, lowerAdmittedSet } from "./planLowering.ts";
import { withTrackingViews } from "../test/trackingViews.ts";
import {
  type GithubRelease,
  matchCapability,
  newestPublishedVersion,
  type ProbeExec,
  probeOnce,
} from "./readiness.ts";
import { deriveWaitGate, type WaitGateLifecycle } from "./waitGate.ts";

// ── the worked example ───────────────────────────────────────────────────────────────────────────
const REPO = "owner/repo";
const PRODUCER = `${REPO}#1`;
const CONSUMER = `${REPO}#2`;
const PKG = "@scope/pkg";
const CAP_REF = PRODUCER; // the producer's own issue handle is the capability ref

const workedEdge: PlanDep = {
  plan_key: CONSUMER,
  depends_on_plan_key: PRODUCER,
  package: PKG,
  capability_ref: CAP_REF,
  created_at: "2026-01-01T00:00:00.000Z",
};

/** A GitHub Release whose `## Provenance` section references the given issue numbers. */
const rel = (tag: string, refs: number[]): GithubRelease => ({
  tag,
  body: `Automated release of \`${tag}\`.\n\n## Provenance\n${refs.map((n) => `- #${n}`).join("\n")}\n`,
});

// ── in-memory app double (data + engine) — mirrors planLowering.test / the admission integration ──
function makeApp(seedPlans: Record<string, unknown>[] = []) {
  const tables = new Map<string, Record<string, unknown>[]>();
  tables.set("plans", [...seedPlans]);
  const started: { processDefinitionId: string; variables?: Record<string, unknown> }[] = [];
  const table = (name: string, key: string) => {
    const rows = tables.get(name) ?? (() => {
      const fresh: Record<string, unknown>[] = [];
      tables.set(name, fresh);
      return fresh;
    })();
    return {
      get: (k: unknown) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
      find: (q: Record<string, unknown>) =>
        Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
      insert: (r: Record<string, unknown>) => {
        rows.push(r);
        return Promise.resolve(r);
      },
      update: (k: unknown, patch: Record<string, unknown>) => {
        const row = rows.find((r) => r[key] === k);
        if (row) Object.assign(row, patch);
        return Promise.resolve(row);
      },
      delete: (k: unknown) => {
        const i = rows.findIndex((r) => r[key] === k);
        if (i >= 0) rows.splice(i, 1);
        return Promise.resolve();
      },
    };
  };
  const app = {
    data: { table: withTrackingViews(table) },
    engine: {
      createInstance: (req: { processDefinitionId: string; variables?: Record<string, unknown> }) => {
        started.push(req);
        return Promise.resolve({ processInstanceKey: `PI-${started.length}` });
      },
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as AppApi;
  return { app, started, tables };
}

// ── hermetic github transport (base-ref admission), mirroring the admission integration harness ────
interface GithubState {
  repo: string;
  defaultBranch: string;
  branches: Set<string>;
  creates: { ref: string; sha: string }[];
}

function githubFetch(state: GithubState) {
  return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = u.pathname;
    const json = (obj: unknown, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && path === `/repos/${state.repo}`) {
      return Promise.resolve(json({ default_branch: state.defaultBranch }));
    }
    const refPrefix = `/repos/${state.repo}/git/ref/heads/`;
    if (method === "GET" && path.startsWith(refPrefix)) {
      const branch = decodeURIComponent(path.slice(refPrefix.length));
      if (!state.branches.has(branch)) return Promise.resolve(new Response("Not Found", { status: 404 }));
      return Promise.resolve(json({ ref: `refs/heads/${branch}`, object: { sha: `${branch}-sha` } }));
    }
    if (method === "POST" && path === `/repos/${state.repo}/git/refs`) {
      // biome-ignore lint/plugin: runtime/framework contract boundary for external data shape
      const bodyObj = JSON.parse(String(init?.body ?? "{}")) as { ref?: string; sha?: string };
      const ref = String(bodyObj.ref ?? "");
      const sha = String(bodyObj.sha ?? "");
      const branch = ref.replace(/^refs\/heads\//, "");
      if (state.branches.has(branch)) return Promise.resolve(json({ message: "Reference already exists" }, 422));
      state.creates.push({ ref, sha });
      state.branches.add(branch);
      return Promise.resolve(json({ ref }, 201));
    }
    return Promise.resolve(new Response(`unexpected ${method} ${path}`, { status: 500 }));
  };
}

async function withGithub<T>(state: GithubState, fn: () => Promise<T>): Promise<T> {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevTok = process.env["GITHUB_TOKEN"];
  const prevFetch = globalThis.fetch;
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  process.env["GITHUB_TOKEN"] = "tok";
  resetDefaultBranchCache();
  globalThis.fetch = githubFetch(state) as typeof fetch;
  try {
    return await fn();
  } finally {
    resetDefaultBranchCache();
    globalThis.fetch = prevFetch;
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    if (prevTok === undefined) delete process.env["GITHUB_TOKEN"];
    else process.env["GITHUB_TOKEN"] = prevTok;
  }
}

function freshGithub(extraBranches: string[] = []): GithubState {
  return { repo: REPO, defaultBranch: "main", branches: new Set(["main", ...extraBranches]), creates: [] };
}

function input(body: unknown) {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: minimal request stub for the operation edge
    req: { method: "POST", path: "/", query: new URLSearchParams(), headers: new Headers(), text: async () => "" } as any,
    params: {},
    query: {},
    body,
  };
}

// The delegate is imported lazily inside each door test so the pure-property tests need no github env.
async function callDoor(app: AppApi, body: unknown) {
  const { default: startEpicSet } = await import("../operations/startEpicSet.ts");
  // biome-ignore lint/suspicious/noExplicitAny: the operation returns an HTTP-shaped result envelope
  return startEpicSet(input(body), app) as Promise<any>;
}

const rowsFor = (tables: Map<string, Record<string, unknown>[]>, name: string) => tables.get(name) ?? [];

// A pure in-memory data/engine double (no github) for the lowering-level property tests.
function makeData() {
  const tables = new Map<string, Record<string, unknown>[]>();
  const table = (name: string, key: string) => {
    const rows = tables.get(name) ?? (() => {
      const fresh: Record<string, unknown>[] = [];
      tables.set(name, fresh);
      return fresh;
    })();
    return {
      get: (k: unknown) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
      find: (q: Record<string, unknown>) =>
        Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
      insert: (r: Record<string, unknown>) => {
        rows.push(r);
        return Promise.resolve(r);
      },
      update: (k: unknown, patch: Record<string, unknown>) => {
        const row = rows.find((r) => r[key] === k);
        if (row) Object.assign(row, patch);
        return Promise.resolve(row);
      },
      delete: (k: unknown) => {
        const i = rows.findIndex((r) => r[key] === k);
        if (i >= 0) rows.splice(i, 1);
        return Promise.resolve();
      },
    };
  };
  const started: { processDefinitionId: string; variables?: Record<string, unknown> }[] = [];
  const engine = {
    createInstance: (req: { processDefinitionId: string; variables?: Record<string, unknown> }) => {
      started.push(req);
      return Promise.resolve({ processInstanceKey: `PI-${started.length}` });
    },
  } as unknown as EngineClient;
  const data = { table: withTrackingViews(table) } as unknown as DataLayer;
  return { data, engine, tables, started };
}

function stageEpic(tables: Map<string, Record<string, unknown>[]>, planKey: string, base: string) {
  const rows = tables.get("admitted_epics") ?? [];
  tables.set("admitted_epics", rows);
  const [repo, num] = planKey.split("#");
  rows.push({
    plan_key: planKey,
    repo,
    issue_number: Number(num),
    issue_url: `https://github.com/${repo}/issues/${num}`,
    base_branch: base,
    created_at: "t0",
  });
}

function stageEdge(tables: Map<string, Record<string, unknown>[]>, e: PlanDep) {
  const rows = tables.get("admitted_plan_deps") ?? [];
  tables.set("admitted_plan_deps", rows);
  rows.push({ ...e });
}

// Force token-transport with NO token so startPlan's best-effort issue-title lookup short-circuits to
// null (no `gh` shell-out, no network) — the epic falls back to its plan key for identity.
async function noFetch<T>(fn: () => Promise<T>): Promise<T> {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevTok = process.env["GITHUB_TOKEN"];
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  delete process.env["GITHUB_TOKEN"];
  try {
    return await fn();
  } finally {
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    if (prevTok === undefined) delete process.env["GITHUB_TOKEN"];
    else process.env["GITHUB_TOKEN"] = prevTok;
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// S5 P1 — a dependent is admitted GATED (a leading capability preflight), never as an eager root, so
// it CANNOT fan out wave 0 before its producer publishes. The engine HOLD is proven end to end in the
// e2e; here we prove the door seeds the gate that makes the hold possible.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
test("S5 P1: the consumer is admitted behind a capability gate (seeded probe), the producer as an eager root", async () => {
  const gh = freshGithub();
  await withGithub(gh, async () => {
    const { app, started } = makeApp();
    const res = await callDoor(app, {
      epics: [
        { issue: PRODUCER, baseBranch: "epic/producer" },
        { issue: CONSUMER, baseBranch: "epic/consumer" },
      ],
      deps: [{ consumer: CONSUMER, producer: PRODUCER, package: PKG, capabilityRef: CAP_REF }],
    });
    assertEquals(res.status, 202);
    assertEquals(res.body.roots, [PRODUCER]); // only the producer is a root
    const byKey = new Map(started.map((s) => [s.variables?.["planKey"], s.variables ?? {}]));
    // The producer fans out immediately — no leading probe.
    assertEquals(byKey.get(PRODUCER)?.["readinessProbes"], null);
    // The consumer carries a leading capability probe + a bounded timeout: it is parked at the
    // preflight and cannot reach wave 0 until that probe goes green.
    const depProbes = byKey.get(CONSUMER)?.["readinessProbes"] as unknown[] | null;
    assert(Array.isArray(depProbes) && depProbes.length === 1, "the consumer is seeded with a capability gate");
    assert(byKey.get(CONSUMER)?.["probeTimeout"] != null, "the consumer's gate carries a bounded timeout");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// S5 P2 — a submitted CYCLE is rejected at the edge with NO partial start: no epic started, no gate
// seeded, no durable/staged edge, no base branch created — one clean 4xx.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
test("S5 P2: a submitted cycle is one clean 400 with NO epic started, NO gate seeded, NO edge, NO branch", async () => {
  const gh = freshGithub();
  await withGithub(gh, async () => {
    const { app, started, tables } = makeApp();
    const res = await callDoor(app, {
      epics: [
        { issue: PRODUCER, baseBranch: "epic/a" },
        { issue: CONSUMER, baseBranch: "epic/b" },
      ],
      deps: [
        { consumer: CONSUMER, producer: PRODUCER, package: PKG, capabilityRef: PRODUCER },
        { consumer: PRODUCER, producer: CONSUMER, package: PKG, capabilityRef: CONSUMER },
      ],
    });
    assertEquals(res.status, 400);
    assertEquals(typeof res.body.error, "string");
    assertEquals(started.length, 0, "no epic instance started on a rejected cycle");
    assertEquals(rowsFor(tables, "plan_deps").length, 0, "no durable edge on a rejected cycle");
    assertEquals(rowsFor(tables, "admitted_plan_deps").length, 0, "no staged edge on a rejected cycle");
    assertEquals(rowsFor(tables, "admitted_epics").length, 0, "no epic staged on a rejected cycle");
    assertEquals(gh.creates, [], "no base branch created — the cycle is rejected before any admitPlan side effect");
  });
});

test("S5 P2: the pure validator rejects the two-node cycle as a 400 (the rule the door composes)", () => {
  let err: EpicSetValidationError | undefined;
  try {
    validateEpicSet(
      [PRODUCER, CONSUMER],
      [
        { consumer: CONSUMER, producer: PRODUCER, package: PKG, capabilityRef: PRODUCER },
        { consumer: PRODUCER, producer: CONSUMER, package: PKG, capabilityRef: CONSUMER },
      ],
    );
  } catch (e) {
    if (e instanceof EpicSetValidationError) err = e;
    else throw e;
  }
  assert(err, "a cycle must raise EpicSetValidationError");
  assertEquals(err!.status, 400);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// S5 P3 — a never-publishing producer ESCALATES (bounded) and never wedges the dependent or the REST
// of the set. The engine timer + escalation task are proven in the e2e; here we prove the invariants
// that make it bounded: the derived probe escalates on timeout (never silently fails), an unpublished
// capability keeps waiting (never throws / never spuriously binds), and a stuck dependent does not
// stop its sibling ROOT from starting.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
test("S5 P3: the derived capability probe escalates on timeout (bounded), it never fails the dependent silently", () => {
  const probe = capabilityProbeForEdge(workedEdge);
  assertEquals(probe.kind, "capability");
  assertEquals(probe.onTimeout, "escalate"); // a stuck producer surfaces to a human, never a silent skip
  assertEquals(probe.target, `github-releases:${REPO}`);
});

test("S5 P3: an unpublished capability is 'not ready' (keeps waiting), never throws and never binds a phantom version", () => {
  // The producer has published a release, but its provenance does NOT carry the consumer's capabilityRef.
  const res = matchCapability(
    { package: PKG, capabilityRef: CAP_REF },
    [rel(`${PKG}@9.9.9`, [999])],
  );
  assert(!res.ready, "an unpublished capability parks the gate, it does not go green");
  assertEquals(res.bind, undefined, "nothing is bound while the capability is unpublished");
});

test("S5 P3: a stuck dependent does not wedge the rest of the set — its sibling ROOT still starts", async () => {
  const { data, engine, tables, started } = makeData();
  // Two independent epics plus the gated consumer: the sibling root #3 must start even though the
  // consumer #2 is parked behind a (never-publishing) producer #1.
  stageEpic(tables, PRODUCER, "epic/producer");
  stageEpic(tables, CONSUMER, "epic/consumer");
  stageEpic(tables, `${REPO}#3`, "epic/independent");
  stageEdge(tables, workedEdge);

  const res = await noFetch(() => lowerAdmittedSet(data, engine, [PRODUCER, CONSUMER, `${REPO}#3`]));

  assertEquals(res.roots.sort(), [PRODUCER, `${REPO}#3`], "both non-dependent epics start immediately");
  assertEquals(res.dependents, [{ planKey: CONSUMER, producers: [PRODUCER] }]);
  assertEquals(started.length, 3, "every epic is started — a gated dependent never blocks its siblings");
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// S5 P4 — the bound `pkg@version` is EXACTLY the one carrying the capability, NOT merely the newest
// published version. This is the crux adversarial case: a strictly-newer release exists that does NOT
// carry the capability, so a "take the latest" resolver would bind the wrong version.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
test("S5 P4: with a newer non-carrying release present, the gate binds the LOWER capability-carrying version, not the newest", async () => {
  const match = { package: PKG, capabilityRef: CAP_REF };
  const releases = [
    rel(`${PKG}@2.0.0`, [500]), // newest, but carries a DIFFERENT capability (#500), not #1
    rel(`${PKG}@1.4.0`, [1]), //   the version that FIRST carries #1 — the correct bind
    rel(`${PKG}@1.6.0`, [1]), //   also carries #1, but is higher than 1.4.0
  ];

  const resolved = matchCapability(match, releases);
  assert(resolved.ready, "the capability is published, so the gate goes green");
  assertEquals(resolved.bind?.resolvedArtifact, `${PKG}@1.4.0`, "binds the lowest version that carries the capability");

  // Prove the bind genuinely DISAGREES with 'newest published' — a latest-wins resolver would be wrong.
  const newest = newestPublishedVersion(PKG, releases);
  assertEquals(newest, "2.0.0", "the newest published version is a strictly higher, non-carrying release");
  assert(resolved.bind?.resolvedArtifact !== `${PKG}@${newest}`, "the bound version is NOT the newest published version");

  // And prove it through the REAL probe the planner lowers (capabilityProbeForEdge → probeOnce), so
  // the guarantee holds on the executed path, not just the bare matcher. The exec stub returns the
  // same provenance the gh api call would.
  const probe = capabilityProbeForEdge(workedEdge);
  // The probe's ONE outside-world seam: `run` returns the `gh api .../releases` payload the resolver
  // reads. `httpGet` is unused by a capability probe but required by the ProbeExec interface.
  const exec: ProbeExec = {
    httpGet: () => Promise.resolve({ status: 200, body: "" }),
    run: (command: string) =>
      Promise.resolve({
        code: 0,
        stdout: command.includes("releases")
          ? JSON.stringify(releases.map((r) => ({ tag_name: r.tag, body: r.body })))
          : "",
        stderr: "",
      }),
  };
  const viaProbe = await probeOnce(probe, exec, {});
  assertEquals(viaProbe.bind?.resolvedArtifact, `${PKG}@1.4.0`, "the executed probe binds the capability-carrying version");
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// S5 P5 — a ROOT epic with no inbound edge starts IMMEDIATELY (no gate, fans out at once).
// ══════════════════════════════════════════════════════════════════════════════════════════════════
test("S5 P5: a root epic with no deps starts immediately with no readiness gate", async () => {
  const gh = freshGithub();
  await withGithub(gh, async () => {
    const { app, started } = makeApp();
    const res = await callDoor(app, { epics: [{ issue: PRODUCER, baseBranch: "epic/solo" }] });
    assertEquals(res.status, 202);
    assertEquals(res.body.roots, [PRODUCER]);
    assertEquals(started.length, 1, "the root is started at once");
    assertEquals(started[0].variables?.["readinessProbes"], null, "a root carries no leading gate");
  });

  // And at the pure schedule layer: an epic with no inbound edge is a root, no dependents.
  const sched = deriveEpicSchedule([PRODUCER], []);
  assertEquals(sched.roots, [PRODUCER]);
  assertEquals(sched.dependents.length, 0);
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// S5 P6 — re-submitting the SAME set is idempotent: no duplicate gate, no double-start, no duplicate
// edge. Proven through the real door AND the lowering executor.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
test("S5 P6: re-submitting the identical set through the door neither double-starts an epic nor duplicates an edge", async () => {
  const gh = freshGithub();
  await withGithub(gh, async () => {
    const { app, started, tables } = makeApp();
    const set = {
      epics: [
        { issue: PRODUCER, baseBranch: "epic/producer" },
        { issue: CONSUMER, baseBranch: "epic/consumer" },
      ],
      deps: [{ consumer: CONSUMER, producer: PRODUCER, package: PKG, capabilityRef: CAP_REF }],
    };
    const first = await callDoor(app, set);
    assertEquals(first.status, 202);
    const startsAfterFirst = started.length;
    const edgesAfterFirst = rowsFor(tables, "plan_deps").length;
    assertEquals(edgesAfterFirst, 1);

    const second = await callDoor(app, set);
    assertEquals(second.status, 202);
    assertEquals(started.length, startsAfterFirst, "no epic re-started on an identical re-submission");
    assertEquals(rowsFor(tables, "plan_deps").length, 1, "no duplicate durable edge on re-submission");
    // The consumer's gate is seeded exactly once — it was not re-started, so no second preflight instance.
    const consumerStarts = started.filter((s) => s.variables?.["planKey"] === CONSUMER).length;
    assertEquals(consumerStarts, 1, "the consumer's capability gate is seeded exactly once");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// S5 P7 — removing/finishing a producer does NOT strand a dependent's gate: it either proceeds on the
// already-published capability, or escalates cleanly — never hangs forever. The engine SLA auto-abandon
// (the "no eternal hang" bound) is proven in the e2e; here we prove the two clean outcomes.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
test("S5 P7: an already-published capability keeps the gate GREEN even after the producer is 'finished' — the dependent proceeds", () => {
  // The producer published the capability (release provenance persists) and is then finished/archived.
  // The resolver reads the durable Release list, so the gate stays green and binds the version.
  const res = matchCapability({ package: PKG, capabilityRef: CAP_REF }, [rel(`${PKG}@1.4.0`, [1])]);
  assert(res.ready, "the gate proceeds on the already-published capability");
  assertEquals(res.bind?.resolvedArtifact, `${PKG}@1.4.0`);
});

test("S5 P7: a still-gated dependent past its bounded timeout reads 'escalated', never 'waiting forever'", () => {
  const start = "2026-01-01T00:00:00.000Z";
  const plan: WaitGateLifecycle = { status: "planning", current_wave: null, bound_artifacts: null, created_at: start };
  const got = deriveWaitGate([workedEdge], plan, {
    nowMs: Date.parse(start) + 48 * 60 * 60 * 1000, // well past the default 30m bound
  });
  assertEquals(got.wait_gate, "escalated", "a stranded gate surfaces as escalated, not an eternal wait");
  assert(got.wait_gate_label?.includes(PRODUCER), "the escalation still names the blocking producer");
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// S5 P8 — the operator projection (S4) shows a parked dependent as "waiting on #N", and shows the
// bound version once resolved.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
test("S5 P8: a parked dependent projects 'waiting on <producer> @ <package>' with a live escalation deadline", () => {
  const start = "2026-01-01T00:00:00.000Z";
  const plan: WaitGateLifecycle = { status: "planning", current_wave: null, bound_artifacts: null, created_at: start };
  const got = deriveWaitGate([workedEdge], plan, { nowMs: Date.parse(start) + 1000 });
  assertEquals(got.wait_gate, "waiting");
  assert(got.wait_gate_label?.includes(`${PRODUCER} @ ${PKG}`), "names the producer#N @ package it is blocked on");
  assert(got.wait_gate_label?.includes("escalates by"), "shows the bounded escalation deadline, not a silent stall");
});

test("S5 P8: once resolved, the dependent projects 'ready' with the exact bound pkg@version", () => {
  const start = "2026-01-01T00:00:00.000Z";
  const plan: WaitGateLifecycle = {
    status: "dispatched",
    current_wave: 0,
    bound_artifacts: JSON.stringify([`${PKG}@1.4.0`]),
    created_at: start,
  };
  const got = deriveWaitGate([workedEdge], plan, { nowMs: Date.parse(start) + 1000 });
  assertEquals(got.wait_gate, "ready");
  assert(got.wait_gate_label?.includes(`${PKG}@1.4.0`), "surfaces the exact bound version once green");
});

test("S5 P8: a ROOT epic (no inbound edge) projects NO wait-gate at all", () => {
  const start = "2026-01-01T00:00:00.000Z";
  const plan: WaitGateLifecycle = { status: "planning", current_wave: null, bound_artifacts: null, created_at: start };
  assertEquals(deriveWaitGate([], plan, { nowMs: Date.parse(start) }), { wait_gate: null, wait_gate_label: null });
});
