// nano-workforce — the `sequenceIssues` intent → canonical delivery-graph GENERATOR (epic
// nano-workforce#605, S4/#610). ADR 0005's delivery graph is a closed vocabulary, and §9.4 of the
// operator guide already names the canonical shape for "implement issue → converge → merge". But an
// agent still had to hand-author the full node/edge JSON: in the evidence session, sequencing four
// issues behind a gate meant constructing 13 nodes and 12 edges by hand. This module produces that
// exact shape from a high-level INTENT instead.
//
// The intent is `{ behind?: "owner/repo#NN", issues: ["owner/repo#A", …] }`. For each issue it emits
// the canonical chain — `agent` (`senior:feature`, emits a `pr` fact) → `connector` (`converge-merge`,
// late-binding that `pr`) → `wait[pr, merged]` (a realistic `poll.timeoutMs`) — and threads the `pr`
// fact along fact-qualified edges per §9.4. The issues run in SEQUENCE: each issue's agent starts once
// the PRIOR issue has merged. An optional leading `wait[epic]` gate (when `behind` is given) makes the
// whole sequence wait for that issue/epic/feature to be fully merged first (§9.5).
//
// It is a PURE builder: no I/O, no staging. The operation (`operations/sequenceIssues.ts`) hands the
// constructed `DeliveryGraph` to the SAME `compileAndStageDeliveryGraph` flow the raw
// `compileDeliveryGraph` door uses (one compiler, one staging path — AGENTS.md "no drift surfaces").
// The generated graph is authored to pass `validateDeliveryGraph` by construction: unique node ids,
// `pr`-typed emits, threaded fact edges, a DAG. It is validated against the S3 vocabulary
// (`deliveryGraphVocabulary`) so an unknown connector target / probe kind is rejected at the door with
// `issues[{path,message}]` rather than only surfacing at compile time.
import type { DeliveryEdge, DeliveryGraph, DeliveryNode, ReadinessProbe } from "../nano-generated/api-io.d.ts";
import { CONVERGE_MERGE_TARGET } from "./convergeTargets.ts";
import { GRAPH_MAX_NODES } from "./deliveryGraph.ts";
import { deliveryGraphVocabulary } from "./deliveryGraphVocabulary.ts";
import { type ParsedIssue, parseIssue } from "./plan.ts";

/** A path-qualified validation failure — the uniform door error contract `issues[{path,message}]`
 * (the same shape the runtime request-validator and the S1 harness assert). */
export interface SequenceIssueError {
  readonly path: string;
  readonly message: string;
}

/** An interleaved `wait` GATE that must go green before a given issue's agent starts (issue #740).
 * Reuses the exact probe schema `wait` nodes already accept — the `npm`/`github-check`/`http`/…
 * vocabulary — so an author can insert e.g. "wait for `@nanobpm/agentic@0.13.0` to publish" between
 * two sequence steps without falling off the intent onto raw node/edge JSON. */
export interface SequenceGate {
  /** The wait-probe kind (must be a known kind in the S3 vocabulary — `npm`, `github-check`, `http`,
   * `command`, `capability`, `pr`, `epic`). */
  kind: string;
  /** The probe target — kind-specific (`pkg@version` for `npm`, `owner/repo@ref` for `github-check`,
   * a URL for `http`, …). */
  target: string;
  /** Optional kind-specific readiness `match` fields (e.g. `{ version }` for `npm`). */
  match?: Record<string, unknown>;
  /** Optional poll budget; defaults to the bounded merge-gate budget ({@link MERGE_POLL}) so a gate
   * never falls into the 30-minute default trap. */
  poll?: { everyMs?: number; timeoutMs?: number };
  /** What to do when the gate never goes green within its budget — `escalate` (default) or `continue`.
   * `fail` is rejected (not yet supported by the compiler/engine). */
  onTimeout?: "escalate" | "continue";
  /** Optional env-key name supplying a credential for the probe (`http`/`capability`). */
  credentialEnv?: string;
}

/** One `issues[]` entry with an OPTIONAL leading {@link SequenceGate} — the object form. A bare string
 * entry (no gate) keeps today's behaviour byte-for-byte. */
export interface SequenceIssueEntry {
  gate?: SequenceGate;
  issue: string;
}

/** The `sequenceIssues` intent body — an optional leading `behind` gate plus the ordered `issues`,
 * each of which may be a bare `owner/repo#N` string OR a `{ gate?, issue }` object interleaving a
 * `wait` gate before that issue's agent (issue #740). */
