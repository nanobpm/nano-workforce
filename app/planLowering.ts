// nano-workforce — inter-epic planner lowering (issue #292, slice S3).
//
// S1 landed the durable inter-epic edge (`plan_deps` + the `PlanDep` read API); S2 added the
// set/batch admission DOOR, which validates a whole set all-or-nothing and STAGES the admitted epics
// + validated edges FK-free into `admitted_epics` / `admitted_plan_deps` — deliberately materializing
// NEITHER a `plans` row NOR a `plan_deps` edge, and starting nothing.
//
// This module is the LOWERING half: it reads that staging and turns the validated DAG into a running
// schedule. It is the seam `startEpicSet` calls once the whole set has admitted:
//   1. ROOTS (no inbound edge) start IMMEDIATELY — each fans out right away, exactly as a single epic
//      does today (`startPlan` with no readiness probe).
//   2. DEPENDENTS (≥1 inbound edge) start with a LEADING capability readiness-gate: `startPlan`
//      seeds the epic's `capability` {@link ReadinessProbe} set (one probe per inbound edge / producer)
//      + the ISO timeout bound, and the plan-fanout process runs them as a preflight before wave 0
//      (resources/processes/plan-fanout.bpmn). The dependent fans out NO wave until every probe is
//      green; a never-publishing producer escalates (bounded) via the reused readiness-escalation
//      user task without wedging the dependent or the rest of the set. A dependent with MULTIPLE
//      inbound edges waits for ALL its producers (the preflight is multi-instance over the probe set).
//   3. Once each epic's `plans` row exists (created by `startPlan`), the validated edges are
//      MATERIALIZED durably via `recordPlanDep` — the `plan_deps.plan_key REFERENCES plans(plan_key)`
//      FK is satisfied by construction because the consumer's `plans` row was just created.
//
// Everything here is idempotent so RE-RUNNING admission for an already-lowered set neither
// double-starts an epic nor re-seeds a gate nor duplicates an edge: `startPlan` short-circuits an
// already-running plan (returning `alreadyRunning`), and `recordPlanDep` collapses a duplicate edge.
// Because the probes are seeded once at instance creation, a re-run that finds the plan already
// running never creates a second instance — so the gate is seeded exactly once.
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import {
  type AdmittedEpic,
  admittedEpics,
  admittedPlanDeps,
  type PlanDep,
  parseIssue,
  recordPlanDep,
  startPlan,
} from "./plan.ts";
import { type ReadinessProbe, readinessTimeout } from "./readiness.ts";

/** Derive the `capability` readiness probe for ONE inbound inter-epic edge: it goes green when the
 * producer epic (`depends_on_plan_key`) has published a release of `package` whose provenance carries
 * the `capability_ref` issue handle, resolving the LOWEST such version (`matchCapability`) and binding
 * it as `resolvedArtifact` (`pkg@version`) — the exact version that FIRST carries the capability, not
 * merely the newest. The provenance source repo is the producer's repo, split from its plan key. */
export function capabilityProbeForEdge(edge: PlanDep): ReadinessProbe {
  const producer = parseIssue(edge.depends_on_plan_key);
  // The producer plan key is always a parseable `owner/repo#N` (S1/S2 admitted it), but fall back to
  // the pre-`#` segment defensively so a probe is always well-formed rather than throwing here.
  const repo = producer ? producer.repo : edge.depends_on_plan_key.split("#")[0];
  return {
    kind: "capability",
    target: `github-releases:${repo}`,
    match: { package: edge.package, capabilityRef: edge.capability_ref },
    // A stuck/never-publishing producer must ESCALATE (bounded) — never fail the dependent silently
    // nor let it proceed unbound. This is the readiness gate's default, made explicit here.
    onTimeout: "escalate",
  };
}

/** One dependent epic's leading gate: the `capability` probes it must ALL satisfy (one per inbound
 * edge / producer) and the ISO-8601 timeout bound its preflight escalation timers fire off. */
export interface DependentGate {
  planKey: string;
  probes: ReadinessProbe[];
  producers: string[];
  probeTimeout: string;
}

/** The pure schedule derived from a validated set: the ROOTS to start immediately and the
 * DEPENDENTS whose fan-out is gated behind their producers' capabilities. */
export interface EpicSchedule {
  roots: string[];
  dependents: DependentGate[];
}

/** Pure, side-effect-free lowering of a validated DAG into a schedule (no data/engine access) — the
 * unit-testable core of {@link lowerAdmittedSet}. Given the set's plan keys and its inter-epic edges,
 * it partitions the epics into roots (no inbound edge → start immediately) and dependents (≥1 inbound
 * edge → wait behind a capability gate), deriving each dependent's probe set from its inbound edges.
 * A dependent with multiple inbound edges carries multiple probes — it must wait for ALL of them. */
