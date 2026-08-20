// Tests for the `human` delivery-graph node (ADR 0005, slice S3): form resolution (specific-else-
// generic + gated agent-router), typed-emit binding, and the #289 late-binding surfaces. Pure logic
// (no engine), plus a structural + cross-layer guard tying the committed BPMN body / `.form` files to
// the completer allowlist and the inbox read-model so the two can't silently diverge.

import { test } from "node:test";
import { readFileSync } from "node:fs";
import { assert, assertEquals, assertStringIncludes } from "#test-assert";
import type { DeliveryFact } from "../nano-generated/api-io.d.ts";
import {
  bindHumanEmits,
  DELIVERY_HUMAN_ELEMENT,
  deriveHumanCategory,
  GENERIC_HUMAN_FORM,
  HUMAN_ACK_FORM,
  HUMAN_PUBLISH_FORM,
  humanEmitBind,
  needsAgentFormRouter,
  normalizeEmits,
  renderHumanEmitBrief,
  resolveHumanForm,
} from "./deliveryHuman.ts";
import { ESCALATION_TASK_ELEMENTS } from "./agentCompletion.ts";
import { USER_TASK_KIND_LABELS } from "./userTasks.ts";

const artifact = (name = "resolvedArtifact"): DeliveryFact => ({ name, type: "artifact" });
const version = (name = "publishedVersion"): DeliveryFact => ({ name, type: "version" });
const str = (name: string): DeliveryFact => ({ name, type: "string" });

// ── Form resolution: explicit → category → generic → agent-router ──────────────────────────────

test("resolveHumanForm: an explicit formKey always wins, even over a category match", () => {
  const r = resolveHumanForm({ emits: [artifact()], human: { formKey: "my-bespoke-form" } });
  assertEquals(r.source, "explicit");
  assertEquals(r.formKey, "my-bespoke-form");
  assertEquals(r.category, null);
});

test("resolveHumanForm: a blank/whitespace explicit formKey does not count as explicit", () => {
  const r = resolveHumanForm({ emits: [], human: { formKey: "   " } });
  assertEquals(r.source, "category");
  assertEquals(r.formKey, HUMAN_ACK_FORM);
});

test("resolveHumanForm: no emits selects the ack (click-done) category form", () => {
  const r = resolveHumanForm({ emits: [], human: {} });
  assertEquals(r.source, "category");
  assertEquals(r.category, "ack");
  assertEquals(r.formKey, HUMAN_ACK_FORM);
});

test("resolveHumanForm: a single artifact emit selects the publish category form", () => {
  const r = resolveHumanForm({ emits: [artifact()], human: {} });
  assertEquals(r.source, "category");
  assertEquals(r.category, "publish");
  assertEquals(r.formKey, HUMAN_PUBLISH_FORM);
});

test("resolveHumanForm: a single bare-version emit falls through to the generic form", () => {
  // The publish form captures a pkg@version `resolvedArtifact`, which fails `version` validation in
  // bindHumanEmits — so a lone `version` must use the generic single-value form, not publish.
  const r = resolveHumanForm({ emits: [version()], human: {} });
  assertEquals(r.source, "generic");
  assertEquals(r.formKey, GENERIC_HUMAN_FORM);
  assertEquals(r.category, null);
});

test("resolveHumanForm: a single non-artifact scalar emit falls through to the generic form", () => {
  const r = resolveHumanForm({ emits: [str("approvalNote")], human: {} });
  assertEquals(r.source, "generic");
  assertEquals(r.formKey, GENERIC_HUMAN_FORM);
  assertEquals(r.category, null);
});

test("regression: a single version resolves to a form whose capture key binds against `version`", () => {
  // Guards the class: the resolved form's canonical capture key must produce a value that coerces
  // against the emitted fact's type. The publish form captures `resolvedArtifact` (pkg@version),
  // which FAILS `version` coercion — so a lone version must route to the generic `value` form.
  const emit = version("publishedVersion");
  const r = resolveHumanForm({ emits: [emit], human: {} });
  assertEquals(r.formKey, GENERIC_HUMAN_FORM);
  // Generic form's `value` capture binds cleanly against the version fact.
  assertEquals(bindHumanEmits([emit], { value: "1.4.0" }).errors, []);
  // Whereas the publish form's `resolvedArtifact` (a pkg@version) would NOT — the mismatch avoided.
  assert(
    bindHumanEmits([emit], { resolvedArtifact: "@nanobpm/urban@0.54.0" }).errors.length > 0,
    "a pkg@version resolvedArtifact must not satisfy a bare-version emit",
  );
});

