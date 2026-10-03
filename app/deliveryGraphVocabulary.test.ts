// app/deliveryGraphVocabulary.test.ts — the DRIFT GUARD for the delivery-graph vocabulary surface
// (epic nano-workforce#605, S3/#609). The vocabulary (`getDeliveryGraphVocabulary`) exists so agents
// discover the closed node/probe/connector vocabulary from the surface instead of reading source; if
// a new probe kind or connector target lands in the compiler WITHOUT a matching vocabulary entry, the
// surface silently lies. These tests fail the build in exactly that case: they assert the vocabulary's
// key sets are byte-identical to the closed sets in `app/deliveryGraph.ts` / `app/readiness.ts` /
// `app/convergeTargets.ts` (AGENTS.md — "no drift surfaces").
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { CONVERGE_MERGE_TARGET, CONVERGE_TARGET, isConvergeTarget, MERGE_MAIN_TARGET } from "./convergeTargets.ts";
import { DELIVERY_FACT_TYPES, DELIVERY_GUARD_SCALAR_TYPES, DELIVERY_NODE_KINDS } from "./deliveryGraph.ts";
import { deliveryGraphVocabulary } from "./deliveryGraphVocabulary.ts";
import {
  DEFAULT_EVERY_MS,
  DEFAULT_TIMEOUT_MS,
  EPIC_CONDITIONS,
  ON_TIMEOUTS,
  PR_CONDITIONS,
  PROBE_KINDS,
} from "./readiness.ts";

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

test("node kinds cover exactly DELIVERY_NODE_KINDS (add a kind to the compiler ⇒ must add a vocab entry)", () => {
  const vocab = deliveryGraphVocabulary();
  assert.deepEqual(
    sorted(vocab.nodeKinds.map((n) => n.kind)),
    sorted(DELIVERY_NODE_KINDS),
    "vocabulary node kinds drifted from DELIVERY_NODE_KINDS — extend NODE_KIND_DETAIL",
  );
});

test("wait probe kinds cover exactly PROBE_KINDS (add a probe kind ⇒ must add a vocab entry)", () => {
  const vocab = deliveryGraphVocabulary();
  assert.deepEqual(
    sorted(vocab.waitProbeKinds.map((p) => p.kind)),
    sorted(PROBE_KINDS),
    "vocabulary wait probe kinds drifted from PROBE_KINDS — extend WAIT_PROBE_DETAIL",
  );
});

test("pr / epic probe conditions match the closed PR_CONDITIONS / EPIC_CONDITIONS", () => {
  const vocab = deliveryGraphVocabulary();
  const pr = vocab.waitProbeKinds.find((p) => p.kind === "pr");
  const epic = vocab.waitProbeKinds.find((p) => p.kind === "epic");
  assert.ok(pr && epic, "pr and epic probe entries must exist");
  assert.deepEqual(sorted(pr.conditions ?? []), sorted(PR_CONDITIONS), "pr conditions drifted from PR_CONDITIONS");
  assert.deepEqual(sorted(epic.conditions ?? []), sorted(EPIC_CONDITIONS), "epic conditions drifted from EPIC_CONDITIONS");
});

test("every real converge-enrollment target has a real vocab entry (add a target ⇒ must add a vocab entry)", () => {
  const vocab = deliveryGraphVocabulary();
  const realTargets = vocab.connectorTargets.filter((t) => t.status === "real").map((t) => t.target);
  for (const target of [CONVERGE_TARGET, CONVERGE_MERGE_TARGET, MERGE_MAIN_TARGET]) {
    assert.ok(
      realTargets.includes(target),
      `converge target '${target}' is missing a 'real' vocabulary entry — extend REAL_CONNECTOR_TARGETS`,
    );
    // Guard the classification too: a target the compiler treats as converge-enrollment must be marked real.
    assert.ok(isConvergeTarget(target), `sanity: '${target}' must be an isConvergeTarget`);
  }
  // Exactly the converge set is "real"; nothing else is claimed real, and the stub sentinel is present.
  assert.deepEqual(sorted(realTargets), sorted([CONVERGE_TARGET, CONVERGE_MERGE_TARGET, MERGE_MAIN_TARGET]));
  assert.ok(
    vocab.connectorTargets.some((t) => t.status === "forward-declared"),
    "the forward-declared stub sentinel must be present so agents learn the real-vs-stub split",
  );
});

test("onTimeout options match the closed ON_TIMEOUTS", () => {
  const vocab = deliveryGraphVocabulary();
  assert.deepEqual(sorted(vocab.onTimeout.map((o) => o.value)), sorted(ON_TIMEOUTS), "onTimeout options drifted from ON_TIMEOUTS");
});

test("fact types + guard scalar types are derived verbatim", () => {
  const vocab = deliveryGraphVocabulary();
  assert.deepEqual(vocab.factTypes, [...DELIVERY_FACT_TYPES]);
  assert.deepEqual(vocab.guardScalarTypes, [...DELIVERY_GUARD_SCALAR_TYPES]);
});

