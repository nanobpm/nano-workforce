// app/deliveryGraphVocabulary.ts — the delivery-graph vocabulary + wait-probe semantics as
// STRUCTURED DATA (epic nano-workforce#605, S3/#609). Served by GET /app/api/delivery-graph/vocabulary
// (operationId `getDeliveryGraphVocabulary`, a read tool projected onto the MCP surface like
// `getAgentInstructions`), so an agent can DISCOVER the closed node/probe/connector vocabulary and the
// non-obvious wait semantics from the surface instead of reading source (the evidence session in #605:
// an agent had to grep `app/readiness.ts` to learn `wait[epic]` also gates a feature run).
//
// Derivation over duplication (AGENTS.md — "no drift surfaces"). Everything that has a closed,
// compiler-enforced source of truth is DERIVED from it, never re-typed:
//   • node kinds        ← `DELIVERY_NODE_KINDS`      (app/deliveryGraph.ts — the trust boundary)
//   • fact types        ← `DELIVERY_FACT_TYPES`      (app/deliveryGraph.ts)
//   • guardable scalars ← `DELIVERY_GUARD_SCALAR_TYPES`
//   • wait probe kinds  ← `PROBE_KINDS`              (app/readiness.ts — what `parseProbe` accepts)
//   • pr conditions     ← `PR_CONDITIONS`            (app/readiness.ts)
//   • epic conditions   ← `EPIC_CONDITIONS`          (app/readiness.ts)
//   • onTimeout options ← `ON_TIMEOUTS`              (app/readiness.ts)
//   • poll defaults     ← `DEFAULT_TIMEOUT_MS`/`DEFAULT_EVERY_MS`/`DEFAULT_READINESS_TIMEOUT`
//   • real connector targets ← `converge`/`converge-merge`/`merge-main` (app/convergeTargets.ts)
// The prose (body contracts, what each probe OBSERVES, the poll-budget trap, fact-threading) is
// co-located here; `app/deliveryGraphVocabulary.test.ts` is the drift guard — it fails the build if a
// probe kind / connector target / node kind is added to the compiler without a vocabulary entry.
import {
  CONVERGE_MERGE_TARGET,
  CONVERGE_TARGET,
  convergeOnlyForTarget,
  MERGE_MAIN_TARGET,
} from "./convergeTargets.ts";
import { DELIVERY_FACT_TYPES, DELIVERY_GUARD_SCALAR_TYPES, DELIVERY_NODE_KINDS } from "./deliveryGraph.ts";
import {
  DEFAULT_EVERY_MS,
  DEFAULT_READINESS_TIMEOUT,
  DEFAULT_TIMEOUT_MS,
  EPIC_CONDITIONS,
  ON_TIMEOUTS,
  PR_CONDITIONS,
  PROBE_KINDS,
} from "./readiness.ts";

/** A node-kind entry: the closed `kind`, its per-kind config key + required/optional body fields, and
 * whether it is side-effecting / may emit facts. `body` names the executable engine-native surface the
 * graph layer schedules onto (the graph layer does NOT re-implement execution). */
export interface NodeKindEntry {
  kind: string;
  configKey: string;
  requiredFields: string[];
  optionalFields: string[];
  sideEffecting: boolean;
  mayEmit: boolean;
  summary: string;
}

/** A wait-probe entry: the closed `kind`, the `match` fields it reads, and — crucially — WHAT it
 * OBSERVES (the read that decides readiness) and WHEN it is ready. */
export interface WaitProbeEntry {
  kind: string;
  target: string;
  matchFields: string[];
  conditions?: string[];
  observes: string;
  ready: string;
  binds?: string[];
}

/** A connector target: whether it is a REAL side-effecting target (a converge-enrollment target that
 * dispatches through `submitPr`) or a FORWARD-DECLARED stub (the connector I/O surface is an ADR 0005
 * non-goal — an unrecognised target returns a deterministic acknowledgement and performs no I/O). */
export interface ConnectorTargetEntry {
  target: string;
  status: "real" | "forward-declared";
  convergeOnlyDefault?: boolean;
  summary: string;
}

/** An `onTimeout` option: what the bounded wait does when the engine timer arm fires. */
export interface OnTimeoutEntry {
  value: string;
  meaning: string;
}