export function deriveEpicSchedule(
  planKeys: readonly string[],
  edges: readonly PlanDep[],
  env: Record<string, string | undefined> = process.env,
): EpicSchedule {
  const inbound = new Map<string, PlanDep[]>();
  for (const edge of edges) {
    const list = inbound.get(edge.plan_key);
    if (list) list.push(edge);
    else inbound.set(edge.plan_key, [edge]);
  }
  const roots: string[] = [];
  const dependents: DependentGate[] = [];
  for (const planKey of planKeys) {
    const edgesForKey = inbound.get(planKey);
    if (!edgesForKey || edgesForKey.length === 0) {
      roots.push(planKey);
      continue;
    }
    const probes = edgesForKey.map(capabilityProbeForEdge);
    // One bound governs the whole dependent's preflight timers — the LONGEST of its probes' derived
    // timeouts, so no producer is cut short. In practice every derived probe shares the default, so
    // this is that default; the max keeps it correct if a probe ever carries a bespoke poll budget.
    const probeTimeout = probes
      .map((p) => readinessTimeout(p, env))
      .reduce((a, b) => (isoLonger(a, b) ? a : b));
    dependents.push({ planKey, probes, producers: edgesForKey.map((e) => e.depends_on_plan_key), probeTimeout });
  }
  return { roots, dependents };
}

/** The result of lowering a set: which epics were started as roots vs gated dependents, and how many
 * durable edges were materialized. Returned so the admission door can report the schedule. */
export interface LoweringResult {
  roots: string[];
  dependents: { planKey: string; producers: string[] }[];
  edgesMaterialized: number;
}

/** Lower a WHOLE admitted set (read from the S2 staging tables) into a running schedule. Reads the
 * staged epics + edges, derives the schedule, starts roots immediately and dependents behind their
 * capability gate, then materializes the durable `plan_deps` edges (after the consumer's `plans` row
 * exists, so the FK holds). Idempotent end-to-end: re-running it neither double-starts an epic, nor
 * re-seeds a gate, nor duplicates an edge. The set's membership is `planKeys` (every admitted epic,
 * roots included) — the same list the door staged. */
export async function lowerAdmittedSet(
  data: DataLayer,
  engine: EngineClient,
  planKeys: readonly string[],
  env: Record<string, string | undefined> = process.env,
): Promise<LoweringResult> {
  // Read the staged epics (for repo/base/issue) and the staged edges (the DAG) for the set.
  const epicByKey = new Map<string, AdmittedEpic>();
  for (const planKey of planKeys) {
    const staged = await admittedEpics(data).get(planKey);
    if (staged) epicByKey.set(planKey, staged);
  }
  const edges: PlanDep[] = [];
  const seenEdges = new Set<string>();
  for (const planKey of new Set(planKeys)) {
    for (const edge of await admittedPlanDeps(data).find({ plan_key: planKey })) {
      const id = `${edge.plan_key}\u0000${edge.depends_on_plan_key}`;
      if (seenEdges.has(id)) continue;
      seenEdges.add(id);
      edges.push(edge);
    }
  }

  const schedule = deriveEpicSchedule([...epicByKey.keys()], edges, env);
  const gateByKey = new Map(schedule.dependents.map((d) => [d.planKey, d]));

  // Start every admitted epic — roots with no probe (immediate fan-out), dependents with their
  // seeded capability gate. `startPlan` creates the `plans` row (idempotent on an already-running
  // plan), which the durable edge FK below then references.
  for (const planKey of epicByKey.keys()) {
    const staged = epicByKey.get(planKey);
    if (!staged) continue;
    const parsed = parseIssue(staged.issue_url) ?? parseIssue(planKey);
    if (!parsed) continue;
    const gate = gateByKey.get(planKey);
    await startPlan(data, engine, parsed, staged.base_branch, {
      readinessProbes: gate?.probes,
      probeTimeout: gate?.probeTimeout,
    });
  }

  // Materialize the durable edges now that every consumer's `plans` row exists. Idempotent: a
  // re-run collapses the duplicate. Done AFTER the starts so the `plan_deps.plan_key` FK is satisfied.
  let edgesMaterialized = 0;
  for (const edge of edges) {
    await recordPlanDep(data, {
      plan_key: edge.plan_key,
      depends_on_plan_key: edge.depends_on_plan_key,
      package: edge.package,
      capability_ref: edge.capability_ref,
    });
    edgesMaterialized += 1;
  }

  return {
    roots: schedule.roots,
    dependents: schedule.dependents.map((d) => ({ planKey: d.planKey, producers: d.producers })),
    edgesMaterialized,
  };
}

/** Compare two ISO-8601 durations of the shape `readinessTimeout` emits (`PT…`), returning true when
 * `a` is the LONGER. Kept deliberately small: the derived probes all share one default, so this only
 * ever breaks a tie; it parses the `PnDTnHnMnS` fields the emitter can produce and never throws. */
function isoLonger(a: string, b: string): boolean {
  return isoDurationSeconds(a) >= isoDurationSeconds(b);
}

/** Coarse ISO-8601 duration → seconds for the `PnDTnHnMnS` subset `msToIsoDuration` emits. Only used
 * to pick the longer of two derived bounds; a malformed value parses as 0 rather than throwing. */
function isoDurationSeconds(iso: string): number {
  const m = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m) return 0;
  const [, d, h, min, s] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0);
}