test("poll-budget carries the real defaults and names the 30-minute trap", () => {
  const vocab = deliveryGraphVocabulary();
  assert.equal(vocab.pollBudget.defaultTimeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(vocab.pollBudget.defaultEveryMs, DEFAULT_EVERY_MS);
  assert.match(vocab.pollBudget.rule, /poll\.timeoutMs/);
  assert.match(vocab.pollBudget.rule, /30 minutes|1800000/);
});

test("the epic probe states the FEATURE-RUN observation semantics (the #605 evidence gap)", () => {
  const vocab = deliveryGraphVocabulary();
  const epic = vocab.waitProbeKinds.find((p) => p.kind === "epic");
  assert.ok(epic, "epic probe entry must exist");
  assert.match(epic.observes, /rootRequestKey/i);
  assert.match(epic.observes, /regardless of/i);
  assert.match(epic.observes, /feature/i);
  assert.match(epic.ready, /stage:"merged"|stage:\\"merged\\"|merged.*active:false/);
});

test("fact-threading rule names the unbound-pr rejection", () => {
  const vocab = deliveryGraphVocabulary();
  assert.match(vocab.factThreading.rule, /unbound-pr/);
});

// Resolve a node kind's per-kind CONFIG sub-schema (the authoritative OpenAPI contract for that
// kind's body) from the parsed spec. `DeliveryNode<Kind>` is `allOf: [DeliveryNodeCommon, { properties:
// { <configKey>: {…} } }]`, so find the allOf member carrying the `<configKey>` sub-schema and return
// that member's `<configKey>` VALUE. For most kinds that value is the inline config object; for the
// `wait` kind it is the `{ $ref: "#/components/schemas/ReadinessProbe" }` object (the config is
// referenced, not inlined), which this helper returns AS-IS — the caller follows the reference itself.
// Returns null only when the kind's node schema has NO inline `<configKey>` member at all (which the
// caller's assert.ok rejects), never for the `wait` kind.
function nodeConfigSchema(
  spec: Record<string, any>,
  nodeSchemaName: string,
  configKey: string,
): Record<string, any> | null {
  const schema = spec?.components?.schemas?.[nodeSchemaName];
  if (!schema) return null;
  const sub = (schema.allOf as Array<Record<string, any>> | undefined)?.map((m) => m?.properties?.[configKey]).find(Boolean);
  return sub ?? null;
}

/** Derive the (sorted) required + optional field sets from a config sub-schema's own `required`/`properties`. */
function fieldSets(configSchema: Record<string, any>): { required: string[]; optional: string[] } {
  const required = [...((configSchema.required as string[] | undefined) ?? [])].sort();
  const optional = Object.keys((configSchema.properties as Record<string, unknown>) ?? {})
    .filter((k) => !required.includes(k))
    .sort();
  return { required, optional };
}

test("every node-kind entry's field sets are DERIVED from its OpenAPI DeliveryNode<Kind>.<configKey> contract (#739/#850)", () => {
  // The #850 failure mode is drift between a `DeliveryNode<Kind>.<configKey>` (the authoritative
  // OpenAPI contract) and this vocabulary surface. A literal field list duplicated here would NOT
  // catch it: if OpenAPI adds or removes a config property, a hand-copied list stays green while the
  // surface lies. So derive the required/optional sets from the PARSED spec and compare the sets
  // directly — the vocabulary cannot silently drift from the contract it claims to mirror. This
  // guards EVERY kind, not just `agent`: the connector entry omitting the real `timeout` field
  // (PR #851 review) is the same drift class the agent-only guard missed.
  const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);
  const spec = parseYaml(readFileSync(`${ROOT}openapi.yaml`, "utf8")) as Record<string, any>;

  const vocab = deliveryGraphVocabulary();
  for (const entry of vocab.nodeKinds) {
    const nodeSchemaName = `DeliveryNode${entry.kind[0]!.toUpperCase()}${entry.kind.slice(1)}`;
    let configSchema = nodeConfigSchema(spec, nodeSchemaName, entry.configKey);
    assert.ok(
      configSchema,
      `openapi.yaml components.schemas.${nodeSchemaName} must carry an inline '${entry.configKey}' config sub-schema`,
    );
    // The `wait` kind's config is `$ref: "#/components/schemas/ReadinessProbe"` — follow the reference.
    if (typeof configSchema!.$ref === "string") {
      const refName = configSchema!.$ref.replace(/^#\/components\/schemas\//, "");
      configSchema = spec?.components?.schemas?.[refName];
      assert.ok(configSchema?.properties, `${refName} (the wait config contract) must declare its properties`);
    }
    const { required, optional } = fieldSets(configSchema!);
    assert.deepEqual(
      [...entry.requiredFields].sort(),
      required,
      `${entry.kind}.requiredFields drifted from ${nodeSchemaName}.${entry.configKey}.required in openapi.yaml`,
    );
    assert.deepEqual(
      [...entry.optionalFields].sort(),
      optional,
      `${entry.kind}.optionalFields drifted from ${nodeSchemaName}.${entry.configKey}'s optional properties in openapi.yaml`,
    );
  }

  // The non-obvious rules an authoring agent must learn from the surface prose: an ABSENT repository
  // is not compile-rejected (a run-level fallback can satisfy it) — it fails at the OPERATOR's
  // Dispatch; and the per-node SLA timeout override exists.
  const agent = vocab.nodeKinds.find((n) => n.kind === "agent");
  assert.ok(agent, "agent node-kind entry must exist");
  assert.match(agent.summary, /resolve to no repository/, "names the dispatch-time failure the author must pre-empt");
  assert.match(agent.summary, /invalid-node-repository/, "names the compile-time validation for a present value");
  assert.match(agent.summary, /repoless/, "names the checkout-less opt-out");
  assert.match(agent.summary, /per-node ISO-8601 `timeout`/, "names the per-node SLA timeout override (#505)");
});