export interface SequenceIssuesIntent {
  behind?: string;
  issues: (string | SequenceIssueEntry)[];
}

/** The result of {@link buildSequenceGraph}: either the constructed graph, or the path-qualified
 * input/vocabulary rejections. */
export type SequenceIssuesResult =
  | { ok: true; graph: DeliveryGraph }
  | { ok: false; issues: SequenceIssueError[] };

/** The realistic merge-gate poll budget the canonical shape uses (§9.4 / §9.1): re-probe every 5
 * minutes, budget 3 days. A `wait[pr, merged]` / `wait[epic]` waits on a human-paced merge, so the
 * 30-minute default poll budget is a trap — always set an explicit `poll.timeoutMs` on a merge/epic
 * gate. Exported so the regression test asserts the generated gate against the canonical values. */
export const MERGE_POLL = { everyMs: 300_000, timeoutMs: 259_200_000 } as const;

/** The wait-probe kind that observes a single in-flight PR's merge state (ADR 0005 §2). */
const PR_PROBE_KIND = "pr";
/** The wait-probe kind that observes a whole epic/feature lineage reaching "fully merged" (§9.5). */
const EPIC_PROBE_KIND = "epic";
/** The agent job type each issue node runs (a full single-issue feature implementation). */
const AGENT_JOB_TYPE = "senior:feature";
/** The upper bound on issues in one sequence — keeps the generated graph within the compiler's
 * 256-node ceiling (3 nodes/issue + an optional gate) with generous headroom, and bounds the intent. */
export const MAX_SEQUENCE_ISSUES = 64;

/** A `pr`-typed emit declaration — what an `agent` node publishes for the PR it opened, so the
 * downstream connector / `wait[pr]` node late-binds its target PR from the fact (§9.4, issue #548). */
const PR_EMIT = { name: "pr", type: "pr" as const };

/** A validated, ready-to-emit interleaved gate: `poll` and `onTimeout` are resolved to concrete values
 * (defaults applied) so {@link assembleGraph} can drop it straight into a `wait` node's config. */
interface BuiltGate {
  kind: ReadinessProbe["kind"];
  target: string;
  match?: Record<string, unknown>;
  poll: { everyMs?: number; timeoutMs?: number };
  onTimeout: "escalate" | "continue";
  credentialEnv?: string;
}

/** A parsed `issues[]` entry: the normalised issue plan-key plus its optional interleaved gate. */
interface ParsedEntry {
  issueKey: string;
  gate: BuiltGate | null;
}

/** Narrow a validated string to the closed `ReadinessProbe["kind"]` union — backed by the runtime
 * vocabulary set so the type guard and the door validation share one source of truth. */
function isProbeKind(kind: string, probeKinds: Set<string>): kind is ReadinessProbe["kind"] {
  return probeKinds.has(kind);
}

/** Parse a ref into an issue target ONLY if its number is a positive, safe integer. `parseIssue`'s
 * `\d+` accepts `#0` and precision-overflowing numbers (e.g. `#99999999999999999999`, which coerces
 * past `Number.MAX_SAFE_INTEGER`), but such a target can never resolve to a real issue/PR — staging a
 * gate on it would wait forever. Reject it deterministically at the door instead (Copilot review,
 * PR #618), so only `#N` with `N >= 1 && Number.isSafeInteger(N)` is accepted. */
function parseIssueRef(ref: unknown): ParsedIssue | null {
  const parsed = typeof ref === "string" ? parseIssue(ref) : null;
  if (!parsed) return null;
  return Number.isSafeInteger(parsed.number) && parsed.number >= 1 ? parsed : null;
}

/** Validate one interleaved `gate` spec against the probe vocabulary, applying defaults. Returns the
 * built gate or path-qualified `issues[{path,message}]` rejections (keyed under `path`, e.g.
 * `issues[1].gate.kind`). Reuses the same probe schema `wait` nodes accept: `{ kind, target, match?,
 * poll?, onTimeout?, credentialEnv? }`. */
