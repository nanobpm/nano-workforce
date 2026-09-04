// nano-workforce — the delivery-graph RUNNER (ADR 0005 slice S4). The integration step that turns the
// PURE compiled preview (S1's `compileDeliveryGraph`) into a RUNNING, engine-native process: it deploys
// the compile-to-native one-shot definition and starts an instance, seeding each node's config so the
// inlined subProcess bodies (agent/wait/human/connector) delegate to their existing worker / user-task
// bodies. It builds NO execution machinery of its own (Decision 2 — the graph SCHEDULES; the engine
// runs it); its whole job is deploy + seed + start.
//
// Definition lifecycle (the ADR open question, resolved here): the deployed process id is
// CONTENT-ADDRESSED — `delivery-graph-<sha256(semanticBpmn)[:12]>` (the pre-layout semantic model, NOT
// the laid-out `bpmn` — issue #716). Identical graphs compile byte-identically
// (S1 determinism) → identical id → an idempotent redeploy (the engine versions the same id, never a
// duplicate definition per run); different graphs get different ids and never collide; and because the
// id ENCODES its content, a stale one-shot definition is GC-identifiable by a later sweeper (out of
// scope to implement the sweeper — the naming is what enables it). The base id the compiler emits
// (`DELIVERY_GRAPH_PROCESS_ID`) is the single substitution target, so the runner never hardcodes it.

import { createHash, randomUUID } from "node:crypto";
import type { EngineClient } from "@nanobpm/urban";
import type { DeliveryFact, DeliveryGraph, DeliveryNode } from "../nano-generated/api-io.d.ts";
import { TRANSCRIPT_URL_BASE_VAR, transcriptUrlBaseFor } from "./agentic/transcript-url.ts";
import { assertNever, compileDeliveryGraph, DELIVERY_GRAPH_PROCESS_ID } from "./deliveryGraphCompiler.ts";
import { DEFAULT_EVERY_MS, msToIsoDuration, parseProbe, readinessPollEvery, readinessTimeout } from "./readiness.ts";
import { RepoEnvelopeConflictError, requireRepoEnvelopeVars } from "./repoEnvelope.ts";
import { isoDuration } from "./reviewWait.ts";

/** The content digest of a compiled graph — `sha256(semanticBpmn)[:12]` — the single source of truth
 * for the content-addressed deploy id (`delivery-graph-<digest>`) AND the dispatch fence's default
 * idempotency key + the staged-proposal primary key. The runner (deploy id),
 * `app/deliveryGraphDispatch` (dedupe key), and `app/deliveryGraphProposals` (proposal digest) all
 * derive from THIS one function so they can never drift on how a graph is addressed.
 *
 * The digest is taken over the graph's SEMANTIC BPMN (the pre-layout `compileDeliveryGraphSemantic`
 * output), NOT the laid-out `bpmn` (issue #716). The diagram interchange is DERIVED deterministically
 * from the semantic model, so the semantic BPMN is the true canonical content of a graph — and, unlike
 * the laid-out BPMN, it is available WITHOUT the CPU-bound `layoutBpmn` pass. This lets the agent-facing
 * compile+stage doors content-address (and stage) a graph on the fast path while the expensive layout is
 * deferred to the operator's preview/dispatch. Every caller MUST pass a `semanticBpmn` so the address
 * stays consistent across staging, preview, dispatch, and deploy. */
export function deliveryGraphDigest(semanticBpmn: string): string {
  return createHash("sha256").update(semanticBpmn).digest("hex").slice(0, 12);
}

/** The bounded-timeout / SLA envelope every node inherits (Decision: bounded → escalate). ISO-8601
 * durations. Defaults are conservative; a caller (the S5 door) may tighten them per run. */
export interface DeliveryRunTimeouts {
  /** `agent`/`connector` service-node bounded timeout before it escalates onto a human-completable task. */
  nodeTimeout?: string;
  /** `wait` gate poll budget before it escalates (the engine bound; the probe itself is read-only). */
  probeTimeout?: string;
  /** `human` node SLA before it records an `escalated` outcome and settles. */
  escalationSlaTimeout?: string;
  /** `wait` gate retry cadence owned by the engine. */
  probePollEvery?: string;
  /** Optional explicit assignee for `human` nodes + escalation tasks (else candidate-group routed). */
  escalationAssignee?: string | null;
}

