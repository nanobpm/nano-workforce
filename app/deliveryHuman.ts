// nano-workforce — the `human` delivery-graph node (ADR 0005, slice S3). A `human` node promotes
// ADR 0002's user-task+form machinery from an *exception* (something broke) to a *scheduled node* (a
// planned "now do X" stop that BLOCKS its dependents, is answerable by a human OR an agent — ADR 0046
// — is SLA-bounded so it nags and cannot silently wedge the graph, and can EMIT a typed fact its form
// captures which late-binds downstream). It is the emit-side of #263's emit-vs-poll dual: a *human*
// emitter is the same shape as an automated one (the `capability`/`pr` probe's `resolvedArtifact`
// bind), which is what unifies human and automated steps in one graph.
//
// This module owns the PURE, side-effect-free machinery the compiler (S1, author-time) and the
// runner (S4, runtime) reuse — it never itself creates a user task or completes one. Execution stays
// engine-native (Decision 2): the human node's body is the deployed `delivery-human` `bpmn:userTask`
// (`resources/processes/delivery-human.bpmn`, an SLA-bounded scheduled user task), completion routes
// through the ONE canonical completer (`completeEscalationAsAgent`/`completeEscalationAsHuman`,
// `app/agentCompletion.ts`) because `DELIVERY_HUMAN_ELEMENT` is registered in
// `ESCALATION_TASK_ELEMENTS`, and the emitted fact threads downstream via the #289 brief-appender /
// bound-output pattern (`renderResolvedDepsBrief` / the `caps-resolved` → `appendPrompt` recipe).
//
// The three pure concerns:
//   1. FORM RESOLUTION — specific-else-generic (Decision 4): an explicit `human.formKey` on the node,
//      else a form SELECTED by node category (derived from the node's typed emits), else a GENERIC
//      fallback form that STILL captures a typed emitted fact — so every human node can emit even with
//      no bespoke form. A runtime agent-form-router is a GATED exception: it fires ONLY when a node
//      activates with no statically resolvable form (multiple heterogeneous emits, no explicit/bespoke
//      form), never in the common path — the same "deterministic default, agent judgment as the escape
//      hatch" grain as the capability probe's empirical verifier.
//   2. TYPED EMIT — validate + coerce the completed form output against the node's declared `emits[]`
//      (Decision 3/4 — binds are validated, not stringly), producing the typed facts the node hands
//      forward. A "click done" node declares no emits — the degenerate no-emit case.
//   3. LATE-BINDING — render the emitted facts into a downstream node's brief (`renderHumanEmitBrief`,
//      mirroring `renderResolvedDepsBrief`) and into a qualified bind map keyed `<nodeId>.<fact>`
//      (`humanEmitBind`, mirroring the probe `bind`) so a downstream `capability`/`npm`/`pr` edge
//      binds and pins exactly the value the human handed forward.
import type { DeliveryFact, DeliveryNodeHuman } from "../nano-generated/api-io.d.ts";
import { DELIVERY_FACT_TYPES, type DeliveryFactType } from "./deliveryGraph.ts";

/** The single BPMN `bpmn:userTask` element id every `human` delivery-graph node schedules its work
 *  as (`resources/processes/delivery-human.bpmn`). One reusable engine-native body, instantiated once
 *  per human node (mirroring the one `readiness-gate` process instantiated per `wait` node). It is
 *  registered in `ESCALATION_TASK_ELEMENTS` (`app/agentCompletion.ts`) so a human OR an agent
 *  (ADR 0046) can complete it through the ONE canonical `complete-user-task` / `agent-complete` door,
 *  and in `USER_TASK_KIND_LABELS` (`app/userTasks.ts`) so it surfaces on the Tasks inbox. */
export const DELIVERY_HUMAN_ELEMENT = "delivery-human-task";

/** The GENERIC fallback form (Decision 4, step 3): captures ONE typed value into the node's single
 *  declared emitted fact, so a human node with no explicit/category form can STILL emit downstream. */
export const GENERIC_HUMAN_FORM = "delivery-human-generic";

/** The "click done" category form: a degenerate no-emit acknowledgement ("now do X" → done). */
export const HUMAN_ACK_FORM = "delivery-human-ack";

/** The manual-publish category form: captures a `resolvedArtifact` (`pkg@version`) — the motivating
 *  case where a human hands a just-published version forward to a downstream `capability`/`npm`/`pr`
 *  edge. */
export const HUMAN_PUBLISH_FORM = "delivery-human-publish";