/** The whole structured vocabulary the read tool returns. */
export interface DeliveryGraphVocabulary {
  adr: string;
  summary: string;
  nodeKinds: NodeKindEntry[];
  factTypes: string[];
  guardScalarTypes: string[];
  waitProbeKinds: WaitProbeEntry[];
  connectorTargets: ConnectorTargetEntry[];
  onTimeout: OnTimeoutEntry[];
  pollBudget: {
    defaultTimeoutMs: number;
    defaultTimeoutIso: string;
    defaultEveryMs: number;
    rule: string;
  };
  factThreading: {
    rule: string;
    details: string[];
  };
  guideSection: string;
}

// ── Node kinds (DERIVED from DELIVERY_NODE_KINDS — the closed allowlist / trust boundary) ─────────
const NODE_KIND_DETAIL: Record<string, Omit<NodeKindEntry, "kind">> = {
  agent: {
    configKey: "agent",
    requiredFields: ["jobType"],
    optionalFields: ["prompt", "converge", "merge"],
    sideEffecting: true,
    mayEmit: true,
    summary:
      "A worker runs an agent job type (the fan-out body, e.g. `senior:feature`). First-class " +
      "`converge?`/`merge?` cell-policy flags declare review-convergence / landing intent (`merge` " +
      "requires `converge`); a raw `senior:converge`/`senior:merge` jobType is rejected (`raw-converge-node`). " +
      "An `agent` that opens a PR emits it as a `pr`-typed fact so downstream connector/wait nodes late-bind it.",
  },
  wait: {
    configKey: "wait",
    requiredFields: ["kind", "target"],
    optionalFields: ["match", "poll", "onTimeout", "credentialEnv"],
    sideEffecting: false,
    mayEmit: true,
    summary:
      "A durable, bounded, read-only readiness probe (a `ReadinessProbe` verbatim). `wait.kind` selects " +
      "the probe (see waitProbeKinds); `poll` is `{ everyMs?, timeoutMs?, backoff? }`. Binds observed " +
      "facts (e.g. a merged `pr` binds `mergedSha`).",
  },
  human: {
    configKey: "human",
    requiredFields: [],
    optionalFields: ["formKey", "prompt"],
    sideEffecting: false,
    mayEmit: true,
    summary:
      "A scheduled user task + form (the Tasks inbox). Blocks dependents, SLA-bounded, answerable by a " +
      "human OR an agent. Config is optional (no required field).",
  },
  connector: {
    configKey: "connector",
    requiredFields: ["target"],
    optionalFields: ["dedupeKey", "payload"],
    sideEffecting: true,
    mayEmit: true,
    summary:
      "An automated, side-effecting outbound action. `payload` for a converge target is " +
      "`{ pr, convergeOnly?, dependsOn? }` (`pr` may be a literal `owner/repo#N`, a `<node>.pr` fact " +
      "reference, or omitted to auto-bind the single incoming `pr` fact). Carries a `dedupeKey` " +
      "(at-least-once safe). See connectorTargets for which targets are real vs. forward-declared.",
  },
};