export interface DeliveryRunOptions extends DeliveryRunTimeouts {
  /** A per-run token that scopes each `wait` node's gate key (`<runKey>:<element>`) so two concurrent
   * runs of the same graph never share a gate correlation. Defaults to a fresh random per-run token
   * (`randomUUID()`) — NOT the graph digest, which every run of an identical graph would share and so
   * cross-correlate. Pass an explicit `runKey` only when you need a reproducible/externally-owned gate
   * scope. */
  runKey?: string;
  /** OPTIONAL `owner/repo` the run's `agent` nodes implement against. Together with `baseBranch` the
   * runner seeds the canonical repository-provisioning envelope (`io.nanobpm.agentTask.repository`, via
   * `requireRepoEnvelopeVars`) as a run-root `createInstance` process variable so each `agent` cell's
   * servicing `senior:*` job provisions an ISOLATED throwaway clone instead of inheriting the worker's
   * launch dir (issue #684/#686 — the same isolation the legacy feature/plan paths got in #685).
   *
   * Issue #729: the envelope is now REQUIRED unless the run is EXPLICITLY `repoless`. A run that is not
   * `repoless` but supplies an unresolved/missing `repository`/`baseBranch` throws
   * `RepoEnvelopeUnresolvedError` at seed time (a loud launch failure) rather than silently degrading to
   * the shared launch-dir behaviour that let concurrent fan-out workers clobber one checkout. */
  repository?: string | null;
  /** OPTIONAL base branch the run's `agent` nodes branch off — the `ref` the harness checks out in the
   * isolated clone (the PRE-PR shape: no PR head exists yet, so the agent cuts its own `feat/<node.id>`
   * branch off this base inside the clone). Required (with `repository`) unless the run is `repoless`. */
  baseBranch?: string | null;
  /** EXPLICIT opt-out of repository provisioning (issue #729). `true` → the run is dispatched with NO
   * isolation envelope (the legacy launch-dir behaviour), for a genuinely repo-less graph (e.g. one with
   * no `agent` nodes that touch a checkout). This must be a CONSCIOUS choice at the dispatch door so the
   * default can never silently share a checkout: when it is not set, `repository` + `baseBranch` are
   * mandatory and an unresolved pair is a hard launch failure, not a silent no-envelope fallback. */
  repoless?: boolean;
}

const DEFAULTS: Required<Omit<DeliveryRunTimeouts, "escalationAssignee">> = {
  nodeTimeout: "PT1H",
  probeTimeout: "PT30M",
  probePollEvery: msToIsoDuration(DEFAULT_EVERY_MS),
  escalationSlaTimeout: "P1D",
};

/** The per-node config the compiled subProcess ioMappings read from `nodeInputs.<element>`. A closed
 * union mirrored by the compiler's `ioMappingLines` — the two must agree on field names (a drift here
 * silently seeds `null` into a node body), so both derive from the same node kinds. */
type NodeInput =
  | { jobType: string; appendPrompt: string; timeout: string }
  | { gateKey: string; probe: unknown; probeTimeout: string; probePollEvery: string }
  | { escalationSlaTimeout: string; escalationAssignee: string | null; prompt: string; nodeId: string; emits: DeliveryFact[] }
  | { target: string; dedupeKey: string | null; payload: Record<string, unknown> | null; timeout: string };

/** The result of compiling + preparing a graph for deployment: the content-addressed process id, the
 * deployable BPMN (base id rewritten), and the seeded `nodeInputs` map — everything `runDeliveryGraph`
 * needs, exposed separately so a caller can deploy/inspect without starting an instance. */
export interface PreparedDeliveryGraph {
  processDefinitionId: string;
  bpmn: string;
  nodeInputs: Record<string, NodeInput>;
}

export type PrepareDeliveryResult =
  | { ok: true; prepared: PreparedDeliveryGraph }
  | { ok: false; errors: { path: string; message: string }[] };

/** A live delivery-graph run: the deployed definition + the started instance + the seed it ran with. */
export interface DeliveryRunHandle extends PreparedDeliveryGraph {
  processInstanceKey: string;
}

export type RunDeliveryResult =
  | { ok: true; handle: DeliveryRunHandle }
  | { ok: false; errors: { path: string; message: string }[] };