/** A human node's derived CATEGORY — a coarse classification of what the node emits, used to SELECT a
 *  bespoke form (Decision 4, step 2) without the author naming one. Derived from the node's typed
 *  `emits[]` so the same typed-fact declaration that drives late-binding also drives form selection —
 *  one source of truth, no second author-facing knob (the frozen S0 `human` config carries only
 *  `formKey`/`prompt`). `null` ⇒ no bespoke category form applies (fall through to generic/router). */
export type HumanNodeCategory = "ack" | "publish";

/** Category → its bespoke form. Kept as the single source of truth for "which form a category selects"
 *  so {@link resolveHumanForm} and any preview/compile step agree. */
export const HUMAN_CATEGORY_FORMS: Readonly<Record<HumanNodeCategory, string>> = {
  ack: HUMAN_ACK_FORM,
  publish: HUMAN_PUBLISH_FORM,
};

/** How a human node's form was resolved. `explicit` — the node named a `human.formKey`; `category` —
 *  a form was selected by the node's derived category; `generic` — the typed-emit-capturing fallback;
 *  `agent-router` — NOTHING statically resolved, so a runtime agent must pick/assemble one (the gated
 *  exception). */
export type HumanFormSource = "explicit" | "category" | "generic" | "agent-router";

/** The resolved form for a human node (Decision 4). `formKey` is the `.form` to attach — `null` ONLY
 *  for `agent-router`, where the runtime supplies it. `category` records the derived category when one
 *  applied. `reason` is a human-readable one-liner for the compiled preview. */
export interface HumanFormResolution {
  readonly source: HumanFormSource;
  readonly formKey: string | null;
  readonly category: HumanNodeCategory | null;
  readonly emits: readonly DeliveryFact[];
  readonly reason: string;
}

/** A typed fact a completed human node hands forward — its declared `name`/`type` plus the validated,
 *  canonically-serialised `value` (a string, like the probe `bind`, so it threads uniformly into
 *  prompts, messages, and qualified bind maps). */
export interface BoundFact {
  readonly name: string;
  readonly type: DeliveryFactType;
  readonly value: string;
}

/** The outcome of binding a completed form's output to a node's declared emits: the typed `facts` in
 *  declaration order plus any path-qualified `errors` (a missing/ill-typed declared fact). An empty
 *  `emits` yields `{ facts: [], errors: [] }` — the degenerate no-emit "click done" case. */
export interface HumanEmitResult {
  readonly facts: readonly BoundFact[];
  readonly errors: readonly string[];
}

/** Narrow an untyped value to a plain object so its fields can be read defensively. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `value` is one of the closed set of delivery fact types (a type guard, so the pure
 *  form/emit logic narrows without an `as` assertion). */
function isDeliveryFactType(value: unknown): value is DeliveryFactType {
  return typeof value === "string" && DELIVERY_FACT_TYPES.some((t) => t === value);
}

/** Normalise a human node's `emits[]` to the well-formed, typed declarations, dropping anything the
 *  S0 validator would already have rejected (a non-record entry, a blank name, an unknown type) so the
 *  pure form/emit logic never trips on a malformed declaration — the graph is validated upstream by
 *  `validateDeliveryGraph`, this is defence in depth. */
export function normalizeEmits(node: Pick<DeliveryNodeHuman, "emits">): DeliveryFact[] {
  const raw = node.emits;
  if (!Array.isArray(raw)) return [];
  const facts: DeliveryFact[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const name = entry.name;
    const type = entry.type;
    if (typeof name !== "string" || name.length === 0) continue;
    if (!isDeliveryFactType(type)) continue;
    facts.push({ name, type, ...(typeof entry.description === "string" ? { description: entry.description } : {}) });
  }
  return facts;
}

/** Derive a human node's CATEGORY from its typed emits (Decision 4, step 2), or `null` when no bespoke
 *  category form applies:
 *   - `ack` — the node emits NOTHING (a "click done" acknowledgement).
 *   - `publish` — the node emits EXACTLY ONE `artifact` fact (a `pkg@version` handle — the manual-
 *     publish-hands-a-version-forward case), which the bespoke publish form captures as a
 *     `resolvedArtifact`. A lone `version` (a BARE version, e.g. `1.4.0`) does NOT map here: the
 *     publish form captures a `pkg@version` into `resolvedArtifact`, which fails `version` coercion in
 *     {@link bindHumanEmits} — so a single `version` falls through to the generic single-value form
 *     (which captures a bare `value`, validated against the `version` type).
 *   - `null` — a single non-artifact scalar/url/version fact (the generic fallback captures it), OR
 *     two-or-more facts (no bespoke or generic single-value form can hold them → the agent-router
 *     territory).
 *  Kept coarse ON PURPOSE: bespoke category forms are a deterministic convenience, not an open
 *  taxonomy; anything they don't cover falls through to the generic fallback or the gated router. */
