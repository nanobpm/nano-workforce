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
import type { DeliveryEdge, DeliveryGraph, DeliveryNode } from "../nano-generated/api-io.d.ts";
import { CONVERGE_MERGE_TARGET } from "./convergeTargets.ts";
import { deliveryGraphVocabulary } from "./deliveryGraphVocabulary.ts";
import { parseIssue } from "./plan.ts";

/** A path-qualified validation failure — the uniform door error contract `issues[{path,message}]`
 * (the same shape the runtime request-validator and the S1 harness assert). */
export interface SequenceIssueError {
  readonly path: string;
  readonly message: string;
}

/** The `sequenceIssues` intent body — an optional leading `behind` gate plus the ordered `issues`. */
export interface SequenceIssuesIntent {
  behind?: string;
  issues: string[];
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

/**
 * Build the canonical delivery graph for a `sequenceIssues` intent, or return path-qualified
 * `issues[{path,message}]` rejections for invalid input. Validates:
 *   - `issues` is a non-empty array within {@link MAX_SEQUENCE_ISSUES};
 *   - every `issues[i]` and the optional `behind` parse as an `owner/repo#N` reference;
 *   - the connector target and wait-probe kinds it emits are known to the S3 vocabulary (drift guard).
 * Pure — no I/O. The constructed graph passes `validateDeliveryGraph` by construction.
 */
export function buildSequenceGraph(intent: unknown): SequenceIssuesResult {
  const issues: SequenceIssueError[] = [];

  const body = isRecord(intent) ? intent : {};
  const rawIssues = body.issues;
  const rawBehind = body.behind;

  // ── `issues`: a non-empty, bounded array of parseable refs ───────────────────────────────────
  const parsedIssues: string[] = [];
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
    rawIssues.forEach((ref, i) => {
      const parsed = typeof ref === "string" ? parseIssue(ref) : null;
      if (!parsed) {
        issues.push({
          path: `issues[${i}]`,
          message: `\`${String(ref)}\` is not a valid \`owner/repo#N\` issue reference.`,
        });
        return;
      }
      parsedIssues.push(parsed.planKey);
    });
  }

  // ── `behind` (optional): a parseable ref, when PRESENT ───────────────────────────────────────
  // Only an OMITTED gate (`undefined`/`null`) is "no gate"; a present-but-empty `behind: ""` is a
  // caller mistake (the schema requires `minLength: 1`), not an ungated sequence — reject it rather
  // than silently dropping the gate the caller asked for (matters most when this builder is invoked
  // directly, bypassing OpenAPI validation).
  let behindKey: string | null = null;
  if (rawBehind !== undefined && rawBehind !== null) {
    const parsed = typeof rawBehind === "string" ? parseIssue(rawBehind) : null;
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
  const vocab = deliveryGraphVocabulary();
  const realTargets = new Set(vocab.connectorTargets.filter((t) => t.status === "real").map((t) => t.target));
  if (!realTargets.has(CONVERGE_MERGE_TARGET)) {
    issues.push({
      path: "issues",
      message: `connector target \`${CONVERGE_MERGE_TARGET}\` is not a real target in the delivery-graph vocabulary.`,
    });
  }
  const probeKinds = new Set(vocab.waitProbeKinds.map((p) => p.kind));
  for (const kind of behindKey ? [PR_PROBE_KIND, EPIC_PROBE_KIND] : [PR_PROBE_KIND]) {
    if (!probeKinds.has(kind)) {
      issues.push({ path: "issues", message: `wait-probe kind \`${kind}\` is not in the delivery-graph vocabulary.` });
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  return { ok: true, graph: assembleGraph(parsedIssues, behindKey) };
}

/** Assemble the canonical node/edge chain for the (already-validated) issue keys + optional gate. */
function assembleGraph(issueKeys: string[], behindKey: string | null): DeliveryGraph {
  const nodes: DeliveryNode[] = [];
  const edges: DeliveryEdge[] = [];

  // Optional leading `wait[epic]` gate — the whole sequence waits for `behind` to be fully merged.
  const GATE_ID = "gate-epic";
  if (behindKey) {
    nodes.push({
      id: GATE_ID,
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

  issueKeys.forEach((issueKey, i) => {
    const n = i + 1;
    const openId = `open-${n}`;
    const landId = `land-${n}`;
    const mergedId = `merged-${n}`;
    const prRef = `${openId}.pr`;

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

    // Sequence: this issue's agent starts once the PRIOR issue merged; the first waits on the gate.
    if (i === 0) {
      if (behindKey) edges.push({ from: GATE_ID, to: openId });
    } else {
      edges.push({ from: `merged-${i}`, to: openId });
    }
  });

  const name =
    issueKeys.length === 1
      ? `sequence ${issueKeys[0]}`
      : `sequence ${issueKeys.length} issues${behindKey ? ` behind ${behindKey}` : ""}`;

  return { name, nodes, edges };
}

/** Narrow an untyped value to a plain object so its fields can be read as `unknown`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