/** Compile a graph and prepare it for deployment WITHOUT touching the engine: content-address its id,
 * rewrite the base process id, and build the `nodeInputs` seed. The deployable DEFINITION (the
 * content-addressed `processDefinitionId` and the `bpmn`) is deterministic — the same graph yields the
 * same id, which is what makes redeploy idempotent — because the gate scope lives in `nodeInputs`
 * (runtime instance variables), not in the BPMN. The default `runKey` is a fresh random per-run token,
 * so each call's `wait` `gateKey`s differ (two concurrent runs of the same graph never cross-correlate);
 * pass an explicit `runKey` for a reproducible seed. Returns the S1 compile errors verbatim for a
 * malformed graph. */
export async function prepareDeliveryGraph(
  graph: DeliveryGraph,
  options: DeliveryRunOptions = {},
): Promise<PrepareDeliveryResult> {
  const compiled = await compileDeliveryGraph(graph);
  if (!compiled.ok) return { ok: false, errors: compiled.errors };

  const digest = deliveryGraphDigest(compiled.semanticBpmn);
  const processDefinitionId = `${DELIVERY_GRAPH_PROCESS_ID}-${digest}`;
  const bpmn = rewriteProcessId(compiled.bpmn, processDefinitionId);

  const runKey = options.runKey?.trim() || randomUUID();
  // Normalize the run-level timeouts through isoDuration so a programmatic caller that bypasses the
  // OpenAPI/door validators cannot bake a malformed or lower-case duration into a BPMN timer FEEL —
  // isoDuration canonicalizes case and falls back to the default on a malformed/blank value.
  const timeouts = {
    nodeTimeout: isoDuration(options.nodeTimeout, DEFAULTS.nodeTimeout),
    probeTimeout: isoDuration(options.probeTimeout, DEFAULTS.probeTimeout),
    probePollEvery: isoDuration(options.probePollEvery, DEFAULTS.probePollEvery),
    escalationSlaTimeout: isoDuration(options.escalationSlaTimeout, DEFAULTS.escalationSlaTimeout),
    escalationAssignee: options.escalationAssignee ?? null,
  };
  const elementByNodeId = new Map(compiled.resolved.nodes.map((n) => [n.id, n.element]));
  const nodeInputs: Record<string, NodeInput> = {};
  for (const node of graph.nodes) {
    const element = elementByNodeId.get(node.id);
    if (element === undefined) continue; // unreachable — resolved covers every node — but keep total.
    nodeInputs[element] = buildNodeInput(node, { runKey, element, ...timeouts });
  }
  return { ok: true, prepared: { processDefinitionId, bpmn, nodeInputs } };
}

/** Deploy + start a compiled graph as a running engine-native instance. Idempotent at the DEFINITION
 * level (content-addressed id — redeploying the same graph re-uses the definition); each call still
 * starts a fresh INSTANCE (a distinct run of that definition). Returns the run handle, or the compile
 * errors for a malformed graph (the engine is never touched in that case). */