// ── Wait probe kinds (DERIVED from PROBE_KINDS — what `parseProbe` accepts) ───────────────────────
const WAIT_PROBE_DETAIL: Record<string, Omit<WaitProbeEntry, "kind">> = {
  http: {
    target: "a URL",
    matchFields: ["status", "bodyIncludes"],
    observes: "an HTTP GET against `target` (optional `credentialEnv` supplies an Authorization credential by env-key name).",
    ready: "the response status matches `match.status` (default: any 2xx) and the body contains `match.bodyIncludes` if set.",
  },
  command: {
    target: "a shell command",
    matchFields: ["exitCode", "stdoutIncludes"],
    observes: "running `target` as a subprocess (the escape hatch for the long tail — `gh`, `curl`, `docker manifest inspect`).",
    ready: "the exit code matches `match.exitCode` (default 0) and stdout contains `match.stdoutIncludes` if set.",
  },
  npm: {
    target: "a `pkg@version` (or bare `pkg`)",
    matchFields: ["version", "stdoutIncludes"],
    observes: "the npm registry for a published version of the package.",
    ready: "`match.version` (default: the version in `pkg@version`) is published.",
  },
  "github-check": {
    target: "an `owner/repo@ref`",
    matchFields: ["conclusion", "checkName"],
    observes: "the GitHub check runs on `ref`.",
    ready: "the check run's conclusion matches `match.conclusion` (default `success`), restricted to `match.checkName` if set.",
  },
  capability: {
    target: "a package/context handle",
    matchFields: ["capabilityRef", "package", "verifyCommand"],
    observes:
      "the publish-provenance substrate: which published `package` version first carries the `capabilityRef` " +
      "issue/PR — an optional `verifyCommand` runs once at the poll-budget boundary as a gated empirical fallback.",
    ready: "a published version of `match.package` carries `match.capabilityRef` in its provenance.",
    binds: ["resolvedArtifact"],
  },
  pr: {
    target: "an `owner/repo#N` PR (or a `<node>.pr` fact reference the compiler late-binds at dispatch)",
    matchFields: ["prState"],
    conditions: [...PR_CONDITIONS],
    observes:
      "the live GitHub state of a single in-flight PR. The ACTION (landing it) stays in a connector/merge " +
      "node body; this kind only OBSERVES, so it is level-triggered (no missed edge).",
    ready: "the PR reaches `match.prState` (default `merged`; one of the pr conditions).",
    binds: ["mergedSha"],
  },
  epic: {
    target:
      "the epic's durable `planKey` — `owner/repo#NN`, the epic ISSUE, not the engine processInstanceKey, " +
      "so a resubmit/replay still resolves (may also be a `<node>.fact` late-binding reference)",
    matchFields: ["epicState"],
    conditions: [...EPIC_CONDITIONS],
    observes:
      "the app's OWN lineage read-model (`/lineage?root=<planKey>`), resolved by `parseEpicLineage` to the " +
      "thread whose `rootRequestKey` matches the planKey — REGARDLESS OF the thread's `kind` (feature | epic | " +
      "pr | delivery). Because `app/lineage.ts` lands a FEATURE thread on `stage:\"merged\"` once its PR merges, " +
      "`wait[epic]` gates a single-PR FEATURE RUN just as well as a plan-fanout epic: point `target` at the " +
      "feature/epic root issue and it observes that thread's aggregate frontier. A failed/abandoned/mixed epic " +
      "settles on another terminal (`abandoned`/`resolved`/`converged`) and never reports merged, so it never " +
      "falsely releases the gate — the bounded wait routes via `onTimeout` instead of hanging.",
    ready: "the lineage thread reaches `stage:\"merged\" && active:false` (every opened slice/PR landed). `match.epicState` (default `merged`; `done` is a synonym) both mean \"fully merged\".",
    binds: ["prCount"],
  },
};

// ── Connector targets (real = the converge-enrollment set from convergeTargets.ts) ────────────────
const REAL_CONNECTOR_TARGETS: ConnectorTargetEntry[] = [
  {
    target: CONVERGE_TARGET,
    status: "real",
    convergeOnlyDefault: convergeOnlyForTarget(CONVERGE_TARGET),
    summary: "Converge-only: drive review convergence and STOP at `converged`, never handing off to the merge loop.",
  },
  {
    target: CONVERGE_MERGE_TARGET,
    status: "real",
    convergeOnlyDefault: convergeOnlyForTarget(CONVERGE_MERGE_TARGET),
    summary:
      "Unit-level land: drive review convergence AND the merge loop, landing the PR onto its OWN base branch " +
      "(for a unit inside an epic that base is the epic integration branch, never `main` directly).",
  },
  {
    target: MERGE_MAIN_TARGET,
    status: "real",
    convergeOnlyDefault: convergeOnlyForTarget(MERGE_MAIN_TARGET),
    summary:
      "Graph-level top-level land (two-level merge, ADR 0006 §3): land the graph/epic INTEGRATION PR onto `main`. " +
      "Dispatch-identical to `converge-merge`; the distinction is the LEVEL, kept a first-class literal.",
  },
];

/** The sentinel that describes ANY non-converge target: the connector I/O surface is forward-declared
 * (ADR 0005 non-goal), so an unrecognised `target` hits the default stub action and performs no real
 * side effect. Included so a caller learns the real-vs-stub split without reading `deliveryConnector.ts`. */
const FORWARD_DECLARED_ENTRY: ConnectorTargetEntry = {
  target: "<any other target>",
  status: "forward-declared",
  summary:
    "Forward-declared stub: the concrete connector I/O scheme is an ADR 0005 non-goal. A target outside the " +
    "converge-enrollment set returns a deterministic acknowledgement (`connector stub — I/O surface " +
    "forward-declared`) and fires NO real side effect until a real action is injected.",
};

const ON_TIMEOUT_DETAIL: Record<string, string> = {
  escalate: "park a human-in-the-loop escalation (the Tasks inbox) when the bounded wait elapses; a human/agent decides whether to extend the budget or abandon.",
  fail: "terminate the gate as failed. NOTE: not yet supported on a `wait` node (blocked on engine terminate-end wiring); the compiler rejects `onTimeout: fail` on a wait.",
  continue: "proceed as if ready when the wait elapses — use ONLY when downstream can tolerate a not-yet-ready upstream (a soft gate).",
};