export function deriveHumanCategory(emits: readonly DeliveryFact[]): HumanNodeCategory | null {
  if (emits.length === 0) return "ack";
  if (emits.length === 1 && emits[0].type === "artifact") return "publish";
  return null;
}

/** Resolve which form a human node uses, specific-else-generic (ADR 0005 Decision 4). Preference:
 *    1. `explicit`     — the node carries a non-blank `human.formKey`.
 *    2. `category`     — the node's derived category selects a bespoke form ({@link deriveHumanCategory}).
 *    3. `generic`      — the node emits ≤1 fact, captured by the generic typed-emit fallback form.
 *    4. `agent-router` — NOTHING statically resolved (≥2 heterogeneous emits, no explicit/bespoke
 *                        form): a runtime agent must pick/assemble a form. This is the GATED escape
 *                        hatch — it fires ONLY here, never in the common path.
 *  Pure and total (never throws): the graph is shape/semantic-validated upstream, and malformed emits
 *  are normalised away, so this always returns a resolution. Author-time callers (the S1 compiler)
 *  attach `formKey` deterministically so the resolved form is visible in the preview; only the
 *  `agent-router` case defers to runtime. */
export function resolveHumanForm(node: Pick<DeliveryNodeHuman, "emits" | "human">): HumanFormResolution {
  const emits = normalizeEmits(node);
  const explicit = node.human?.formKey;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return {
      source: "explicit",
      formKey: explicit.trim(),
      category: null,
      emits,
      reason: `explicit form "${explicit.trim()}" attached on the node`,
    };
  }
  const category = deriveHumanCategory(emits);
  if (category !== null) {
    return {
      source: "category",
      formKey: HUMAN_CATEGORY_FORMS[category],
      category,
      emits,
      reason:
        category === "ack"
          ? "no emitted fact — the generic acknowledgement (click-done) form"
          : `emits a single ${emits[0].type} fact — the manual-publish form (captures a resolvedArtifact)`,
    };
  }
  if (emits.length <= 1) {
    return {
      source: "generic",
      formKey: GENERIC_HUMAN_FORM,
      category: null,
      reason: `emits a single ${emits[0].type} fact — the generic typed-emit fallback form`,
      emits,
    };
  }
  return {
    source: "agent-router",
    formKey: null,
    category: null,
    emits,
    reason:
      `emits ${emits.length} typed facts and carries no explicit/bespoke form — no static form can ` +
      "capture them, so a runtime agent-form-router must assemble one (the gated exception)",
  };
}

/** True when a human node resolves to the gated runtime agent-form-router — i.e. nothing statically
 *  resolved. A thin predicate over {@link resolveHumanForm} so callers can branch without re-deriving. */
export function needsAgentFormRouter(node: Pick<DeliveryNodeHuman, "emits" | "human">): boolean {
  return resolveHumanForm(node).source === "agent-router";
}

/** The canonical form-field keys a bespoke/generic form captures its single typed value under, tried
 *  (in addition to the fact's own name) when binding a single-fact node's output. The generic form
 *  captures `value`; the publish form captures `resolvedArtifact`. */
const CANONICAL_VALUE_KEYS = ["resolvedArtifact", "value"] as const;

/** Coerce + validate one raw form value against a declared fact type, returning the canonical string
 *  serialisation or an error message. Typed so a bind is validated, not stringly (Decision 3/4): an
 *  `artifact` must be `pkg@version`, a `version` a bare version, a `url` a parseable location, a
 *  `number` finite, a `boolean` a real boolean. */