export async function runDeliveryGraph(
  engine: Pick<EngineClient, "deployResources" | "createInstance">,
  graph: DeliveryGraph,
  options: DeliveryRunOptions = {},
): Promise<RunDeliveryResult> {
  const prep = await prepareDeliveryGraph(graph, options);
  if (!prep.ok) return prep;
  const { processDefinitionId, bpmn, nodeInputs } = prep.prepared;

  await engine.deployResources([{ name: `${processDefinitionId}.bpmn`, content: bpmn, contentType: "application/xml" }]);
  const base = typeof options.baseBranch === "string" && options.baseBranch.trim() !== "" ? options.baseBranch.trim() : null;
  const repo = typeof options.repository === "string" && options.repository.trim() !== "" ? options.repository.trim() : null;
  // Host-git provisioning (c8ctl, issue #684/#686/#729): resolve the ONE canonical repository envelope
  // (`app/repoEnvelope.ts`) BEFORE seeding so every `agent` node's servicing `senior:*` job gets an
  // ISOLATED throwaway clone instead of inheriting the worker's launch dir — otherwise several copilot
  // workers on one host share (and clobber) a single checkout, the exact field failure #684 described.
  // This is the delivery-graph analog of the whole-epic seed in `app/plan.ts`: a single run-root
  // `createInstance` process variable that propagates through each agent cell's subProcess into its job.
  // Like plan.ts's fan-out seed it carries `ref = base` but NO `branchCreate` — a run fans out to MANY
  // agent nodes, each needing its own deterministic `feat/<node.id>` branch, so a single run-level
  // envelope can't name one; each agent cuts its own branch off `base` inside the isolated clone (the
  // agent-guide's `feat/*` convention, kept idempotent by the #551 preflight). `baseRef = base` too, so
  // the harness keeps `origin/<base>` reachable for the review 3-dot diff.
  //
  // Issue #729: the envelope is REQUIRED here unless the run is EXPLICITLY `repoless`. A run that is not
  // `repoless` but whose `repository`/`baseBranch` are unresolved throws `RepoEnvelopeUnresolvedError`
  // (a loud launch failure the dispatch door surfaces as a 400 and `dispatchDeliveryGraphRun` marks the
  // run `failed`) rather than silently emitting `{}` and degrading every agent to the shared launch dir.
  // Only an explicit `repoless: true` (a conscious operator opt-in for a genuinely repo-less graph)
  // dispatches with no envelope.
  //
  // `repoless: true` is MUTUALLY EXCLUSIVE with `repository`/`baseBranch`: the dispatch door already
  // rejects the conflicting shape with a 400, but a PROGRAMMATIC caller (test/internal) that bypasses
  // the door could pass both — and silently disable isolation (the `repoless` arm just drops the
  // repo/base and emits `{}`). Re-enforce the exclusivity HERE too (defense-in-depth, mirroring the
  // door) so a conflicting-but-well-meant call fails LOUDLY at seed time rather than quietly degrading
  // to the shared launch dir it named a repo to avoid.
  if (options.repoless === true && (repo !== null || base !== null)) {
    throw new RepoEnvelopeConflictError(
      `repoless run also named repository=${JSON.stringify(repo)} baseBranch=${JSON.stringify(base)}`,
    );
  }
  const repoVars = options.repoless === true ? {} : requireRepoEnvelopeVars(repo ?? "", base, base);
  const { processInstanceKey } = await engine.createInstance({
    processDefinitionId,
    variables: {
      nodeInputs,
      // Stage 0 transcript correlation (#543): the transcript-endpoint base every agent node's
      // completing worker appends its jobKey-scoped stream to, to emit `transcriptUrl` (see the agent
      // node ioMapping in deliveryGraphCompiler). Seeded once at the run root — the same value for
      // every node — and read down into each agent job via `=transcriptUrlBase`.
      [TRANSCRIPT_URL_BASE_VAR]: transcriptUrlBaseFor(),
      // Spread the resolved repository-isolation envelope (empty `{}` only on an explicit `repoless`
      // run — see above) LAST so it never clobbers the other run-root vars.
      ...repoVars,
    },
  });
  // The engine can yield a numeric key; `DeliveryRunHandle.processInstanceKey` is typed `string` and
  // downstream consumers expect a string — coerce (codebase-wide `String(...)` pattern, e.g. app/plan.ts).
  return {
    ok: true,
    handle: { processDefinitionId, bpmn, nodeInputs, processInstanceKey: String(processInstanceKey) },
  };
}

/** Rewrite the compiled BPMN's base `bpmn:process` id to the content-addressed deploy id. The base id
 * appears exactly once as the process element's `id` attribute (element ids are `n<i>`/`gw*`/`Start`/
 * `End`, never the process id), and once more as the top-level `bpmndi:BPMNPlane`'s `bpmnElement`
 * reference back to that process (the diagram interchange the compiler now attaches, #440). Both must
 * move together, otherwise the deployed definition carries a DANGLING plane reference and renders
 * positionless — the very bug DI was added to fix. Nested sub-process planes reference `n<i>` element
 * ids, which are untouched. */
function rewriteProcessId(bpmn: string, processDefinitionId: string): string {
  return bpmn
    .replace(`id="${DELIVERY_GRAPH_PROCESS_ID}"`, `id="${processDefinitionId}"`)
    .replace(`bpmnElement="${DELIVERY_GRAPH_PROCESS_ID}"`, `bpmnElement="${processDefinitionId}"`);
}

