// nano-workforce — the cross-repo CAPABILITY EDGE authoring/plumbing helpers (issue #289).
//
// This is the pure, I/O-free half of the "consumer readiness edge" (ADR 0001 §4, #263): a plan task
// declares that it consumes an upstream capability C that ships as some `pkg@version` from ANOTHER
// repo, and must not start until C first ships. The planner emits this as `RecordPlanTask.needs[]`
// (plan-fanout.bpmn); `pr.record-plan` levelizes it to `plan_task_needs` and `pr.select-wave` reads
// it back to gate the task before dispatch.
//
// The gate itself is the EXISTING durable `readiness-gate` process (#258) driven with a `capability`
// {@link ReadinessProbe} (#274) — this module never re-implements the wait or the matcher; it only
// (a) normalises a raw planner need, (b) maps a need to the gate's `ReadinessProbeIn`, and (c) renders
// the late-bound "resolved-dependencies" prompt brief that pins each `pkg@version` into the agent's
// context (mirroring `renderBaseBranchBrief` in app/plan.ts). Pure + unit-testable — no network, no DB.
import type { OnTimeout, ProbeMatch, ReadinessProbe } from "./readiness.ts";

/** A single cross-repo capability dependency declared on a plan task — the stable authoring contract
 * (#263: declare the HANDLE, never a version). Mirrors the `CapabilityNeed` `nano:shape` in
 * plan-fanout.bpmn so it is typed end to end. */
export interface CapabilityNeed {
  /** The upstream capability handle — `owner/repo#NNN`, `repo#NNN`, or the bare `#NNN`. It carries
   * the provenance issue/PR ref the resolved version must reference; the leading `owner/repo` (when
   * present) also names the releases source repo the gate polls (see {@link capabilityReleasesRepo}). */
  readonly capabilityRef: string;
  /** The artifact whose GitHub Releases carry the publish provenance (e.g. `@nanobpm/urban`).
   * Per-package scoped — a sibling package's provenance can never resolve this edge. */
  readonly package: string;
  /** OPTIONAL gated empirical verifier (#274 decision 5): run ONCE at the gate boundary against the
   * newest published `package` version when deterministic provenance resolved nothing. Left unset,
   * the edge is deterministic-provenance-only. */
  readonly verifyCommand?: string;
}

/** The gate's input envelope — mirrors the `ReadinessProbeIn` `nano:shape` in readiness-gate.bpmn
 * (`gateKey`, `probeTimeout`, optional `onTimeout`, nested `probe`). Kept local (not imported) so this
 * pure module never depends on the generated worker-io types. */
export interface ReadinessProbeInput {
  readonly gateKey: string;
  readonly probeTimeout: string;
  readonly onTimeout?: OnTimeout;
  readonly probe: ReadinessProbe;
}

/** One resolved capability edge — the late-bound fact the gate hands back (`capabilityRef →
 * resolvedArtifact`, e.g. `nanobpm/nano-ide#274 → @nanobpm/urban@0.54.0`). Fanned in over a task's
 * needs and rendered into the implementation prompt by {@link renderResolvedDepsBrief}. */
