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

test("the agent entry's field sets are DERIVED from the OpenAPI DeliveryNodeAgent.agent contract (#739/#850)", () => {
  // The #850 failure mode is drift between `DeliveryNodeAgent.agent` (the authoritative OpenAPI
  // contract) and this vocabulary surface. A literal field list duplicated here would NOT catch it:
  // if OpenAPI adds or removes an `agent` property, a hand-copied list stays green while the surface
  // lies. So derive the required/optional sets from the PARSED spec and compare the sets directly —
  // the vocabulary cannot silently drift from the contract it claims to mirror.
  const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);
  const spec = parseYaml(readFileSync(`${ROOT}openapi.yaml`, "utf8")) as Record<string, any>;
  const schema = spec?.components?.schemas?.DeliveryNodeAgent;
  assert.ok(schema, "openapi.yaml must define components.schemas.DeliveryNodeAgent");
  // DeliveryNodeAgent is `allOf: [DeliveryNodeCommon, { properties: { agent: {…} } }]` — find the
  // member that carries the `agent` sub-schema (the node's config contract).
  const agentSchema = (schema.allOf as Array<Record<string, any>> | undefined)?.map((m) => m?.properties?.agent).find(Boolean);
  assert.ok(agentSchema?.properties, "DeliveryNodeAgent.agent must declare its config properties");
  const specRequired = [...((agentSchema.required as string[] | undefined) ?? [])].sort();
  const specOptional = Object.keys(agentSchema.properties as Record<string, unknown>)
    .filter((k) => !specRequired.includes(k))
    .sort();

  const vocab = deliveryGraphVocabulary();
  const agent = vocab.nodeKinds.find((n) => n.kind === "agent");
  assert.ok(agent, "agent node-kind entry must exist");
  assert.deepEqual(
    [...agent.requiredFields].sort(),
    specRequired,
    "agent.requiredFields drifted from DeliveryNodeAgent.agent.required in openapi.yaml",
  );
  assert.deepEqual(
    [...agent.optionalFields].sort(),
    specOptional,
    "agent.optionalFields drifted from DeliveryNodeAgent.agent's optional properties in openapi.yaml",
  );
  // The non-obvious rules an authoring agent must learn from the surface prose: an ABSENT repository
  // is not compile-rejected (a run-level fallback can satisfy it) — it fails at the OPERATOR's
  // Dispatch; and the per-node SLA timeout override exists.
  assert.match(agent.summary, /resolve to no repository/, "names the dispatch-time failure the author must pre-empt");
  assert.match(agent.summary, /invalid-node-repository/, "names the compile-time validation for a present value");
  assert.match(agent.summary, /repoless/, "names the checkout-less opt-out");
  assert.match(agent.summary, /per-node ISO-8601 `timeout`/, "names the per-node SLA timeout override (#505)");
});