/** The idempotency preflight prepended to EVERY `agent` node's `appendPrompt` (issue #551). A delivery
 * agent node dispatches a raw `senior:feature` job with no `feature_runs` idempotency row and no
 * PR-existence guard, and the job carries retries — so an idle/timeout re-dispatch hands the SAME
 * "implement #N" prompt to another worker, who (in a fresh worktree, blind to the first) opens a SECOND
 * PR on the same issue. That is exactly how instance 43077's node n0 (`Magikcraft/nano-bpm#977`) spawned
 * the #979/#980 duplicate. The advisory AGENTS.md claim protocol did not prevent it because nothing tells
 * the *agent* to look first. This block does: a preflight that makes the agent **adopt-and-report** an
 * existing PR instead of opening a duplicate. Adopt-and-report (not "escalate") because a delivery agent
 * node has NO in-band escalate route — an in-flight agent can only complete (job done) or fail (which
 * raises an incident, the stuck state we are avoiding); adopting completes the completion-barrier node
 * cleanly, with no duplicate and no incident. Fixed wording (no derived data), so identical graphs still
 * compile+seed deterministically; it is unconditional because every agent node that opens a PR is exposed
 * to the same re-dispatch race. This is an advisory guard — the categorical fix (an engine-level
 * preflight guard, or routing the node through the idempotent feature cell) is tracked as a follow-up. */
export function renderIdempotencyPreamble(): string {
  return [
    "## Idempotency preflight (delivery graph) — check BEFORE you implement",
    "",
    "This node may be re-dispatched (a retry after a timeout) or run in parallel with another worker.",
    "BEFORE you write ANY code, confirm nobody is already delivering the issue you were asked to implement:",
    "",
    "1. Read that issue's comments for an existing **claim** (a comment beginning `Claimed —`, an",
    "   assignee, or a referenced in-progress branch/worktree).",
    "2. List the repository's OPEN pull requests for one that already references the issue (a `Closes",
    "   #N`, the issue number in its title/body, or a branch named for it).",
    "",
    "If an existing claim OR an open PR already covers this issue, DO NOT open a second PR — a duplicate",
    "PR is a defect: it splits review and collides in the same files. Instead **adopt and report**:",
    "complete WITHOUT making any changes and return the EXISTING PR as your result — put it in your `pr`",
    "field (a URL or `owner/repo#N`) and complete with your normal success status, with a `summary` that",
    "names the PR you adopted. This satisfies the node cleanly; a downstream door (or a human) drives the",
    "existing PR the rest of the way.",
    "",
    "Only implement — and open your own PR — when NO claim and NO open PR exist for the issue.",
    "",
    "---",
    "",
    "",
  ].join("\n");
}


/** Render the classifier-emit contract appended to an `agent` node's `appendPrompt` (issue #506) — the
 * instruction that turns a declared `emits[]` into completion variables a downstream guarded split (S7)
 * can route on. A `senior:*` fleet agent completes with the Output-contract envelope (`status`,
 * `summary`, `pr`, …); the delivery output ioMapping instead publishes the engine variable named exactly
 * after each fact (`factSourceVar` → `fact.name`), so the agent must ALSO return each declared fact as a
 * TOP-LEVEL field of that same result JSON. This block tells it so, deriving entirely from the node's
 * declared `emits` (no second source of truth). Empty for a no-emit node → the prompt is unchanged, so a
 * plain implementation node behaves exactly as before. Deterministic: fixed wording, facts in declared
 * order, so identical graphs still compile+seed byte-identically. */
export function renderEmitContract(emits: readonly DeliveryFact[]): string {
  if (emits.length === 0) return "";
  const facts = emits.map((f) => `- \`${f.name}\` (${f.type})${f.description ? ` — ${f.description}` : ""}`);
  return [
    "",
    "",
    "---",
    "",
    "## Classifier emit contract (delivery graph)",
    "",
    "This node is a PRODUCER in a delivery graph: a downstream **guarded split** routes on the typed",
    "fact(s) below. In ADDITION to your normal result fields (`status`, `summary`, `pr`, …), the",
    "structured result you write to `AGENT_RESULT_FILE` MUST include these TOP-LEVEL fields, each a",
    "bare scalar of the declared type:",
    "",
    ...facts,
    "",
    "The value you return for each fact IS the routing decision — a downstream edge fires only when the",
    "fact equals a specific literal, otherwise the graph takes the `default` (else) branch. If you",
    "genuinely cannot determine a fact, OMIT it (the default branch is taken) rather than guessing.",
  ].join("\n");
}


/** Build the `nodeInputs.<element>` seed for one node, per its kind — the exact fields the compiled
 * subProcess ioMapping pulls. Total over the closed kind set. */