function parseGate(raw: unknown, path: string, probeKinds: Set<string>): { gate?: BuiltGate; errors: SequenceIssueError[] } {
  const errors: SequenceIssueError[] = [];
  if (!isRecord(raw)) {
    return { errors: [{ path, message: "`gate` must be an object carrying a `wait` probe (`{ kind, target, … }`)." }] };
  }

  // Trim before validating AND before persisting: harmless surrounding whitespace must neither
  // trip a confusing "unknown kind" rejection nor survive into the generated `wait` node, where a
  // stray trailing space silently probes the wrong target (`pkg@1.0.0 ` → a gate that never goes
  // green). The persisted value is always the trimmed one.
  let validKind: ReadinessProbe["kind"] | null = null;
  const kind = raw.kind;
  if (typeof kind !== "string" || kind.trim() === "") {
    errors.push({ path: `${path}.kind`, message: "`gate.kind` is required and must be a non-empty wait-probe kind." });
  } else {
    const trimmedKind = kind.trim();
    if (!isProbeKind(trimmedKind, probeKinds)) {
      errors.push({ path: `${path}.kind`, message: `wait-probe kind \`${trimmedKind}\` is not in the delivery-graph vocabulary.` });
    } else {
      validKind = trimmedKind;
    }
  }

  let validTarget: string | null = null;
  const target = raw.target;
  if (typeof target !== "string" || target.trim() === "") {
    errors.push({ path: `${path}.target`, message: "`gate.target` is required and must be a non-empty string." });
  } else {
    validTarget = target.trim();
  }

  let match: Record<string, unknown> | undefined;
  if (raw.match !== undefined) {
    if (!isRecord(raw.match)) {
      errors.push({ path: `${path}.match`, message: "`gate.match`, when present, must be an object of readiness fields." });
    } else {
      match = raw.match;
    }
  }

  const poll: { everyMs?: number; timeoutMs?: number } = { ...MERGE_POLL };
  if (raw.poll !== undefined) {
    if (!isRecord(raw.poll)) {
      errors.push({ path: `${path}.poll`, message: "`gate.poll`, when present, must be `{ everyMs?, timeoutMs? }`." });
    } else {
      for (const key of ["everyMs", "timeoutMs"] as const) {
        const v = raw.poll[key];
        if (v === undefined) continue;
        if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) {
          errors.push({ path: `${path}.poll.${key}`, message: `\`gate.poll.${key}\`, when present, must be a positive integer (milliseconds).` });
        } else {
          poll[key] = v;
        }
      }
    }
  }

  let onTimeout: "escalate" | "continue" = "escalate";
  if (raw.onTimeout !== undefined) {
    if (raw.onTimeout !== "escalate" && raw.onTimeout !== "continue") {
      errors.push({
        path: `${path}.onTimeout`,
        message: "`gate.onTimeout` must be `escalate` (default) or `continue` — `fail` is not supported on a `wait` node.",
      });
    } else {
      onTimeout = raw.onTimeout;
    }
  }

  let credentialEnv: string | undefined;
  if (raw.credentialEnv !== undefined) {
    if (typeof raw.credentialEnv !== "string" || raw.credentialEnv.trim() === "") {
      errors.push({ path: `${path}.credentialEnv`, message: "`gate.credentialEnv`, when present, must be a non-empty env-key name." });
    } else {
      credentialEnv = raw.credentialEnv;
    }
  }

  if (errors.length > 0 || validKind === null || validTarget === null) return { errors };
  return {
    gate: {
      kind: validKind,
      target: validTarget,
      ...(match ? { match } : {}),
      poll,
      onTimeout,
      ...(credentialEnv ? { credentialEnv } : {}),
    },
    errors: [],
  };
}

/**
 * Build the canonical delivery graph for a `sequenceIssues` intent, or return path-qualified
 * `issues[{path,message}]` rejections for invalid input. Validates:
 *   - `issues` is a non-empty array within {@link MAX_SEQUENCE_ISSUES};
 *   - every `issues[i]` (a bare ref, or a `{ gate?, issue }` object) and the optional `behind` parse
 *     as an `owner/repo#N` reference;
 *   - each interleaved `gate` names a wait-probe kind known to the S3 vocabulary (issue #740);
 *   - the connector target and wait-probe kinds it emits are known to the S3 vocabulary (drift guard);
 *   - the generated graph stays within the compiler's node ceiling.
 * Pure — no I/O. The constructed graph passes `validateDeliveryGraph` by construction.
 */