test("resolveHumanForm: two-plus heterogeneous emits with no form gate the agent-router (null form)", () => {
  const node = { emits: [artifact(), str("changelog")], human: {} };
  const r = resolveHumanForm(node);
  assertEquals(r.source, "agent-router");
  assertEquals(r.formKey, null);
  assert(needsAgentFormRouter(node), "needsAgentFormRouter must agree the router fires");
});

test("resolveHumanForm: an explicit form suppresses the agent-router even with many emits", () => {
  const node = { emits: [artifact(), str("changelog"), version("v")], human: { formKey: "multi" } };
  assertEquals(resolveHumanForm(node).source, "explicit");
  assert(!needsAgentFormRouter(node), "an explicit form must pre-empt the router");
});

test("deriveHumanCategory: ack for empty, publish for one artifact, null for a lone version/scalar", () => {
  assertEquals(deriveHumanCategory([]), "ack");
  assertEquals(deriveHumanCategory([artifact()]), "publish");
  // A lone bare `version` is NOT publish — the publish form captures a pkg@version resolvedArtifact,
  // which fails `version` coercion; it falls through to the generic single-value form.
  assertEquals(deriveHumanCategory([version()]), null);
  assertEquals(deriveHumanCategory([str("x")]), null);
  assertEquals(deriveHumanCategory([artifact(), version()]), null);
});

test("normalizeEmits: drops malformed declarations (non-record, blank name, unknown type)", () => {
  const emits = [
    artifact("good"),
    { name: "", type: "string" },
    { name: "bad", type: "nope" },
    "junk",
    { type: "string" },
  ] as unknown as DeliveryFact[];
  const out = normalizeEmits({ emits });
  assertEquals(out.length, 1);
  assertEquals(out[0].name, "good");
});

test("normalizeEmits: drops names the S0 validator would reject (dotted/non-identifier, over-long, duplicate)", () => {
  const emits = [
    str("good"),
    { name: "dotted.name", type: "string" }, // fails FACT_NAME_PATTERN (would make <nodeId>.<fact> ambiguous)
    { name: "1leading", type: "string" }, // leading digit — not a bare identifier
    { name: "has space", type: "string" }, // whitespace — not an identifier
    { name: `${"x".repeat(129)}`, type: "string" }, // exceeds FACT_NAME_MAX_LENGTH (128)
    { name: "good", type: "version" }, // duplicate name — first (string) wins, this is dropped
  ] as unknown as DeliveryFact[];
  const out = normalizeEmits({ emits });
  assertEquals(out.length, 1);
  assertEquals(out[0].name, "good");
  assertEquals(out[0].type, "string");
});

test("normalizeEmits: a name at exactly the 128-char cap is kept", () => {
  const emits = [{ name: "x".repeat(128), type: "string" }] as unknown as DeliveryFact[];
  const out = normalizeEmits({ emits });
  assertEquals(out.length, 1);
});

// ── Typed emit binding ─────────────────────────────────────────────────────────────────────────

test("bindHumanEmits: a no-emit node yields no facts and no errors regardless of captured form", () => {
  const r = bindHumanEmits([], { note: "did it", value: "ignored" });
  assertEquals(r.facts.length, 0);
  assertEquals(r.errors.length, 0);
});

test("bindHumanEmits: a single artifact binds from the canonical resolvedArtifact capture key", () => {
  const r = bindHumanEmits([artifact()], { resolvedArtifact: "@nanobpm/urban@0.54.0", note: "n" });
  assertEquals(r.errors, []);
  assertEquals(r.facts.length, 1);
  assertEquals(r.facts[0].value, "@nanobpm/urban@0.54.0");
  assertEquals(r.facts[0].type, "artifact");
});

