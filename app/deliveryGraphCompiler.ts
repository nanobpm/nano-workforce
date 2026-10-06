// nano-workforce — the TRUSTED, DETERMINISTIC compiler for an agent-authored delivery graph
// (ADR 0005, slice S1). It is the fast, safe INNER LOOP a co-designing agent hammers: given an
// agent-authored `DeliveryGraph` (the JSON contract from slice S0), it VALIDATES (the pure
// `validateDeliveryGraph` semantic check), then COMPILES it to a native artifact, and RENDERS a
// preview — but it NEVER deploys or dispatches anything (Decision 5/6: `compile` and `start` are
// SEPARATE doors; there is deliberately no `dryRun` flag on the start door). Being side-effect-free,
// it is callable repeatedly while the agent iterates JSON → compile → fix.
//
// Two invariants make it TRUSTED (Decision 1/2 — the closed node vocabulary is the trust boundary):
//
//   • It is human-written and DETERMINISTIC: the same input JSON always produces byte-identical
//     output (BPMN, diagram, resolved graph). Nodes/edges are sorted by id and every generated id is
//     assigned positionally, so there is no map-iteration or timestamp nondeterminism.
//   • It only ever instantiates ALLOWLISTED node kinds. The `compileNode` switch is exhaustive over
//     the closed `DeliveryNodeKind` union with a `never` default, so the compiler CANNOT emit a
//     construct for a non-allowlisted kind — a new kind fails `tsc` until it is deliberately handled.
//     `validateDeliveryGraph` is the runtime guard (an unknown kind is rejected before compilation);
//     the exhaustive switch is the compile-time guarantee.
//
// Compile-to-native (the first cut, Decision 6): each node maps to an engine-native call
// activity / sub-process (a `wait` reuses the real `readiness-gate`; `agent`/`connector` target
// forward-declared bodies S4 binds) and each edge becomes a native sequence flow, with explicit
// parallel gateways for genuine fan-out (>1 downstream) and fan-in (>1 upstream). This slice targets
// the WIRING/SHAPE — the concrete node bodies land in S4.

import type {
  CompileDeliveryGraphErrors,
  CompileDeliveryGraphResult,
  DeliveryFact,
  DeliveryGraph,
  DeliveryHumanStop,
  DeliveryNode,
  DeliverySideEffect,
  ResolvedDeliveryEdge,
  ResolvedDeliveryNode,
} from "../nano-generated/api-io.d.ts";
import { TRANSCRIPT_URL_BASE_VAR, TRANSCRIPT_URL_VAR } from "./agentic/transcript-url.ts";
import { CONVERGE_MERGE_TARGET, CONVERGE_TARGET, isConvergeTarget, MERGE_MAIN_TARGET } from "./convergeTargets.ts";
import { DELIVERY_CONNECTOR_TASK_TYPE } from "./deliveryConnector.ts";
import {
  AGENT_RESULT_LOCAL_VARS,
  analyzeExclusiveTopology,
  CONNECTOR_RESULT_LOCAL_VARS,
  canonicalJson,
  type DeliveryGraphError,
  deliveryNodeFacts,
  ESCALATION_DECISION_RETRY,
  ESCALATION_DECISION_VAR,
  ESCALATION_LOCAL_VARS,
  ESCALATION_NOTE_VAR,
  HUMAN_RESULT_LOCAL_VARS,
  hasXmlInvalidChars,
  redactConnectorValue,
  resolveDeliveryFrom,
  stripXmlInvalidChars,
  validateDeliveryGraph,
} from "./deliveryGraph.ts";
import { DELIVERY_CONTRACT_TWIN_SUFFIX, DELIVERY_ESCALATION_TWIN_SUFFIX, DELIVERY_HUMAN_ELEMENT, DELIVERY_WAIT_ESCALATION_TWIN_SUFFIX, ESCALATION_FORM, GENERIC_HUMAN_FORM, resolveHumanForm } from "./deliveryHuman.ts";
import { layoutBpmnOffThread } from "./layoutOffThread.ts";
import { DEFAULT_BACKOFF, DEFAULT_EVERY_MS, DEFAULT_ON_TIMEOUT, DEFAULT_TIMEOUT_MS, isProbeKind, normalizePoll, redactString } from "./readiness.ts";
// `redactFreeText` now lives in the low-level `redactText.ts` helper (both this compiler and
// `deliveryHuman.ts` import it there) to break the former `compiler ⇄ deliveryHuman` import cycle
// (PR #863 review). Re-exported here so existing `./deliveryGraphCompiler.ts` consumers keep resolving it.
import { redactFreeText } from "./redactText.ts";
import { AGENT_TASK_NS } from "./repoEnvelope.ts";
import { isoDuration } from "./reviewWait.ts";

export { redactFreeText };

/** A display-safe rendering of a `wait` probe's target for user-visible BPMN name/documentation
 * (issue #778 review): a `command` target is an arbitrary shell snippet that can embed a secret, so it
 * is never surfaced — only a fixed placeholder; an `http` target can carry a credential in its
 * `user:pass@` userinfo or `?query`/`#fragment`, so it goes through the same {@link redactString} log
 * redaction. A structured, non-credential identifier (`owner/repo#42`, `pkg@version`, `owner/repo@ref`,
 * a `<node>.<fact>` ref) is shown VERBATIM — but because the graph validator only requires a non-empty
 * target (and `parsePrTarget` accepts any prefix before `#<digits>`), a URL-SHAPED value smuggled into
 * one of those kinds is still routed through the same URL-only {@link redactConnectorValue}, so a
 * `//user:pass@host/repo#42` has its credential stripped while a legitimate `#`/`@` in a structured ref
 * (which is not URL-shaped) is left untouched. The RAW target is retained only in runtime variables (the
 * probe config + the escalation diagnostics), never in the deployed documentation the explorer/modeler
 * shows. */
function redactProbeTargetForDisplay(probe: Extract<DeliveryNode, { kind: "wait" }>["wait"]): string {
  // NORMALIZE the kind first — `parseProbe` (`readiness.ts`) trims `wait.kind` before the worker keys
  // on it, and the semantic validator only requires a non-empty string, so an internal/direct graph
  // with `kind: " command "` runs as a COMMAND probe at runtime. Comparing the RAW (padded) kind here
  // would miss that, route its arbitrary shell target through the URL-only `redactConnectorValue`, and
  // leak it into the deployed BPMN documentation instead of `<redacted>` (issue #778 review — thread
  // deliveryGraphCompiler.ts:70). Classify on the TRIMMED-RAW kind — the SAME `str(raw.kind).trim()`
  // the runtime `parseProbe` keys on — and do NOT `stripXmlInvalidChars` it first: an XML-invalid char
  // is not whitespace `parseProbe` trims, so a control-char-smuggled kind (`kind: "command\x01"`,
  // `kind: "pr\x01"`) is REJECTED at runtime and never runs. Stripping the char before classifying
  // would sanitise `"pr\x01"` toward a genuine `pr`, take the verbatim structured-target path, and leak
  // an arbitrary secret-bearing target into the staged BPMN documentation for a probe that can never run
  // (issue #778 review — thread deliveryGraphCompiler.ts:81, over :78). Any kind that is not an exact
  // recognised `isProbeKind` after trimming falls to the unconditional `<redacted>` below.
  const kind = probe.kind.trim();
  if (kind === "command") return "<redacted>";
  // TRIM the target first — `parseProbe` (`readiness.ts`) trims `target` for EVERY kind before the worker
  // keys on it, so a padded ` owner/repo#1 ` and `owner/repo#1` are the SAME runtime probe. Rendering the
  // raw (padded) value would leave the whitespace in `nodeDisplay`/`semanticBpmn`, forking the graph digest
  // (and run key) from the trimmed-equivalent graph even though both probe the same value (issue #778
  // review — thread deliveryGraphCompiler.ts:75).
  const target = probe.target.trim();
  // `stripXmlInvalidChars` BEFORE `redactString`: an XML-forbidden control (e.g. `\x0B`) hidden inside
  // the `user:pass@` userinfo would otherwise split `redactString`'s `//…@` match, escape redaction, and
  // be re-joined into a live credential once the renderer strips that control (issue #778 review).
  if (kind === "http") return redactString(stripXmlInvalidChars(target));
  // A kind that is not a recognised {@link isProbeKind} is MALFORMED — `parseProbe` rejects it at
  // dispatch so it never runs, but the compiler still renders its target into the STAGED BPMN
  // documentation/preview at compile time. That target could be an arbitrary command-like/secret-bearing
  // snippet smuggled under a not-quite-known kind (`kind:"command\x01"`, `kind:"pr\x01"`, `kind:"cmd"`),
  // so routing it through the URL-only `redactConnectorValue` would leak it verbatim. Redact it
  // unconditionally, exactly like a `command` target — only a genuinely structured kind (`pr`/`epic`/
  // `npm`/`github-check`/`capability`) shows its target (issue #778 review — thread
  // deliveryGraphCompiler.ts:81, over :78).
  if (!isProbeKind(kind)) return "<redacted>";
  return redactConnectorValue(target);
}

/** The task-header key that carries an `agent` node's DECLARED per-node repository spec (#739) into the
 * compiled BPMN. It is a DIGEST-STABLE, env-free marker — pure graph content — so two graphs differing
 * only in a node's declared `repository`/`baseBranch` content-address differently (they are different
 * graphs), while the env-dependent parts of the real envelope (`cloneTimeoutMs`) and the run-level
 * FALLBACK repo are NOT baked here (they are injected by the runner POST-digest, so the same graph in
 * two environments / two runs still shares one id). The runner replaces this single marker header on
 * every agent service task with the flattened EFFECTIVE `io.nanobpm.agentTask.*` envelope headers
 * (declared ?? run-level), or strips it for an unresolved/`repoless` cell. The `__` prefix marks it as
 * an internal marker the harness never reads. */
export const AGENT_REPO_SPEC_HEADER = `${AGENT_TASK_NS}.__repoSpec`;

/** The engine-native BODY every node kind delegates to (Decision 2 — the graph SCHEDULES, it does not
 * re-implement execution). Each node compiles to an EMBEDDED `bpmn:subProcess` (call activities are a
 * no-op on the pinned WASM engine — the child is never instantiated — so, like the rest of the
 * codebase, `plan-fanout`'s `readiness-preflight` included, delegation is an inlined subProcess that
 * shares the parent variable scope). The inner task delegates to a real, already-registered worker /
 * user-task body:
 *   • `agent`     → the `senior:*` job the node names (the implementation-task body).
 *   • `wait`      → the `pr.readiness-probe` service task (the reusable ReadinessProbe poll gate; the
 *                   `pr` kind is S2). Polling its own target is what makes an unrelated upstream event
 *                   unable to falsely resolve the wait (#274/S2 concurrency-correctness).
 *   • `human`     → the S3 scheduled user-task + generic form + SLA (`delivery-human-task__<el>`,
 *                   recognised by the `isDeliveryHumanElement` convention so it routes through the ONE
 *                   canonical completer and the Tasks inbox).
 *   • `connector` → the `pr.delivery-connector` dedupe stub (forward-declared; real I/O deferred per
 *                   the ADR non-goals — but a real, idempotent node).
 * Kept as the single source of truth so the compiler, the resolved-preview and the runner agree on
 * the delegation target each node names. */
const DELEGATE_TASK_TYPE: Record<Exclude<DeliveryNode["kind"], "agent" | "human">, string> = {
  wait: "pr.readiness-probe",
  connector: DELIVERY_CONNECTOR_TASK_TYPE,
};

/** The BPMN `bpmn:process` id of the compiled one-shot definition (S1). Stable across compiles of the
 * same graph — the pure S1 preview always emits this base id. The S4 runner (`deliveryRunner.ts`)
 * derives a CONTENT-ADDRESSED deploy id from it (`delivery-graph-<sha>`), so re-deploying the same
 * graph is idempotent and stale definitions are GC-identifiable; exported here as the single source of
 * truth so the runner never hardcodes the literal it substitutes. */
export const DELIVERY_GRAPH_PROCESS_ID = "delivery-graph";

/** The run-level node SLA fallback (`PT1H`) — the SINGLE SOURCE OF TRUTH shared by the compiler's
 * bounded-timeout ioMapping and the runner's `DEFAULTS.nodeTimeout` (PR #876 review). A node released
 * with no per-node and no run-level timeout falls back to THIS one constant, so the two code paths can
 * never drift to two different "default SLA" values (derivation-over-duplication). */
export const DELIVERY_NODE_DEFAULT_TIMEOUT = "PT1H";

/** The BPMN element id a `human` node's inlined user task carries. One user task per human node (the
 * compiled one-shot inlines each), so the id is per-node (`delivery-human-task__<element>`) — the
 * `isDeliveryHumanElement` convention (single source of truth in `deliveryHuman.ts`) is what keeps it
 * recognised by `ESCALATION_TASK_ELEMENTS` / the Tasks inbox despite the per-node suffix. */
function humanTaskElement(element: string): string {
  return `${DELIVERY_HUMAN_ELEMENT}__${element}`;
}

/** The BPMN element id a service node's bounded-timeout escalation user task carries — same
 * human-completable convention as a human node, so a stalled `agent`/`wait`/`connector` escalates onto
 * the Tasks inbox and is answerable by a human OR an agent (ADR 0046). */
function escalationTaskElement(element: string, kind?: DeliveryNode["kind"]): string {
  // A `wait` gate's escalation has no retry semantics, so it renders the select-less generic form and
  // stamps the `__wait` kind marker into its id — letting `escalationFormId` DERIVE that form from the
  // id rather than inferring the retry-capable form from the shared `__esc` suffix (PR #863 review).
  const suffix = kind === "wait" ? DELIVERY_WAIT_ESCALATION_TWIN_SUFFIX : DELIVERY_ESCALATION_TWIN_SUFFIX;
  return `${DELIVERY_HUMAN_ELEMENT}__${element}${suffix}`;
}

/** The BPMN element id an `agent` node's PRODUCER-CONTRACT escalation user task carries (issue #731) —
 * distinct from the `__esc` timeout twin so a node can carry both a bounded-timeout escalation AND a
 * post-completion contract-gate escalation without an id collision. Same human-completable convention
 * (`delivery-human-task__…` → recognised by `isDeliveryHumanElement`, routed onto the Tasks inbox), so
 * a producer that finishes without doing its job escalates AT that node and is answerable by a human
 * OR an agent. */
function contractEscalationTaskElement(element: string): string {
  return `${DELIVERY_HUMAN_ELEMENT}__${element}${DELIVERY_CONTRACT_TWIN_SUFFIX}`;
}

// ESCALATION_DECISION_VAR / ESCALATION_DECISION_RETRY / ESCALATION_LOCAL_VARS / AGENT_RESULT_LOCAL_VARS /
// CONNECTOR_RESULT_LOCAL_VARS are imported from ./deliveryGraph.ts (their canonical home — the
// validator's reservedDeliveryFactNames derives from them there without an import cycle).
// ESCALATION_LOCAL_VARS is [ESCALATION_DECISION_VAR,"value",ESCALATION_NOTE_VAR]; AGENT_RESULT_LOCAL_VARS is the
// canonical node-local agent result contract (every resources/prompts/*.md output field);
// CONNECTOR_RESULT_LOCAL_VARS the connector's fixed result metadata. All three are declared node-local
// on the subProcess and cleared on retry so a node's report never leaks to the shared root.

/** The node-local boolean the preflight input mapping binds (see {@link nodeInputsPreflightFeel}). */
const NODE_INPUTS_PREFLIGHT_VAR = "nodeInputsPresent";

/** FEEL for the per-node preflight guard: `true` when the runner-seeded `nodeInputs.<el>` config is
 * present, else a FEEL `assert` failure — an input-mapping incident on the node whose message names the
 * cause and the fix, instead of a node that runs with null config and escalates with no explanation. */
export function nodeInputsPreflightFeel(el: string): string {
  const present = `is defined(nodeInputs) and nodeInputs != null and is defined(nodeInputs.${el}) and nodeInputs.${el} != null`;
  const cause =
    `delivery-graph node ${el}: its runner-seeded config nodeInputs.${el} is missing from the process ` +
    "instance (lost root variables?). Restore the instance's root variables (nodeInputs), then RE-ENTER " +
    "the node's sub-process from OUTSIDE (relaunch/re-enter the node) so its subProcess input mappings " +
    "re-evaluate against the restored config. Do NOT only resolve this incident, and do NOT use this " +
    "node's in-subprocess \"Retry this step\" loop: resolving re-evaluates just this leaf's inputs, and " +
    "the retry loop goes straight back to the inner service task — neither re-runs the subProcess entry " +
    "mappings, so the subProcess-seeded config (prompt/appendPrompt/nodeTimeout, connector " +
    "target/payload/dedupeKey) stays null and the job would run unconfigured.";
  return `=assert(true, ${present}, ${feelStr(cause)})`;
}

/** A distinctive infix stamped into the compiler-generated resume-validity flag variable ({@link
 * resumeValidVar}) to visually mark it as an internal engine variable rather than a user fact. It is
 * NOT a reserved fact-name namespace — reserving it in the public `DeliveryFact.name` space would
 * silently reject previously valid names (e.g. `my__flag__fact`) that openapi still advertises as legal
 * and that durable library/proposal rows may already carry (PR #876 review). Collision-freedom is
 * instead guaranteed structurally at the single bind site (see {@link escalationTaskLines}), so this
 * infix is only a readability aid. */
const FLAG_VAR_INFIX = "__flag__";

/** The internal FEEL variable the resume-validation gateway routes on (PR #876 review). Derived from
 * the escalation task's compiler-generated element id (sanitised to a FEEL-safe identifier) — NOT from
 * the user fact-name space — so it can never collide with a user-declared emit fact bound into the same
 * escalation subprocess scope (an `agent`/`connector` emit binds under its own `fact.name`). This
 * removes the need to RESERVE a user-visible fact name (`resumeValid`) and the recompilation break that
 * reserving it would impose on durable rows that already carry a fact of that name.
 *
 * The sanitised element id is still a legal FACT-NAME string (`^[A-Za-z_][A-Za-z0-9_]*$`), so a node
 * could in principle declare an emit NAMED EXACTLY this flag — and for a single-emit `agent`/`connector`
 * node that fact's emit-source var IS its own name ({@link factSourceVar}), which would map the
 * recovered fact value AND this boolean flag onto the ONE variable. Rather than RESERVE part of the
 * public fact-name space to forbid that (which would break previously valid names — PR #876 review),
 * the single bind site in {@link escalationTaskLines} makes the generated flag name collision-free
 * against this node's actual emit-source target by construction (a deterministic unused suffix). */
export function resumeValidVar(esc: string): string {
  return `${esc.replace(/[^A-Za-z0-9_]/g, "_")}${FLAG_VAR_INFIX}resumeValid`;
}

/** The self-reported completion statuses an `agent` node's job may return that count as a TERMINAL
 * SUCCESS and are allowed to route their result onward (issue #731). Everything else — the pathological
 * `in_progress` an agent that delegated/returned-before-finishing reports (instance 10746), a `blocked`/
 * `failed`/`escalated` give-up, or any unrecognised free-formed status — fails the producer status gate
 * and escalates AT the node instead of threading an incomplete result into a downstream consumer. An
 * ABSENT/null status passes the gate (a status-less completion — an older fleet worker or a bare test
 * stub — is not itself the failure mode; the required-emit gate still catches a missing data fact).
 * Sorted for the compiler's byte-identical-output determinism. Exported as the SINGLE SOURCE OF TRUTH:
 * the compiler's contract gate reads it here, and the runner's `renderProducerContract` (#760) derives
 * the agent-facing status vocabulary from the SAME list — changing it changes both the gate and the
 * prompt at once, so the two representations of the producer contract can never drift. */
export const AGENT_TERMINAL_SUCCESS_STATUSES: readonly string[] = ["done", "opened", "skipped"];

/** A never-reached exhaustiveness guard: `compileNode`'s `switch` covers every allowlisted kind, so
 * the closed union narrows to `never` here. If a future kind is added to the vocabulary without a
 * compiler arm, `tsc` flags this call — the compile-time half of the trust bound. */
export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unreachable — non-allowlisted delivery node kind ${JSON.stringify(value)}`);
}

/** XML 1.0's `Char` production forbids, anywhere in a document: the C0 control characters (except tab
 * `#x9`, LF `#xA`, CR `#xD`), the noncharacters U+FFFE/U+FFFF, and unpaired UTF-16 surrogates — none can
 * be represented by an entity, so any of them in an element `name`/`documentation` makes
 * `layoutBpmn`/deployment reject the whole semantic BPMN. The character-class filter is
 * {@link stripXmlInvalidChars}, canonical in `./deliveryGraph.ts` so the validator (which REJECTS such a
 * character in executable FEEL) and this compiler (which strips it from DISPLAY text) share one
 * definition. User-authored display strings (a node's free-form `prompt`, a probe `target`, an emit
 * name) only impose length limits at the OpenAPI edge, so such a character can reach the renderer — and
 * a code-unit truncation elsewhere can even manufacture a lone surrogate from a valid astral character.
 * Strip all of these before emitting any XML text / attribute content (VALID astral pairs are
 * preserved) — dropping an unrepresentable character is the only well-formed rendering. */

/** Escape a string for use as XML text / attribute content, first stripping XML-1.0-forbidden control
 * characters (see {@link stripXmlInvalidChars}). Deterministic and total. */