export function buildSequenceGraph(intent: unknown): SequenceIssuesResult {
  const issues: SequenceIssueError[] = [];

  const body = isRecord(intent) ? intent : {};
  const rawIssues = body.issues;
  const rawBehind = body.behind;

  // The vocabulary is needed up front to validate interleaved gate `kind`s as each entry is parsed.
  const vocab = deliveryGraphVocabulary();
  const probeKinds = new Set(vocab.waitProbeKinds.map((p) => p.kind));

  // ── `issues`: a non-empty, bounded array of parseable refs, each optionally carrying a gate ────
  const parsedEntries: ParsedEntry[] = [];
  if (!Array.isArray(rawIssues)) {
    issues.push({ path: "issues", message: "`issues` must be a non-empty array of `owner/repo#N` issue references." });
  } else if (rawIssues.length === 0) {
    issues.push({ path: "issues", message: "`issues` must contain at least one `owner/repo#N` issue reference." });
  } else if (rawIssues.length > MAX_SEQUENCE_ISSUES) {
    issues.push({
      path: "issues",
      message: `\`issues\` has too many entries (${rawIssues.length}) — the limit is ${MAX_SEQUENCE_ISSUES}.`,
    });
  } else {
    rawIssues.forEach((entry, i) => {
      // A bare string entry is a gate-less issue (today's behaviour, byte-for-byte). An object entry
      // carries a required `issue` ref plus an OPTIONAL leading `gate` (issue #740).
      const rawRef = isRecord(entry) ? entry.issue : entry;
      const parsed = parseIssueRef(rawRef);
      if (!parsed) {
        const shown = isRecord(entry) ? String(rawRef) : String(entry);
        issues.push({
          path: isRecord(entry) ? `issues[${i}].issue` : `issues[${i}]`,
          message: `\`${shown}\` is not a valid \`owner/repo#N\` issue reference.`,
        });
        return;
      }
      let gate: BuiltGate | null = null;
      if (isRecord(entry) && entry.gate !== undefined && entry.gate !== null) {
        const parsedGate = parseGate(entry.gate, `issues[${i}].gate`, probeKinds);
        issues.push(...parsedGate.errors);
        gate = parsedGate.gate ?? null;
      }
      parsedEntries.push({ issueKey: parsed.planKey, gate });
    });
  }

  // ── `behind` (optional): a parseable ref, when PRESENT ───────────────────────────────────────
  // Only an OMITTED gate (`undefined`/`null`) is "no gate"; a present-but-empty `behind: ""` is a
  // caller mistake (the schema requires `minLength: 1`), not an ungated sequence — reject it rather
  // than silently dropping the gate the caller asked for (matters most when this builder is invoked
  // directly, bypassing OpenAPI validation).
  let behindKey: string | null = null;
  if (rawBehind !== undefined && rawBehind !== null) {
    const parsed = parseIssueRef(rawBehind);
    if (!parsed) {
      issues.push({
        path: "behind",
        message: `\`${String(rawBehind)}\` is not a valid \`owner/repo#N\` issue/epic reference.`,
      });
    } else {
      behindKey = parsed.planKey;
    }
  }

  // ── Vocabulary drift guard (S3): the target/probe kinds this generator emits MUST be known to the
  // structured vocabulary. This can only trip if the closed vocabulary changes underneath us — it is
  // surfaced as a door `issue` (not a throw) so the failure mode is a clean rejection, not a 500. ──
  const realTargets = new Set(vocab.connectorTargets.filter((t) => t.status === "real").map((t) => t.target));
  if (!realTargets.has(CONVERGE_MERGE_TARGET)) {
    issues.push({
      path: "issues",
      message: `connector target \`${CONVERGE_MERGE_TARGET}\` is not a real target in the delivery-graph vocabulary.`,
    });
  }
  for (const kind of behindKey ? [PR_PROBE_KIND, EPIC_PROBE_KIND] : [PR_PROBE_KIND]) {
    if (!probeKinds.has(kind)) {
      issues.push({ path: "issues", message: `wait-probe kind \`${kind}\` is not in the delivery-graph vocabulary.` });
    }
  }

  // ── Node-budget guard: interleaved gates add a node per gated issue, so a fully-gated max-length
  // sequence (plus the optional `behind` gate) can push past the compiler's node ceiling. Reject it
  // at the door so a SUCCESSFULLY generated graph always validates `by construction`. ──
  if (issues.length === 0) {
    const projectedNodes = (behindKey ? 1 : 0) + parsedEntries.reduce((n, e) => n + 3 + (e.gate ? 1 : 0), 0);
    if (projectedNodes > GRAPH_MAX_NODES) {
      issues.push({
        path: "issues",
        message: `the generated graph would have too many nodes (${projectedNodes}) — the limit is ${GRAPH_MAX_NODES}; use fewer issues or interleaved gates.`,
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  return { ok: true, graph: assembleGraph(parsedEntries, behindKey) };
}

/** Assemble the canonical node/edge chain for the (already-validated) parsed entries + optional gate.
 * Each entry emits `agent → connector[converge-merge] → wait[pr, merged]`; an entry with an
 * interleaved `gate` gets a leading `wait[<gate.kind>]` node spliced between the prior sequence step
 * and its agent, so the agent starts only once the prior issue merged AND the gate went green. */
function assembleGraph(entries: ParsedEntry[], behindKey: string | null): DeliveryGraph {
  const nodes: DeliveryNode[] = [];
  const edges: DeliveryEdge[] = [];

  // Optional leading `wait[epic]` gate — the whole sequence waits for `behind` to be fully merged.
  const EPIC_GATE_ID = "gate-epic";
  if (behindKey) {
    nodes.push({
      id: EPIC_GATE_ID,
      kind: "wait",
      wait: {
        kind: EPIC_PROBE_KIND,
        target: behindKey,
        match: { epicState: "merged" },
        poll: { ...MERGE_POLL },
        onTimeout: "escalate",
      },
      emits: [{ name: "prCount", type: "number" }],
    });
  }

  entries.forEach((entry, i) => {
    const n = i + 1;
    const openId = `open-${n}`;
    const landId = `land-${n}`;
    const mergedId = `merged-${n}`;
    const prRef = `${openId}.pr`;
    const issueKey = entry.issueKey;

    // The sequence predecessor whose completion releases THIS issue: the prior issue's merge, else the
    // leading epic gate for the first issue (null when the first issue is ungated by `behind`).
    const predecessor = i === 0 ? (behindKey ? EPIC_GATE_ID : null) : `merged-${i}`;

    // Interleaved gate (issue #740): a `wait[<kind>]` node the issue's agent waits on. It inherits the
    // sequence predecessor's edge (so it only starts probing once the prior issue merged) and the
    // agent then waits on the gate — gating the agent on the prior merge AND the gate condition.
    let agentPredecessor = predecessor;
    if (entry.gate) {
      const gateId = `gate-${n}`;
      const g = entry.gate;
      nodes.push({
        id: gateId,
        kind: "wait",
        wait: {
          kind: g.kind,
          target: g.target,
          ...(g.match ? { match: g.match } : {}),
          poll: { ...g.poll },
          onTimeout: g.onTimeout,
          ...(g.credentialEnv ? { credentialEnv: g.credentialEnv } : {}),
        },
      });
      if (predecessor) edges.push({ from: predecessor, to: gateId });
      agentPredecessor = gateId;
    }

    // agent → opens the PR, emits it as a typed `pr` fact the downstream nodes late-bind.
    nodes.push({
      id: openId,
      kind: "agent",
      agent: { jobType: AGENT_JOB_TYPE, prompt: `Implement ${issueKey} and open a PR.` },
      emits: [{ ...PR_EMIT }],
    });
    // connector[converge-merge] → drive the opened PR through review convergence + the merge loop.
    nodes.push({
      id: landId,
      kind: "connector",
      connector: { target: CONVERGE_MERGE_TARGET, payload: { pr: prRef } },
    });
    // wait[pr, merged] → observe the PR reaching `merged`, with a realistic poll budget.
    nodes.push({
      id: mergedId,
      kind: "wait",
      wait: {
        kind: PR_PROBE_KIND,
        target: prRef,
        match: { prState: "merged" },
        poll: { ...MERGE_POLL },
        onTimeout: "escalate",
      },
    });

    // Thread the `pr` fact to both consumers (required — an unthreaded reference is `unbound-pr`).
    edges.push({ from: prRef, to: landId });
    edges.push({ from: prRef, to: mergedId });

    // Sequence: this issue's agent starts once its predecessor (prior merge / epic gate / interleaved
    // gate) released. A first ungated issue has no predecessor edge (it starts immediately).
    if (agentPredecessor) edges.push({ from: agentPredecessor, to: openId });
  });

  const gateCount = entries.filter((e) => e.gate).length;
  const name =
    entries.length === 1
      ? `sequence ${entries[0].issueKey}`
      : `sequence ${entries.length} issues${gateCount > 0 ? ` with ${gateCount} gate${gateCount === 1 ? "" : "s"}` : ""}${behindKey ? ` behind ${behindKey}` : ""}`;

  return { name, nodes, edges };
}

/** Narrow an untyped value to a plain object so its fields can be read as `unknown`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