test("bindHumanEmits: a single scalar binds from the generic form's `value` capture key", () => {
  const r = bindHumanEmits([str("approvalNote")], { value: "ship it" });
  assertEquals(r.errors, []);
  assertEquals(r.facts[0].value, "ship it");
});

test("bindHumanEmits: a fact keyed by its own name wins over the canonical fallback", () => {
  const r = bindHumanEmits([version("publishedVersion")], { publishedVersion: "1.4.0", value: "9.9.9" });
  assertEquals(r.facts[0].value, "1.4.0");
});

test("bindHumanEmits: multi-emit binds each fact by its own name (no canonical fallback)", () => {
  const emits = [artifact("art"), str("changelog")];
  const r = bindHumanEmits(emits, { art: "@a/b@1.0.0", changelog: "notes" });
  assertEquals(r.errors, []);
  assertEquals(r.facts.length, 2);
});

test("bindHumanEmits: a missing declared fact is a path-qualified error", () => {
  const r = bindHumanEmits([artifact("art")], { note: "n" });
  assertEquals(r.facts.length, 0);
  assertEquals(r.errors.length, 1);
  assertStringIncludes(r.errors[0], "emits.art");
});

test("bindHumanEmits: an ill-typed artifact/version/url/number/boolean each errors", () => {
  assertStringIncludes(bindHumanEmits([artifact("a")], { a: "no-at-sign" }).errors[0], "pkg@version");
  assertStringIncludes(bindHumanEmits([version("v")], { v: "not a version" }).errors[0], "version");
  assertStringIncludes(bindHumanEmits([{ name: "u", type: "url" }], { u: "not a url" }).errors[0], "URL");
  assertStringIncludes(bindHumanEmits([{ name: "n", type: "number" }], { n: "abc" }).errors[0], "number");
  assertStringIncludes(bindHumanEmits([{ name: "b", type: "boolean" }], { b: "maybe" }).errors[0], "boolean");
});

test("bindHumanEmits: an artifact with an ill-formed version segment errors", () => {
  // A well-formed `pkg@version` shape but a version segment that is not a valid version must reject —
  // the version segment validates the same way a bare `version` fact does (#263, shared VERSION_PATTERN).
  assertStringIncludes(
    bindHumanEmits([artifact("a")], { a: "@nanobpm/urban@not-a-version" }).errors[0],
    "pkg@version",
  );
  assertEquals(bindHumanEmits([artifact("a")], { a: "@nanobpm/urban@not-a-version" }).facts.length, 0);
  // A valid digit-led (optionally `v`-prefixed) version segment still passes.
  assertEquals(bindHumanEmits([artifact("a")], { a: "@nanobpm/urban@0.54.0" }).facts[0].value, "@nanobpm/urban@0.54.0");
  assertEquals(bindHumanEmits([artifact("a")], { a: "pkg@v2.0.0-rc.1" }).facts[0].value, "pkg@v2.0.0-rc.1");
});

test("bindHumanEmits: number/boolean/url coerce to canonical string serialisations", () => {
  assertEquals(bindHumanEmits([{ name: "n", type: "number" }], { n: "42" }).facts[0].value, "42");
  assertEquals(bindHumanEmits([{ name: "b", type: "boolean" }], { b: true }).facts[0].value, "true");
  assertEquals(
    bindHumanEmits([{ name: "u", type: "url" }], { u: "https://x.test/p" }).facts[0].value,
    "https://x.test/p",
  );
});

// ── Late-binding surfaces (#289) ─────────────────────────────────────────────────────────────────

test("humanEmitBind: builds a `<nodeId>.<fact>` qualified bind map (empty for a no-emit node)", () => {
  const { facts } = bindHumanEmits([artifact("resolvedArtifact")], { resolvedArtifact: "@a/b@1.0.0" });
  assertEquals(humanEmitBind("manual-publish", facts), { "manual-publish.resolvedArtifact": "@a/b@1.0.0" });
  assertEquals(humanEmitBind("x", []), {});
});