/** Build the structured delivery-graph vocabulary. Pure — no I/O; every closed set is imported from
 * its owning module so this can never silently drift from what the compiler/runner actually accept. */
export function deliveryGraphVocabulary(): DeliveryGraphVocabulary {
  const nodeKinds: NodeKindEntry[] = DELIVERY_NODE_KINDS.map((kind) => {
    const detail = NODE_KIND_DETAIL[kind];
    if (!detail) throw new Error(`deliveryGraphVocabulary: no detail for node kind '${kind}' (drift — extend NODE_KIND_DETAIL)`);
    return { kind, ...detail };
  });

  const waitProbeKinds: WaitProbeEntry[] = PROBE_KINDS.map((kind) => {
    const detail = WAIT_PROBE_DETAIL[kind];
    if (!detail) throw new Error(`deliveryGraphVocabulary: no detail for wait probe kind '${kind}' (drift — extend WAIT_PROBE_DETAIL)`);
    return { kind, ...detail };
  });

  return {
    adr: "ADR 0005 — agent-authored delivery graphs",
    summary:
      "A delivery graph is a JSON DAG `{ name?, nodes[], edges[] }` an agent authors as DATA (never BPMN/code — " +
      "the closed node vocabulary is the trust boundary). The agent surface ends at propose → compile → stage; " +
      "DISPATCH is an operator-only cockpit action. This tool surfaces the closed vocabulary + the non-obvious " +
      "wait/poll/fact-threading semantics so they are discoverable, not source-only.",
    nodeKinds,
    factTypes: [...DELIVERY_FACT_TYPES],
    guardScalarTypes: [...DELIVERY_GUARD_SCALAR_TYPES],
    waitProbeKinds,
    connectorTargets: [...REAL_CONNECTOR_TARGETS, FORWARD_DECLARED_ENTRY],
    onTimeout: ON_TIMEOUTS.map((value) => {
      const meaning = ON_TIMEOUT_DETAIL[value];
      if (!meaning) throw new Error(`deliveryGraphVocabulary: no meaning for onTimeout '${value}' (drift — extend ON_TIMEOUT_DETAIL)`);
      return { value, meaning };
    }),
    pollBudget: {
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      defaultTimeoutIso: DEFAULT_READINESS_TIMEOUT,
      defaultEveryMs: DEFAULT_EVERY_MS,
      rule:
        `POLL-BUDGET TRAP: an omitted \`poll\`/\`poll.timeoutMs\` inherits the built-in default budget of ` +
        `${DEFAULT_READINESS_TIMEOUT} (${DEFAULT_TIMEOUT_MS} ms), re-probing every ${DEFAULT_EVERY_MS} ms. ` +
        `That default is right for "is the package published yet" but badly wrong for \`wait[pr, merged]\` / ` +
        `\`wait[epic]\`, which routinely wait hours or days — such a gate would escalate after 30 minutes for ` +
        `no visible reason (neither compile nor preview surfaces the effective bound). ALWAYS set a realistic ` +
        `\`poll.timeoutMs\` explicitly on any merge or epic gate.`,
    },
    factThreading: {
      rule:
        "A node's emitted `fact` is carried to a consumer ONLY by an EDGE. An edge `from` is either a bare " +
        "`<nodeId>` (the node's completion fact) or a qualified `<nodeId>.<fact>` referencing a declared `emits`. " +
        "A node that references a fact (e.g. a connector/`wait[pr]` late-binding `open.pr`) MUST have an incoming " +
        "edge threading that fact from every producer — an unthreaded reference is rejected (`unbound-pr`).",
      details: [
        "The referenced fact must be declared in the producer's `emits[]` with the right `type` (a `pr` reference must be `pr`-typed).",
        "A connector `payload` may OMIT `pr` to auto-bind the SINGLE incoming `pr` fact; with two `pr` facts flowing in you must name one.",
        "Only scalar facts (`string`/`number`/`boolean`) may be referenced by an edge `when` guard; `artifact`/`version`/`url`/`pr` are not guardable.",
        "The whole edge set must be a DAG; a self-edge or cycle is rejected.",
      ],
    },
    guideSection: "docs/agent-guide.md §9 (Author and run a delivery graph)",
  };
}