function escapeXml(value: string): string {
  return stripXmlInvalidChars(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Escape a string for XML ELEMENT TEXT content while KEEPING literal double-quotes — the convention
 * every authored `<bpmn:conditionExpression>` FEEL uses (e.g. `=status = "converged"`). Only `&`, `<`,
 * `>` are entity-escaped (required for text-node well-formedness); quotes stay literal so a FEEL string
 * literal survives to the engine. Safe because the compiler grafts DI onto its own semantic XML without
 * re-serializing it, so these text nodes are never round-tripped/normalized. Deterministic and total. */
function escapeXmlText(value: string): string {
  return stripXmlInvalidChars(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Render a `name=value` XML attribute, choosing the delimiter so FEEL string literals survive the
 * WASM engine's deploy path. That path does NOT decode `&#34;`/`&quot;` entities before FEEL parsing,
 * so a FEEL expression containing a string literal MUST use a SINGLE-QUOTE attribute delimiter with
 * literal double-quotes inside (verified empirically — an entity-escaped `"` silently yields no value,
 * not an incident). When the value has no `"`, the ordinary double-quote form (with full entity
 * escaping) is used. Deterministic. */
function attr(name: string, value: string): string {
  if (value.includes('"')) {
    const inner = stripXmlInvalidChars(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&apos;");
    return `${name}='${inner}'`;
  }
  return `${name}="${escapeXml(value)}"`;
}

/** Escape a string for use inside a mermaid quoted label. First strips XML-1.0-forbidden control
 * characters (see {@link stripXmlInvalidChars}) — the same free-form node labels feed the Mermaid path,
 * so a stray control char (e.g. `\x01` in a prompt) would otherwise make the preview unparsable. Mermaid
 * then uses `#` HTML-entity escapes: `&`, `<`, `>` and `"` are encoded (`#amp;`/`#lt;`/`#gt;`/`#quot;`)
 * so free-form prompt/target text can't be interpreted as markup and make a label render wrong or vanish
 * (`&` is encoded FIRST so its `#amp;` isn't re-encoded). Any line break — LF **or** a bare/`\r\n` CR
 * (a valid char `stripXmlInvalidChars` preserves) — is folded to a space, since a raw break inside the
 * line-oriented Mermaid source would make the preview unparsable. */
function escapeMermaid(value: string): string {
  return stripXmlInvalidChars(value)
    .replace(/&/g, "#amp;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/"/g, "#quot;")
    .replace(/\r\n?|\n/g, " ");
}

/** A node's typed emits, normalised to a stable array (absent → `[]`). */
function normaliseEmits(node: DeliveryNode): DeliveryFact[] {
  return Array.isArray(node.emits) ? node.emits.map((f) => ({ ...f })) : [];
}

/** Locale-independent, byte-stable string ordering: compares by UTF-16 code unit, so the sort is
 * identical across host locales (unlike `localeCompare`, whose collation varies by runtime locale for
 * non-ASCII ids). This keeps the compiler's "byte-identical across environments" determinism guarantee
 * strict. Returns -1 / 0 / 1. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The engine variable a producer node's OUTPUT mapping reads to publish a declared emitted `fact`
 * (S4 late-binding). Each node kind's real body exposes the observed value under a canonical name:
 *   • `wait` (readiness-gate) — a `mergedSha` fact reads the merge oid; a `prCount` fact reads the
 *     epic-match `prCount` bind (how many slice PRs a `wait[epic]` landed); an `artifact` fact reads
 *     the `resolvedArtifact` bind (mirroring the `capability`/`pr` probe binds); anything else reads
 *     the probe's `detail`.
 *   • `human` (delivery-human) — an `artifact` fact reads `humanEmitArtifact`; anything else reads
 *     `humanEmitValue` (the generic typed-emit form's captured value).
 *   • `agent`/`connector` — the body's job worker returns the value under the fact's own name.
 * Deterministic and total over the closed kind set. */
function factSourceVar(kind: DeliveryNode["kind"], fact: DeliveryFact): string {
  switch (kind) {
    case "wait":
      return fact.name === "mergedSha"
        ? "mergedSha"
        : fact.name === "prCount"
          ? "prCount"
          : fact.type === "artifact"
            ? "resolvedArtifact"
            : "detail";
    case "human":
      return fact.type === "artifact" ? "humanEmitArtifact" : "humanEmitValue";
    case "agent":
    case "connector":
      return fact.name;
    default:
      return assertNever(kind, "factSourceVar");
  }
}

/** A FEEL string literal (raw, with literal double-quotes). XML-attribute escaping and delimiter
 * choice are handled by `attr` at emit time — do NOT pre-escape here, or the quote is hidden from
 * `attr`'s single-quote-delimiter heuristic and gets double-encoded. */
function feelStr(value: string): string {
  return JSON.stringify(value);
}

/** Render a guard `equals` literal (S7) as its FEEL form — a string becomes a `"…"` literal, a number
 * its decimal, a boolean `true`/`false`. `undefined` renders as `""` so it can double as a stable sort
 * key for edges without a guard. Deterministic and total over the `string|number|boolean` scalar set. */
function feelLiteral(value: string | number | boolean | undefined): string {
  if (typeof value === "string") return feelStr(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return "";
}

/** The FEEL predicate a guarded edge (S7) contributes to its exclusive-split flow condition — e.g.
 * `n0_result = "breaking"` — comparing the producer's published `<element>_<fact>` variable to the
 * edge's `equals` literal. `when` names `<fromNode>.<fact>` (validated: a scalar fact of this edge's
 * producer), so the variable is `<producerElement>_<fact>`. Returns `undefined` for a plain or default
 * edge (no `when`). Deterministic. */
function guardConditionPart(
  edge: ResolvedDeliveryEdge,
  elementById: ReadonlyMap<string, string>,
  nodeFacts: ReadonlyMap<string, ReadonlySet<string>>,
): string | undefined {
  if (edge.when === undefined || edge.default === true) return undefined;
  const { fact } = resolveDeliveryFrom(edge.when, nodeFacts);
  if (fact === undefined) return undefined;
  const producerElement = elementById.get(edge.fromNode) ?? edge.fromNode;
  return `${producerElement}_${fact} = ${feelLiteral(edge.equals)}`;
}

/** One sequence flow in the compiled process — `source`/`target` are element ids, `name` an optional
 * (fact / guard) label. `condition` is a FEEL boolean guard rendered as a `<bpmn:conditionExpression>`
 * child (S7 guarded edge); `isDefault` marks the exclusive split's default (else) flow, whose id the
 * split gateway carries as its `default` attribute. */
interface Flow {
  id: string;
  source: string;
  target: string;
  name?: string;
  condition?: string;
  isDefault?: boolean;
}

/** One late-binding input a consumer node receives (S4): the producer node's business id, the
 * referenced emitted fact name, and the flat parent variable (`<producerElement>_<fact>`) the
 * producer's output mapping publishes the observed value into. */
interface BoundInput {
  fromNode: string;
  fact: string;
  producerElement: string;
}

/** A compiled node's structural fixtures: its own BPMN `element` id, and — when it has >1 downstream
 * or >1 upstream — the fork/join gateway that fans its flow out/in. `entry` is the id upstream flows
 * target (the join, else the element); `exit` is the id downstream flows leave from (the fork, else
 * the element). `forkExclusive`/`joinExclusive` select an EXCLUSIVE gateway (S7): a guarded-split
 * source forks on an `exclusiveGateway` (data-based branch), and a fan-in reconverging exclusive
 * branches joins on an `exclusiveGateway` (first-token-proceeds) rather than a parallel AND-join. */
interface NodeWiring {
  node: DeliveryNode;
  element: string;
  forkGateway?: string;
  joinGateway?: string;
  forkExclusive: boolean;
  joinExclusive: boolean;
  entry: string;
  exit: string;
}

/** Fetch a key that MUST be present (every node id was registered in the map above). Returns the
 * value without a type assertion, throwing on the impossible missing case. */
function mustGet<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`compileDeliveryGraph: missing map entry for ${String(key)}`);
  return value;
}

/** The compiler result BEFORE diagram-interchange layout: everything the generated
 * `CompileDeliveryGraphResult` carries EXCEPT the laid-out `bpmn`, plus the `semanticBpmn` (the
 * pre-layout, DI-less BPMN). `compileDeliveryGraphSemantic` produces this cheaply (no
 * `layoutBpmn`); `compileDeliveryGraph` layers the CPU-bound DI layout on top. Because the DI is
 * DERIVED deterministically from `semanticBpmn`, `semanticBpmn` is the canonical content of a graph —
 * the source `deliveryGraphDigest` content-addresses (issue #716). */
export interface CompiledDeliveryGraphSemantic {
  ok: true;
  /** A human-readable mermaid `flowchart` of the resolved graph. */
  diagram: string;
  /** The compiled one-shot BPMN process definition WITHOUT diagram interchange — the canonical,
   * layout-independent content of the graph. Deterministic: same input graph → byte-identical XML. */
  semanticBpmn: string;
  resolved: CompileDeliveryGraphResult["resolved"];
  humanNodes: CompileDeliveryGraphResult["humanNodes"];
  sideEffects: CompileDeliveryGraphResult["sideEffects"];
}

/** A fully-compiled graph — the generated wire result (`diagram`, laid-out `bpmn`, …) PLUS the
 * pre-layout `semanticBpmn` the content digest is taken over. */
export type CompiledDeliveryGraph = CompileDeliveryGraphResult & { semanticBpmn: string };

/**
 * Validate + compile a delivery graph into a PURE preview WITHOUT the CPU-bound diagram-interchange
 * layout (issue #716). Returns `{ ok:true, diagram, semanticBpmn, resolved, humanNodes, sideEffects }`
 * for a well-formed graph, or `{ ok:false, errors }` (each error path-qualified) for a malformed one.
 * NEVER deploys, dispatches, or mutates anything — safe to call repeatedly. Deterministic: identical
 * input JSON yields byte-identical output.
 *
 * This is the fast path the agent-facing compile/stage doors (`compileDeliveryGraph` /
 * `sequenceIssues` → `compileAndStageDeliveryGraph`) take: staging needs only the content digest (taken
 * over `semanticBpmn`), the mermaid `diagram`, and the resolved model — NOT the laid-out `bpmn`. Skipping
 * `layoutBpmn` (`bpmn-auto-layout`, superlinear in node/edge count — minutes on a 256-node/1024-edge
 * graph) keeps a cold MCP tool call well under the client's per-call timeout instead of tripping a
 * `-32001` that poisons the stateful session (#715). The laid-out `bpmn` is generated lazily, only at the
 * OPERATOR's preview/dispatch time (`previewProposalBpmn` / `dispatchDeliveryGraph`), which is a cockpit
 * action, not an MCP call, and so is not timeout-bound.
 */
export async function compileDeliveryGraphSemantic(
  graph: unknown,
): Promise<CompiledDeliveryGraphSemantic | CompileDeliveryGraphErrors> {
  const validationErrors: DeliveryGraphError[] = validateDeliveryGraph(graph);
  if (validationErrors.length > 0) {
    // Forward every semantic failure verbatim as a wire `{ path, message }` (the stable `code` stays
    // server-side). Nothing is compiled — the agent fixes the exact offending input and re-compiles.
    return { ok: false, errors: validationErrors.map(({ path, message }) => ({ path, message })) };
  }

  // The graph passed the OpenAPI `DeliveryGraph` SHAPE gate (the runtime edge for the typed agent
  // door; `validateDeliveryGraphShape` in the shared text-ingress for the graphJson-string doors) and
  // the semantic validator, so it is safe to narrow to the typed contract. Every field below is
  // well-formed by construction.
  // biome-ignore lint/plugin: validated external body narrowed to its contract after validateDeliveryGraph
  const typed = graph as DeliveryGraph;
  const nodes = [...typed.nodes].sort((a, b) => byCodeUnit(a.id, b.id));
  const edges = Array.isArray(typed.edges) ? typed.edges : [];

  // Resolve every edge's `from` endpoint against the SAME node/fact map the validator checked (shared
  // helper — no drift), then sort edges deterministically by (consumer, producer, fact). Guard fields
  // (`when`/`equals`/`default`, S7) are carried through verbatim so the preview and the compiled
  // gateway conditions derive from one resolved edge.
  const nodeFacts = deliveryNodeFacts(typed);
  const resolvedEdges: ResolvedDeliveryEdge[] = edges
    .map((edge) => {
      const { nodeId, fact } = resolveDeliveryFrom(edge.from, nodeFacts);
      let resolved: ResolvedDeliveryEdge = { from: edge.from, to: edge.to, fromNode: nodeId };
      if (fact !== undefined) resolved = { ...resolved, fromFact: fact };
      if (edge.when !== undefined) resolved = { ...resolved, when: edge.when };
      if (edge.equals !== undefined) resolved = { ...resolved, equals: edge.equals };
      if (edge.default === true) resolved = { ...resolved, default: true };
      return resolved;
    })
    .sort(
      (a, b) =>
        byCodeUnit(a.to, b.to) ||
        byCodeUnit(a.fromNode, b.fromNode) ||
        byCodeUnit(a.fromFact ?? "", b.fromFact ?? "") ||
        byCodeUnit(a.when ?? "", b.when ?? "") ||
        byCodeUnit(feelLiteral(a.equals), feelLiteral(b.equals)),
    );

  // Per-node producer/consumer adjacency (by node id), each sorted + de-duplicated for determinism.
  const producersById = new Map<string, string[]>();
  const consumersById = new Map<string, string[]>();
  for (const node of nodes) {
    producersById.set(node.id, []);
    consumersById.set(node.id, []);
  }
  for (const edge of resolvedEdges) {
    pushUnique(producersById.get(edge.to), edge.fromNode);
    pushUnique(consumersById.get(edge.fromNode), edge.to);
  }
  for (const list of producersById.values()) list.sort(byCodeUnit);
  for (const list of consumersById.values()) list.sort(byCodeUnit);

  // Exclusive-split topology (S7): a node with a GUARDED (`when`) out-edge is an exclusive split; a
  // fan-in that re-converges a split's branches is an exclusive merge. Derived from the ONE shared
  // `analyzeExclusiveTopology` the validator also uses, so gateway-type selection never drifts from the
  // parity the validator enforced. A lone `default: true` edge (no guarded sibling) always fires and is
  // NOT a split; and a node whose guarded + `default` edges all converge on ONE downstream target has
  // no real fan-out either — mirror the validator: key off a guarded `when` fanning to >=2 DISTINCT
  // downstream targets only.
  const splitNodes = new Set<string>();
  const guardedNodes = new Set<string>();
  const branchTargetsByNode = new Map<string, Set<string>>();
  for (const edge of resolvedEdges) {
    const guarded = edge.when !== undefined && edge.default !== true;
    if (!guarded && edge.default !== true) continue;
    if (guarded) guardedNodes.add(edge.fromNode);
    const targets = branchTargetsByNode.get(edge.fromNode) ?? new Set<string>();
    targets.add(edge.to);
    branchTargetsByNode.set(edge.fromNode, targets);
  }
  for (const node of guardedNodes) {
    if ((branchTargetsByNode.get(node)?.size ?? 0) > 1) splitNodes.add(node);
  }
  const forwardAdj = new Map<string, string[]>();
  for (const node of nodes) forwardAdj.set(node.id, [...(consumersById.get(node.id) ?? [])]);
  const topology = analyzeExclusiveTopology(
    nodes.map((n) => n.id),
    forwardAdj,
    splitNodes,
  );

  // Assign the deterministic BPMN element id per node (`n0`, `n1`, … in sorted order) plus the
  // fork/join gateway ids any fan-out/fan-in node needs: a PARALLEL fork/join is `gwf<i>`/`gwj<i>`; an
  // EXCLUSIVE split/merge (S7) is `gwx<i>`/`gwm<i>`. Each id space has its own positional counter so the
  // scheme stays deterministic and non-colliding.
  const elementById = new Map<string, string>();
  const wirings: NodeWiring[] = [];
  const wiringById = new Map<string, NodeWiring>();
  let forkSeq = 0;
  let joinSeq = 0;
  let splitSeq = 0;
  let mergeSeq = 0;
  nodes.forEach((node, i) => {
    const element = `n${i}`;
    elementById.set(node.id, element);
    const consumers = consumersById.get(node.id) ?? [];
    const producers = producersById.get(node.id) ?? [];
    const forkExclusive = splitNodes.has(node.id);
    // A fan-in is an EXCLUSIVE merge (first-token-proceeds) iff EVERY incoming branch is conditional —
    // a split's own guarded/default out-edge, or a producer only conditionally reached. This is the
    // SAME parity predicate the validator enforces (`edgeConditional`), so gateway-type selection never
    // drifts from it. Deriving `joinExclusive` from `mergeNodes` alone over-fires: `analyzeExclusive
    // Topology` marks every node reachable from >=2 branch targets as a merge, including nodes DOWNSTREAM
    // of the real re-convergence — so a post-merge node that ALSO joins an independent always-firing
    // producer would wrongly compile to an exclusive merge instead of the parallel AND-join both the
    // validator and the semantics demand.
    const joinExclusive =
      producers.length > 1 &&
      producers.every((p) => splitNodes.has(p) || topology.conditional.has(p));
    const forkGateway =
      consumers.length > 1 ? (forkExclusive ? `gwx${splitSeq++}` : `gwf${forkSeq++}`) : undefined;
    const joinGateway =
      producers.length > 1 ? (joinExclusive ? `gwm${mergeSeq++}` : `gwj${joinSeq++}`) : undefined;
    const wiring: NodeWiring = {
      node,
      element,
      forkGateway,
      joinGateway,
      forkExclusive: forkGateway !== undefined && forkExclusive,
      joinExclusive: joinGateway !== undefined && joinExclusive,
      entry: joinGateway ?? element,
      exit: forkGateway ?? element,
    };
    wirings.push(wiring);
    wiringById.set(node.id, wiring);
  });

  const roots = nodes.filter((n) => (producersById.get(n.id) ?? []).length === 0);
  const leaves = nodes.filter((n) => (consumersById.get(n.id) ?? []).length === 0);
  const startForkGateway = roots.length > 1 ? "gwf_start" : undefined;
  // The End sink is an exclusive merge when its leaves are mutually-exclusive branch tails (only one
  // fires per run); a parallel AND-join there would deadlock on the untaken branch. The validator has
  // already rejected a leaf set that MIXES conditional and always-firing tails.
  const endExclusive = leaves.length > 1 && leaves.some((n) => topology.conditional.has(n.id));
  const endJoinGateway = leaves.length > 1 ? (endExclusive ? "gwm_end" : "gwj_end") : undefined;

  // ── Build the flow list in a DETERMINISTIC order, then assign `f0…` ids positionally ────────────
  const flows: Omit<Flow, "id">[] = [];
  // 1. Start → root(s).
  if (roots.length === 1) {
    flows.push({ source: "Start", target: mustGet(wiringById, roots[0].id).entry });
  } else if (roots.length > 1) {
    flows.push({ source: "Start", target: "gwf_start" });
    for (const root of roots) {
      flows.push({ source: "gwf_start", target: mustGet(wiringById, root.id).entry });
    }
  }
  // 2. Structural fork flows (node → its fork gateway).
  for (const w of wirings) if (w.forkGateway) flows.push({ source: w.element, target: w.forkGateway });
  // 3. Structural join flows (join gateway → node).
  for (const w of wirings) if (w.joinGateway) flows.push({ source: w.joinGateway, target: w.element });
  // 4. Edge flows: producer.exit → consumer.entry, labelled with the referenced fact(s) when
  //    qualified. Collapse edges sharing the same (fromNode → to) endpoints into ONE sequence flow:
  //    `producersById`/`consumersById` (hence the fork/join gateways) are de-duplicated by node id, so
  //    two fact-qualified edges between the same pair (e.g. `a.x -> b` and `a.y -> b`) would otherwise
  //    emit parallel flows between endpoints with no diverging gateway — invalid BPMN that schedules
  //    the consumer more than once. `resolvedEdges` is already sorted by (to, fromNode, fromFact), so
  //    same-endpoint edges are contiguous and their fact labels accumulate in deterministic order. For
  //    a guarded split (S7) the collapsed flow carries the OR of its guard conditions (or is the split
  //    default); the producer's exit is its exclusive gateway.
  const collapsedEdges: { fromNode: string; to: string; facts: string[]; conditions: string[]; isDefault: boolean }[] =
    [];
  for (const edge of resolvedEdges) {
    const last = collapsedEdges[collapsedEdges.length - 1];
    const guardPart = guardConditionPart(edge, elementById, nodeFacts);
    if (last && last.fromNode === edge.fromNode && last.to === edge.to) {
      if (edge.fromFact !== undefined && !last.facts.includes(edge.fromFact)) last.facts.push(edge.fromFact);
      if (edge.default === true) last.isDefault = true;
      if (guardPart !== undefined && !last.conditions.includes(guardPart)) last.conditions.push(guardPart);
    } else {
      collapsedEdges.push({
        fromNode: edge.fromNode,
        to: edge.to,
        facts: edge.fromFact !== undefined ? [edge.fromFact] : [],
        conditions: guardPart !== undefined ? [guardPart] : [],
        isDefault: edge.default === true,
      });
    }
  }
  for (const edge of collapsedEdges) {
    const producer = mustGet(wiringById, edge.fromNode);
    const consumer = mustGet(wiringById, edge.to);
    let flow: Omit<Flow, "id"> = { source: producer.exit, target: consumer.entry };
    // A guard LABEL for the diagram/preview: the fact name(s), else the rendered condition / "default".
    const label =
      edge.facts.length > 0
        ? edge.facts.join(", ")
        : edge.isDefault
          ? "default"
          : edge.conditions.length > 0
            ? edge.conditions.join(" or ")
            : undefined;
    if (label !== undefined) flow = { ...flow, name: label };
    if (edge.isDefault) {
      flow = { ...flow, isDefault: true };
    } else if (edge.conditions.length > 0) {
      flow = { ...flow, condition: `=${edge.conditions.join(" or ")}` };
    }
    flows.push(flow);
  }
  // 5. Leaf(s) → End.
  if (leaves.length === 1) {
    flows.push({ source: mustGet(wiringById, leaves[0].id).exit, target: "End" });
  } else if (leaves.length > 1) {
    const endGateway = endExclusive ? "gwm_end" : "gwj_end";
    for (const leaf of leaves) {
      flows.push({ source: mustGet(wiringById, leaf.id).exit, target: endGateway });
    }
    flows.push({ source: endGateway, target: "End" });
  }
  const numberedFlows: Flow[] = flows.map((f, i) => ({ id: `f${i}`, ...f }));

  // Per-consumer late-binding inputs (S4): for every FACT-QUALIFIED edge, the consumer node receives
  // the producer's emitted fact as a `boundFacts` list entry (`{from,name,value}`), threaded from the
  // flat `<producerElement>_<fact>` variable the producer's output mapping publishes. Grouped by the
  // consumer's element id and sorted (producer element, then fact) for determinism.
  const boundInputsByElement = new Map<string, BoundInput[]>();
  for (const edge of resolvedEdges) {
    if (edge.fromFact === undefined) continue;
    const consumerEl = mustGet(elementById, edge.to);
    const producerEl = mustGet(elementById, edge.fromNode);
    const list = boundInputsByElement.get(consumerEl) ?? [];
    list.push({ fromNode: edge.fromNode, fact: edge.fromFact, producerElement: producerEl });
    boundInputsByElement.set(consumerEl, list);
  }
  for (const list of boundInputsByElement.values()) {
    list.sort((a, b) => byCodeUnit(a.producerElement, b.producerElement) || byCodeUnit(a.fact, b.fact));
  }

  // Producer-side required-emit gate (issue #731): the set of a producer's declared emit names that are
  // consumed as a REQUIRED DATA DEPENDENCY downstream — i.e. threaded on a FACT-QUALIFIED edge
  // (`from: "<node>.<fact>"`) into a consumer's connector `payload`/probe `target`. This is the SAME
  // `<producerElement>_<fact>` wiring `boundInputsByElement` derives, keyed by the PRODUCER element so a
  // node can gate its own completion on populating every fact a sibling depends on. A ROUTING emit
  // (referenced only by an edge `when` guard, never as a fact-qualified `from`) is deliberately absent
  // here — those stay optional (omit ⇒ default branch). Grouped by producer element; only set
  // membership is ever queried downstream, so the sets carry no ordering guarantee.
  const requiredEmitsByElement = new Map<string, Set<string>>();
  for (const edge of resolvedEdges) {
    if (edge.fromFact === undefined) continue;
    const producerEl = mustGet(elementById, edge.fromNode);
    const set = requiredEmitsByElement.get(producerEl) ?? new Set<string>();
    set.add(edge.fromFact);
    requiredEmitsByElement.set(producerEl, set);
  }

  const semanticBpmn = renderBpmn(typed, wirings, numberedFlows, startForkGateway, endJoinGateway, boundInputsByElement, requiredEmitsByElement);
  const diagram = renderMermaid(typed, wirings, resolvedEdges, elementById);
  const resolved = buildResolved(typed, wirings, resolvedEdges, producersById);
  const humanNodes = buildHumanNodes(nodes);
  const sideEffects = buildSideEffects(nodes);

  return { ok: true, diagram, semanticBpmn, resolved, humanNodes, sideEffects };
}

/**
 * Validate + compile a delivery graph into a PURE preview INCLUDING diagram interchange (ADR 0005
 * slice S1). Returns the generated `CompileDeliveryGraphResult` shape (`diagram`, laid-out `bpmn`,
 * `resolved`, `humanNodes`, `sideEffects`) PLUS the pre-layout `semanticBpmn`, or `{ ok:false, errors }`
 * for a malformed graph. NEVER deploys, dispatches, or mutates anything. Deterministic: identical input
 * JSON yields byte-identical output.
 *
 * ASYNC because the final step attaches DIAGRAM INTERCHANGE (`bpmndi:BPMNDiagram`) via the toolkit
 * autolayout (`layoutBpmn` — `bpmn-auto-layout`), the SAME pass every AUTHORED process gets from
 * `npm run layout` (`scripts/layout-bpmn.ts`). This is the one BPMN in the system generated at
 * runtime, so without this it was the only one shipping DI-less — unrenderable in the process
 * explorer (#440). `layoutBpmn` is itself deterministic given identical semantic input, so
 * "same JSON → byte-identical XML" still holds with the diagram included.
 *
 * Callers that only need the content digest / preview (the agent-facing compile+STAGE doors) should
 * use the cheaper {@link compileDeliveryGraphSemantic} instead — layout here is CPU-bound and
 * superlinear (issue #716), so it belongs only on the operator's preview/dispatch/deploy paths that
 * genuinely render or run the BPMN.
 */
export async function compileDeliveryGraph(
  graph: unknown,
): Promise<CompiledDeliveryGraph | CompileDeliveryGraphErrors> {
  const semantic = await compileDeliveryGraphSemantic(graph);
  if (!semantic.ok) return semantic;
  const bpmn = await layoutDeliveryDiagram(semantic.semanticBpmn);
  return { ...semantic, bpmn };
}

/** Attach diagram interchange (`bpmndi:BPMNDiagram`) to the semantic-only compiled BPMN via the
 * toolkit autolayout — the SAME `layoutBpmn` (`bpmn-auto-layout`) pass `npm run layout` runs over
 * every authored process (`scripts/layout-bpmn.ts`), so there is ONE layout source, not two. Without
 * it, a compiled/running delivery graph rendered positionless in the process explorer (#440).
 *
 * We do NOT return `layoutBpmn`'s serialized output directly: its moddle round-trip re-serializes the
 * semantic model, and in doing so normalizes attribute quoting — a single-quote-delimited attribute
 * with literal double-quotes inside becomes a double-quoted attribute with `&#34;` entities. The
 * compiler deliberately emits FEEL string literals (`boundFacts`) with SINGLE-quote delimiters because
 * the WASM engine deploy path does NOT decode those entities before FEEL parsing (see `attr`), so a
 * round-trip would silently blank every late-bound fact. Instead we keep the compiler's carefully
 * encoded semantic XML BYTE-FOR-BYTE and graft only the computed `<bpmndi:BPMNDiagram>` block(s) onto
 * it — the diagram references element ids `layoutBpmn` leaves untouched, so the graft is sound.
 *
 * `bpmn-auto-layout` is a real runtime dependency of `@nanobpm/urban` (which re-exports `layoutBpmn`),
 * but the toolkit no-ops layout (semantic model unchanged, no DI) when it is somehow absent. That
 * silent no-op is exactly the DI-less bug this fixes, so we FAIL LOUD if the pass produced no diagram.
 * Deterministic given identical input, preserving the compiler's "same JSON → byte-identical XML".
 *
 * The autolayout itself runs OFF the main event loop in a `node:worker_threads` worker, bounded by a
 * timeout (`layoutBpmnOffThread` → `app/layoutOffThread.ts`, issue #854): `layoutBpmn` is superlinear
 * and, run inline here, blocked the whole app (no HTTP, no poll passes) for the entire layout — a hard
 * lock-up on a large graph (#852). This is the ONE place the layout runs, so hoisting it off-thread
 * covers BOTH the dispatch and preview paths that funnel through `compileDeliveryGraph`. */
async function layoutDeliveryDiagram(semanticBpmn: string): Promise<string> {
  const laidOut = await layoutBpmnOffThread(semanticBpmn);
  const start = laidOut.indexOf("<bpmndi:BPMNDiagram");
  const endTag = "</bpmndi:BPMNDiagram>";
  const end = laidOut.lastIndexOf(endTag);
  if (start === -1 || end === -1) {
    throw new Error(
      "compileDeliveryGraph: layoutBpmn produced no bpmndi:BPMNDiagram, so the compiled graph would " +
        "deploy DI-less and render positionless in the process explorer (#440). This usually means the " +
        "`bpmn-auto-layout` toolkit peer is missing (the toolkit then silently no-ops layout), but it " +
        "can also indicate a change in `layoutBpmn` output (different namespace prefix/serialization) or " +
        "an internal layout failure returning semantic-only XML. Ensure `bpmn-auto-layout` is installed " +
        "as a runtime dependency and that `layoutBpmn` still emits a `<bpmndi:BPMNDiagram>` block.",
    );
  }
  const diagram = laidOut.slice(start, end + endTag.length);
  const closing = "</bpmn:definitions>";
  const insertAt = semanticBpmn.lastIndexOf(closing);
  if (insertAt === -1) {
    throw new Error("compileDeliveryGraph: compiled BPMN has no </bpmn:definitions> to graft DI into");
  }
  return `${semanticBpmn.slice(0, insertAt)}  ${diagram}\n${semanticBpmn.slice(insertAt)}`;
}

/** Push `value` into `list` (may be undefined for a dangling target, already reported by the
 * validator) only when not already present — keeps adjacency de-duplicated. */
function pushUnique(list: string[] | undefined, value: string): void {
  if (list && !list.includes(value)) list.push(value);
}

/** Build the resolved/normalised graph — nodes (sorted) with their compiled element id, engine-native
 * called element, typed emits, and sorted `dependsOn`; plus the resolved, sorted edges. */
function buildResolved(
  graph: DeliveryGraph,
  wirings: readonly NodeWiring[],
  edges: readonly ResolvedDeliveryEdge[],
  producersById: ReadonlyMap<string, string[]>,
): CompileDeliveryGraphResult["resolved"] {
  const nodes: ResolvedDeliveryNode[] = wirings.map((w) => {
    const base: ResolvedDeliveryNode = {
      id: w.node.id,
      kind: w.node.kind,
      element: w.element,
      emits: normaliseEmits(w.node),
      dependsOn: [...(producersById.get(w.node.id) ?? [])],
      calledElement: delegateTarget(w.node, w.element),
    };
    return base;
  });
  const resolved: CompileDeliveryGraphResult["resolved"] = { nodes, edges: [...edges] };
  return graph.name !== undefined ? { name: graph.name, ...resolved } : resolved;
}

/** The engine-native delegation target a node's inlined subProcess drives — its job `taskType`
 * (`agent` → the named `senior:*` job; `wait` → `pr.readiness-probe`; `connector` →
 * `pr.delivery-connector`) or, for a `human` node, its per-node user-task element id. Surfaced on the
 * resolved preview so a co-designing agent sees exactly which worker/user-task each node fans out to.
 * Deterministic and total over the closed kind set. */
function delegateTarget(node: DeliveryNode, element: string): string {
  switch (node.kind) {
    case "agent":
      return node.agent.jobType;
    case "human":
      return humanTaskElement(element);
    case "wait":
    case "connector":
      return DELEGATE_TASK_TYPE[node.kind];
    default:
      return assertNever(node, "delegateTarget");
  }
}

/** Redact any credential-bearing URL inside each emit's free-form `description` for the operator-facing
 * preview projection, mirroring the `redactFreeText(trimmedOrEmpty(description))` the BPMN label embeds
 * (`nodeDisplay`). Returns fresh `DeliveryFact` copies (never mutates the source), so the RAW descriptions
 * on the runtime path are untouched (issue #778 review). */
function redactEmitsForPreview(facts: readonly DeliveryFact[]): DeliveryFact[] {
  return facts.map((f) =>
    typeof f.description === "string" ? { ...f, description: redactFreeText(f.description) } : { ...f },
  );
}

/** Extract the human STOP-points (sorted by id) — where the graph pauses for a person/agent, with the
 * instruction, optional attached form, and the typed facts the node will emit. */
function buildHumanNodes(nodes: readonly DeliveryNode[]): DeliveryHumanStop[] {
  const stops: DeliveryHumanStop[] = [];
  for (const node of nodes) {
    if (node.kind !== "human") continue;
    // Redact a credential-bearing URL inside each emit's free-form `description` at its SOURCE, the SAME
    // way `nodeDisplay` embeds it (`redactFreeText(trimmedOrEmpty(description))`): `humanNodes[]` — emits
    // included — is persisted into the staged proposal `preview` and rendered on the Delivery Graphs page
    // (and denormalised into parked-node labels), so a `//user:pass@…` in a fact description would leak
    // unredacted through this operator-facing projection even though the BPMN label path redacts it. The
    // RAW descriptions still reach the runtime `appendPrompt` (`renderEmitContract`) unmodified (#778).
    const stop: DeliveryHumanStop = { nodeId: node.id, emits: redactEmitsForPreview(normaliseEmits(node)) };
    // Redact the operator-facing preview `prompt` at its SOURCE with the SAME display-safe helper
    // `nodeDisplay` renders with: this projection is persisted into the staged proposal `preview` and
    // rendered verbatim on the Delivery Graphs page (and denormalised into the run's parked-node
    // labels), so a URL credential in a human prompt (`//user:pass@…`) must be stripped here too — else
    // it leaks unredacted through the preview even though the BPMN display path redacts it. The runtime
    // user-task prompt seeded via the compiled BPMN `nodeInputs` (`deliveryRunner.buildNodeInput`,
    // `case "human"`) is ALSO redacted the same way — it renders in the parked task's read-only form
    // field, another display surface — so no leak path remains (issue #778 review). `redactFreeText` is
    // a no-op for a credential-free prompt.
    const withPrompt =
      typeof node.human?.prompt === "string" ? { ...stop, prompt: redactFreeText(node.human.prompt) } : stop;
    // The `formKey` is an opaque identifier a modeler/explorer reads verbatim off the staged proposal
    // preview + Delivery Graphs page (and denormalised into parked-node labels), so a credential-bearing
    // formKey (`//user:pass@…`) must be stripped here with the SAME `redactConnectorValue` the BPMN
    // `Form:` documentation (nodeDisplay) and the digest-invisible traversal use — else it leaks
    // unredacted through the preview. The RAW formKey still drives runtime form resolution
    // (`deliveryHuman.ts` reads `node.human.formKey` directly), unmodified (issue #778 review).
    stops.push(
      typeof node.human?.formKey === "string"
        ? { ...withPrompt, formKey: redactConnectorValue(node.human.formKey) }
        : withPrompt,
    );
  }
  return stops;
}

/** Extract the SIDE EFFECTS (sorted by id) the compiled graph will perform — `agent` job runs and
 * `connector` outbound actions. `wait` gates are read-only and `human` stops are surfaced separately,
 * so neither is a side effect. */
function buildSideEffects(nodes: readonly DeliveryNode[]): DeliverySideEffect[] {
  const effects: DeliverySideEffect[] = [];
  for (const node of nodes) {
    if (node.kind === "agent") {
      effects.push({
        nodeId: node.id,
        kind: "agent",
        // Redact a credential-bearing `jobType` at its SOURCE with the display-safe helper `nodeDisplay`
        // uses — this side-effect projection is persisted into the staged proposal preview, an
        // operator-visible surface, so a URL-shaped jobType carrying a secret must not echo verbatim here
        // any more than in the node label/documentation (issue #778 review — thread :1202).
        description: `runs agent job \`${redactConnectorValue(node.agent.jobType)}\``,
      });
    } else if (node.kind === "connector") {
      // Redact the operator-facing `target`/`dedupeKey` at their SOURCE with the SAME display-safe
      // helper `nodeDisplay` renders with: this projection is persisted into the staged proposal
      // `preview` and rendered on the Delivery Graphs page, so a URL credential in a connector target
      // or dedupe key (`//user:pass@…`) must be stripped here too — else it leaks unredacted through
      // the preview even though the BPMN display path redacts it. The RAW values still reach the
      // runtime connector via the compiled BPMN `nodeInputs`, unmodified (issue #778 review).
      const effect: DeliverySideEffect = {
        nodeId: node.id,
        kind: "connector",
        description: `invokes connector target \`${redactConnectorValue(node.connector.target)}\``,
      };
      effects.push(
        typeof node.connector.dedupeKey === "string"
          ? { ...effect, dedupeKey: redactConnectorValue(node.connector.dedupeKey) }
          : effect,
      );
    }
  }
  return effects;
}

/** Shared empty required-emits set for nodes with no required emits — reused instead of allocating a
 * fresh `new Set()` per such node while rendering. Safe because `requiredEmits` is only ever read
 * (`ReadonlySet`). */
const EMPTY_REQUIRED_EMITS: ReadonlySet<string> = new Set<string>();

/** Render the compiled one-shot BPMN process definition (compile-to-native). Deterministic — element
 * order is fixed (start, gateways, nodes sorted, end) and every id is positional. */
function renderBpmn(
  graph: DeliveryGraph,
  wirings: readonly NodeWiring[],
  flows: readonly Flow[],
  startForkGateway: string | undefined,
  endJoinGateway: string | undefined,
  boundInputsByElement: ReadonlyMap<string, BoundInput[]>,
  requiredEmitsByElement: ReadonlyMap<string, ReadonlySet<string>>,
): string {
  // Precompute incoming/outgoing flow-id maps once (single pass over flows) so BPMN rendering stays
  // linear in the number of flows instead of O(elements * flows) from repeated full-array filtering.
  // Insertion order is preserved, matching the previous per-element filter order.
  const incomingById = new Map<string, string[]>();
  const outgoingById = new Map<string, string[]>();
  const appendTo = (map: Map<string, string[]>, key: string, id: string): void => {
    const list = map.get(key);
    if (list) list.push(id);
    else map.set(key, [id]);
  };
  for (const f of flows) {
    appendTo(incomingById, f.target, f.id);
    appendTo(outgoingById, f.source, f.id);
  }
  const incoming = (elementId: string): string[] => incomingById.get(elementId) ?? [];
  const outgoing = (elementId: string): string[] => outgoingById.get(elementId) ?? [];
  const refs = (tag: string, ids: readonly string[]): string =>
    ids.map((id) => `      <bpmn:${tag}>${id}</bpmn:${tag}>`).join("\n");

  // The default (else) flow id per exclusive-split gateway (S7) — the flow the gateway names in its
  // `default` attribute so an unmatched runtime value takes the else-branch instead of erroring.
  const defaultFlowBySource = new Map<string, string>();
  for (const f of flows) if (f.isDefault) defaultFlowBySource.set(f.source, f.id);

  // Render a diverging/converging gateway. `exclusive` picks `exclusiveGateway` (data-based XOR split /
  // first-token merge, S7) over the parallel AND fork/join; a diverging exclusive gateway carries its
  // `default` flow id when one exists.
  const gateway = (id: string, exclusive: boolean, name: string): string[] => {
    const tag = exclusive ? "exclusiveGateway" : "parallelGateway";
    const def = defaultFlowBySource.get(id);
    const defAttr = def !== undefined ? ` default="${def}"` : "";
    return [
      `    <bpmn:${tag} id="${id}"${defAttr} name="${escapeXml(name)}">`,
      refs("incoming", incoming(id)),
      refs("outgoing", outgoing(id)),
      `    </bpmn:${tag}>`,
    ];
  };

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
      'xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" ' +
      'xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" ' +
      'xmlns:di="http://www.omg.org/spec/DD/20100524/DI" ' +
      'id="Definitions_delivery_graph" targetNamespace="http://nanobpm.io/nano-workforce">',
  );
  const processName = graph.name ?? "Delivery graph";
  lines.push(`  <bpmn:process id="${DELIVERY_GRAPH_PROCESS_ID}" name="${escapeXml(processName)}" isExecutable="true">`);

  // Start event.
  lines.push('    <bpmn:startEvent id="Start" name="Graph opened">');
  lines.push(refs("outgoing", outgoing("Start")));
  lines.push("    </bpmn:startEvent>");

  // Start fork gateway (fan-out to multiple roots) — always a PARALLEL fork: Start unconditionally
  // activates every independent root.
  if (startForkGateway) {
    lines.push(...gateway(startForkGateway, false, "fan out to roots"));
  }

  // Node elements (sorted), each preceded by its join gateway and followed by its fork gateway. An
  // exclusive split's fork (S7) is an `exclusiveGateway` with guard conditions on its out-flows; an
  // exclusive-merge's join is a first-token `exclusiveGateway`.
  for (const w of wirings) {
    if (w.joinGateway) {
      lines.push(...gateway(w.joinGateway, w.joinExclusive, `join into ${w.node.id}`));
    }
    lines.push(
      renderNodeElement(
        w,
        incoming(w.element),
        outgoing(w.element),
        boundInputsByElement.get(w.element) ?? [],
        requiredEmitsByElement.get(w.element) ?? EMPTY_REQUIRED_EMITS,
      ),
    );
    if (w.forkGateway) {
      lines.push(...gateway(w.forkGateway, w.forkExclusive, `fan out of ${w.node.id}`));
    }
  }

  // End join gateway (fan-in from multiple leaves) + end event. Exclusive when the leaves are
  // mutually-exclusive branch tails (S7), else a parallel AND-join.
  if (endJoinGateway) {
    lines.push(...gateway(endJoinGateway, endJoinGateway.startsWith("gwm"), "join leaves"));
  }
  lines.push('    <bpmn:endEvent id="End" name="Graph complete">');
  lines.push(refs("incoming", incoming("End")));
  lines.push("    </bpmn:endEvent>");

  // Sequence flows. A guarded flow (S7) carries a `<bpmn:conditionExpression>` FEEL child; the default
  // flow is unconditional (the gateway names it). Condition text uses LITERAL double-quotes for FEEL
  // string literals (the authored-BPMN convention, e.g. `=status = "converged"`) — text content is not
  // subject to the attribute entity-decoding hazard, and the compiler grafts DI without re-serializing
  // this XML, so the literal quotes survive to deploy.
  for (const f of flows) {
    const nameAttr = f.name !== undefined ? ` name="${escapeXml(f.name)}"` : "";
    if (f.condition !== undefined) {
      lines.push(
        `    <bpmn:sequenceFlow id="${f.id}"${nameAttr} sourceRef="${f.source}" targetRef="${f.target}">` +
          `<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">${escapeXmlText(f.condition)}</bpmn:conditionExpression>` +
          "</bpmn:sequenceFlow>",
      );
    } else {
      lines.push(
        `    <bpmn:sequenceFlow id="${f.id}"${nameAttr} sourceRef="${f.source}" targetRef="${f.target}" />`,
      );
    }
  }

  lines.push("  </bpmn:process>");
  lines.push("</bpmn:definitions>");
  // Drop empty ref lines (nodes/events with no incoming or outgoing) so the output stays clean.
  return `${lines.filter((l) => l.length > 0).join("\n")}\n`;
}

/** The first non-empty line of a (possibly multi-line) string, trimmed and length-capped for use as a
 * concise element label. Returns `""` for a blank/undefined input; a line longer than `cap` is
 * truncated with an ellipsis. Truncation is by Unicode CODE POINT (`Array.from`), not UTF-16 code unit,
 * so slicing never splits an astral character (emoji etc.) into an unpaired surrogate — an unpaired
 * surrogate survives {@link stripXmlInvalidChars} and would make the emitted BPMN not well-formed.
 * The first-non-empty test is on each line's SANITIZED content ({@link stripXmlInvalidChars}), so a line
 * that is ONLY XML-forbidden control characters (which the renderer strips to nothing) is skipped rather
 * than selected — otherwise a prompt of only `\x01` would be chosen and render as a blank ` · <id>`
 * label instead of falling back to the job type / `Human decision`. The RAW (unsanitised) line is
 * returned for mixed text — the renderer sanitises it (issue #778 review). Deterministic. */
function firstLine(value: string | undefined | null, cap = 72): string {
  if (typeof value !== "string") return "";
  const line = value.split(/\r?\n/).map((l) => l.trim()).find((l) => stripXmlInvalidChars(l).trim().length > 0) ?? "";
  const points = Array.from(line);
  return points.length > cap ? `${Array.from(points.slice(0, cap - 1)).join("").trimEnd()}…` : line;
}

/** Trim an optional value to a non-blank string, or `""` when absent/blank. */
function trimmedOrEmpty(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "";
}

/** The runtime-effective node `timeout` fingerprint: the SAME normalisation the runtime applies
 * (`isoDuration` in `deliveryRunner` — trim + upper-case a valid ISO-8601 duration, else fall back to
 * the run-level default). A valid duration collapses whitespace/case variants that drive the identical
 * SLA (`"PT1H"`/`"PT1H "`/`"pt1h"` → `"PT1H"`); a malformed one (including an XML-invalid-char variant
 * like `"PT1H\x01"`) collapses to the `""` fallback sentinel — genuinely different from a valid value.
 * A non-string stays as-is so the caller's `typeof raw === "string"` guard skips an absent timeout
 * (issue #778 review — thread :1307). */
function normaliseNodeTimeout(value: string | undefined | null): string | undefined | null {
  return typeof value === "string" ? isoDuration(value, "") : value;
}

/** A runtime plain-object narrowing used where a statically-typed field may LIE at runtime because no
 * validator constrained its shape — notably a connector `payload`, whose schema is a forward-declared
 * `additionalProperties:true` stub the semantic validator does NOT shape-check (issue #778 review). A
 * bare primitive (`42`) or an array is NOT a record, so callers must gate on this before an `in`/`Object.keys`
 * probe that would otherwise THROW on a primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** URL-only credential redaction relocated to the low-level graph module ({@link redactConnectorValue}
 * in `deliveryGraph.ts`) so the DISPLAY path here and `validateDeliveryGraph`'s reject/error path share
 * ONE redactor — no drift surface (issue #778 review). */

/** A human-readable label for a connector node's `target`. The converge-enrollment vocabulary
 * (`convergeTargets.ts`) maps to intent-revealing phrases; any other (forward-declared) target is shown
 * through {@link redactConnectorValue} — an opaque identifier (`slack:#releases`) survives unchanged, but
 * a credential-bearing URL (`//user:pass@…`, `?token=…`) has its secret components stripped so it is
 * never persisted into user-visible BPMN documentation/modeler. Deterministic. */
function humanizeConnectorTarget(target: string): string {
  switch (target) {
    case CONVERGE_TARGET:
      return "Converge PR (review only)";
    case CONVERGE_MERGE_TARGET:
      return "Converge & merge PR";
    case MERGE_MAIN_TARGET:
      return "Merge to main";
    default:
      return `Connector: ${redactConnectorValue(target)}`;
  }
}

/** Render a probe's `match` predicate as a compact `k=v, k=v` description (declared fields only).
 * Three fields are FREE-FORM, user-supplied secret-bearing values — `verifyCommand` (an arbitrary shell
 * command the capability probe runs at the gate boundary) and `bodyIncludes`/`stdoutIncludes` (arbitrary
 * response-body / stdout substrings that can carry response tokens) — so they are never surfaced in the
 * user-visible name/documentation; only a fixed `<redacted>` placeholder appears while the raw value
 * survives in the runtime probe config. Every other declared field is a structured/enumerable predicate,
 * but not all are safe to interpolate verbatim — a free-form string predicate (`capabilityRef`,
 * `package`, `checkName`, …) can carry a credential-bearing URL (`//user:pass@host#274`, which
 * `parseProbe` accepts for its trailing id), so each is run through {@link redactConnectorValue} (a
 * URL-only redactor: an ordinary `status=200`/`checkName=build` passes through untouched, a URL has its
 * credential stripped). The raw value still survives in the runtime probe config; any value the display
 * redacts is fingerprinted by `digestInvisibleRawValues` so the digest/run-key stays faithful. Fields are
 * emitted in a STABLE code-unit key order (not the caller's JSON insertion order) so two semantically
 * identical graphs render byte-identically — preserving the compiler's determinism/digest guarantee.
 * (Issue #778 review.) */
const REDACTED_MATCH_FIELDS: ReadonlySet<string> = new Set(["verifyCommand", "bodyIncludes", "stdoutIncludes"]);
/** The DECLARED `ProbeMatch` fields (app/readiness.ts). `validateDeliveryGraph` does NOT reject an
 * unknown extra `wait.match` key, so a text-ingress graph can smuggle an arbitrary attacker-named key
 * whose value would otherwise be rendered VERBATIM into the user-visible preview/documentation here (a
 * credential-leak channel — an unknown key bypasses the `REDACTED_MATCH_FIELDS` set entirely). Only these
 * declared, enumerable predicate fields are rendered; any other key is dropped from the display (the raw
 * value still survives untouched in the runtime probe config). Keep in sync with `ProbeMatch`. */
const DECLARED_MATCH_FIELDS: ReadonlySet<string> = new Set([
  "status",
  "bodyIncludes",
  "exitCode",
  "stdoutIncludes",
  "version",
  "conclusion",
  "checkName",
  "capabilityRef",
  "package",
  "verifyCommand",
  "prState",
  "epicState",
]);

/** The declared `wait.match` fields `parseMatch` (`app/readiness.ts`) reads through `num()` — a value of
 * any OTHER type coerces to `undefined` (the predicate is treated as UNSET). Every other declared field is
 * read through `str(v).trim()`, so a numeric `conclusion:1` and a string `conclusion:"1"` coerce to the
 * SAME probe value (`"1"`) and parse IDENTICALLY. `describeProbeMatch` renders `String(v)`, so both also
 * render `conclusion=1` — genuinely one identity, NOT a fork. Only a `num()`-backed field forks
 * invisibly: a numeric `status:200` and a string `status:"200"` render IDENTICALLY (`status=200`) yet
 * parse DIFFERENTLY (`200` vs. unset/any-2xx). `matchValueTypeMismatch` flags EXACTLY that numeric-field
 * cross-type case so it is fingerprinted; a string-field cross-type value is runtime-equivalent and must
 * NOT be flagged, or two identical graphs fork their stable run key and double-dispatch (issue #778
 * review — thread deliveryGraphCompiler.ts:1251). */
const NUMERIC_MATCH_FIELDS: ReadonlySet<string> = new Set(["status", "exitCode"]);
function matchValueTypeMismatch(key: string, value: unknown): boolean {
  // ONLY `num()`-backed fields are type-sensitive: a non-number coerces to "unset" (any-2xx), a
  // runtime-distinct meaning that renders identically. Every string field runs through `str(v).trim()`,
  // so a number and its string twin are the SAME probe — never a fork. Unknown keys are `parseMatch`-inert.
  return NUMERIC_MATCH_FIELDS.has(key) && typeof value !== "number";
}
/** The per-kind `match` field whose AUTHORED value equals the runtime matcher's DEFAULT — i.e. writing
 * it explicitly is behaviourally identical to OMITTING it. `matchPr` defaults `prState` to `"merged"`,
 * `matchEpic` defaults `epicState` to `"merged"`, `matchGithubCheck` defaults `conclusion` to
 * `"success"`, and `matchCommand` defaults `exitCode` to `0` (`readiness.ts`). Rendering an authored
 * default into the display doc forks `semanticBpmn`/the digest from the omitted-but-equivalent graph, so
 * two runtime-identical encodings get DISTINCT digests/run keys and dispatch TWICE instead of colliding
 * as `alreadyRunning`. {@link describeProbeMatch} drops a field equal to its kind's default so the two
 * collapse (issue #778 review — thread deliveryGraphCompiler.ts:1267). Only the fields whose matcher
 * reads a SCALAR default belong here: `http`'s `status` default is "any 2xx" (not a value), and `npm`'s
 * `version` default is the target's own `pkg@version` (not a constant), so neither has an
 * omitted-equivalent scalar. */
const EFFECTIVE_MATCH_DEFAULT: ReadonlyMap<string, { field: string; value: string | number }> = new Map([
  ["pr", { field: "prState", value: "merged" }],
  ["epic", { field: "epicState", value: "merged" }],
  ["github-check", { field: "conclusion", value: "success" }],
  ["command", { field: "exitCode", value: 0 }],
]);
/** True when `[key,value]` is `kind`'s defaulted match field carrying exactly the runtime default — so
 * rendering it would spuriously fork the digest from the omitted-equivalent graph. String defaults are
 * compared trimmed (the matcher/`parseMatch` trim), numeric defaults by strict number equality (a
 * type-mismatched `"0"`/`"5"` is NOT collapsed here — {@link matchValueTypeMismatch} already fingerprints
 * it as digest-invisible). */
function matchFieldIsEffectiveDefault(kind: string, key: string, value: unknown): boolean {
  const def = EFFECTIVE_MATCH_DEFAULT.get(kind);
  if (!def || def.field !== key) return false;
  if (typeof def.value === "number") return typeof value === "number" && value === def.value;
  return typeof value === "string" && value.trim() === def.value;
}
/** True when `value` is a string whose runtime-normalized (trimmed) form is EMPTY — `parseMatch`
 * (`app/readiness.ts`) reads every string predicate through `str(v).trim() || undefined`, so a `""` or
 * whitespace-only value coerces to `undefined`, i.e. it is runtime-equivalent to OMITTING the field.
 * Rendering it anyway (e.g. `bodyIncludes=<redacted>` for a redacted field, or `version=` for a plain
 * one) would fork `semanticBpmn`/the run key from the omitted-equivalent graph and double-dispatch, so
 * {@link describeProbeMatch} drops it (issue #778 review — thread deliveryGraphCompiler.ts:1254). Numbers/
 * booleans are never "empty" and pass through untouched. */
function matchValueRuntimeEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim() === "";
}
function describeProbeMatch(kind: string, match: Extract<DeliveryNode, { kind: "wait" }>["wait"]["match"]): string {
  if (match === undefined || match === null) return "";
  // Render the NORMALISED (trimmed) string value — `parseMatch` (`readiness.ts`) trims each string
  // predicate before the worker uses it, so a padded `version:" 1.2.3 "` and `"1.2.3"` probe the same
  // value. Rendering the raw value would leave the whitespace in `semanticBpmn`, forking the digest/run
  // key from the trimmed-equivalent graph while both run the identical match (issue #778 review — thread
  // deliveryGraphCompiler.ts:1206). Non-string values (numbers/booleans) are shown as-is. A field whose
  // authored value equals its kind's runtime DEFAULT ({@link matchFieldIsEffectiveDefault}) is DROPPED —
  // writing e.g. `prState:"merged"` explicitly is identical to omitting it, so surfacing it would fork the
  // digest from the omitted-equivalent graph and double-dispatch (issue #778 review — thread :1267). A
  // string predicate whose trimmed value is EMPTY ({@link matchValueRuntimeEmpty}) is likewise DROPPED —
  // `parseMatch` coerces it to `undefined`, so it too is omitted-equivalent (issue #778 review — thread :1254).
  return Object.entries(match)
    .filter(([k, v]) => v !== undefined && v !== null && DECLARED_MATCH_FIELDS.has(k) && !matchValueRuntimeEmpty(v) && !matchFieldIsEffectiveDefault(kind, k, v))
    .sort(([a], [b]) => byCodeUnit(a, b))
    .map(([k, v]) => `${k}=${REDACTED_MATCH_FIELDS.has(k) ? "<redacted>" : redactConnectorValue(typeof v === "string" ? v.trim() : String(v))}`)
    .join(", ");
}

/** The SINGLE source of a compiled node's human-readable display (issue #778): a concise `name` label
 * derived from the node's typed config — with the node `id` retained as a stable ` · <id>` suffix for
 * correlation (edges/logs/DI reference ids) — plus a longer `documentation` string rendered as the
 * flow element's `<bpmn:documentation>` child. BOTH the subProcess wrapper and its inner task read
 * their name from here (they must NOT compute names independently — derivation over duplication).
 * Deterministic and total over the closed kind union. */
export function nodeDisplay(node: DeliveryNode): { name: string; documentation: string } {
  const id = node.id;
  const emitsLabel = normaliseEmits(node)
    // Include a display-safe (URL-credential-redacted) `description`: the runtime `appendPrompt`
    // (`renderEmitContract`) embeds each fact's `description`, so two graphs differing ONLY in an emit
    // description dispatch DIFFERENT instructions — omitting it here would collapse them to one
    // `semanticBpmn`/digest and let keyless dispatch reuse the wrong prompt. A credential-bearing
    // description is redacted (and additionally flagged lossy by {@link graphCarriesRedactedSecrets})
    // (issue #778 review). */
    .map((e) => {
      const desc = redactFreeText(trimmedOrEmpty(e.description));
      return `${e.name} (${e.type})${desc ? ` — ${desc}` : ""}`;
    })
    .join(", ");
  const withId = (label: string): string => `${label} · ${id}`;
  switch (node.kind) {
    case "agent": {
      const a = node.agent;
      const policy = a.merge ? "converge+merge" : a.converge ? "converge" : "";
      const base = firstLine(typeof a.prompt === "string" ? redactFreeText(a.prompt) : a.prompt) || redactConnectorValue(a.jobType);
      const label = policy ? `${base} & ${policy}` : base;
      const doc: string[] = [`Agent job: ${redactConnectorValue(a.jobType)}`];
      const repo = trimmedOrEmpty(a.repository);
      const branch = trimmedOrEmpty(a.baseBranch);
      if (repo || branch) doc.push(`Target: ${repo || "(run repo)"}${branch ? `@${branch}` : ""}`);
      if (policy) doc.push(`Policy: ${policy}`);
      if (emitsLabel) doc.push(`Emits: ${emitsLabel}`);
      const agentTimeout = normaliseNodeTimeout(a.timeout);
      if (agentTimeout) doc.push(`Timeout: ${agentTimeout}`);
      const prompt = trimmedOrEmpty(a.prompt);
      if (prompt) doc.push(`Prompt: ${redactFreeText(prompt)}`);
      return { name: withId(label), documentation: doc.join("\n") };
    }
    case "connector": {
      const c = node.connector;
      // TRIM the target — the connector worker (`workers/delivery-connector/worker.ts`) trims `vars.target`
      // before matching the reserved converge/merge vocabulary AND before dispatch, so a padded
      // `" converge-merge "` executes as `converge-merge`. Humanising/redacting the RAW value would miss
      // the reserved-target switch (rendering the generic `Connector: converge-merge` instead of the
      // descriptive `Converge & merge PR`) and fork the `semanticBpmn`/digest from the trimmed-equivalent
      // graph that dispatches identically (issue #778 review — thread deliveryGraphCompiler.ts:1277).
      const target = c.target.trim();
      const doc: string[] = [`Connector target: ${redactConnectorValue(target)}`];
      if (trimmedOrEmpty(c.dedupeKey)) doc.push(`Dedupe key: ${redactConnectorValue(trimmedOrEmpty(c.dedupeKey))}`);
      // TRIM the bound `payload.pr` — but ONLY for a CONVERGE target. `resolveConvergePr`/`parsePr`
      // (`deliveryConnector`/`readiness`) trim `payload.pr` before matching, so for a converge/converge-merge
      // connector a padded `" impl.pr "` and `"impl.pr"` drive the SAME dispatch and MUST collapse to one
      // display/digest. A GENERIC (forward-declared) connector forwards `payload` UNCHANGED to its worker
      // (`workers/delivery-connector/worker.ts` runs `readConvergeInput` only for `isConvergeTarget(target)`),
      // so `{pr:"  x  "}` and `{pr:"x"}` are DIFFERENT runtime payloads — trimming them for display would
      // collapse two distinct dispatches into one digest and let the keyless dispatch fence reuse the wrong
      // payload (issue #783 review — thread deliveryGraphCompiler.ts:1376). So preserve the RAW `pr` unless
      // this is a converge target.
      const rawPr = c.payload && typeof c.payload.pr === "string" ? c.payload.pr : "";
      const boundPr = isConvergeTarget(target) ? rawPr.trim() : rawPr;
      if (boundPr) doc.push(`PR: ${redactConnectorValue(boundPr)}`);
      if (emitsLabel) doc.push(`Emits: ${emitsLabel}`);
      // Render the CANONICAL timeout (`isoDuration` — trim + upper-case, else the run default), the SAME
      // normalisation the runtime applies, so `pt1h`/`PT1H`/`PT1H ` collapse to one `semanticBpmn`/digest
      // instead of forking the run key on authored casing/whitespace (issue #778 review — thread
      // deliveryGraphCompiler.ts:1243).
      const connectorTimeout = normaliseNodeTimeout(c.timeout);
      if (connectorTimeout) doc.push(`Timeout: ${connectorTimeout}`);
      return { name: withId(humanizeConnectorTarget(target)), documentation: doc.join("\n") };
    }
    case "wait": {
      const p = node.wait;
      // NORMALISE the kind — `parseProbe` trims `wait.kind` before the worker runs the probe, and
      // `digestInvisibleRawValues` fingerprints the trimmed kind, but the label/documentation must trim it
      // too: a padded `" http "` runs the SAME probe as `"http"`, so rendering the raw kind would fork the
      // `semanticBpmn`/digest+name and let a re-stage bypass the idempotency fence and duplicate the run
      // (issue #778 review — thread deliveryGraphCompiler.ts:1296). `redactProbeTargetForDisplay` already
      // trims the kind internally for its command/http branch decision.
      const kind = p.kind.trim();
      const safeTarget = redactProbeTargetForDisplay(p);
      const doc: string[] = [`Readiness probe: ${kind}`, `Target: ${safeTarget}`];
      const match = describeProbeMatch(kind, p.match);
      if (match) doc.push(`Match: ${match}`);
      // `credentialEnv` names a DECLARED env-contract key (validated `isEnvKey`, never a secret value —
      // the secret is read from the ambient env at execution time), yet it is carried raw into the
      // runtime probe config where it selects the HTTP Authorization credential. Surfacing its safe
      // env-key NAME here makes it part of `semanticBpmn`, so two graphs differing only in `credentialEnv`
      // get DISTINCT digests instead of colliding — the content-address stays a faithful identity and
      // keyless dispatch cannot reuse the wrong credential's running instance (issue #778 review).
      if (trimmedOrEmpty(p.credentialEnv)) doc.push(`Credential env: ${trimmedOrEmpty(p.credentialEnv)}`);
      // `parseProbe` defaults an OMITTED `onTimeout` to `escalate` ({@link DEFAULT_ON_TIMEOUT}) and
      // `waitBodyLines` only changes topology for `continue`, so an EXPLICIT `escalate` is behaviourally
      // identical to omitting it. Surfacing it in the doc would fork `semanticBpmn`/the content digest
      // from the omitted-equivalent graph (which `digestInvisibleRawValues` does NOT fingerprint —
      // `trimmedOrEmpty("")` == its display, so it is not pushed), giving two runtime-identical encodings
      // DISTINCT run keys that dispatch TWICE instead of colliding. DROP the effective default after
      // trimming, exactly as {@link matchFieldIsEffectiveDefault} does for default match fields — emit the
      // line only for a non-default (`continue`) routing (issue #778 review — thread
      // deliveryGraphCompiler.ts:1398).
      const onTimeout = trimmedOrEmpty(p.onTimeout);
      if (onTimeout && onTimeout !== DEFAULT_ON_TIMEOUT) doc.push(`On timeout: ${onTimeout}`);
      if (p.poll) {
        // Render the CANONICAL EFFECTIVE poll policy — the SAME `normalizePoll` the runtime applies —
        // NOT the authored fields, so two runtime-EQUIVALENT graphs share one `semanticBpmn`/digest
        // instead of forking the content address on an encoding difference the runtime collapses. The
        // runtime `normalizePoll` (a) falls a sub-1ms / non-numeric `everyMs`/`timeoutMs` back to its
        // default, (b) truncates a fractional value, (c) clamps `everyMs` to `MAX_EVERY_MS`, and (d)
        // defaults an omitted `backoff` to `exponential`. So `poll:{everyMs:0, backoff:"exponential"}`
        // runs IDENTICALLY to an omitted/default poll, yet rendering the raw `every 0ms, exponential
        // backoff` forked the digest — letting a re-stage bypass the idempotency fence and duplicate the
        // run (issue #778 review — thread deliveryGraphCompiler.ts:1414). SUPPRESS each field that equals
        // its effective default (matching the omitted-poll rendering, which shows no line at all), so a
        // graph whose poll normalises entirely to the defaults renders identically to one with no poll.
        const effective = normalizePoll(p.poll);
        const budget: string[] = [];
        if (effective.everyMs !== DEFAULT_EVERY_MS) budget.push(`every ${effective.everyMs}ms`);
        if (effective.timeoutMs !== DEFAULT_TIMEOUT_MS) budget.push(`timeout ${effective.timeoutMs}ms`);
        if (effective.backoff !== DEFAULT_BACKOFF) budget.push(`${effective.backoff} backoff`);
        if (budget.length > 0) doc.push(`Poll: ${budget.join(", ")}`);
      }
      if (emitsLabel) doc.push(`Emits: ${emitsLabel}`);
      return { name: withId(`Wait: ${kind} ${safeTarget}`), documentation: doc.join("\n") };
    }
    case "human": {
      const h = node.human;
      const base = firstLine(typeof h?.prompt === "string" ? redactFreeText(h.prompt) : h?.prompt) || "Human decision";
      const doc: string[] = [];
      const prompt = trimmedOrEmpty(h?.prompt);
      doc.push(prompt ? `Prompt: ${redactFreeText(prompt)}` : "Human decision step");
      if (trimmedOrEmpty(h?.formKey)) doc.push(`Form: ${redactConnectorValue(trimmedOrEmpty(h?.formKey))}`);
      if (emitsLabel) doc.push(`Emits: ${emitsLabel}`);
      return { name: withId(base), documentation: doc.join("\n") };
    }
    default:
      return assertNever(node, "nodeDisplay");
  }
}

/** The raw field values a graph carries that the redacted `semanticBpmn` DROPS or COLLAPSES — i.e. the
 * content that reaches the runtime `nodeInputs` but is NOT faithfully represented in the digest, so two
 * graphs differing ONLY here compile to IDENTICAL `semanticBpmn` → identical digest (issue #778 review,
 * issue #716 content-address). Each entry is namespaced `nodeId\0field\0rawValue` so it also captures
 * WHICH node/field differs. This ONE traversal is the single source of truth for BOTH:
 *   • {@link graphCarriesRedactedSecrets} — non-empty ⇒ the digest is not a faithful identity, so a
 *     keyless dispatch must be disambiguated (Option C), and
 *   • the dispatch run-key ({@link stableProposalRunKey}) — which fingerprints this list ALONGSIDE the
 *     semantic digest, so credential-differing graphs get distinct run-keys while the digest collapses
 *     every compiler-normalised default/reorder (no per-field enumeration to drift).
 * Digest-invisible content is: `user:pass@`/`?query`/`#fragment` URL credentials redacted from a
 * `target`/`prompt`/`dedupeKey`/`formKey`/emit-`description`; a `command`-probe `target`, the free-form
 * `verifyCommand`/`bodyIncludes`/`stdoutIncludes` match secrets (all shown only as `<redacted>`); a
 * non-redacted `match` value whose raw form loses characters to XML-1.0 sanitisation
 * ({@link hasXmlInvalidChars}) at serialisation; and the free-form connector `payload` (only a safe
 * `pr` string is surfaced). Deterministic; reuses the SAME redaction helpers `nodeDisplay` renders
 * with, so the set can never drift from what is actually stripped. */
export function digestInvisibleRawValues(graph: DeliveryGraph): string[] {
  const out: string[] = [];
  // `raw` is digest-invisible when a present string does NOT match the EXACT `display` form `nodeDisplay`
  // embeds in `semanticBpmn` — apply the SAME normalisation (`trimmedOrEmpty`/redaction) the display does,
  // or a difference the display collapses (redaction OR trimmed whitespace) escapes while still reaching
  // the runtime raw.
  const push = (nodeId: string, field: string, raw: string | undefined | null, display: string | undefined | null): void => {
    if (typeof raw === "string" && raw !== display) out.push(`${nodeId}\u0000${field}\u0000${raw}`);
  };
  for (const node of graph.nodes) {
    const id = node.id;
    // Emit `description` is embedded in `emitsLabel` as `redactFreeText(trimmedOrEmpty(description))`
    // (see `nodeDisplay`) AND in the runtime `appendPrompt` (`renderEmitContract`) raw, so a
    // credential-bearing description whose redaction drops content is digest-invisible.
    for (const fact of normaliseEmits(node)) {
      push(id, `emit.${fact.name}.description`, fact.description, redactFreeText(trimmedOrEmpty(fact.description)));
    }
    switch (node.kind) {
      case "agent":
        // Display embeds `redactFreeText(trimmedOrEmpty(prompt))`; the RAW, untrimmed prompt reaches the
        // runtime (`buildNodeInput`), so a leading/trailing-whitespace-only difference is invisible too.
        push(id, "agent.prompt", node.agent.prompt, redactFreeText(trimmedOrEmpty(node.agent.prompt)));
        // `jobType` is a required non-empty string but only shape-validated, so it can smuggle a
        // credential-bearing URL (`//user:pass@host`). The display now redacts it through the SAME
        // `redactConnectorValue` (URL-only) rule, so a redacted jobType whose raw form the digest cannot
        // see reaches the worker verbatim (`cfg("jobType")`) — fingerprint the raw whenever it differs
        // from the redacted display (issue #778 review — thread :1202). An ordinary `senior:feature`
        // is not URL-shaped, so display == raw and nothing is pushed.
        push(id, "agent.jobType", node.agent.jobType, redactConnectorValue(node.agent.jobType));
        // The node `timeout` is embedded in the display doc as `trimmedOrEmpty(timeout)` then XML-
        // serialised (`escapeXml` STRIPS XML-1.0-invalid chars), yet the runtime reads it through
        // `isoDuration(timeout, nodeTimeout)` (deliveryRunner) — which TRIMS + upper-cases a valid value
        // and falls back to the run default on a malformed one. So `"PT1H"`, `"PT1H "`, and `"pt1h"` all
        // drive the SAME runtime SLA and must NOT be distinguished (else a whitespace-only OR case-only
        // re-stage launches a second run), while `"PT1H\x01"` (invalid ⇒ falls back) genuinely differs.
        // Fingerprint the ISO-normalised raw timeout AND compare it against the ISO-normalised form of what
        // the digest actually sees (the XML-sanitised trimmed display value) — normalising BOTH sides, so a
        // lowercase `"pt1h"` (digest sees `"pt1h"`, runtime canonicalises to `"PT1H"`) is NOT falsely marked
        // digest-invisible, while an XML-invalid variant (digest sees `"PT1H"` after the strip but the raw
        // falls back to the default) still is (issue #778 review — thread :1331, over :1307/:1251).
        push(id, "agent.timeout", normaliseNodeTimeout(node.agent.timeout), normaliseNodeTimeout(stripXmlInvalidChars(trimmedOrEmpty(node.agent.timeout))));
        break;
      case "human":
        push(id, "human.prompt", node.human?.prompt, redactFreeText(trimmedOrEmpty(node.human?.prompt)));
        // Runtime form resolution TRIMS an explicit formKey (`resolveHumanForm` in `deliveryHuman.ts`),
        // so a whitespace-only formKey variant has identical compiled form + runtime behaviour. Fingerprint
        // the NORMALISED (trimmed) value — the same value form resolution keys on — so a leading/trailing-
        // whitespace difference does NOT falsely mark the node digest-invisible and re-launch the whole
        // graph; only a genuine redaction difference (a real credential) survives (issue #778 review).
        push(id, "human.formKey", trimmedOrEmpty(node.human?.formKey), redactConnectorValue(trimmedOrEmpty(node.human?.formKey)));
        break;
      case "connector": {
        const c = node.connector;
        // The connector worker TRIMS `vars.target` before reserved-vocab matching AND dispatch, so a
        // whitespace-padded target has identical routing + runtime behaviour. Fingerprint the NORMALISED
        // (trimmed) value the worker keys on — matching the trimmed display — so a padding-only difference
        // does not fork the digest-invisible fingerprint (which would force an idempotencyKey and
        // double-launch a graph the runtime treats identically), while a real credential difference in the
        // trimmed value still survives (issue #778 review — thread deliveryGraphCompiler.ts:1277).
        push(id, "connector.target", trimmedOrEmpty(c.target), redactConnectorValue(trimmedOrEmpty(c.target)));
        // The connector worker TRIMS the authored dedupeKey (`connectorDedupeKey` in `deliveryConnector.ts`,
        // the SINGLE dedupe-key derivation site), so a whitespace-only variant has identical dedupe identity
        // + runtime behaviour. Fingerprint the NORMALISED (trimmed) value the worker keys on, so a trimmed-
        // whitespace difference does NOT falsely mark the node digest-invisible (which would force an
        // idempotencyKey and double-launch a graph the runtime treats identically); only a genuine redaction
        // difference (a real credential) survives (issue #778 review).
        push(id, "connector.dedupeKey", trimmedOrEmpty(c.dedupeKey), redactConnectorValue(trimmedOrEmpty(c.dedupeKey)));
        // The connector `timeout` is digest-invisible the same way an agent's is: displayed as
        // `trimmedOrEmpty(timeout)` then XML-sanitised, but read through `isoDuration(timeout, nodeTimeout)`
        // into the runtime SLA. Fingerprint the ISO-normalised value, compared with the ISO-normalised form
        // of the XML-sanitised display value (normalise BOTH sides) so a whitespace- OR case-only variant
        // collapses while an invalid one stays disambiguated (issue #778 review — thread :1331, over :1307).
        push(id, "connector.timeout", normaliseNodeTimeout(c.timeout), normaliseNodeTimeout(stripXmlInvalidChars(trimmedOrEmpty(c.timeout))));
        // The free-form connector `payload` survives raw into runtime `nodeInputs`, but `nodeDisplay`
        // surfaces at most a single NON-EMPTY string `payload.pr` (redacted). So the display FAITHFULLY
        // represents the payload ONLY when it is exactly `{ pr: <non-empty string> }` whose redaction is
        // a no-op; EVERY other shape leaves content the digest cannot see and is therefore invisible:
        // (a) a non-plain-object payload (a bare `42`/array — on which `"pr" in payload` would THROW, so
        // it MUST be gated before that probe), (b) a present-but-empty object or any extra key beyond
        // `pr`, (c) an omitted / non-string / empty `pr`, or (d) a string `pr` whose redaction drops
        // content. The whole raw payload (canonicalised so key order is not spuriously distinguishing)
        // is the disambiguator — but NORMALISE `pr` (trim) ONLY for a CONVERGE target: `nodeDisplay` and
        // the runtime both read `payload.pr.trim()` there (`resolveConvergePr`/`parsePr`), so a padded
        // credential-bearing `pr` and its trimmed twin are ONE runtime identity and MUST collapse
        // (fingerprinting the untrimmed payload forked their stable run key and double-launched the
        // connector side effect — issue #778 review — thread deliveryGraphCompiler.ts:1484). A GENERIC
        // (forward-declared) connector instead forwards `payload` UNCHANGED to its worker (`readConvergeInput`
        // in `workers/delivery-connector/worker.ts` runs only for `isConvergeTarget`), so `{pr:"  x  "}` and
        // `{pr:"x"}` are DISTINCT runtime payloads that MUST stay disambiguated — trimming them here would
        // collapse two different dispatches into one run key and let the keyless dispatch fence reuse the
        // wrong payload (issue #783 review — thread deliveryGraphCompiler.ts:1376). So trim only when the
        // target is a converge target.
        if (c.payload !== undefined && c.payload !== null) {
          const normalisedPayload =
            isConvergeTarget(trimmedOrEmpty(c.target)) && isRecord(c.payload) && typeof c.payload.pr === "string"
              ? { ...c.payload, pr: c.payload.pr.trim() }
              : c.payload;
          let invisible = true;
          if (isRecord(normalisedPayload)) {
            const keys = Object.keys(normalisedPayload);
            const pr = normalisedPayload.pr;
            invisible = keys.length !== 1 || keys[0] !== "pr" || typeof pr !== "string" || pr === "" || pr !== redactConnectorValue(pr);
          }
          if (invisible) out.push(`${id}\u0000connector.payload\u0000${canonicalJson(normalisedPayload)}`);
        }
        break;
      }
      case "wait": {
        const p = node.wait;
        // `parseProbe` (`readiness.ts`) TRIMS `target` for EVERY kind before the worker keys on it, so a
        // leading/trailing-whitespace-only variant (` run-task ` vs `run-task`) is the SAME runtime probe.
        // For a `command` probe the display is a constant `<redacted>`, so without trimming the fingerprint
        // the digest would fork on that whitespace — a distinct staged run key for an identical runtime
        // probe, bypassing the idempotency fence. Fingerprint the TRIMMED target (all kinds) so it matches
        // the runtime-normalised value (issue #778 review — thread :1372).
        push(id, "wait.target", p.target.trim(), redactProbeTargetForDisplay(p));
        // `credentialEnv` names a DECLARED env-contract key, shown in the doc as `trimmedOrEmpty(...)` then
        // XML-sanitised at serialisation, while the runtime `parseProbe` reads it as `.trim()`. A value
        // carrying an XML-invalid char (`"GITHUB_TOKEN\x01"`) sanitises to the SAME display as valid
        // `"GITHUB_TOKEN"`, so without a fingerprint the malformed graph shares the valid graph's digest and
        // `graphCarriesRedactedSecrets` stays false — letting keyless dispatch short-circuit the malformed
        // proposal onto the valid running instance (and mark it dispatched) even though `parseProbe` would
        // reject the raw value. Fingerprint the trimmed raw against its XML-sanitised form so a whitespace-
        // only variant collapses (runtime trims) while an invalid-char one stays disambiguated (issue #778
        // review — thread :1355).
        push(id, "wait.credentialEnv", trimmedOrEmpty(p.credentialEnv), stripXmlInvalidChars(trimmedOrEmpty(p.credentialEnv)));
        // `kind`/`onTimeout`/`poll.backoff` are shown verbatim in the doc (`Readiness probe: <kind>`,
        // `On timeout: <onTimeout>`, `<backoff> backoff`) then XML-sanitised at serialisation, while the
        // runtime `parseProbe` reads their RAW values. Exactly like `credentialEnv` above, a value carrying
        // an XML-invalid char (`"http\x01"`) sanitises to the SAME display as the valid form, so without a
        // fingerprint the malformed probe shares a valid graph's digest and `graphCarriesRedactedSecrets`
        // stays false — letting keyless dispatch short-circuit the malformed proposal onto the valid
        // running instance (and mark it dispatched) even though `parseProbe` would reject the raw value.
        // Fingerprint each trimmed raw against its XML-sanitised form so a whitespace-only variant collapses
        // (runtime trims) while an invalid-char one stays disambiguated (issue #778 review — thread :1366,
        // same class as the credentialEnv :1355 fingerprint above).
        push(id, "wait.kind", trimmedOrEmpty(p.kind), stripXmlInvalidChars(trimmedOrEmpty(p.kind)));
        push(id, "wait.onTimeout", trimmedOrEmpty(p.onTimeout), stripXmlInvalidChars(trimmedOrEmpty(p.onTimeout)));
        push(id, "wait.poll.backoff", trimmedOrEmpty(p.poll?.backoff), stripXmlInvalidChars(trimmedOrEmpty(p.poll?.backoff)));
        if (p.match) {
          for (const [k, v] of Object.entries(p.match)) {
            if (v === undefined || v === null) continue;
            // A string predicate whose trimmed value is EMPTY is runtime-unset — `parseMatch` coerces a
            // string field through `str(v).trim() || undefined` and a numeric field through `num(v)` (a
            // non-number → undefined), so `""`/`"   "` is omitted-equivalent on EITHER. `describeProbeMatch`
            // now drops it from the display (same digest as the omitted graph), so the run-key fingerprint
            // MUST drop it too — otherwise an empty variant pushes a token the omitted graph does not, forking
            // `stableProposalRunKey` under a shared digest and letting a keyless re-stage double-dispatch
            // (issue #778 review — thread deliveryGraphCompiler.ts:1254).
            if (matchValueRuntimeEmpty(v)) continue;
            // `verifyCommand`/`bodyIncludes`/`stdoutIncludes` are shown only as `<redacted>`; every other
            // match value is shown as `redactConnectorValue(String(v))`, which (a) XML-1.0 sanitisation
            // (`escapeXml`) later STRIPS invalid characters from — so `"1\x01"` and `"1"` share a digest —
            // AND (b) URL-redacts a credential-bearing free-form predicate (`capabilityRef`/`package`/
            // `checkName`) so `//user:pass@host#274` no longer surfaces the secret in the display. Either
            // transform leaves content the digest cannot see while the raw probe config differs; both cases
            // are digest-invisible and the raw value is the disambiguator (issue #778 review — thread :1169).
            if (REDACTED_MATCH_FIELDS.has(k)) {
              // A redacted field is ALWAYS invisible (display is `<redacted>`). `parseMatch` coerces these
              // free-form predicates through `str(v).trim()`, so fingerprint the SAME coercion — a
              // whitespace-only variant AND a number/string cross-type twin (`1` vs `"1"`) both collapse to
              // the one runtime match (an internal invalid char still distinguishes) instead of forking the
              // server-derived run key (issue #778 review — threads :1363 / deliveryGraphCompiler.ts:1251).
              // `v` is guaranteed non-null here; `str` is not exported, so inline `String(v).trim()`.
              out.push(`${id}\u0000wait.match.${k}\u0000${canonicalJson(String(v).trim())}`);
            } else if (matchValueTypeMismatch(k, v)) {
              // A numeric field (`status`/`exitCode`) coerces through `num()`: a real number is a
              // distinct runtime match, but EVERY non-number (`"200"`, `" 200 "`, `"foo"`, `true`)
              // collapses to the SAME `undefined` (unset / any-2xx) match. Fingerprint that CANONICAL
              // coerced value — a constant `null` unset marker — NOT the raw `v`: otherwise two
              // runtime-equivalent non-number twins (`"200"` vs `" 200 "`, which also DISPLAY identically)
              // fork distinct `stableProposalRunKey`s and double-dispatch. The number/string cross-type
              // twin (`200` vs `"200"`) still forks correctly because the number takes the else-branch and
              // pushes nothing, while a genuinely different-DISPLAY string (`"foo"`) already forks via
              // `semanticBpmn` (issue #778 review — thread deliveryGraphCompiler.ts:1616).
              out.push(`${id}\u0000wait.match.${k}\u0000${canonicalJson(null)}`);
            } else {
              // A non-redacted field is shown as `redactConnectorValue(String(v).trim())` — `describeProbeMatch`
              // trims a string predicate before display, and `parseMatch` likewise coerces via
              // `str(v).trim()` — so fingerprint the SAME trimmed form. Comparing/fingerprinting the RAW
              // `String(v)` instead forks the run key for a whitespace-only variant (`" //user:pass@host#1 "`
              // vs its trimmed twin) that parses to the ONE runtime match, so a keyless re-stage double-
              // dispatches an identical graph (issue #778 review — thread deliveryGraphCompiler.ts:1591).
              const tv = typeof v === "string" ? v.trim() : v;
              if (hasXmlInvalidChars(String(tv)) || redactConnectorValue(String(tv)) !== String(tv)) {
                out.push(`${id}\u0000wait.match.${k}\u0000${canonicalJson(tv)}`);
              }
            }
          }
        }
        break;
      }
      default:
        return assertNever(node, "digestInvisibleRawValues");
    }
  }
  // Canonicalise the order so this list is a content IDENTITY, not an ENCODING one. Each entry is fully
  // self-identifying (`nodeId\0field\0raw`), so its position in `graph.nodes` iteration order carries no
  // information — but the run-key fingerprint (`stableProposalRunKey`) canonicalises this array with
  // `canonicalJson`, which PRESERVES array order. The compiler SORTS nodes before emitting `semanticBpmn`,
  // so two graphs differing ONLY in top-level node order share one digest; without this sort their
  // invisible-value lists would differ in order alone, yielding DISTINCT run-keys that double-launch the
  // same logical graph instead of short-circuiting as `alreadyRunning`. Sort by code unit (locale-
  // independent) so the fingerprint is reorder-invariant, matching the digest's node-reorder collapse
  // (issue #778 review). Sorting cannot drop or merge entries, so the emptiness check
  // (`graphCarriesRedactedSecrets`) and the credential-disambiguation are unaffected.
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

/** Whether a graph's raw content carries values that redaction/normalisation DROPS from `semanticBpmn`
 * (issue #778 review — Option C): non-empty {@link digestInvisibleRawValues}. Two graphs differing ONLY
 * in such a value compile to IDENTICAL `semanticBpmn` → identical digest, so the digest is NOT a faithful
 * fingerprint for them; a dispatch must then REQUIRE an explicit `idempotencyKey` (or the stable
 * server-side run-key) to disambiguate, instead of silently collapsing the second onto the first's
 * still-running instance. `false` ⇒ the digest is a complete identity and no key is required. */
export function graphCarriesRedactedSecrets(graph: DeliveryGraph): boolean {
  return digestInvisibleRawValues(graph).length > 0;
}

/** Render one node as an EMBEDDED `bpmn:subProcess` — the engine-native delegation unit (Decision 2).
 * Call activities are a no-op on the pinned WASM engine (the child is never instantiated), so — like
 * `plan-fanout`'s `readiness-preflight` — every node inlines a subProcess that shares the parent
 * variable scope. A single outer in/out keeps the compiler's fan-out/fan-in topology clean; the
 * subProcess's own `zeebe:ioMapping` (a) seeds the body its config from `nodeInputs.<element>` (runner-
 * set), (b) threads late-binding `boundFacts` from upstream producers' emitted-fact variables, and (c)
 * publishes this node's declared emits into flat `<element>_<fact>` variables a downstream consumer
 * binds. Every node is bounded (a timeout escalates onto a human-completable user task) and resumable
 * (engine-persisted). The `switch` is EXHAUSTIVE over the closed kind union — the compile-time trust
 * bound. */
function renderNodeElement(
  w: NodeWiring,
  incoming: readonly string[],
  outgoing: readonly string[],
  boundInputs: readonly BoundInput[],
  requiredEmits: ReadonlySet<string>,
): string {
  const el = w.element;
  const display = nodeDisplay(w.node);
  const name = escapeXml(display.name);
  const flowRefs = [
    ...incoming.map((id) => `      <bpmn:incoming>${id}</bpmn:incoming>`),
    ...outgoing.map((id) => `      <bpmn:outgoing>${id}</bpmn:outgoing>`),
  ];
  const io = ioMappingLines(w, boundInputs);
  const inner = innerBodyLines(w, requiredEmits, display.name);
  // `<bpmn:documentation>` is the BPMN-native per-node description (a tooltip/details panel in the
  // explorer/modeler). It is a SEMANTIC child, so it survives the `layoutBpmn` DI graft untouched
  // (unlike a hand-edited DI block). Schema-wise it must be the flow element's FIRST child (before
  // `<extensionElements>`/`<incoming>`), so it slots ahead of the flow refs and io. Omitted when empty.
  const documentation =
    display.documentation.trim() !== ""
      ? [`      <bpmn:documentation>${escapeXml(display.documentation)}</bpmn:documentation>`]
      : [];
  const lines = [
    `    <bpmn:subProcess id="${el}" name="${name}">`,
    ...documentation,
    ...flowRefs,
    "      <bpmn:extensionElements>",
    ...io,
    "      </bpmn:extensionElements>",
    ...inner,
    "    </bpmn:subProcess>",
  ];
  return lines.join("\n");
}

/** The subProcess `<zeebe:ioMapping>` lines (8-space indented, inside `extensionElements`). Inputs
 * pull the body's config from `nodeInputs.<element>` (runner-seeded) plus any late-binding
 * `boundFacts`; outputs publish the node's declared emits into flat `<element>_<fact>` variables.
 * Deterministic — fixed input/output order, positional fact targets. FEEL sources go through `attr`
 * (single-quote delimiter) so embedded string literals survive the engine's deploy path. */
function ioMappingLines(w: NodeWiring, boundInputs: readonly BoundInput[]): string[] {
  const el = w.element;
  const node = w.node;
  const inputs: { source: string; target: string }[] = [];
  const outputs: { source: string; target: string }[] = [];
  const cfg = (field: string): string => `=nodeInputs.${el}.${field}`;
  const guarded = (src: string): string => `=if (is defined(${src})) then ${src} else null`;
  // Null-safe bounded-timeout source (issue #872): the node's boundary timer is `=nodeTimeout`, so a
  // null `nodeInputs.<el>.timeout` seeds a null duration and the engine fires the timer IMMEDIATELY
  // (a ~0.5s escalation that looks like an instant SLA breach). Fall back to the run-level
  // `runNodeTimeout` (seeded by the runner), then to the shared `DELIVERY_NODE_DEFAULT_TIMEOUT`
  // constant (`PT1H`) — the SAME default the runner seeds, so the two never drift (PR #876 review) —
  // so a node released with no per-node timeout always gets a real SLA instead of a zero-length timer.
  const timeoutSource = (): string => {
    const perNode = cfg("timeout").slice(1);
    return `=if (is defined(${perNode}) and ${perNode} != null) then ${perNode} else (if (is defined(runNodeTimeout) and runNodeTimeout != null) then runNodeTimeout else ${feelStr(DELIVERY_NODE_DEFAULT_TIMEOUT)})`;
  };

  switch (node.kind) {
    case "agent":
      inputs.push({ source: cfg("jobType"), target: "jobType" });
      inputs.push({ source: cfg("appendPrompt"), target: "appendPrompt" });
      inputs.push({ source: timeoutSource(), target: "nodeTimeout" });
      // Stage 0 transcript correlation (#543): seed the transcript URL base so the completing fleet
      // worker can append its own jobKey-scoped stream and emit `transcriptUrl` (below). `transcriptUrlBase`
      // is a top-level launch variable (deliveryRunner) — guarded so a hand-seeded instance without it
      // threads null rather than raising a FEEL error.
      inputs.push({ source: guarded(TRANSCRIPT_URL_BASE_VAR), target: TRANSCRIPT_URL_BASE_VAR });
      break;
    case "wait": {
      inputs.push({ source: cfg("gateKey"), target: "gateKey" });
      // #548 late-binding: when the authored probe `target` is a `<node>.<fact>` reference to an
      // upstream emitted fact threaded on an incoming edge, rewrite the seeded probe's `target` to the
      // OBSERVED value via FEEL `context put`, so the canonical `agent → connector[converge-merge] →
      // wait[pr, merged]` shape polls the PR the agent opened with NO hardcoded literal. A plain literal
      // target (a real `owner/repo#N` is never `<node>.<fact>`-shaped) can't match a bound ref, so it
      // passes through unchanged. Guarded (`is defined`) so an as-yet-unobserved fact binds NULL rather
      // than raising a FEEL error.
      //
      // The else-branch writes NULL — NOT the authored fact-ref literal (issue #872, PR #876 review).
      // The compiler is the ONLY component that knows whether the target was actually bound; leaving the
      // `<node>.<fact>` reference in place forced the readiness-probe worker to re-derive "unresolved"
      // from a SYNTAX test (`isFactRefTarget`), which cannot tell an unresolved fact-ref from a VALID
      // dotted literal command target (e.g. `check.sh`) and so parked that gate forever. Writing null
      // here is the fail-closed provenance: the worker guards null/blank ONLY, and a dotted literal
      // always reaches its probe verbatim.
      // TRIM the target before the bind match — `parseProbe` (`readiness.ts`) trims `wait.target` before
      // the worker keys on it, and the display/digest render the trimmed form (`p.target.trim()`,
      // deliveryGraphCompiler.ts:1476). Matching the RAW `node.wait.target` here let a padded fact
      // reference (`" open.pr "`) render/digest like the trimmed ref yet SKIP this binding, leaving the
      // runtime with the literal `open.pr` the wait can never resolve (issue #778 review — thread
      // deliveryGraphCompiler.ts:1476). Mirrors the connector's `payload.pr.trim()` normalisation.
      const boundTarget = boundInputs.find((b) => `${b.fromNode}.${b.fact}` === node.wait.target.trim());
      if (boundTarget) {
        const varName = `${boundTarget.producerElement}_${boundTarget.fact}`;
        const probeRef = cfg("probe").slice(1);
        inputs.push({
          source: `=context put(${probeRef}, "target", if (is defined(${varName}) and ${varName} != null) then ${varName} else null)`,
          target: "probe",
        });
      } else {
        inputs.push({ source: cfg("probe"), target: "probe" });
      }
      inputs.push({ source: cfg("probeTimeout"), target: "probeTimeout" });
      inputs.push({ source: cfg("probePollEvery"), target: "probePollEvery" });
      break;
    }
    case "human":
      inputs.push({ source: cfg("escalationSlaTimeout"), target: "escalationSlaTimeout" });
      inputs.push({ source: cfg("escalationAssignee"), target: "escalationAssignee" });
      // Seed the authored instruction + node identity + emit context so the generic human form renders
      // "now do X", names the parked node, and labels/hides its emit field (issue #499). `emits` is the
      // single source of truth; the emit label/mode are derived from it in FEEL here (no duplicate seed).
      inputs.push({ source: cfg("prompt"), target: "prompt" });
      inputs.push({ source: cfg("nodeId"), target: "nodeId" });
      inputs.push({ source: `=if count(${cfg("emits").slice(1)}) = 0 then "none" else "typed"`, target: "emitMode" });
      inputs.push({
        source: `=string join(for _e in ${cfg("emits").slice(1)} return _e.name + " (" + _e.type + ")", ", ")`,
        target: "emitLabel",
      });
      break;
    case "connector":
      inputs.push({ source: cfg("target"), target: "target" });
      inputs.push({ source: cfg("dedupeKey"), target: "dedupeKey" });
      inputs.push({ source: cfg("payload"), target: "payload" });
      inputs.push({ source: timeoutSource(), target: "nodeTimeout" });
      break;
    default:
      return assertNever(node, "ioMappingLines");
  }

  // Node-local result scope (see AGENT_RESULT_LOCAL_VARS / ESCALATION_LOCAL_VARS): declare the variables a
  // job completion / escalation completion writes as `null` on THIS subProcess, so Nano's nearest-scope
  // propagation lands them here instead of the shared root. BOTH service-node kinds (agent AND connector)
  // also localise each declared emit's source variable (an agent/connector fact's source is the fact's
  // own name — see factSourceVar), so a sibling's same-named emit can never satisfy this node's contract
  // gate or publish through this node's `<el>_<fact>` output. A connector ALSO returns fixed result
  // metadata (`connectorOutcome`/`connectorDedupeKey`/`connectorDetail`); without localising those too,
  // parallel connectors overwrite each other's root-scoped result (Copilot review #863, thread
  // r4180856788) exactly as parallel agents once overwrote one shared root status/pr.
  // A `DeliveryNodeConnector` permits `emits` too, so WITHOUT this a timed-out connector could publish a
  // parallel sibling connector's root-scoped result through its own output mapping (Copilot review #863,
  // thread r4179717614).
  // A `human` node has no worker result, but its user task captures the operator's answer into fixed,
  // non-node-unique scratch (`humanEmitValue`/`humanEmitArtifact`/`humanOutcome`/`humanNote`) by SELECTING
  // from fixed form controls (`value`/`resolvedArtifact`/`note`, plus a bespoke form's fact-named control).
  // Left at the shared ROOT these cross-publish between parallel human nodes: a human that completes while
  // a sibling times out WITHOUT producing a value would have the sibling read its root `humanEmitValue`
  // and publish it as the sibling's own `<el>_<fact>` — the complete-one/timeout-the-other leak (Copilot
  // review #863, thread r4199949849). So a human subProcess ALSO localises its scratch + form controls
  // (HUMAN_RESULT_LOCAL_VARS) and its explicit fact-named control (the declared emit's own name, read first
  // by a bespoke single-emit form), fail-closing a value-less timeout to its OWN null instead of a
  // sibling's.
  // A `wait` node likewise has no worker result, but its SLA-timeout escalation parks on the SAME generic
  // form, whose completion writes the escalation controls (ESCALATION_LOCAL_VARS = decision/value/
  // escalationNote). On the escalate path the interrupting boundary timer CANCELS the probeLoop before its
  // output mapping runs, so the `_lastAttempt` probe result and any value-resume materialise the emit
  // SOURCE (`detail`/`resolvedArtifact`/`mergedSha`/`prCount` — factSourceVar) with NOTHING declaring them
  // in the wait subProcess. Left at the shared ROOT those cross-publish between parallel timed-out waits:
  // a value-less completion on one wait reads a sibling's root `value`/emit and resumes from the sibling's
  // answer (Copilot review #863, thread r4200608648). So a wait subProcess ALSO localises its escalation
  // controls + each declared emit source. None of these is read by a wait gateway (the `ready?` splits read
  // only `ready`, which stays un-seeded), so the null-seed cannot shadow a gateway (the multi-instance
  // `=null`-shadow gotcha). A wait has no retry escape, so there is no retry-reset to clear them.
  if (node.kind === "agent" || node.kind === "connector" || node.kind === "human" || node.kind === "wait") {
    const locals = new Set<string>();
    if (node.kind === "human") {
      for (const v of HUMAN_RESULT_LOCAL_VARS) locals.add(v);
      // A bespoke single-emit human form captures the value under the FACT'S OWN NAME (humanBodyLines'
      // `selectExpr` reads `<factName>` before the canonical control), so that control must be node-local
      // too — otherwise a blank completion reads a sibling's root value. factSourceVar maps a human emit to
      // the fixed `humanEmitValue`/`humanEmitArtifact` (already in the set), so seed the fact name directly.
      for (const fact of normaliseEmits(node)) locals.add(fact.name);
    } else {
      // agent / connector / wait: the escalation user task completes with a form's controls, and each
      // declared emit's SOURCE var (factSourceVar) must fail-close to this node's own null.
      for (const v of ESCALATION_LOCAL_VARS) locals.add(v);
      if (node.kind === "agent") {
        for (const v of AGENT_RESULT_LOCAL_VARS) locals.add(v);
      } else if (node.kind === "connector") {
        for (const v of CONNECTOR_RESULT_LOCAL_VARS) locals.add(v);
      } else {
        // `wait`: its SLA-timeout escalation renders the GENERIC human form (`delivery-human-generic`),
        // whose controls are `value` + `note` — NOT the retry-capable `ESCALATION_FORM`'s
        // `decision`/`value`/`escalationNote` (a wait has no retryElement, so `escalationTaskLines` picks
        // the generic form). `value` is already in ESCALATION_LOCAL_VARS, but the generic form's `note`
        // control is NOT — so completing a timed-out wait with an operator note would propagate `note` to
        // the shared ROOT, letting parallel waits overwrite one another's note and exposing a
        // wait-specific note to later jobs (Copilot review #863, thread r4200916073). Seed it node-local.
        locals.add("note");
      }
      // (a `wait` has no self-reported worker result metadata — only its escalation controls + emit sources)
      for (const fact of normaliseEmits(node)) locals.add(factSourceVar(node.kind, fact));
    }
    const taken = new Set(inputs.map((i) => i.target));
    for (const v of locals) {
      if (!taken.has(v)) inputs.push({ source: "=null", target: v });
    }
  }

  // Late-binding: a deterministic FEEL list literal of the upstream producers' emitted facts, keyed
  // exactly as the edge references them (`<producerNode>.<fact>`), read from the flat parent variable
  // each producer publishes. Guarded so an as-yet-unobserved fact threads as null, not a FEEL error.
  if (boundInputs.length > 0) {
    const entries = boundInputs.map((b) => {
      const varName = `${b.producerElement}_${b.fact}`;
      return `{from: ${feelStr(b.fromNode)}, name: ${feelStr(b.fact)}, value: if (is defined(${varName})) then ${varName} else null}`;
    });
    inputs.push({ source: `=[${entries.join(", ")}]`, target: "boundFacts" });
  }

  // Outputs: publish each declared emit into `<element>_<fact>` for a downstream consumer to bind.
  // A `human` node's non-artifact emits ALL share the one captured `humanEmitValue` (the generic/publish
  // forms have a single value field — see humanBodyLines). Publishing that one value into SEVERAL
  // distinct facts would corrupt them (PR #863 Copilot Low, thread r4182488264). validateDeliveryGraph
  // now REJECTS every ≥2-emit human node (`human-unroutable-emits`, threads
  // deliveryGraphCompiler.ts:1859 / :1927) — no static form can capture several emits (an explicit
  // `human.formKey` is no exception: this ioMapping reads only the fixed value/resolvedArtifact/note
  // controls, never a bespoke form's per-fact fields), so that whole class is refused at authoring time
  // rather than silently publishing null. This discard stays as residual defence for a ≥2-emit node that
  // somehow reaches compile despite the validator: only a SINGLE non-artifact human emit is sourced from
  // `humanEmitValue`; with two or more, every non-artifact emit publishes null. Artifact emits are
  // unaffected (they read the distinct `humanEmitArtifact`).
  const humanNonArtifactEmits =
    node.kind === "human" ? normaliseEmits(node).filter((f) => f.type !== "artifact") : [];
  const humanValueEmit = humanNonArtifactEmits.length === 1 ? humanNonArtifactEmits[0] : undefined;
  for (const fact of normaliseEmits(node)) {
    const discardHumanValue =
      node.kind === "human" && fact.type !== "artifact" && humanValueEmit === undefined;
    outputs.push({ source: discardHumanValue ? "=null" : guarded(factSourceVar(node.kind, fact)), target: `${el}_${fact.name}` });
  }

  // Stage 0 transcript correlation (#543): propagate the completing worker's `transcriptUrl` (built
  // from the seeded base + its jobKey) up to the process-instance scope, where Nano Explorer's
  // variables panel renders it as the link from this run to the agent's transcript. Guarded so a job
  // completed without it (an older fleet worker) threads null instead of raising a FEEL error.
  if (node.kind === "agent") {
    outputs.push({ source: guarded(TRANSCRIPT_URL_VAR), target: TRANSCRIPT_URL_VAR });
  }

  const lines: string[] = ["        <zeebe:ioMapping>"];
  for (const i of inputs) lines.push(`          <zeebe:input ${attr("source", i.source)} target="${i.target}" />`);
  for (const o of outputs) lines.push(`          <zeebe:output ${attr("source", o.source)} target="${o.target}" />`);
  lines.push("        </zeebe:ioMapping>");
  return lines;
}

/** The inner flow of a node's subProcess (6-space indented). `agent`/`connector` delegate to a job
 * worker; `wait` polls the ReadinessProbe gate (blocking until its target is observed ready — polling
 * its OWN target is what makes an unrelated upstream event unable to falsely resolve it); `human` is
 * the S3 scheduled user-task + generic form + SLA. Each is a single-entry / single-exit subgraph with
 * a bounded timeout that escalates onto a human-completable user task (or, for `human`, records an
 * escalated outcome). */
function innerBodyLines(w: NodeWiring, requiredEmits: ReadonlySet<string>, displayName: string): string[] {
  const el = w.element;
  const node = w.node;
  switch (node.kind) {
    case "agent": {
      // Issue #731: an `agent` node gates its own completion on a producer contract — a terminal-success
      // self-reported `status` AND a non-null value for every declared emit a downstream consumer binds
      // as a required data dependency. A broken producer (returns `in_progress`, or omits a required
      // emit) escalates AT this node instead of threading an incomplete result onward.
      const nodeEmits = normaliseEmits(node);
      const contractGate = { requiredEmits: nodeEmits.filter((f) => requiredEmits.has(f.name)), emits: nodeEmits };
      // The executable `<zeebe:taskDefinition type=…>` MUST carry the raw `jobType` verbatim for worker
      // routing (validateDeliveryGraph rejects a URL-shaped/credential-bearing jobType, so it can never
      // be a leak here), but the `descriptor` is embedded by `serviceBodyLines` into the operator-visible
      // timeout / producer-contract escalation FEEL `prompt` — so it takes the SAME display redaction
      // `nodeDisplay` applies, never the raw value (issue #778 review — thread deliveryGraphCompiler.ts:1606).
      return serviceBodyLines(el, node.id, attr("type", node.agent.jobType), [], redactConnectorValue(node.agent.jobType), contractGate, agentRepoSpecHeaderLines(node), displayName, "agent", nodeEmits);
    }
    case "connector": {
      // TRIM the target before building the escalation descriptor — `nodeDisplay` and the connector
      // worker both key on the trimmed value, so an untrimmed `" converge-merge "` would fork the
      // `semanticBpmn`/digest from the trimmed-equivalent graph that dispatches identically (issue #778
      // review — thread deliveryGraphCompiler.ts:1741).
      // A connector declares `emits` (its emit source is the fact's own name) but has NO
      // producer-contract gate, so pass them explicitly as `nodeEmits` — otherwise the timeout
      // escalation could not resume a connector's emit on Continue, nor clear it on Retry (#863).
      // The resume/validation path (Continue) uses only the REQUIRED emits a downstream node binds —
      // the facts a null (lost) result poisons (#872/#876) — while `nodeEmits` (all declared emits)
      // drive the Retry clear and the resume-valid flag's collision-avoidance targets.
      const connectorEmits = normaliseEmits(node);
      const connectorRequired = connectorEmits.filter((f) => requiredEmits.has(f.name));
      return serviceBodyLines(el, node.id, `type="${DELEGATE_TASK_TYPE.connector}"`, [], `connector → ${redactConnectorValue(node.connector.target.trim())}`, undefined, [], displayName, "connector", connectorEmits, connectorRequired);
    }
    case "wait":
      return waitBodyLines(el, node, displayName);
    case "human": {
      // Select the human node's form by DERIVING it from the canonical resolver (resolveHumanForm),
      // never hardcoding the generic form: a 0-emit node uses the acknowledgement form, a single-artifact
      // node uses the manual-publish form (which carries the `resolvedArtifact` control the generic form
      // lacks, so the artifact is actually captured instead of published null), and a single-value node
      // uses the generic typed-emit form. A ≥2-emit node resolves to the agent-router (formKey null) and
      // is REJECTED upstream by validateDeliveryGraph (`human-unroutable-emits` — a bespoke formKey is no
      // rescue for ≥2 emits, since one form value cannot satisfy several typed facts), so the
      // `?? GENERIC_HUMAN_FORM` fallback here is unreachable defensive cover (PR #863 threads
      // deliveryGraphCompiler.ts:1859 / :1927).
      // For a SINGLE emit the node MAY carry an EXPLICIT bespoke form whose field is named after the
      // emitted fact (the canonical binding contract `bindHumanEmits` reads the fact's own key first,
      // then the generic `value`/`resolvedArtifact` capture keys — deliveryHuman.ts) — so thread the one
      // emit through so the userTask ioMapping reads that fact-named field too. Without it a valid
      // `{ approval: "yes" }` custom form for an `approval` emit renders fine but publishes NULL (the
      // ioMapping only read the fixed `value`/`resolvedArtifact` controls) — PR #863 review, thread
      // deliveryGraphCompiler.ts:1929. SCOPE the fact-NAMED read to `source === "explicit"`: the built-in
      // generic/publish forms capture under the FIXED `value`/`resolvedArtifact` controls, and a fact
      // happening to be named after one of those built-in forms' OTHER fields (e.g. a single emit named
      // `note`) must not make the mapping read that unrelated field — only a bespoke form keys its control
      // on the fact.
      // TYPE COERCION is a WIDER contract than the fact-named read: the SAME class of bug (a captured
      // TEXT value published verbatim for a typed fact) also bites the GENERIC single-value form — a lone
      // `boolean`/`number` emit answered through the generic textfield would publish the string
      // `"true"`/`"1"` that a downstream guarded split (`= true`/`= 1`) never matches. So coerce by the
      // one declared emit's type for EVERY form source (explicit AND built-in), while preferring the
      // fact-named field ONLY for an explicit bespoke form (PR #863 thread r4189815989).
      const humanForm = resolveHumanForm(node);
      const singleEmit = humanForm.emits.length === 1 ? humanForm.emits[0] : undefined;
      const preferFactName = humanForm.source === "explicit";
      // A human node has no worker self-report to gate on, but its single emit CAN be a downstream-REQUIRED
      // fact — and invalid typed input coerces to null (fail-closed on the value, coerceFactValueFeel), so
      // WITHOUT a completion gate the node ends and the unconditional edge activates the consumer with a
      // null required fact (PR #863 review, thread r4198662345). Thread whether that single emit is
      // required so humanBodyLines grows a fail-closed completion gate over it (re-enter on an invalid
      // value) instead of publishing null onward.
      const requiredEmit = singleEmit !== undefined && requiredEmits.has(singleEmit.name);
      return humanBodyLines(el, displayName, humanForm.formKey ?? GENERIC_HUMAN_FORM, singleEmit, preferFactName, requiredEmit);
    }
    default:
      return assertNever(node, "innerBodyLines");
  }
}

/** Render the DECLARED per-node repository-spec marker task header (#739) for an `agent` node — a single
 * `<zeebe:taskHeaders>` block carrying {@link AGENT_REPO_SPEC_HEADER} with a compact JSON of the node's
 * `id` and its DECLARED `{ repository, baseBranch }` (each `null` when absent). It is emitted on EVERY
 * agent service task (even one with no declared repo → `{"repository":null,"baseBranch":null}`) so the
 * runner has a single, uniform anchor to replace with the effective envelope on every cell. The node
 * `id` is carried here (issue #776) so the runner can emit the deterministic per-node `feat/<node.id>`
 * `branch.create` on the injected envelope — the identity is not otherwise recoverable from the isolated
 * `<zeebe:taskHeaders>` block the runner rewrites. Digest-stable and env-free — only the node id and
 * declared values (pure graph content) appear here; the run-level fallback and the env-dependent
 * `cloneTimeoutMs` are injected by the runner POST-digest. The id + declared values pass the
 * `owner/repo` + node-id/branch-name allowlists (validator/OpenAPI), so the JSON carries no XML-hostile
 * chars. */
function agentRepoSpecHeaderLines(node: Extract<DeliveryNode, { kind: "agent" }>): string[] {
  const trimOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const spec = JSON.stringify({ nodeId: node.id, repository: trimOrNull(node.agent.repository), baseBranch: trimOrNull(node.agent.baseBranch) });
  return [
    "          <zeebe:taskHeaders>",
    `            <zeebe:header key="${AGENT_REPO_SPEC_HEADER}" ${attr("value", spec)} />`,
    "          </zeebe:taskHeaders>",
  ];
}

/** `agent`/`connector` body: `start → serviceTask → end`, with a bounded `=nodeTimeout` boundary that
 * exclusive split's SUCCESS flow: the completion proceeds onward only when the self-reported `status`
 * is a terminal success (or absent/null) AND every required-data-dependency emit is populated non-null.
 * Reads the job's returned variables from the subProcess scope (the emit source var for an agent fact
 * is the fact's own name — see {@link factSourceVar}). When it is false the split's DEFAULT flow routes
 * to the contract-escalation task instead. */
function agentContractProceedCondition(requiredEmits: readonly DeliveryFact[]): string {
  const statusList = `[${AGENT_TERMINAL_SUCCESS_STATUSES.map((s) => feelStr(s)).join(", ")}]`;
  const statusOk = `(not(is defined(status)) or status = null or list contains(${statusList}, status))`;
  const emitClauses = requiredEmits.map((f) => `(is defined(${f.name}) and ${f.name} != null)`);
  return `=${[statusOk, ...emitClauses].join(" and ")}`;
}

/** The read-only context line seeded onto an `agent` node's producer-contract escalation (issue #731),
 * so the human/agent unsticking it sees WHY it parked — the node, its job type, the actual reported
 * status, and, per required emit, whether it arrived. Turns the instance-10746 failure (a silent null
 * thread + two mis-attributed CONSUMER incidents) into one correctly-attributed PRODUCER escalation. */
function agentContractContextFeel(nodeId: string, descriptor: string, requiredEmits: readonly DeliveryFact[], nodeEmits: readonly DeliveryFact[]): string {
  const statuses = AGENT_TERMINAL_SUCCESS_STATUSES.join("/");
  const head = feelStr(
    `Node ${nodeId} (${descriptor}) completed but did not satisfy its producer contract — when a producer ` +
      `reports a status it must be a terminal-success status (${statuses}; an absent/null status is accepted), ` +
      `and it must populate every emit a downstream node requires ` +
      "before its result routes onward. Reported status=",
  );
  let feel = `=${head} + (if (is defined(status) and status != null) then string(status) else "(none)") + "."`;
  for (const f of requiredEmits) {
    const present = `(is defined(${f.name}) and ${f.name} != null)`;
    feel += ` + " Required emit '${f.name}': " + (if ${present} then "present" else "MISSING (null)") + "."`;
  }
  // The node's OWN agent report (node-local since the result vars are declared on the subProcess): what
  // the agent said it did / why it stopped, its question for the operator, and the transcript link — the
  // actionable content the bare status line above never carried (171774's three report-less escalations).
  const text = (v: string): string => `(is defined(${v}) and ${v} != null and string(${v}) != "")`;
  // Each fragment reads as its own sentence on the plain-text "Decision context" (terminal period added
  // unless the agent's text already ends in punctuation).
  const sentence = (v: string): string => `string(${v}) + (if matches(string(${v}), "[.!?]\\s*$") then "" else ".")`;
  feel += ` + (if ${text("summary")} then " Agent report: " + ${sentence("summary")} else " Agent report: (the agent returned no summary).")`;
  feel += ` + (if ${text("question")} and (not(${text("summary")}) or string(question) != string(summary)) then " Agent question: " + ${sentence("question")} else "")`;
  feel += ` + (if ${text("error")} then " Error: " + ${sentence("error")} else "")`;
  feel += ` + (if ${text("transcriptUrl")} then " Transcript: " + string(transcriptUrl) else "")`;
  feel += ` + ${feelStr(escalationResolutionHint(nodeEmits, requiredEmits, true))}`;
  return feel;
}

/** `agent`/`connector` body: `start → serviceTask → end`, with a bounded `=nodeTimeout` boundary that
 * escalates the stalled node onto a human-completable user task. `taskDefAttr` is the pre-rendered
 * `type="…"` attribute; `taskProps` are optional `<zeebe:property>` envelope lines; `descriptor`
 * names the stalled work (job type / connector target) for the escalation task's context line (#499).
 *
 * `contractGate` (agent only, issue #731) inserts a PRODUCER post-condition between the task and the
 * end: an exclusive split whose SUCCESS flow ({@link agentContractProceedCondition}) proceeds only on a
 * terminal-success `status` AND non-null required emits, and whose DEFAULT flow parks a broken producer
 * on a SECOND (contract) escalation task — distinct from the `__esc` timeout twin. That escalation is
 * RESUMABLE with the node's required emits (a human/agent supplies the missing fact, which the
 * subProcess output mapping then publishes as `<el>_<fact>`), mirroring the #514 Defect-B wait resume.
 * Omitted for a `connector` (no self-reported status contract), whose body stays `task → end`. */
function serviceBodyLines(
  el: string,
  nodeId: string,
  taskDefAttr: string,
  taskProps: readonly string[],
  descriptor: string,
  contractGate?: { requiredEmits: readonly DeliveryFact[]; emits: readonly DeliveryFact[] },
  taskHeaders: readonly string[] = [],
  taskName: string = nodeId,
  // The node's kind (`agent`/`connector`) and its OWN declared emits. A connector passes
  // `contractGate = undefined` (no self-reported status contract) yet still declares `emits`, so the
  // escalation resume / retry-clear below key off the node's OWN emits, not the agent-only gate — and
  // map them through `factSourceVar(kind, …)` (issue #863 review — thread "Connector emits are lost
  // during timeout escalation recovery").
  kind: "agent" | "connector" = "agent",
  nodeEmits: readonly DeliveryFact[] = contractGate?.emits ?? [],
  // The node's REQUIRED emits (the facts a downstream node binds as a data dependency). The #863 Retry
  // path clears ALL `nodeEmits`; the #876 Continue/resume path is gated through fail-closed validation
  // on exactly these REQUIRED emits — a null/invalid operator value re-parks instead of threading null
  // onto a consumed fact (issue #872). Defaults to the contract gate's required emits (an agent); a
  // connector passes its own required subset explicitly (it has no gate to derive from).
  resumeEmits: readonly DeliveryFact[] = contractGate?.requiredEmits ?? [],
): string[] {
  const esc = escalationTaskElement(el);
  const isAgent = contractGate !== undefined;
  // Gateway decisions are computed INSIDE the node's scope and published as a node-UNIQUE root boolean,
  // because Nano evaluates exclusive-gateway conditions against the ROOT variables only (not the
  // gateway's scope, as Zeebe does). The node's result vars are node-local (see ioMappingLines), so a
  // gateway reading `status`/`<emit>` directly would never see them; reading `<el>_contractMet` /
  // `<el>_retryRequested` works on either engine semantics and can never collide ACROSS nodes. The
  // source var ({@link factSourceVar}) of EVERY declared emit (required + non-required) is reserved so
  // BOTH the resume-valid flag (PR #876) AND these control vars are grown collision-free against all of
  // them — an emit whose source var equals the bare control name (e.g. an agent emit literally named
  // `<el>_contractMet`) would otherwise be null-seeded node-local and SHADOW the root control the outer
  // gateway reads, so the producer could never pass (issue #863 review, thread r4199435326).
  const reservedFlagTargets = nodeEmits.map((f) => factSourceVar(kind, f));
  const contractMetVar = nodeControlVar(el, "contractMet", reservedFlagTargets);
  const taskExt = [
    "        <bpmn:extensionElements>",
    `          <zeebe:taskDefinition ${taskDefAttr} />`,
    ...(taskProps.length > 0 ? ["          <zeebe:properties>", ...taskProps, "          </zeebe:properties>"] : []),
    ...taskHeaders,
    "          <zeebe:ioMapping>",
    // Preflight guard: the node body is configured from the runner-seeded root `nodeInputs.<el>`. If that
    // seed is missing (lost root variables — nano-bpm#1331 wiped them on 171774/171309), every `cfg(...)`
    // on the subProcess silently evaluated to null and the agent ran BLIND (no prompt/timeout), reporting
    // `blocked` into an unexplained producer-contract escalation. Fail LOUD instead: a FEEL `assert` makes
    // this input raise an incident naming the cause, BEFORE a job exists; once the root variables are
    // restored, resolving the incident re-applies the inputs and the job is created. It sits on the inner
    // LEAF task, not the subProcess: a leaf input incident parks the token on every engine (#946), whereas
    // a subProcess input incident was completed past its body by the drain sweep (nano-bpm#1334).
    // KNOWN LIMITATION (fail-loud-only, nano-workforce#866): resolving this incident re-evaluates ONLY
    // this leaf's inputs — the subProcess-level config mappings (prompt/appendPrompt/nodeTimeout,
    // connector target/payload/dedupeKey) ran ONCE at subProcess entry and are NOT re-mapped on resolve.
    // The in-subprocess "Retry this step" loop does NOT help either: it loops directly back to the inner
    // service task (to reset the node-local scratch), bypassing the subProcess entry mappings, so it too
    // leaves the config null. Recovery therefore requires re-entering the sub-process from OUTSIDE —
    // relaunch/re-enter the node so its subProcess input mappings re-evaluate against the restored
    // `nodeInputs` — not merely resolving the incident or using "Retry this step". The incident message
    // says so. The correct fix is to run this check at sub-process ENTRY — Camunda parity, where a failed
    // sub-process input mapping parks in `activating` and resolving re-evaluates ALL inputs — which
    // nano-bpm#1336 restores; until then we fail loud here rather than risk the #1334 drain-past.
    `            <zeebe:input ${attr("source", nodeInputsPreflightFeel(el))} target="${NODE_INPUTS_PREFLIGHT_VAR}" />`,
    ...(contractGate !== undefined
      ? [`            <zeebe:output ${attr("source", agentContractProceedCondition(contractGate.requiredEmits))} target="${contractMetVar}" />`]
      : []),
    "          </zeebe:ioMapping>",
    "        </bpmn:extensionElements>",
  ];
  // The timeout escalation is resumable with the node's declared emits too: work finished out of band
  // (or a draft PR the stalled agent already opened) can be handed onward instead of threading null.
  // `nodeEmits` is the node's OWN declared emits (for an agent, the contract gate's emits; for a
  // connector, its own — a connector declares `emits` and its emit source is the fact's own name, so
  // keying off the absent agent-only gate would drop them and map no `value` on a Continue resume).
  const allEmits = nodeEmits;
  const contractEsc = contractEscalationTaskElement(el);
  const contractEmits = contractGate?.requiredEmits ?? [];
  const timeoutEscalation = escalationTaskLines(
    esc,
    nodeId,
    [`${el}_i2`],
    `${el}_i3`,
    `${escalationContextFeel(
      nodeId,
      descriptor,
      "nodeTimeout",
      "; in-flight work may already exist — check for a draft PR or partial state before retrying or reassigning.",
    )} + ${feelStr(escalationResolutionHint(nodeEmits, resumeEmits, isAgent))}`,
    {
      // #863 Retry + #876 Continue/validate, nested: the timeout escalation routes through a retry gate
      // (`retryElement`) and, on Continue with a required emit, a fail-closed validation gate
      // (`validTarget`) that re-parks a null/invalid value instead of threading it downstream.
      ...(resumeEmits.length > 0 ? { resume: { kind, emits: resumeEmits, declaredEmits: nodeEmits }, validTarget: `${el}_end` } : {}),
      displayName: taskName,
      retryElement: el,
      reservedTargets: reservedFlagTargets,
    },
  );
  const head = [
    `      <bpmn:startEvent id="${el}_start"><bpmn:outgoing>${el}_i0</bpmn:outgoing></bpmn:startEvent>`,
    `      <bpmn:serviceTask id="${el}_task" name="${escapeXml(taskName)}">`,
    ...taskExt,
    `        <bpmn:incoming>${el}_i0</bpmn:incoming>`,
    `        <bpmn:incoming>${el}_r1</bpmn:incoming>`,
    `        <bpmn:outgoing>${el}_i1</bpmn:outgoing>`,
    "      </bpmn:serviceTask>",
    `      <bpmn:boundaryEvent id="${el}_be" name="Node timed out" attachedToRef="${el}_task">`,
    `        <bpmn:outgoing>${el}_i2</bpmn:outgoing>`,
    `        <bpmn:timerEventDefinition id="${el}_ted"><bpmn:timeDuration xsi:type="bpmn:tFormalExpression">=nodeTimeout</bpmn:timeDuration></bpmn:timerEventDefinition>`,
    "      </bpmn:boundaryEvent>",
    ...timeoutEscalation,
  ];
  const timeoutResumable = resumeEmits.length > 0;
  const contractResumable = isAgent && contractEmits.length > 0;
  // #863 shared reset: both escalations' retry branches (`${esc}Rr` / `${contractEsc}Rr`) loop into ONE
  // reset-throw that clears the node-local scratch (including each escalation's resume-valid flag) then
  // re-enters the task. Per-escalation retry gates (built in `escalationTaskLines`) feed it, so a Continue
  // re-park knows WHICH escalation to return to while Retry is funnelled through this single reset.
  const resetFlagVars: string[] = [];
  if (timeoutResumable) resetFlagVars.push(escalationResumeFlagVar(esc, { kind, emits: resumeEmits }, reservedFlagTargets));
  if (contractResumable) resetFlagVars.push(escalationResumeFlagVar(contractEsc, { kind: "agent", emits: contractEmits }, reservedFlagTargets));
  const retryIncoming = [`${esc}Rr`, ...(isAgent ? [`${contractEsc}Rr`] : [])];
  const reset = retryResetLines(el, kind, allEmits, resetFlagVars, retryIncoming);

  if (contractGate === undefined) {
    return [
      ...head,
      ...reset,
      `      <bpmn:endEvent id="${el}_end"><bpmn:incoming>${el}_i1</bpmn:incoming><bpmn:incoming>${timeoutResumable ? `${esc}Vok` : `${esc}Rc`}</bpmn:incoming></bpmn:endEvent>`,
      flow(`${el}_i0`, `${el}_start`, `${el}_task`),
      flow(`${el}_i1`, `${el}_task`, `${el}_end`),
      flow(`${el}_i2`, `${el}_be`, esc),
      flow(`${el}_i3`, esc, `${esc}Rg`),
    ];
  }

  // Producer-contract gate (issue #731): task → gate → (proceed | contract-escalation) → end. When the
  // contract escalation is RESUMABLE (it grew a validation gate), its return flow `${el}_g2` routes to
  // the GATE (not straight to the end), and the gate's valid branch flows to the end (PR #876 review).
  const emits = contractEmits;
  const proceedCondition = `=${contractMetVar} = true`;
  const contractEscalation = escalationTaskLines(
    contractEsc,
    nodeId,
    [`${el}_g1`],
    `${el}_g2`,
    agentContractContextFeel(nodeId, descriptor, emits, nodeEmits),
    // Resumable when the producer owes a required emit: a human/agent supplies the missing fact, which
    // the subProcess output ioMapping then publishes as `<el>_<fact>` (agent emit source = fact name),
    // so the downstream consumer late-binds a real value instead of the null that poisoned it (#731) —
    // VALIDATED by the post-escalation gate (`validTarget`) so an omitted/malformed value re-parks
    // instead of threading null downstream (PR #876 review), and routed through the retry gate
    // (`retryElement`) so Retry resets+reruns the node (#863).
    { ...(contractResumable ? { resume: { kind: "agent" as const, emits, declaredEmits: nodeEmits }, validTarget: `${el}_end` } : {}), displayName: taskName, retryElement: el, reservedTargets: reservedFlagTargets },
  );
  return [
    ...head,
    `      <bpmn:exclusiveGateway id="${el}_gate" name="producer contract met?" default="${el}_g1">`,
    `        <bpmn:incoming>${el}_i1</bpmn:incoming>`,
    `        <bpmn:outgoing>${el}_g0</bpmn:outgoing>`,
    `        <bpmn:outgoing>${el}_g1</bpmn:outgoing>`,
    "      </bpmn:exclusiveGateway>",
    ...contractEscalation,
    ...reset,
    `      <bpmn:endEvent id="${el}_end"><bpmn:incoming>${el}_g0</bpmn:incoming><bpmn:incoming>${timeoutResumable ? `${esc}Vok` : `${esc}Rc`}</bpmn:incoming><bpmn:incoming>${contractResumable ? `${contractEsc}Vok` : `${contractEsc}Rc`}</bpmn:incoming></bpmn:endEvent>`,
    flow(`${el}_i0`, `${el}_start`, `${el}_task`),
    flow(`${el}_i1`, `${el}_task`, `${el}_gate`),
    `      <bpmn:sequenceFlow id="${el}_g0" name="contract met" sourceRef="${el}_gate" targetRef="${el}_end"><bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">${proceedCondition}</bpmn:conditionExpression></bpmn:sequenceFlow>`,
    `      <bpmn:sequenceFlow id="${el}_g1" name="contract broken" sourceRef="${el}_gate" targetRef="${contractEsc}" />`,
    flow(`${el}_g2`, contractEsc, `${contractEsc}Rg`),
    flow(`${el}_i2`, `${el}_be`, esc),
    flow(`${el}_i3`, esc, `${esc}Rg`),
  ];
}

/** The operator-facing "how do I resolve this" sentence appended to a service node's escalation
 * prompt (retry-node resolution): every escalation names its two exits so the task is actionable on
 * its own, without reading the BPMN. */
function escalationResolutionHint(nodeEmits: readonly DeliveryFact[], resumeEmits: readonly DeliveryFact[], isAgent: boolean): string {
  const retry =
    ` To resolve: choose Resolution "Retry this step" (${ESCALATION_DECISION_VAR}="${ESCALATION_DECISION_RETRY}") to re-run this node` +
    (isAgent ? " — the note is passed to the agent as guidance for the retry" : "");
  // Mirror the compiled topology (escalationTaskLines): a value-resumable Continue is offered ONLY when
  // the node declares EXACTLY ONE emit AND that emit is the required resume target. Gating on the
  // required count alone would promise a value field a node declaring two facts (one required) never
  // renders (issue #863 review, thread r4193902690).
  const names = (fs: readonly DeliveryFact[]): string => fs.map((e) => `'${e.name}'`).join("/");
  let proceed: string;
  if (nodeEmits.length === 1 && resumeEmits.length === 1) {
    proceed = `; or choose "Continue" and put the '${resumeEmits[0].name}' value in the value field (e.g. work finished out of band)`;
  } else if (nodeEmits.length > 1 && resumeEmits.length >= 1) {
    // A multi-declared node that still owes ≥1 REQUIRED emit: the resume-valid flag is hard-`false`, so
    // the post-escalation validation gate ALWAYS re-parks — Continue loops back HERE, it does NOT write
    // nulls or advance to a fallback branch (deliveryGraphCompiler.ts fail-closed loop; #863 review
    // r4194186490/r4194186441). Only "Retry this step" can produce the facts.
    proceed = `; "Continue" CANNOT resume this node and does NOT advance — the single value field cannot supply its ${names(nodeEmits)} facts, so it re-parks HERE until you choose "Retry this step" to actually produce them`;
  } else if (nodeEmits.length > 1) {
    // Multi-declared but NO required resume target downstream: the escalation is not validation-gated, so
    // Continue genuinely proceeds past the node to its default (fallback) branch.
    proceed = `; or choose "Continue" to proceed past this node to its default (fallback) branch — no downstream node requires its ${names(nodeEmits)} facts, and the single value field cannot supply them anyway`;
  } else {
    proceed = '; or choose "Continue" to proceed past this node';
  }
  return `${retry}${proceed}.`;
}

/** Grow a node-unique ROOT control var (`<el>_contractMet` / `<el>_retryRequested`) collision-free
 * (deterministic trailing `_`) against the node-local emit SOURCE vars ({@link factSourceVar}) that
 * share this node's flat subProcess scope. These controls are decided INSIDE the node's scope yet must
 * be READ by the OUTER gateways (Nano evaluates exclusive-gateway conditions against the ROOT vars
 * only), so they are published at root. But an emit whose source var equals the bare control name
 * (e.g. an agent emit literally named `n0_contractMet` on the first node `n0`, whose source var IS its
 * own name) is ALSO null-seeded node-local by {@link ioMappingLines} — and Nano's nearest-scope
 * propagation then writes the gate/escalation output into that LOCAL shadow instead of the root the
 * outer gateway reads, so the gateway never sees `true` and the producer can never pass (issue #863
 * review, thread r4199435326). Growing the control name clear of every emit source var removes the
 * whole class, exactly as {@link escalationResumeFlagVar} grows the resume-valid flag. */
function nodeControlVar(el: string, suffix: string, reservedTargets: readonly string[]): string {
  const reserved = new Set<string>(reservedTargets);
  let name = `${el}_${suffix}`;
  while (reserved.has(name)) name = `${name}_`;
  return name;
}

/** The node-unique ROOT boolean an escalation completion publishes for the retry gateway (see the
 * gateway-scope note in {@link serviceBodyLines}), grown collision-free ({@link nodeControlVar})
 * against the node's emit source vars so a same-named emit can neither shadow nor collide with it. The
 * SAME `reservedTargets` must be passed at the write and read sites so the grown name agrees. */
function retryRequestedVar(el: string, reservedTargets: readonly string[] = []): string {
  return nodeControlVar(el, "retryRequested", reservedTargets);
}

/** The retry-node resolution RESET shared by a service node's escalations (`__esc`, and an agent's
 * `__contract`): their per-escalation retry gates (built in {@link escalationTaskLines}) each loop
 * `─retry→` this single reset, which clears the node-local scratch then re-enters the task (`_r1`). The
 * reset (a none intermediate throw event carrying output mappings only — the compiler never emits a
 * scriptTask) clears the node-local decision and the previous attempt's emits (a rerun that succeeds
 * may report no status at all; a stale emit would otherwise be republished downstream) — plus, for an
 * agent, its FULL declared result set (every {@link AGENT_RESULT_LOCAL_VARS} field, so a stale
 * `blocked` status can't fail the contract gate again and a stale `transcriptUrl`/PR alias/other
 * optional field can't republish downstream) — plus each escalation's resume-valid flag
 * (`resumeFlagVars`, so a Retry can never leave a stale `true` that the next Continue's validation gate
 * would read) — and appends the operator's {@link ESCALATION_NOTE_VAR} to the agent prompt as retry
 * guidance. All targets are node-local (declared on the subProcess by `ioMappingLines`), so nothing
 * leaks to the root. `incoming` is each feeding escalation's retry branch (`${esc}Rr`). */
function retryResetLines(el: string, kind: "agent" | "connector", emits: readonly DeliveryFact[], resumeFlagVars: readonly string[], incoming: readonly string[]): string[] {
  const isAgent = kind === "agent";
  const outputs: { source: string; target: string }[] = [];
  // Clear the node's declared emits for ANY emitting kind (agent or connector) so a retry never
  // republishes a stale value; for an agent, also clear the FULL declared result set
  // (AGENT_RESULT_LOCAL_VARS — every field declared node-local, not just the five self-reported status
  // fields) so a retried worker that omits an optional field (transcriptUrl, agentCheckpoint, a PR
  // alias, exitCode, …) cannot let the previous attempt's value republish downstream or surface in the
  // next escalation. For a connector, clear its fixed result metadata (CONNECTOR_RESULT_LOCAL_VARS) for
  // the same reason. The status/summary fields and prompt-guidance are agent-specific (a connector has
  // no self-reported status contract or prompt).
  const cleared = new Set<string>(isAgent ? AGENT_RESULT_LOCAL_VARS : CONNECTOR_RESULT_LOCAL_VARS);
  for (const f of emits) cleared.add(factSourceVar(kind, f));
  // Clear each escalation's resume-valid flag too (PR #876 flag × #863 retry): a Retry resets the
  // node-local scratch, so a stale `true` can never survive into the next Continue's validation gate.
  for (const v of resumeFlagVars) cleared.add(v);
  for (const v of cleared) outputs.push({ source: "=null", target: v });
  if (isAgent) {
    // Read the OPERATOR's note from the escalation-specific `escalationNote` control — NEVER the plain
    // `note`: `note` is a documented WORKER RESULT field (resources/prompts/plan.md returns one) that
    // nearest-scope propagation lands in this same subProcess scope, so reading it here would feed a
    // worker-produced note back to the agent as "Operator guidance" whenever the operator retries
    // WITHOUT a note (the form permits omitting it) — PR #863 Copilot "Previously missed".
    const hasNote = `(is defined(${ESCALATION_NOTE_VAR}) and ${ESCALATION_NOTE_VAR} != null and string(${ESCALATION_NOTE_VAR}) != "")`;
    // Re-derive from the RUNNER-SEEDED BASELINE (`nodeInputs.<el>.appendPrompt`), never the live
    // `appendPrompt`: the subProcess input seeds `appendPrompt` from `nodeInputs` only at subProcess
    // ENTRY, so on a retry re-entry the task still reads this var as the last reset left it — building
    // on the live value would carry the previous retry's note forward and ACCUMULATE one stale
    // "Operator guidance…" paragraph per consecutive retry.
    const seeded = `nodeInputs.${el}.appendPrompt`;
    const base = `(if (is defined(${seeded}) and ${seeded} != null) then ${seeded} + "\n\n" else "")`;
    outputs.push({
      source: `=if ${hasNote} then ${base} + "Operator guidance for this retry: " + string(${ESCALATION_NOTE_VAR}) else (if (is defined(${seeded})) then ${seeded} else null)`,
      target: "appendPrompt",
    });
  }
  // Clear the escalation controls (ESCALATION_LOCAL_VARS = decision/value/escalationNote), derived from
  // the ONE source so a renamed control can't drift a second hardcoded list. These are declared
  // node-local by ioMappingLines for BOTH kinds (agent and connector), so each clear lands in this
  // subProcess scope, never the shared root.
  //
  // Do NOT clear the plain `note` here. `note` is a WORKER RESULT field that is node-local ONLY for an
  // agent (it is in AGENT_RESULT_LOCAL_VARS, so the `cleared` result-set loop above already resets it on
  // an agent retry). A connector does NOT declare `note` node-local (CONNECTOR_RESULT_LOCAL_VARS omits
  // it, and it is neither an escalation control nor a connector emit), so an unconditional `note = null`
  // here would land at the SHARED ROOT — leaking null across the node-isolation boundary and clobbering a
  // parallel node's `note` — while for an agent it merely duplicates the `cleared` loop's reset
  // (deliveryGraphCompiler.ts:2181, PR #863 Copilot "Previously missed").
  for (const v of ESCALATION_LOCAL_VARS) outputs.push({ source: "=null", target: v });
  return [
    `      <bpmn:intermediateThrowEvent id="${el}_retry" name="Reset for retry">`,
    "        <bpmn:extensionElements>",
    "          <zeebe:ioMapping>",
    ...outputs.map((o) => `            <zeebe:output ${attr("source", o.source)} target="${o.target}" />`),
    "          </zeebe:ioMapping>",
    "        </bpmn:extensionElements>",
    ...incoming.map((id) => `        <bpmn:incoming>${id}</bpmn:incoming>`),
    `        <bpmn:outgoing>${el}_r1</bpmn:outgoing>`,
    "      </bpmn:intermediateThrowEvent>",
    flow(`${el}_r1`, `${el}_retry`, `${el}_task`),
  ];
}

/** The node-unique internal resume-valid flag ({@link resumeValidVar}) an escalation publishes for its
 * post-escalation validation gate, GROWN collision-free (deterministic trailing `_`) against every
 * declared emit's source var (`reservedTargets`) plus the resumed required emits (PR #876 review). The
 * SAME computation must run in both {@link escalationTaskLines} (writer + gate condition) and the
 * {@link retryResetLines} reset (clear), so it lives in one shared helper. Returns `""` for a
 * non-resumable escalation (no flag). */
function escalationResumeFlagVar(
  esc: string,
  resume: { kind: DeliveryNode["kind"]; emits: readonly DeliveryFact[] } | undefined,
  reservedTargets: readonly string[],
): string {
  if (resume === undefined || resume.emits.length === 0) return "";
  const reserved = new Set<string>(reservedTargets);
  for (const f of resume.emits) reserved.add(factSourceVar(resume.kind, f));
  let flag = resumeValidVar(esc);
  while (reserved.has(flag)) flag = `${flag}_`;
  return flag;
}

/** `wait` body: `start → pr.readiness-probe (poll) → ready? → end`, escalating on not-ready or on the
 * `=probeTimeout` engine bound. The probe polls its OWN target, so an unrelated upstream event can
 * never flip it to ready (#274/S2 concurrency-correctness); the `pr` kind (S2) binds `mergedSha`. */
function waitBodyLines(el: string, node: Extract<DeliveryNode, { kind: "wait" }>, displayName: string): string[] {
  const nodeId = node.id;
  const name = escapeXml(displayName);
  const esc = escalationTaskElement(el, "wait");
  const emits = normaliseEmits(node);
  // `onTimeout` routing (#462): `escalate` (default) parks the not-ready-at-boundary token on a
  // human-completable escalation task; `continue` proceeds past the gate as not-ready WITHOUT a human
  // stop (a documented sharp edge — the downstream side-effecting node then runs without the awaited
  // fact). `fail` is rejected earlier at validation (blocked on engine terminate-end, #978), so it
  // never reaches here.
  //
  // NORMALISE (trim) `onTimeout` before the topology decision — `parseProbe` trims it
  // (`str(raw.onTimeout).trim()`) and the display/digest path uses `trimmedOrEmpty(p.onTimeout)`, so a
  // padded `" continue "` runs the SAME `continue` routing at the worker. Comparing the RAW value here
  // would emit the escalation branch for a `" continue "` the runtime treats as continue — the compiled
  // topology diverging from the requested (and digested) behaviour (issue #778 review — thread
  // deliveryGraphCompiler.ts:2012).
  const continueOnTimeout = trimmedOrEmpty(node.wait?.onTimeout) === "continue";
  // When the escalation is RESUMABLE (it grew a validation gate), its return flow `_i5` routes to the
  // GATE (not straight to the end) and the gate's valid branch flows to the end (PR #876 review).
  // Only a SINGLE-emit wait is genuinely value-resumable: the single escalation-form `value` field
  // cannot supply >1 distinct fact, and a wait gate has no Retry escape, so a MULTI-emit wait grows NO
  // validation gate (building one would wedge the token in an unresolvable loop — issue #863 review
  // r4198123619). A multi-emit (or no-emit) wait escalation therefore flows `_i5` straight to the node
  // end — an acknowledged, value-less continue — the same path as a no-emit wait.
  const waitResumed = !continueOnTimeout && emits.length === 1;
  // Defect A: read-only probe diagnostics seeded onto the escalation task so the operator/agent can
  // tell a genuine "not published yet" from a transient false-negative — the probe's last detail, the
  // resolved target/match, and a compact summary of the candidate releases the probe observed.
  const diagnosticInputs = [
    { source: "=if (is defined(detail)) then detail else null", target: "probeDetail" },
    { source: "=if (is defined(observed)) then observed else null", target: "observedReleases" },
    { source: `=if (is defined(probe.target)) then probe.target else nodeInputs.${el}.probe.target`, target: "probeTarget" },
    { source: `=nodeInputs.${el}.probe.match`, target: "probeMatch" },
  ];
  return [
    `      <bpmn:startEvent id="${el}_start"><bpmn:outgoing>${el}_i0</bpmn:outgoing></bpmn:startEvent>`,
    `      <bpmn:subProcess id="${el}_probeLoop" name="Probe readiness loop: ${name}">`,
    "        <bpmn:extensionElements>",
    "          <zeebe:ioMapping>",
    '            <zeebe:output source="=ready" target="ready" />',
    '            <zeebe:output source="=if (is defined(detail)) then detail else null" target="detail" />',
    '            <zeebe:output source="=if (is defined(resolvedArtifact)) then resolvedArtifact else null" target="resolvedArtifact" />',
    '            <zeebe:output source="=if (is defined(mergedSha)) then mergedSha else null" target="mergedSha" />',
    '            <zeebe:output source="=if (is defined(prCount)) then prCount else null" target="prCount" />',
    '            <zeebe:output source="=if (is defined(observed)) then observed else null" target="observed" />',
    "          </zeebe:ioMapping>",
    "        </bpmn:extensionElements>",
    `        <bpmn:incoming>${el}_i0</bpmn:incoming>`,
    `        <bpmn:outgoing>${el}_i1</bpmn:outgoing>`,
    `        <bpmn:startEvent id="${el}_loopStart"><bpmn:outgoing>${el}_li0</bpmn:outgoing></bpmn:startEvent>`,
    `        <bpmn:serviceTask id="${el}_task" name="Probe readiness: ${name}">`,
    "          <bpmn:extensionElements>",
    `            <zeebe:taskDefinition type="${DELEGATE_TASK_TYPE.wait}" />`,
    "            <zeebe:properties>",
    '              <zeebe:property name="io.nanobpm.dataEnvelope.in" value="ReadinessProbeIn" />',
    '              <zeebe:property name="io.nanobpm.dataEnvelope.out" value="ReadinessProbeOut" />',
    "            </zeebe:properties>",
    "          </bpmn:extensionElements>",
    `          <bpmn:incoming>${el}_li0</bpmn:incoming>`,
    `          <bpmn:incoming>${el}_li4</bpmn:incoming>`,
    `          <bpmn:outgoing>${el}_li1</bpmn:outgoing>`,
    "        </bpmn:serviceTask>",
    `        <bpmn:exclusiveGateway id="${el}_gw" name="ready?" default="${el}_li3">`,
    `          <bpmn:incoming>${el}_li1</bpmn:incoming>`,
    `          <bpmn:outgoing>${el}_li2</bpmn:outgoing>`,
    `          <bpmn:outgoing>${el}_li3</bpmn:outgoing>`,
    "        </bpmn:exclusiveGateway>",
    `        <bpmn:intermediateCatchEvent id="${el}_waitPoll" name="Wait poll interval">`,
    `          <bpmn:incoming>${el}_li3</bpmn:incoming>`,
    `          <bpmn:outgoing>${el}_li4</bpmn:outgoing>`,
    `          <bpmn:timerEventDefinition id="${el}_pollTed"><bpmn:timeDuration xsi:type="bpmn:tFormalExpression">=probePollEvery</bpmn:timeDuration></bpmn:timerEventDefinition>`,
    "        </bpmn:intermediateCatchEvent>",
    `        <bpmn:endEvent id="${el}_loopEnd"><bpmn:incoming>${el}_li2</bpmn:incoming></bpmn:endEvent>`,
    flow(`${el}_li0`, `${el}_loopStart`, `${el}_task`),
    flow(`${el}_li1`, `${el}_task`, `${el}_gw`),
    `      <bpmn:sequenceFlow id="${el}_li2" name="ready" sourceRef="${el}_gw" targetRef="${el}_loopEnd"><bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">=ready = true</bpmn:conditionExpression></bpmn:sequenceFlow>`,
    `        <bpmn:sequenceFlow id="${el}_li3" name="not ready" sourceRef="${el}_gw" targetRef="${el}_waitPoll" />`,
    flow(`${el}_li4`, `${el}_waitPoll`, `${el}_task`),
    "      </bpmn:subProcess>",
    `      <bpmn:boundaryEvent id="${el}_be" name="Gate timed out" attachedToRef="${el}_probeLoop">`,
    `        <bpmn:outgoing>${el}_i2</bpmn:outgoing>`,
    `        <bpmn:timerEventDefinition id="${el}_ted"><bpmn:timeDuration xsi:type="bpmn:tFormalExpression">=probeTimeout</bpmn:timeDuration></bpmn:timerEventDefinition>`,
    "      </bpmn:boundaryEvent>",
    `      <bpmn:serviceTask id="${el}_lastAttempt" name="Probe readiness at boundary: ${name}">`,
    "        <bpmn:extensionElements>",
    `          <zeebe:taskDefinition type="${DELEGATE_TASK_TYPE.wait}" />`,
    "          <zeebe:properties>",
    '            <zeebe:property name="io.nanobpm.dataEnvelope.in" value="ReadinessProbeIn" />',
    '            <zeebe:property name="io.nanobpm.dataEnvelope.out" value="ReadinessProbeOut" />',
    "          </zeebe:properties>",
    "          <zeebe:ioMapping>",
    '            <zeebe:input source="=true" target="lastAttempt" />',
    "          </zeebe:ioMapping>",
    "        </bpmn:extensionElements>",
    `        <bpmn:incoming>${el}_i2</bpmn:incoming>`,
    `        <bpmn:outgoing>${el}_i6</bpmn:outgoing>`,
    "      </bpmn:serviceTask>",
    `      <bpmn:exclusiveGateway id="${el}_lastGw" name="ready after boundary?" default="${el}_i4">`,
    `        <bpmn:incoming>${el}_i6</bpmn:incoming>`,
    `        <bpmn:outgoing>${el}_i7</bpmn:outgoing>`,
    `        <bpmn:outgoing>${el}_i4</bpmn:outgoing>`,
    "      </bpmn:exclusiveGateway>",
    ...(continueOnTimeout
      ? []
      : escalationTaskLines(
          esc,
          nodeId,
          [`${el}_i4`],
          `${el}_i5`,
          waitEscalationContextFeel(nodeId),
          // A resumed wait-gate escalation is VALIDATED by the post-escalation gate (`validTarget`) so
          // an omitted/malformed operator value re-parks instead of threading null onto the emit the
          // downstream consumer binds (PR #876 review). Only a SINGLE-emit wait is value-resumable, so
          // `validTarget` (and the gate it drives) is provided ONLY then — a multi-emit wait has no
          // escapable resume and so grows no gate (issue #863 review r4198123619).
          { resume: { kind: node.kind, emits }, diagnosticInputs, displayName, reservedTargets: emits.map((f) => factSourceVar(node.kind, f)), ...(emits.length === 1 ? { validTarget: `${el}_end` } : {}) },
        )),
    // On `continue`, the not-ready-at-boundary branch (`_i4`) proceeds straight to the node end (no
    // human stop, no `_i5` escalation-return flow); on `escalate` it parks on the escalation task,
    // which returns via `_i5`. A RESUMABLE escalation routes `_i5` to its validation gate (not straight
    // to the end), so a value-less/invalid resume can never bypass the gate (PR #876 review).
    `      <bpmn:endEvent id="${el}_end"><bpmn:incoming>${el}_i1</bpmn:incoming>${continueOnTimeout ? `<bpmn:incoming>${el}_i4</bpmn:incoming>` : waitResumed ? `<bpmn:incoming>${esc}Vok</bpmn:incoming>` : `<bpmn:incoming>${el}_i5</bpmn:incoming>`}<bpmn:incoming>${el}_i7</bpmn:incoming></bpmn:endEvent>`,
    flow(`${el}_i0`, `${el}_start`, `${el}_probeLoop`),
    flow(`${el}_i1`, `${el}_probeLoop`, `${el}_end`),
    flow(`${el}_i2`, `${el}_be`, `${el}_lastAttempt`),
    flow(`${el}_i6`, `${el}_lastAttempt`, `${el}_lastGw`),
    `      <bpmn:sequenceFlow id="${el}_i7" name="ready" sourceRef="${el}_lastGw" targetRef="${el}_end"><bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">=ready = true</bpmn:conditionExpression></bpmn:sequenceFlow>`,
    `      <bpmn:sequenceFlow id="${el}_i4" name="not ready" sourceRef="${el}_lastGw" targetRef="${continueOnTimeout ? `${el}_end` : esc}" />`,
    ...(continueOnTimeout ? [] : [flow(`${el}_i5`, esc, waitResumed ? `${esc}Vg` : `${el}_end`)]),
  ];
}

/** `human` body: the S3 scheduled user-task (`delivery-human-task__<el>`) + generic form + assignment
 * + SLA. On completion the form's captured typed value is output (`humanEmitValue`/`humanEmitArtifact`
 * — the subProcess ioMapping then publishes it as the node's fact); on SLA expiry the node records an
 * `escalated` outcome and settles (bounded — the graph cannot silently wedge). Mirrors the standalone
 * `delivery-human.bpmn` shape, reusing the S3 form + emit-var contract (`deliveryHuman.ts`).
 *
 * `singleEmit` (the node's ONE declared fact, when it declares exactly one) lets a bespoke explicit
 * form capture its value under the FACT'S OWN NAME — the same precedence `bindHumanEmits` honours
 * (fact name first, then the canonical `value`/`resolvedArtifact` keys). The userTask output source
 * therefore prefers `<factName>` and falls back to the canonical control, so a custom form keyed on the
 * fact (`{ approval: "yes" }` for an `approval` emit) publishes its value instead of NULL, while the
 * generic/publish/ack forms (which capture `value`/`resolvedArtifact`) are unaffected (PR #863 review,
 * thread deliveryGraphCompiler.ts:1929). Fact names are `FACT_NAME_PATTERN`-constrained
 * (`[A-Za-z_][A-Za-z0-9_]*`), so the name embeds safely as a FEEL identifier. The selected value is then
 * COERCED/VALIDATED to the emit's declared type via {@link coerceFactValueFeel} (the same typed-binding
 * contract the escalation resume uses), so a bespoke `boolean`/`number` form publishes a real FEEL
 * boolean/number — not the raw string `"true"`/`"1"` that a downstream guarded split (`= true`/`= 1`)
 * would never match (PR #863 thread r4189815989). */
function humanBodyLines(el: string, displayName: string, formId: string, singleEmit?: DeliveryFact, preferFactName = false, requiredEmit = false): string[] {
  const task = humanTaskElement(el);
  const assignee =
    '=if (is defined(escalationAssignee) and escalationAssignee != null and trim(string(escalationAssignee)) != "") then escalationAssignee else null';
  // The canonical capture key for the single emit's TYPE (artifact → the publish form's
  // `resolvedArtifact`; anything else → the generic form's `value`). `selectExpr(canonical)` is a bare
  // (no leading `=`) null-safe FEEL expression; when `preferFactName` (an EXPLICIT bespoke form only) it
  // reads `<factName>` first, then the canonical control — a built-in form's fixed control otherwise.
  // The fact-named read is STRINGABILITY-guarded (`string(<factName>) != null`) because `is defined(X)`
  // is TRUE and `X != null` holds for a FEEL BUILTIN function (`count`, `sum`, …) when a blank form
  // leaves no task variable of that name — so a bare presence guard would SELECT the builtin FUNCTION as
  // the `then` arm for the emit. The number/boolean coercers reject a non-stringable operand, but the text
  // types (`string`/`version`/`url`/`pr`) pass the selection through verbatim and the artifact source is
  // never coerced, so without this guard those fact types would select the builtin function rather than
  // fall back to the canonical control / null. On the pinned WASM engine a function-valued selection is
  // itself folded to null before it can be published (a FEEL variable binding cannot hold a function), so
  // the guard is defence-in-depth THERE — but it is NOT a no-op: it makes the null-fold explicit and
  // engine-independent (an engine that published the function instead would corrupt the fact or incident
  // on the downstream io-mapping), and it is what the compiler-level FEEL assertion in
  // `deliveryGraphCompiler.test.ts` pins red-before/green-after. `string(<builtin>)` folds to null, so the
  // guard falls back to the canonical control / null; a real captured TEXT value stringifies to itself and
  // is still selected. The guard sits ONLY on the fact-named candidate — the canonical `resolvedArtifact`
  // object in the else arm is untouched, so a genuine object handle still passes through (Copilot review
  // #863, "Guard fact names that shadow FEEL builtins").
  const selectExpr = (canonical: string): string =>
    singleEmit !== undefined && preferFactName
      ? `if (is defined(${singleEmit.name}) and ${singleEmit.name} != null and string(${singleEmit.name}) != null) then ${singleEmit.name} else if (is defined(${canonical})) then ${canonical} else null`
      : `if (is defined(${canonical})) then ${canonical} else null`;
  // A form captures the selected value as TEXT (a textfield, or an explicit form's fact-named control), so
  // the non-artifact single emit must be VALIDATED against the fact's declared type AND COERCED to it
  // before writing `humanEmitValue` — the SAME type-aware, fail-closed contract the escalation resume
  // enforces. That contract is absorbed into {@link coerceFactValueFeel}, whose per-type arm now VALIDATES
  // (not merely coerces) the selection: `boolean`/`number` already failed closed on an unparseable entry,
  // and `string`/`version`/`url`/`pr` now fail closed on a value that does not match the declared type's
  // grammar — so a generic/custom form can no longer publish a blank string, a malformed version/URL, or an
  // invalid PR ref directly downstream (PR #863 review 5430718031, "Validate human-task fact values before
  // publishing"). (The validity test is folded INTO the coercion's single `if` rather than wrapped in an
  // outer `if (resumeValueCondition(…)) then …` because the pinned engine mis-evaluates a nested
  // `if…then…else` selection inside that outer guard — verified engine-native: valid entries routed to the
  // default branch. Folding the check into the one `if` keeps the working single-level shape.)
  const valueSource =
    singleEmit !== undefined && singleEmit.type !== "artifact"
      ? `=${coerceFactValueFeel(singleEmit, selectExpr("value"))}`
      : "=if (is defined(value)) then value else null";
  // The artifact source is likewise VALIDATED before publish: the publish form's `required` rule checks
  // only PRESENCE, so a value like `not-an-artifact` was accepted and propagated downstream despite the
  // canonical `pkg@version` handle contract (PR #863 review 5430718031, "Validate human artifact handles
  // before publishing"). Gate it on the SAME artifact grammar the escalation resume enforces
  // (`resumeValueCondition`'s artifact arm — scoped-package aware), fail closed to null. An artifact handle
  // is a text reference, so the valid arm publishes the selection verbatim (no coercion). The guard is a
  // FLAT `matches(trim(string(…)))` on the selection — NOT `resumeValueCondition`'s full form, whose
  // `is defined(<nested if…else>)` presence conjunct the pinned engine mis-evaluates when the selection is
  // a compound `if…then…else` (verified engine-native: a valid handle routed to null). `string(…) != null`
  // is the null-safe presence/stringability test; `matches()` is null-safe (a non-match yields false).
  const artifactSource =
    singleEmit !== undefined && singleEmit.type === "artifact"
      ? (() => {
          const sel = selectExpr("resolvedArtifact");
          const s = `string(${sel})`;
          return `=if (${s} != null and matches(trim(${s}), "^@?[^@\\\\s]+@v?\\\\d[\\\\w.+-]*$") = true) then ${sel} else null`;
        })()
      : "=if (is defined(resolvedArtifact)) then resolvedArtifact else null";
  // FAIL-CLOSED COMPLETION GATE (PR #863 review, thread r4198662345): a human node whose single emit is a
  // downstream-REQUIRED fact must not publish an invalid (null-coerced) value onward — the edge to the
  // consumer is unconditional and a human node has no worker contract gate or Retry path, so a null here
  // activates the consumer with a null required fact. Mirror the escalation resume's fail-closed shape:
  // the task's OWN output mapping computes a validity flag from the SAME `selectExpr` SELECTION the emit
  // publishes (so an explicit bespoke form's fact-named control is validated, not a bare always-absent
  // field) via {@link resumeValueCondition} (the SAME per-type grammar the escalation resume enforces —
  // presence included, so a blank required entry is invalid too), and a post-task exclusive gateway routes
  // a VALID completion to the node end while an INVALID one loops back to the human task for re-entry (the
  // human analogue of a re-park — a human node has no separate escalation twin to re-park onto). The flag is
  // the node-unique, collision-free {@link resumeValidVar} (the emit source is the fixed `humanEmitValue`/
  // `humanEmitArtifact`, never the fact's own name, so the generated flag can never collide with it).
  // Grown ONLY when the single emit is required — a routing-only/unconsumed emit keeps the direct
  // `task → end` flow (a routing-only null just takes a guarded split's deadlock-safe default, exactly
  // like the escalation resume's no-required-target case). The gateway routes on the SIMPLE
  // `<flag> = true` boolean (a gateway ioMapping is not visible downstream in the pinned engine —
  // verified — so the validity is computed here on the task output, not on the gateway).
  const gateRequired = requiredEmit && singleEmit !== undefined;
  const flagVar = resumeValidVar(task);
  // The completion-validity flag MUST validate the SAME selection the emit publishes (`selectExpr`), not
  // the BARE canonical control: for an EXPLICIT bespoke form (`preferFactName`) the emit reads the
  // fact-named control (`<singleEmit.name>`) FIRST, so a flag keyed on the bare `value`/`resolvedArtifact`
  // would read an always-undefined field and reject a GENUINELY VALID explicit-form completion forever —
  // the gateway's `_cbad` default re-parks the human every round until the SLA escalates (a correct human
  // answer could never complete an explicit-form required-emit node). Mirror the emit's selection and feed
  // it to `resumeValueCondition` with a FLAT `string(sel) != null` presence override — NOT the default
  // `is defined(<compound>)` presence, which the pinned engine mis-evaluates on a compound
  // `if…then…else` selection (the same reason `artifactSource` uses a flat `matches(trim(string(…)))`).
  const validitySource = (() => {
    if (singleEmit === undefined) return "=false";
    const sel = selectExpr(singleEmit.type === "artifact" ? "resolvedArtifact" : "value");
    return `=if ${resumeValueCondition(singleEmit, sel, `string(${sel}) != null`)} then true else false`;
  })();
  const endEvent = `      <bpmn:endEvent id="${el}_end"><bpmn:incoming>${gateRequired ? `${el}_cok` : `${el}_i1`}</bpmn:incoming></bpmn:endEvent>`;
  const completionGate: string[] = gateRequired
    ? [
        `      <bpmn:exclusiveGateway id="${el}_cg" name="required fact valid?" default="${el}_cbad">`,
        `        <bpmn:incoming>${el}_i1</bpmn:incoming>`,
        `        <bpmn:outgoing>${el}_cok</bpmn:outgoing>`,
        `        <bpmn:outgoing>${el}_cbad</bpmn:outgoing>`,
        "      </bpmn:exclusiveGateway>",
        `      <bpmn:sequenceFlow id="${el}_cok" name="valid" sourceRef="${el}_cg" targetRef="${el}_end"><bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">=${flagVar} = true</bpmn:conditionExpression></bpmn:sequenceFlow>`,
        `      <bpmn:sequenceFlow id="${el}_cbad" name="invalid — re-enter" sourceRef="${el}_cg" targetRef="${task}" />`,
      ]
    : [];
  return [
    `      <bpmn:startEvent id="${el}_start"><bpmn:outgoing>${el}_i0</bpmn:outgoing></bpmn:startEvent>`,
    `      <bpmn:userTask id="${task}" name="Delivery: human step — ${escapeXml(displayName)}">`,
    "        <bpmn:extensionElements>",
    // `formId` is the node's RESOLVED form key, which for an explicit `human.formKey` is OPERATOR-SUPPLIED
    // text — render it through `attr()` (which switches to a single-quote delimiter when the value contains
    // a `"`) so a quote-bearing key can never break out of the attribute and inject BPMN. Authoring-time
    // validation (`deliveryGraph.ts`) additionally rejects a URL-/credential-/control-char-bearing formKey
    // before it ever reaches here, so this is defence in depth, not the only gate.
    `          <zeebe:formDefinition ${attr("formId", formId)} />`,
    "          <zeebe:userTask />",
    `          <zeebe:assignmentDefinition candidateGroups="operators" ${attr("assignee", assignee)} />`,
    "          <zeebe:ioMapping>",
    `            <zeebe:output ${attr("source", '="completed"')} target="humanOutcome" />`,
    `            <zeebe:output ${attr("source", valueSource)} target="humanEmitValue" />`,
    `            <zeebe:output ${attr("source", artifactSource)} target="humanEmitArtifact" />`,
    `            <zeebe:output ${attr("source", "=if (is defined(note)) then note else null")} target="humanNote" />`,
    // The completion-gate validity flag — computed from the SAME `selectExpr` selection the emit uses, so
    // it is independent of the (already fail-closed) coerced `humanEmitValue`/`humanEmitArtifact` above and
    // routes the gateway.
    ...(gateRequired ? [`            <zeebe:output ${attr("source", validitySource)} target="${flagVar}" />`] : []),
    "          </zeebe:ioMapping>",
    "        </bpmn:extensionElements>",
    `        <bpmn:incoming>${el}_i0</bpmn:incoming>`,
    // The invalid completion loops back to re-enter this task (re-park for a value correction).
    ...(gateRequired ? [`        <bpmn:incoming>${el}_cbad</bpmn:incoming>`] : []),
    `        <bpmn:outgoing>${el}_i1</bpmn:outgoing>`,
    "      </bpmn:userTask>",
    `      <bpmn:boundaryEvent id="${el}_sla" name="SLA elapsed" attachedToRef="${task}">`,
    `        <bpmn:outgoing>${el}_i2</bpmn:outgoing>`,
    `        <bpmn:timerEventDefinition id="${el}_ted"><bpmn:timeDuration xsi:type="bpmn:tFormalExpression">=escalationSlaTimeout</bpmn:timeDuration></bpmn:timerEventDefinition>`,
    "      </bpmn:boundaryEvent>",
    endEvent,
    `      <bpmn:endEvent id="${el}_escEnd" name="Escalated">`,
    "        <bpmn:extensionElements>",
    `          <zeebe:ioMapping><zeebe:input ${attr("source", '="escalated"')} target="humanOutcome" /></zeebe:ioMapping>`,
    "        </bpmn:extensionElements>",
    `        <bpmn:incoming>${el}_i2</bpmn:incoming>`,
    "      </bpmn:endEvent>",
    flow(`${el}_i0`, `${el}_start`, task),
    // Valid completion routes task → gate → end; the gate's default (invalid) loops back to the task.
    flow(`${el}_i1`, task, gateRequired ? `${el}_cg` : `${el}_end`),
    flow(`${el}_i2`, `${el}_sla`, `${el}_escEnd`),
    ...completionGate,
  ];
}

/** A bounded node's escalation user task — a human-completable stop (`isDeliveryHumanElement`
 * convention) that a human OR an agent (ADR 0046) answers to unstick a stalled node. `contextFeel` is
 * a FEEL expression yielding the context line seeded onto the generic form's read-only prompt field
 * (issue #499) — e.g. "Node n1 (senior:feature) exceeded its SLA (PT30M); …" — so the operator can see
 * WHICH node timed out and that in-flight work may already exist, instead of a blank form.
 *
 * `opts.resume` turns an inert escalation into a RESUMABLE one (issue #514 Defect B): when the parked
 * `wait` node declares emits, the form must both PRESENT its typed-value field (so `emitMode`/
 * `emitLabel` are derived from those emits, not forced to "none") and, on completion, MAP the
 * operator-supplied value onto the node's emit-source variable (`detail` for scalar/version,
 * `resolvedArtifact` for artifact, `mergedSha` for a merge oid — {@link factSourceVar}). Without that
 * mapping a naive resume publishes `<el>_<fact> = null`, silently starving the downstream consumer.
 * `opts.diagnosticInputs` seeds read-only probe context (issue #514 Defect A) onto the same task so the
 * operator can see WHY the gate escalated (its last probe detail + observed candidate releases). */

/** The ONE canonical runtime normalization a captured escalation/human-form text value is folded
 * through before a `boolean`/`number` gate or coercion reads it: `lower case(trim(string(...)))`. The
 * validity gate ({@link resumeValueCondition}) and the typed bind ({@link coerceFactValueFeel}) MUST
 * share it, or a value one accepts the other converts differently — e.g. `" true "` passes a trimming
 * gate but a non-trimming coercion publishes the wrong boolean, and `"TRUE"` a case-folding coercion
 * accepts but a non-folding gate rejects (#863 review r4194186383). Deriving both from this single
 * expression makes "gate accepts ⇒ coercion binds the same value" structurally true, not coincidental. */
function normalizedBoolNumberFeel(rawExpr: string): string {
  return `lower case(trim(string(${rawExpr})))`;
}

/** Coerce/validate a captured form value — a null-safe FEEL expression `rawExpr` yielding the operator's
 * entry (string-valued text, or null when absent) — to a single emit's declared {@link DeliveryFact.type},
 * so the published fact is a REAL FEEL value and not an untyped string. One source of truth shared by the
 * escalation-resume validation gate (the {@link escalationTaskLines} output mapping, which coerces the
 * resumed `value` when `resumeValueCondition` accepts it) and the bespoke single-emit human-form
 * source ({@link humanBodyLines}), so the two typed-publish paths cannot drift (PR #863 threads
 * r4182488193 / r4189815989). Returns a bare expression WITHOUT a leading `=`.
 *   • `boolean` — accept the literal `"true"`/`"false"`, case-insensitively AND
 *     surrounding-whitespace-trimmed via the shared {@link normalizedBoolNumberFeel}
 *     (`lower case(trim(string(…)))`); anything else is invalid and yields null. (The pinned engine's
 *     FEEL `matches` does not support an inline `(?i:…)` flag — verified against the WASM engine — so
 *     case-insensitivity is done by lower-casing the input, not the pattern.) The validity gate
 *     ({@link resumeValueCondition}) folds the SAME normalization, so a value it accepts coerces to the
 *     SAME boolean here (#863 review r4194186383). An already-boolean control value round-trips
 *     correctly: `string(true)` → `"true"` passes the same gate.
 *   • `number` — `number(trim(string(value)))` parses the trimmed numeric text (matching the gate's
 *     `trim(string(…))`); an unparseable entry yields null.
 *   • every other type (`string`/`url`/`version`/`pr`/`artifact`) is text-valued already — pass through.
 * The defined FAILURE PATH for invalid input is `null`, so a required-emit producer gate escalates and a
 * guarded split takes its deadlock-safe default rather than routing on a mistyped value. `definedGuard`,
 * when given, wraps the passthrough/branch in an outer `is defined(...)` for a raw name that may be
 * entirely absent (the escalation `value` control); a `rawExpr` already null-safe (the human-form
 * selection expression) passes none. */
function coerceFactValueFeel(fact: DeliveryFact, rawExpr: string, definedGuard?: string): string {
  const pre = definedGuard ? `${definedGuard} and ` : "";
  // Parenthesise rawExpr wherever it stands as a BARE infix operand (`(rawExpr) != null`): a caller may
  // pass a COMPOUND `if … then … else null` selection expression (the bespoke/generic human-form
  // `selectExpr`), and FEEL's `else` arm is GREEDY — an unparenthesised `if C then x else null != null
  // and matches(…)` parses as `if C then x else (null != null and matches(…))`, so when the field is
  // defined the whole coercion guard collapses to the raw entry and `if ("true") then … else null`
  // (a non-boolean condition) publishes NULL, silently defeating the coercion for every bespoke/generic
  // boolean & number human form (the escalation path passes the bare name `value`, so it was unaffected —
  // which is why the string-shape unit tests never caught it; empirically confirmed on the WASM engine).
  // The `string(rawExpr)`/`number(rawExpr)` sites are already bounded by their call parens, and the
  // passthrough `then rawExpr else null` has no trailing operator, so only the `!= null` operand needs it.
  const operand = `(${rawExpr})`;
  switch (fact.type) {
    case "boolean": {
      // Share the gate's EXACT normalization ({@link normalizedBoolNumberFeel}) so a value the validity
      // gate ({@link resumeValueCondition}) accepts coerces to the SAME boolean here — `" true "`/`"TRUE"`
      // can never be accepted-then-mis-published (#863 review r4194186383).
      const norm = normalizedBoolNumberFeel(rawExpr);
      // NULL-SAFE the normalization exactly like the number arm below: `operand != null` does NOT prove the
      // operand is STRINGABLE, so a fact name colliding with a FEEL builtin (`count`, …) left blank resolves
      // the selection operand to the builtin FUNCTION and `lower case(trim(string(<function>)))` throws a
      // runtime INCIDENT. Guard with `string(rawExpr) != null` (null-safe, short-circuits the normalization).
      return `if (${pre}${operand} != null and string(${rawExpr}) != null and matches(${norm}, "^(true|false)$")) then ${norm} = "true" else null`;
    }
    case "number":
      // TRIM/stringify to match the gate's `trim(string(...))` (#863 review r4194186383): the gate accepts
      // `" 42 "`, so the bind must parse the same trimmed text — a bare `number(" 42 ")` yields null,
      // breaking the "gate accepts ⇒ bind is non-null" invariant.
      // NULL-SAFE the trim: `string(rawExpr) != null` must guard it, because `operand != null` does NOT
      // prove the operand is STRINGABLE. When the fact name collides with a FEEL builtin (`count`, `sum`,
      // …), a blank human form leaves the variable unset, so the `is defined(count) and count != null`
      // selection operand resolves to the builtin FUNCTION (is-defined ⇒ true, function ≠ null), and
      // `trim(string(<function>))` throws `trim: expected a string, got null` — a runtime INCIDENT rather
      // than the intended null (the pre-round `number(rawExpr)` folded it to null; this restores that
      // null-safety while keeping the trim). `string(…)` itself is null-safe (yields null, no incident),
      // so the guard evaluates cleanly and short-circuits the trim away for any non-stringable operand.
      return `if (${pre}${operand} != null and string(${rawExpr}) != null) then number(trim(string(${rawExpr}))) else null`;
    case "string":
    case "version":
    case "url":
    case "pr": {
      // TEXT-VALUED types were previously passed through UNCHANGED — so a human form could publish a blank
      // string, a malformed version/URL, or an invalid PR ref directly downstream despite the declared
      // fact type (PR #863 review 5430718031, "Validate human-task fact values before publishing"). Fold
      // the SAME type-aware validity grammar the escalation resume gate ({@link resumeValueCondition})
      // enforces into this single `if`, failing CLOSED to null on a non-conforming entry. The grammar is
      // applied as a FLAT `matches(...)`/`trim(...)` on `string(rawExpr)` (null-safe, no
      // `is defined(<nested if…else>)` — the pinned engine mis-evaluates that compound inside an outer
      // guard, verified engine-native). The valid arm publishes the selection VERBATIM (these types need
      // no coercion), so a real captured value round-trips unchanged.
      const s = `string(${rawExpr})`;
      const grammar =
        fact.type === "string"
          ? `trim(${s}) != ""`
          : fact.type === "version"
            ? `matches(trim(${s}), "^v?\\\\d[\\\\w.+-]*$") = true`
            : fact.type === "url"
              ? `matches(trim(${s}), "^[A-Za-z][A-Za-z0-9+.-]*://") = true`
              : `matches(lower case(trim(${s})), "^(([^/#]+/[^/#]+)#(\\\\d+)|((https?://)?(www\\\\.)?github\\\\.com/[^/]+/[^/]+/pull/\\\\d+([/?#].*)?))$") = true`;
      return `if (${pre}${operand} != null and ${s} != null and ${grammar}) then ${rawExpr} else null`;
    }
    default:
      return definedGuard ? `if (${definedGuard}) then ${rawExpr} else null` : rawExpr;
  }
}

function escalationTaskLines(
  esc: string,
  nodeId: string,
  incoming: readonly string[],
  outgoing: string,
  contextFeel: string,
  opts?: {
    /** `emits` are the escalation's RESUME targets (the facts a Continue value may publish); for a
     * `wait` node this is the node's full declared-emit set, but for an `agent`/`connector` it is only
     * the REQUIRED subset a downstream node binds. `declaredEmits` is the node's FULL declared-emit set
     * — it drives SPEC 13.3's hard cardinality rule (value-resume ONLY when exactly one emit is
     * declared), which the required-count alone cannot see (issue #863 review, thread r4193902690).
     * Defaults to `emits` for the `wait` case where the two sets coincide. */
    resume?: { kind: DeliveryNode["kind"]; emits: readonly DeliveryFact[]; declaredEmits?: readonly DeliveryFact[] };
    diagnosticInputs?: readonly { source: string; target: string }[];
    displayName?: string;
    /** The node element whose retry gate this escalation feeds (#863): the completion publishes the
     * node-unique `<el>_retryRequested` boolean from the node-local `decision`, and the tail grows a
     * retry gate (`${esc}Rg`) routing Retry to the shared reset `${retryElement}_retry`. Absent for a
     * `wait`-gate escalation (resolution is "supply the awaited value", never "re-run the probe loop"). */
    retryElement?: string;
    /** The element the resume-validation gate's VALID branch flows to (the node end). Required iff
     * `resume` carries emits — a resumable escalation's Continue never routes straight to its end. */
    validTarget?: string;
    /** The emit-source var ({@link factSourceVar}) of EVERY declared emit of this node — required AND
     * non-required (a routing-only `when`-guard emit, or a declared-but-unconsumed one) — that shares
     * this escalation's flat subprocess scope. The resumed required emits are reserved regardless; this
     * reserves the REST so the generated resume-valid flag is grown collision-free against ALL of them,
     * never only the single resumed required emit (PR #876 review). */
    reservedTargets?: readonly string[];
  },
): string[] {
  const resume = opts?.resume;
  const emits = resume?.emits ?? [];
  // The node's FULL declared-emit set drives SPEC 13.3's hard cardinality rule. For a `wait` node
  // `resume.emits` already IS the declared set, so it defaults here; for an `agent`/`connector`
  // `resume.emits` is only the REQUIRED subset, so the declared set is threaded explicitly (issue #863
  // review, thread r4193902690).
  const declaredEmits = resume?.declaredEmits ?? emits;
  // The escalation form (`ESCALATION_FORM` / `GENERIC_HUMAN_FORM`) captures the operator's answer in a
  // SINGLE `value` field, so it can resume AT MOST ONE emit. With >1 required emit, one value cannot
  // satisfy multiple distinct typed facts — mapping it onto every emit-source var writes the SAME value
  // to each, corrupting all of them (and coercing one string into differently-typed facts; #863 review
  // r4180629319). So Continue-with-value is offered ONLY for a single emit; with multiple, the value
  // field is inert ("none"), the resume-valid flag is hard-`false` (#876 fail closed), and the
  // validation gate always re-parks — re-running the node ("Retry this step") stays the way to produce
  // the facts.
  //
  // The cardinality that gates this is the DECLARED-emit count, NOT the required-emit count: a node
  // declaring two facts where only one is required must STILL leave the value field inert (SPEC 13.3 —
  // "any node with multiple declared emits leaves the field inert"). Gating on `emits.length === 1`
  // (required) alone let such a node offer a value-resumable Continue that would publish the lone
  // required fact while silently dropping the sibling (issue #863 review, thread r4193902690).
  const resumableEmit = declaredEmits.length === 1 && emits.length === 1 ? emits[0] : undefined;
  const emitMode = resumableEmit !== undefined ? "typed" : "none";
  const inputs: string[] = [
    `            <zeebe:input ${attr("source", contextFeel)} target="prompt" />`,
    `            <zeebe:input ${attr("source", `=${feelStr(nodeId)}`)} target="nodeId" />`,
    `            <zeebe:input ${attr("source", `=${feelStr(emitMode)}`)} target="emitMode" />`,
  ];
  if (resumableEmit !== undefined) {
    inputs.push(
      `            <zeebe:input ${attr("source", `=${feelStr(`${resumableEmit.name} (${resumableEmit.type})`)}`)} target="emitLabel" />`,
    );
  }
  for (const di of opts?.diagnosticInputs ?? []) {
    inputs.push(`            <zeebe:input ${attr("source", di.source)} target="${di.target}" />`);
  }
  // Defect B + PR #876 review + #863 retry: the operator's captured typed value is VALIDATED on this
  // task's OWN output mapping (reading the form's `value` field), which the pinned engine evaluates
  // reliably — unlike a downstream gateway's ioMapping, whose inputs/outputs are NOT visible downstream
  // (verified engine-native). The required emit's emit-source var is bound from `value` — COERCED to
  // the fact's declared type ({@link coerceFactValueFeel}, #863) — ONLY when it is present and type-valid
  // ({@link resumeValueCondition}, #876), else null; a validity boolean flags the resume. The
  // post-escalation validation gateway routes on the SIMPLE `<resumeValidVar> = true` (a complex FEEL
  // condition on the gateway mis-evaluates — verified), re-parking an invalid resume (fail closed) so it
  // can never thread null/garbage onto the emit the subProcess output ioMapping republishes downstream.
  // On Continue (`decision != retry`) this validation gate runs; on Retry the per-escalation retry gate
  // funnels to the shared reset instead. The generic/service escalation form captures the answer in a
  // single `value` field — no `resolvedArtifact` field — so a single emit resumes from `value`,
  // validated per its fact type (artifact→resolvedArtifact, version→detail, …).
  //
  // MULTI-EMIT (PR #876 review): the form's SINGLE `value` cannot supply a distinct value per fact, so a
  // node owing more than one required emit CANNOT be resumed from it. Copying the one `value` into every
  // emit-source var would release duplicate/garbage facts downstream; instead we FAIL CLOSED — bind
  // nothing and hard-set the validity flag to `false`, so the validation gate always re-parks.
  const outputs: string[] = [];
  // The resume-valid flag shares this escalation's flat engine scope with EVERY declared emit's source
  // var — not only the single resumed required emit — so it is grown collision-free against ALL of them
  // (shared with the reset via {@link escalationResumeFlagVar}). See that helper for the collision class.
  const flagVar = escalationResumeFlagVar(esc, resume, opts?.reservedTargets ?? []);
  if (resume !== undefined && resumableEmit !== undefined) {
    const fact = resumableEmit;
    const target = factSourceVar(resume.kind, fact);
    const valid = resumeValueCondition(fact, "value");
    outputs.push(
      // Bind the coerced typed value only when it passes the fail-closed validity test (so flag=true
      // always implies a non-null, correctly-typed bind — the two can never disagree).
      `            <zeebe:output ${attr("source", `=if ${valid} then ${coerceFactValueFeel(fact, "value")} else null`)} target="${target}" />`,
    );
    outputs.push(
      // The validity flag the post-escalation gateway routes on — an internal, compiler-generated
      // variable name ({@link resumeValidVar}), made collision-free against the emit-source var above
      // by construction, so it can neither collide with nor be shadowed by a declared emit.
      `            <zeebe:output ${attr("source", `=if ${valid} then true else false`)} target="${flagVar}" />`,
    );
  } else if (resume !== undefined && emits.length > 0) {
    outputs.push(
      // Fail closed: the escalation is not value-resumable (more than one required emit, OR more than
      // one DECLARED emit so the single value field is inert per SPEC 13.3) yet a required emit is owed,
      // so the resume is never valid and the validation gate always re-parks (see the comment above).
      `            <zeebe:output ${attr("source", "=false")} target="${flagVar}" />`,
    );
  }
  if (opts?.retryElement !== undefined) {
    outputs.push(
      // The node-unique `<el>_retryRequested` boolean the per-escalation retry gate routes on (#863),
      // derived from the node-local `decision` the operator chose on `ESCALATION_FORM`.
      `            <zeebe:output ${attr("source", `=is defined(${ESCALATION_DECISION_VAR}) and ${ESCALATION_DECISION_VAR} = ${feelStr(ESCALATION_DECISION_RETRY)}`)} target="${retryRequestedVar(opts.retryElement, opts.reservedTargets ?? [])}" />`,
    );
  }
  // The escalation user task shows the node's DESCRIPTIVE display name (issue #778 review) so a
  // timed-out / contract-broken node is legible in the explorer/inbox instead of an opaque bare id;
  // `nodeId` is still threaded as the `nodeId` input above for runtime correlation.
  const escLabel = trimmedOrEmpty(opts?.displayName) || nodeId;
  // The retry-capable `decision` select lives ONLY on the service-escalation form (`ESCALATION_FORM`).
  // A wait-gate escalation carries no `retryElement` — its resolution is "supply the awaited value and
  // continue", never "re-run the probe loop" — so it keeps the select-less generic form rather than
  // render a "Retry this step" option that would be silently ignored.
  const form = opts?.retryElement !== undefined ? ESCALATION_FORM : GENERIC_HUMAN_FORM;
  const task = [
    `      <bpmn:userTask id="${esc}" name="Escalate: ${escapeXml(escLabel)}">`,
    "        <bpmn:extensionElements>",
    `          <zeebe:formDefinition formId="${form}" />`,
    "          <zeebe:userTask />",
    '          <zeebe:assignmentDefinition candidateGroups="operators" />',
    "          <zeebe:ioMapping>",
    ...inputs,
    ...outputs,
    "          </zeebe:ioMapping>",
    "        </bpmn:extensionElements>",
    ...incoming.map((id) => `        <bpmn:incoming>${id}</bpmn:incoming>`),
    `        <bpmn:outgoing>${outgoing}</bpmn:outgoing>`,
    "      </bpmn:userTask>",
  ];
  const retryEl = opts?.retryElement;
  // The resume-validation gate re-parks an invalid Continue back onto THIS escalation task (fail
  // closed). That loop is only escapable when the operator has a way out of it — EITHER a genuinely
  // value-resumable single emit (supply the value → flag true → proceed to the node end) OR a Retry
  // gate (service nodes). A multi-emit WAIT escalation has NEITHER: the single `value` field cannot
  // supply >1 distinct fact so the flag is hard-`false` and Continue ALWAYS re-parks, and a wait gate
  // carries no `retryElement`, so there is no Retry escape. Building the gate there wedges the timed-out
  // token in an unresolvable loop (issue #863 review, thread r4198123619 — "Prevent unresolvable loops
  // for multi-emit wait nodes"). So the gate is grown ONLY when there is an escape; otherwise the
  // escalation flows straight to the node end, exactly like a no-emit wait escalation (an acknowledged,
  // value-less continue). Service nodes KEEP the fail-closed re-park — their Retry gate is the escape.
  const resumable = resume !== undefined && emits.length > 0 && (resumableEmit !== undefined || retryEl !== undefined);
  // A wait-gate escalation with no escapable resume (no `retryElement`, not resumable) has no tail — the
  // caller flows `outgoing` straight to the node end.
  if (retryEl === undefined && !resumable) return task;

  const tail: string[] = [];
  // #863 retry gate (service escalations only): the esc task's `outgoing` flows into this gate (built by
  // the caller). Retry (`decision == retry`) → the SHARED reset `${retryEl}_retry`; Continue (default) →
  // the validation gate (if resumable) else the node end. Checking Retry FIRST is essential: a Retry
  // supplies no `value`, so its resume-valid flag is false — a validation-first topology would wrongly
  // re-park a legitimate Retry.
  if (retryEl !== undefined) {
    const rg = `${esc}Rg`;
    const rr = `${esc}Rr`;
    const rc = `${esc}Rc`;
    const continueTarget = resumable ? `${esc}Vg` : `${retryEl}_end`;
    tail.push(
      `      <bpmn:exclusiveGateway id="${rg}" name="retry node?" default="${rc}">`,
      `        <bpmn:incoming>${outgoing}</bpmn:incoming>`,
      `        <bpmn:outgoing>${rr}</bpmn:outgoing>`,
      `        <bpmn:outgoing>${rc}</bpmn:outgoing>`,
      "      </bpmn:exclusiveGateway>",
      `      <bpmn:sequenceFlow id="${rr}" name="retry" sourceRef="${rg}" targetRef="${retryEl}_retry"><bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">=${retryRequestedVar(retryEl, opts?.reservedTargets ?? [])} = true</bpmn:conditionExpression></bpmn:sequenceFlow>`,
      `      <bpmn:sequenceFlow id="${rc}" name="continue" sourceRef="${rg}" targetRef="${continueTarget}" />`,
    );
  }

  // Resume-validation gate (PR #876 review): a resumable Continue no longer routes straight to the node
  // end. It flows into an exclusive gateway whose VALID branch proceeds to the node end and whose
  // DEFAULT (invalid) branch loops back onto the escalation task — so a blank/malformed `value` re-parks
  // instead of releasing a null/invalid fact downstream (fail closed on the default). The gateway is a
  // PLAIN exclusive gateway (NO ioMapping — a gateway's ioMapping is not visible downstream in the
  // pinned engine, verified): the per-emit validation already ran on the escalation task's OWN output
  // mapping (binding the emit-source var + the validity flag), so the gateway only routes on the simple
  // `<resumeValidVar> = true` boolean. For a multi-emit node the flag is hard-`false` (unresumable via
  // the single-value form), so the gate always re-parks. The gate's incoming is the retry gate's
  // `continue` flow (service escalation) or the esc task's `outgoing` (wait escalation).
  if (resumable) {
    const validTarget = opts?.validTarget;
    if (validTarget === undefined) {
      throw new Error(`escalationTaskLines(${esc}): a resumable escalation requires opts.validTarget (the node end its valid resume flows to)`);
    }
    const vg = `${esc}Vg`;
    const vok = `${esc}Vok`;
    const vbad = `${esc}Vbad`;
    const vgIncoming = retryEl !== undefined ? `${esc}Rc` : outgoing;
    tail.push(
      `      <bpmn:exclusiveGateway id="${vg}" name="resume value valid?" default="${vbad}">`,
      `        <bpmn:incoming>${vgIncoming}</bpmn:incoming>`,
      `        <bpmn:outgoing>${vok}</bpmn:outgoing>`,
      `        <bpmn:outgoing>${vbad}</bpmn:outgoing>`,
      "      </bpmn:exclusiveGateway>",
      `      <bpmn:sequenceFlow id="${vok}" name="valid" sourceRef="${vg}" targetRef="${validTarget}"><bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">=${flagVar} = true</bpmn:conditionExpression></bpmn:sequenceFlow>`,
      `      <bpmn:sequenceFlow id="${vbad}" name="invalid" sourceRef="${vg}" targetRef="${esc}" />`,
    );
  }
  return [...task, ...tail];
}

/** The per-required-emit FEEL condition an escalation resume value must satisfy to bind its
 * emit-source var (PR #876 review) — the runtime mirror of `coerceFactValue` (app/deliveryHuman.ts),
 * re-expressed in FEEL so the compiled model validates WITHOUT a worker round-trip. A missing/null
 * value fails every branch (fail closed). Type-aware: a `pr` must match the `owner/repo#N` shape, a
 * `version`/`artifact` the version grammar, a `number`/`boolean` coerce, a `url` carry a scheme, a
 * `string` be non-blank.
 *
 * The pinned WASM FEEL evaluator's null semantics drive the exact shape (each verified engine-native):
 * the type-test builtins `is string(x)` / `is number(x)` / `is boolean(x)` are UNSUPPORTED — they raise
 * "cannot call a null value" (an ioMapping incident) rather than returning a boolean — so they are
 * NEVER used. Instead every value is funnelled through `string(resumeValue)` (null-safe) and validated
 * by `matches(...)`/`trim(...)`, which ARE null-safe (a non-match yields false, never an error).
 * `is defined(x)` returns NULL (not false) for an absent variable, so the presence guard is anchored
 * `= true` (null-safe). The caller binds `if cond then <value> else null` on the escalation task's OWN
 * output mapping (verified: a valid value binds it, an invalid/absent one binds null — fail closed).
 *
 * CANONICAL-GRAMMAR ALIGNMENT (PR #876 round-4 "Previously missed"): the regexes below must accept
 * exactly what the canonical contracts accept, or a timed-out node cannot resume with a value that
 * works on its normal completion path. `artifact` mirrors `coerceFactValue`'s `pkg@version` split on
 * the LAST `@` — so a SCOPED package (`@nanobpm/urban@0.54.0`) is accepted: the name segment is
 * `[^@\s]+` (no `@`/space) preceded by an OPTIONAL leading scope `@`. `pr` mirrors `parsePr`
 * (app/prParse.ts), which accepts BOTH the `owner/repo#N` shorthand AND a canonical GitHub PR URL
 * (`https://github.com/owner/repo/pull/N`, optional scheme/`www.`, optional `/files`/`?query`/
 * `#fragment` suffix) — so the `pr` branch is the disjunction of the two anchored grammars. parsePr's
 * URL regex carries the `/i` flag, so the `pr` branch folds the tested value through `lower case(...)`
 * (an engine-native, null-safe builtin) before matching its lower-case literals — otherwise a mixed-
 * case host/scheme the normal completion path accepts (`https://GitHub.com/...`, `HTTPS://...`) would be
 * rejected here, re-parking a legitimate resume (fail-closed on a value the canonical path takes). Only
 * the accept/reject test folds; the bound `value` stays verbatim.
 *
 * KNOWN FAIL-CLOSED DIVERGENCES (PR #876 round-5 escalation — ACCEPTED tradeoff, do NOT redesign the
 * completion door): these FEEL regexes are a deliberate in-engine APPROXIMATION of the canonical
 * `coerceFactValue`/`new URL()`/`Number()` parsers, which are host-side and not FEEL-expressible. A few
 * exotic-but-canonically-valid inputs are therefore rejected HERE (re-parked) even though the normal
 * completion path accepts them — safe (fail-CLOSED, never fail-open), and the escalation form's `value`
 * is a textfield so no type is erased. The known cases, accepted as rare enough not to warrant a
 * worker/host round-trip:
 *   • `number`: scientific/hex/octal/binary literals (`1e3`, `0x10`, `.5`) — `Number()` parses them,
 *     the `^-?\d+(\.\d+)?$` regex does not.
 *   • `url`: schemes WHATWG `URL` accepts without `://` (`mailto:user@example.com`, `urn:…`) — the
 *     `scheme://` guard requires the authority form.
 *   • `artifact`: a multi-`@` name whose non-final `@` is NOT a scope prefix — the single last-`@`
 *     split differs from edge cases of the canonical parser.
 * If these ever become common, the fix is to route the resume through the canonical host-side coercer
 * (a completion-door redesign) rather than widening these regexes toward fail-OPEN. */
function resumeValueCondition(fact: DeliveryFact, v: string, presentOverride?: string): string {
  // `presentOverride` lets a caller supply a FLAT null-safe presence test (`string(sel) != null`) when `v`
  // is a COMPOUND `if…then…else` selection (e.g. the human-form completion gate's `selectExpr`): the pinned
  // engine mis-evaluates `is defined(<compound if…then…else>)` — the same quirk `artifactSource` sidesteps
  // with a flat `matches(trim(string(…)))` — so the default `is defined(v)`-based presence is only safe for
  // a BARE variable name (the escalation resume `value`). Every per-type grammar arm below reads `v` only
  // through null-safe `string()`/`matches()`/`trim()` wrappers, so a flat presence override keeps the whole
  // condition engine-safe over a compound selection.
  const present = presentOverride ?? `((is defined(${v})) = true and (${v} != null))`;
  const s = `string(${v})`;
  switch (fact.type) {
    case "string":
      return `${present} and trim(${s}) != ""`;
    case "number":
      // Share the coercion's `number(trim(string(...)))` input ({@link normalizedBoolNumberFeel} folds an
      // extra harmless lower-case over the digits): gate and bind normalize identically (#863 r4194186383).
      return `${present} and (matches(${normalizedBoolNumberFeel(v)}, "^-?\\\\d+(\\\\.\\\\d+)?$") = true)`;
    case "boolean":
      // SAME normalization as the typed bind ({@link coerceFactValueFeel} → {@link normalizedBoolNumberFeel}),
      // so this gate accepts exactly the texts the coercion publishes correctly — `" true "`/`"TRUE"` are
      // accepted here AND bound as a real boolean, never accepted-then-mis-published (#863 r4194186383).
      return `${present} and (${normalizedBoolNumberFeel(v)} = "true" or ${normalizedBoolNumberFeel(v)} = "false")`;
    case "version":
      return `${present} and (matches(trim(${s}), "^v?\\\\d[\\\\w.+-]*$") = true)`;
    case "artifact":
      return `${present} and (matches(trim(${s}), "^@?[^@\\\\s]+@v?\\\\d[\\\\w.+-]*$") = true)`;
    case "url":
      return `${present} and (matches(trim(${s}), "^[A-Za-z][A-Za-z0-9+.-]*://") = true)`;
    case "pr":
      // Case-INSENSITIVE like the canonical parsePr (`/i`): fold the tested value to lower case so the
      // lower-case host/scheme literals below match a mixed-case input the normal path accepts.
      return `${present} and (matches(lower case(trim(${s})), "^(([^/#]+/[^/#]+)#(\\\\d+)|((https?://)?(www\\\\.)?github\\\\.com/[^/]+/[^/]+/pull/\\\\d+([/?#].*)?))$") = true)`;
    default:
      return assertNever(fact.type, "resumeValueCondition");
  }
}

/** Build the FEEL context line seeded onto an escalation task's read-only prompt field (issue #499).
 * The node id + descriptor (job type / connector target / "readiness gate") are baked as compile-time
 * literals; the elapsed SLA is read from the node body's runtime `timeoutVar` (`nodeTimeout` for a
 * bounded service node, `probeTimeout` for a `wait` gate). `tail` closes the sentence per kind. */
function escalationContextFeel(nodeId: string, descriptor: string, timeoutVar: string, tail: string): string {
  const head = feelStr(`Node ${nodeId} (${descriptor}) exceeded its SLA (`);
  return `=${head} + string(${timeoutVar}) + ${feelStr(`)${tail}`)}`;
}

/** The escalation context line for a `wait` gate (issue #514 Defect A). Extends the base #499 line with
 * the probe's RUNTIME last `detail` and its observed-candidate summary (`observed`), so a human/agent
 * reading the (read-only) prompt can immediately tell a genuine "not published yet" from a transient
 * false-negative — without hunting for the internal variables. Both are folded in defensively (an
 * as-yet-unset var renders "—", never a FEEL error). */
function waitEscalationContextFeel(nodeId: string): string {
  const base = escalationContextFeel(
    nodeId,
    "readiness gate",
    "probeTimeout",
    " before its ReadinessProbe went green — decide how to proceed.",
  );
  const lastProbe = `(if (is defined(detail)) then string(detail) else "—")`;
  const observed = `(if (is defined(observed)) then string(observed) else "—")`;
  return `${base} + " Last probe: " + ${lastProbe} + ". Observed: " + ${observed} + "."`;
}

/** A plain `<bpmn:sequenceFlow>` (6-space indented). */
function flow(id: string, source: string, target: string): string {
  return `      <bpmn:sequenceFlow id="${id}" sourceRef="${source}" targetRef="${target}" />`;
}

/** Render a human-readable mermaid `flowchart` of the resolved graph — one box per node labelled with
 * the SAME descriptive {@link nodeDisplay} name the compiled BPMN uses (issue #778: one display source,
 * no `kind: id` drift between the diagram and the deployed model), one arrow per edge (labelled with the
 * referenced fact when qualified). Deterministic (nodes/edges already sorted). */
function renderMermaid(
  graph: DeliveryGraph,
  wirings: readonly NodeWiring[],
  edges: readonly ResolvedDeliveryEdge[],
  elementById: ReadonlyMap<string, string>,
): string {
  const lines: string[] = ["flowchart TD"];
  if (graph.name !== undefined) lines.push(`  %% ${escapeMermaid(graph.name)}`);
  for (const w of wirings) {
    lines.push(`  ${w.element}["${escapeMermaid(nodeDisplay(w.node).name)}"]`);
  }
  for (const edge of edges) {
    const from = mustGet(elementById, edge.fromNode);
    const to = mustGet(elementById, edge.to);
    // Label a guarded edge with its predicate (`fact == value`) and a default with `default` (S7), a
    // fact-qualified edge with the fact name, else an unlabelled arrow.
    let label: string | undefined;
    if (edge.when !== undefined && edge.default !== true) {
      const guardFact = edge.when.includes(".") ? edge.when.slice(edge.when.lastIndexOf(".") + 1) : edge.when;
      label = `${guardFact} == ${feelLiteral(edge.equals)}`;
    } else if (edge.default === true) {
      label = "default";
    } else if (edge.fromFact !== undefined) {
      label = edge.fromFact;
    }
    if (label !== undefined) {
      lines.push(`  ${from} -- "${escapeMermaid(label)}" --> ${to}`);
    } else {
      lines.push(`  ${from} --> ${to}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