test("renderHumanEmitBrief: empty for no facts; pins each name→value otherwise", () => {
  assertEquals(renderHumanEmitBrief([]), "");
  const { facts } = bindHumanEmits([artifact("resolvedArtifact")], { resolvedArtifact: "@nanobpm/urban@0.54.0" });
  const brief = renderHumanEmitBrief(facts);
  assertStringIncludes(brief, "Human-emitted facts");
  assertStringIncludes(brief, "`resolvedArtifact` (artifact) → `@nanobpm/urban@0.54.0`");
});

// ── Cross-layer / structural guards ──────────────────────────────────────────────────────────────

const bpmn = readFileSync("resources/processes/delivery-human.bpmn", "utf8");
const flat = bpmn.replace(/\s+/g, " ");

test("BPMN: the human node is a native SLA-bounded userTask backed by the generic form", () => {
  const task = flat.match(
    new RegExp(`<bpmn:userTask\\b[^>]*\\bid="${DELIVERY_HUMAN_ELEMENT}"[\\s\\S]*?</bpmn:userTask>`),
  );
  assert(task, `${DELIVERY_HUMAN_ELEMENT} must be a <bpmn:userTask>`);
  assertStringIncludes(task![0], "<zeebe:userTask", "must be a native (Zeebe) user task");
  assertStringIncludes(task![0], `formId="${GENERIC_HUMAN_FORM}"`, "must attach the generic typed-emit form");
  assertStringIncludes(task![0], 'candidateGroups="operators"', "must surface to operators");
  // The interrupting SLA boundary timer bounds the node — it nags/times out, never silently wedges.
  const boundary = flat.match(
    new RegExp(`<bpmn:boundaryEvent\\b[^>]*\\battachedToRef="${DELIVERY_HUMAN_ELEMENT}"[\\s\\S]*?</bpmn:boundaryEvent>`),
  );
  assert(boundary, "an SLA boundary timer must be attached to the human task");
  assertStringIncludes(boundary![0], "=escalationSlaTimeout", "the SLA reuses the escalation timeout var");
  assertStringIncludes(boundary![0], "<bpmn:timerEventDefinition", "the SLA arm must be a timer");
});

test("BPMN: humanOutcome is set on BOTH the completion and the SLA-timeout path", () => {
  // Symmetry with readiness-gate.bpmn's `gateOutcome`: a caller reading process variables must be
  // able to distinguish a completed human step from one the SLA timer escalated. The userTask sets
  // "completed" on the normal path; the timeout end event must set "escalated" — otherwise the
  // escalation path ends with humanOutcome unset and the two outcomes are indistinguishable.
  assertStringIncludes(
    flat,
    '<zeebe:output source="=&#34;completed&#34;" target="humanOutcome" />',
    "the completion path must set humanOutcome=completed",
  );
  const escalated = flat.match(
    /<bpmn:endEvent\b[^>]*\bid="human-escalated"[\s\S]*?<\/bpmn:endEvent>/,
  );
  assert(escalated, "the SLA-timeout end event human-escalated must exist");
  assertStringIncludes(
    escalated![0],
    '<zeebe:input source="=&#34;escalated&#34;" target="humanOutcome" />',
    "the SLA-timeout path must set humanOutcome=escalated",
  );
});

test("drift guard: the human element is completer-answerable and surfaces on the inbox", () => {
  // The canonical completer refuses any user task outside ESCALATION_TASK_ELEMENTS, so a model that
  // parks on delivery-human-task while the code doesn't accept it would deploy but be unanswerable
  // (by human OR agent, ADR 0046) — the silent-drift failure this guard closes.
  assert(
    ESCALATION_TASK_ELEMENTS.has(DELIVERY_HUMAN_ELEMENT),
    "ESCALATION_TASK_ELEMENTS must accept the delivery human node",
  );
  // And it must carry an inbox label, or the parked task is invisible on the Tasks cockpit.
  assert(
    typeof USER_TASK_KIND_LABELS[DELIVERY_HUMAN_ELEMENT] === "string",
    "USER_TASK_KIND_LABELS must label the delivery human node",
  );
});