export interface ResolvedCapability {
  readonly capabilityRef: string;
  readonly resolvedArtifact: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Normalise ONE raw planner-emitted need into a {@link CapabilityNeed}, or `null` when it is unusable
 * (blank `capabilityRef` or `package`). A malformed need is DROPPED rather than throwing so one bad
 * entry can never fail the whole plan record — mirroring `record-plan`'s tolerant task normalisation. */
export function parseCapabilityNeed(raw: unknown): CapabilityNeed | null {
  if (!isRecord(raw)) return null;
  const capabilityRef = str(raw.capabilityRef).trim();
  const pkg = str(raw.package).trim();
  if (capabilityRef === "" || pkg === "") return null;
  const verifyCommand = str(raw.verifyCommand).trim();
  return { capabilityRef, package: pkg, ...(verifyCommand === "" ? {} : { verifyCommand }) };
}

/** Normalise a whole `needs[]` array, dropping malformed entries and de-duplicating on
 * `capabilityRef@package` (a task that lists the same edge twice must gate on it once). */
export function parseCapabilityNeeds(raw: unknown): CapabilityNeed[] {
  if (!Array.isArray(raw)) return [];
  const out: CapabilityNeed[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const need = parseCapabilityNeed(entry);
    if (!need) continue;
    const key = `${need.capabilityRef}\u0000${need.package}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(need);
  }
  return out;
}

/** The bare numeric id of a capability handle — `nanobpm/nano-ide#274`, `nano-ide#274`, `#274`, and a
 * naked `274` all normalise to `274`. Returns `undefined` for a handle with no number (never
 * resolvable). Kept in lockstep with `capabilityNumber` in app/readiness.ts (the matcher's predicate). */
export function capabilityRefNumber(capabilityRef: string): string | undefined {
  const m = capabilityRef.match(/(\d+)\s*$/);
  return m ? m[1] : undefined;
}

/** The releases-source repo a capability handle names, as `owner/repo`, or `undefined` when the handle
 * carries no `owner/repo` prefix (a bare `#274` / `repo#274`). The gate polls THIS repo's GitHub
 * Releases for the package's publish provenance, so a handle without it cannot be gated deterministically
 * — the planner is taught to always write the full `owner/repo#NNN` (resources/prompts/plan.md). */
export function capabilityReleasesRepo(capabilityRef: string): string | undefined {
  const beforeHash = capabilityRef.split("#")[0]?.trim() ?? "";
  const m = beforeHash.match(/^([^/\s]+\/[^/\s]+)$/);
  return m ? m[1] : undefined;
}

/** Raised when a capability need cannot be turned into a gateable probe because its handle names no
 * `owner/repo` releases source (e.g. a bare `#274`). Fail LOUDLY at wiring time — a silently
 * un-pollable edge would only surface as a spurious gate timeout much later. */
export class UnresolvableCapabilityRefError extends Error {
  readonly capabilityRef: string;
  constructor(capabilityRef: string) {
    super(
      `capability need '${capabilityRef}': the handle names no owner/repo releases source. ` +
        `Declare the full 'owner/repo#NNN' handle so the gate knows which repo's Releases to poll.`,
    );
    this.name = "UnresolvableCapabilityRefError";
    this.capabilityRef = capabilityRef;
  }
}

/** The gate's correlation/idempotency key for a task's capability edge:
 * `<planKey>:<taskId>:<capabilityRef>:<package>` (issue #289 design §2). Stable across a resume so a
 * re-dispatched agent re-attaches to the same gate. `package` is part of the identity because a task
 * can legitimately declare the SAME `capabilityRef` for different packages (`parseCapabilityNeeds`
 * de-dupes on `capabilityRef+package`; `plan_task_needs`' PK includes `package`) — each
 * `(capabilityRef, package)` edge is a distinct need with its own gate row, so the key must be 1:1
 * with the need or two edges would collide on one gate row and only one could ever resolve. */
export function capabilityGateKey(
  planKey: string,
  taskId: string,
  capabilityRef: string,
  pkg: string,
): string {
  return `${planKey}:${taskId}:${capabilityRef}:${pkg}`;
}

/** The message name plan-fanout's per-task capability barrier (`wait-caps-resolved`) subscribes to and
 * the host publishes to release the gated task once every one of its capability needs has resolved
 * (issue #289 §2/§3). The single source of truth for the string shared by the BPMN subscription and
 * the host publisher, mirroring `WAVE_MERGED_MESSAGE`. */
export const CAPS_RESOLVED_MESSAGE = "caps-resolved";

/** The per-TASK barrier correlation key `<planKey>:<taskId>` the `wait-caps-resolved` catch binds
 * and the host publishes `caps-resolved` on (issue #289 §2). Distinct from {@link capabilityGateKey}
 * (which is per-NEED): a task fans in ALL its needs, so its barrier releases ONCE, keyed on the task —
 * not once per need. Stable across a resume so a re-dispatched fan-out re-attaches to the same barrier. */
export function capabilityTaskBarrierKey(planKey: string, taskId: string): string {
  return `${planKey}:${taskId}`;
}

/** Map a normalised {@link CapabilityNeed} to the EXISTING `readiness-gate` process input (#289 §2):
 * a `capability` probe scanning the handle's releases source for the package's provenance, bounded by
 * `probeTimeout` and escalating on timeout. Reuses the gate + matcher verbatim (derivation over
 * duplication) — this only shapes the descriptor. Throws {@link UnresolvableCapabilityRefError} when
 * the handle names no releases source. */
export function capabilityNeedToProbeInput(
  need: CapabilityNeed,
  opts: { planKey: string; taskId: string; probeTimeout: string },
): ReadinessProbeInput {
  const repo = capabilityReleasesRepo(need.capabilityRef);
  if (!repo) throw new UnresolvableCapabilityRefError(need.capabilityRef);
  const match: ProbeMatch = {
    capabilityRef: need.capabilityRef,
    package: need.package,
    ...(need.verifyCommand ? { verifyCommand: need.verifyCommand } : {}),
  };
  const probe: ReadinessProbe = {
    kind: "capability",
    target: `github-releases:${repo}`,
    match,
    onTimeout: "escalate",
  };
  return {
    gateKey: capabilityGateKey(opts.planKey, opts.taskId, need.capabilityRef, need.package),
    probeTimeout: opts.probeTimeout,
    onTimeout: "escalate",
    probe,
  };
}

/** Render the per-task "resolved-dependencies" brief appended to an implementer agent's prompt once
 * every capability gate on the task has resolved (#289 §3), mirroring `renderBaseBranchBrief`. It pins
 * each `capabilityRef → pkg@version` the gate discovered so the agent installs EXACTLY that version —
 * no pre-named version, no human. Returns "" for an empty list so callers can concatenate unconditionally. */
export function renderResolvedDepsBrief(resolved: readonly ResolvedCapability[]): string {
  if (resolved.length === 0) return "";
  const lines = [
    "",
    "",
    "---",
    "",
    "**Resolved cross-repo dependencies (authoritative — pin these EXACT versions):**",
    "",
    "An upstream capability this task depends on has shipped. Install/pin exactly the resolved",
    "`package@version` below — do NOT bump, float, or re-resolve it:",
    "",
  ];
  for (const r of resolved) lines.push(`- \`${r.capabilityRef}\` → \`${r.resolvedArtifact}\``);
  lines.push("");
  lines.push("These versions first carry the capability your slice consumes; a newer or older version");
  lines.push("may not. Treat them as the contract you build against.");
  return lines.join("\n");
}