function buildNodeInput(
  node: DeliveryNode,
  ctx: { runKey: string; element: string; nodeTimeout: string; probeTimeout: string; probePollEvery: string; escalationSlaTimeout: string; escalationAssignee: string | null },
): NodeInput {
  switch (node.kind) {
    case "agent": {
      // Classifier-emit contract (issue #506). A `senior:*` fleet agent's real completion is the
      // Output-contract envelope (`{ status, summary, pr, … }`) — it does NOT return a bare fact, so a
      // node's declared `emits` would never appear and a downstream GUARDED split (S7) could only ever
      // take its `default` branch. Close the gap the same way `factSourceVar` already reads it: the
      // output ioMapping publishes the engine variable named exactly after each fact, so the agent must
      // return `{ <fact>: <value> }` AS A TOP-LEVEL field of its result JSON (the same channel that
      // carries `status`/`summary`/`pr`). The agent only knows to do this if it is TOLD — so the
      // declared emits are rendered into the node's `appendPrompt` (its sole steering channel; the
      // delivery agent node carries no base-prompt resource), keeping `emits` the single source of
      // truth. A no-emit node appends nothing, so a plain implementation node is unchanged.
      const basePrompt = node.agent.prompt ?? "";
      const emits = Array.isArray(node.emits) ? node.emits.map((f) => ({ ...f })) : [];
      return { jobType: node.agent.jobType, appendPrompt: renderIdempotencyPreamble() + basePrompt + renderEmitContract(emits), timeout: isoDuration(node.agent.timeout, ctx.nodeTimeout) };
    }
    case "wait": {
      const probe = parseProbe(node.wait, { allowLateBoundTarget: true });
      // Only a VALID, positive per-node budget overrides the run level. Match the `>= 1` predicate
      // `readinessTimeout`/`readinessPollEvery` apply internally, rather than a bare JS-truthiness
      // check on `poll.timeoutMs`/`everyMs`: a negative (`-1`) value is truthy, so a truthiness gate
      // would route to `readinessTimeout(probe, {})`, which then rejects it (`< 1`) and — because
      // `env` is `{}` — falls back to the *built-in* default (PT30M / DEFAULT_EVERY_MS), silently
      // discarding the run/dispatch override in `ctx.*`. Gating on the same validity predicate here
      // makes an invalid per-node value fall through to `ctx.probeTimeout`/`ctx.probePollEvery`.
      const declaredTimeout = typeof probe.poll?.timeoutMs === "number" && probe.poll.timeoutMs >= 1;
      const declaredEvery = typeof probe.poll?.everyMs === "number" && probe.poll.everyMs >= 1;
      return {
        gateKey: `${ctx.runKey}:${ctx.element}`,
        probe: node.wait,
        // Per-node escalation boundary (#462): a `wait` node's declared `poll.timeoutMs` drives its
        // compiled `=probeTimeout` bound, mirroring the `everyMs → probePollEvery` override below —
        // otherwise a node's poll budget is honored for the interval but silently ignored for the
        // boundary (a 7-day gate escalated at the 30-minute run default). Falls back to the run-level
        // `ctx.probeTimeout` (which itself honors the dispatch override / default) when undeclared.
        probeTimeout: declaredTimeout ? readinessTimeout(probe, {}) : ctx.probeTimeout,
        probePollEvery: declaredEvery ? readinessPollEvery(probe, {}) : ctx.probePollEvery,
      };
    }
    case "human":
      return {
        escalationSlaTimeout: ctx.escalationSlaTimeout,
        escalationAssignee: ctx.escalationAssignee,
        // Seed the authored instruction, node identity, and declared emits so the human user-task's
        // form can render its "now do X" prompt, name the parked node, and label/hide its emit field
        // (issue #499 — the generic form otherwise renders contextless). `emits` stays the single
        // source of truth: the compiled ioMapping derives the emit label/mode from it in FEEL.
        prompt: node.human?.prompt ?? "",
        nodeId: node.id ?? ctx.element,
        emits: Array.isArray(node.emits) ? node.emits.map((f) => ({ ...f })) : [],
      };
    case "connector":
      return {
        target: node.connector.target,
        dedupeKey: node.connector.dedupeKey ?? null,
        payload: node.connector.payload ?? null,
        timeout: isoDuration(node.connector.timeout, ctx.nodeTimeout),
      };
    default:
      return assertNever(node, "buildNodeInput");
  }
}