function coerceFactValue(type: DeliveryFactType, raw: unknown): { value: string } | { error: string } {
  switch (type) {
    case "string": {
      if (typeof raw !== "string" || raw.trim() === "") return { error: "expected a non-empty string" };
      return { value: raw };
    }
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
      if (!Number.isFinite(n)) return { error: "expected a finite number" };
      return { value: String(n) };
    }
    case "boolean": {
      if (typeof raw === "boolean") return { value: String(raw) };
      if (raw === "true" || raw === "false") return { value: raw };
      return { error: 'expected a boolean (true/false)' };
    }
    case "version": {
      if (typeof raw !== "string" || !/^v?\d[\w.+-]*$/.test(raw.trim())) {
        return { error: "expected a version string (e.g. 1.4.0)" };
      }
      return { value: raw.trim() };
    }
    case "artifact": {
      if (typeof raw !== "string") return { error: "expected a pkg@version artifact handle" };
      const at = raw.trim().lastIndexOf("@");
      const name = raw.trim().slice(0, at);
      const version = raw.trim().slice(at + 1);
      if (at <= 0 || name.length === 0 || version.length === 0) {
        return { error: "expected a pkg@version artifact handle (e.g. @nanobpm/urban@0.54.0)" };
      }
      return { value: raw.trim() };
    }
    case "url": {
      if (typeof raw !== "string" || raw.trim() === "") return { error: "expected a URL" };
      try {
        new URL(raw.trim());
      } catch {
        return { error: "expected a valid URL (with a scheme)" };
      }
      return { value: raw.trim() };
    }
    default:
      return { error: `unknown fact type "${type}"` };
  }
}

/** Bind a completed human node's form `output` to its declared `emits[]` (Decision 3/4). For each
 *  declared fact, read its value from the output — preferring the fact's own `name` key, then, for a
 *  single-fact node, the canonical capture keys the generic/publish forms use (`resolvedArtifact` /
 *  `value`) — and validate/coerce it against the fact's type. Returns the typed facts in declaration
 *  order plus one error per missing/ill-typed declared fact. A node with no declared emits yields no
 *  facts and no errors (the degenerate "click done" case) regardless of what the form captured.
 *
 *  This is the typed-emit contract the runner (S4) enforces on completion before threading the facts
 *  downstream via {@link humanEmitBind} / {@link renderHumanEmitBrief} — the emit-side of #263. */
export function bindHumanEmits(
  emits: readonly DeliveryFact[],
  output: Record<string, unknown> | null | undefined,
): HumanEmitResult {
  const out = isRecord(output) ? output : {};
  const facts: BoundFact[] = [];
  const errors: string[] = [];
  const single = emits.length === 1;
  for (const fact of emits) {
    let raw = out[fact.name];
    if (raw === undefined && single) {
      for (const key of CANONICAL_VALUE_KEYS) {
        if (out[key] !== undefined) {
          raw = out[key];
          break;
        }
      }
    }
    if (raw === undefined || raw === null) {
      errors.push(`emits.${fact.name}: no value captured for the declared ${fact.type} fact`);
      continue;
    }
    const coerced = coerceFactValue(fact.type, raw);
    if ("error" in coerced) {
      errors.push(`emits.${fact.name}: ${coerced.error}`);
      continue;
    }
    facts.push({ name: fact.name, type: fact.type, value: coerced.value });
  }
  return { facts, errors };
}

/** Build the qualified bind map a human node's emitted facts publish downstream, keyed exactly as a
 *  delivery edge references them — `<nodeId>.<fact>` (mirroring the probe `bind: Record<string,string>`
 *  and the `capability` kind's `resolvedArtifact`). A downstream edge `from: "<nodeId>.<fact>"` binds
 *  and PINS the human-handed value from this map. Empty for a no-emit node. */
export function humanEmitBind(nodeId: string, facts: readonly BoundFact[]): Record<string, string> {
  const bind: Record<string, string> = {};
  for (const fact of facts) bind[`${nodeId}.${fact.name}`] = fact.value;
  return bind;
}

/** Render the "human-emitted facts" brief appended to a downstream node's prompt once a human node
 *  completes and hands its typed facts forward (#289 §3), mirroring `renderResolvedDepsBrief`. It pins
 *  each `name → value` the human declared + captured so a downstream agent/edge consumes EXACTLY that
 *  value — no re-derivation, no human re-entry. Returns "" for a no-emit node so callers concatenate
 *  unconditionally (the same `if X = null then "" else X` FEEL convention as the other briefs). */
export function renderHumanEmitBrief(facts: readonly BoundFact[]): string {
  if (facts.length === 0) return "";
  const lines = [
    "",
    "",
    "---",
    "",
    "**Human-emitted facts (authoritative — a scheduled human step handed these forward):**",
    "",
    "A `human` node upstream captured and emitted the typed values below. Consume/pin exactly these —",
    "do NOT re-derive, float, or re-request them:",
    "",
  ];
  for (const fact of facts) lines.push(`- \`${fact.name}\` (${fact.type}) → \`${fact.value}\``);
  lines.push("");
  lines.push("These are the contract the human handed forward; a different value is a different run.");
  return lines.join("\n");
}
