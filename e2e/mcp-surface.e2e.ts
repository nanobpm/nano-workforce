// MCP surface end-to-end regression net (epic #605 slice S1, issue #607).
//
// Drives the app's REAL runtime-served MCP endpoint (`/app/mcp`, ADR 0067) over the full
// Streamable-HTTP client handshake — `initialize` → `Mcp-Session-Id` → `notifications/initialized`
// → `tools/list` → `tools/call` — against a hermetic in-process instance, via the reusable
// `e2e/support/mcp-harness.ts` module. It PINS the client-visible contract the S0 defect broke:
//
//   • every projected tool schema is `$ref`-free with an explicit `type` (S0 / nano-ide#502);
//   • an object argument arrives AS AN OBJECT — and a stringified one is faithfully PARSED, not
//     rejected, now that ADR 0067 / nano-ide#503 landed upstream in @nanobpm/urban 0.87;
//   • validation failures answer uniformly with `issues[{path,message}]`;
//   • the reads parse; the mutating framework tools are gated; side-effecting calls leave NO live
//     staged proposal behind (safe to run repeatedly).
//
// It is the harness siblings extend: S2 (#608), S4 (#610) and S5 (#611) add their own per-tool case
// by importing `bootMcpHarness` — they do NOT re-implement the handshake. See the module header of
// `support/mcp-harness.ts` for the extension seam.
//
// Run with `npm run e2e`.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  assertObjectBodyAccepted,
  assertSchemaSelfContained,
  assertValidationIssues,
  bootMcpHarness,
  type McpHarness,
  type McpTool,
  MINIMAL_VALID_GRAPH,
  schemaHasRef,
  STRINGIFIED_BODY_MESSAGE,
} from "./support/mcp-harness.ts";

// The read tools the surface must expose and answer (issue #607 scope). Each is safe and repeatable.
const READ_TOOLS = [
  "getVersion",
  "getAgentInstructions",
  "listActivePrs",
  "listStagedProposals",
  "getLineage",
] as const;

// The object-body doors covered by a `tools/call` (issue #607 scope). `previewDeliveryGraph` is the
// PURE positive proof (a valid graph, nothing staged). The rest are side-EFFECTING (they stage a
// proposal or start a process on a VALID body), so the harness drives them with a deliberately
// INVALID — but object-shaped — body: validation rejects it, which (a) proves the object argument
// reached the door AS AN OBJECT and (b) persists nothing, keeping the harness repeatable.
const OBJECT_BODY_DOORS = [
  "compileDeliveryGraph",
  "startConvergenceLoop",
  "startPlanFanout",
  "startEpicSet",
  "startFeature",
  "agentCompleteEscalation",
  "appendBlackboard",
] as const;

// S0-PENDING self-containment allowlist (issue #606 / upstream nano-ide#502).
// --------------------------------------------------------------------------
// S1 (this harness) and S0 (openapi.yaml restructuring) are the two WAVE-0 scaffold slices and land
// in parallel — so this test must be GREEN on `main` whether or not S0 has merged yet. On the
// pre-S0 spec these object-body tools still project a leaked `$ref` (`body: { $ref: <component> }`);
// S0 inlines them. For each, the audit tolerates EITHER the self-contained shape (post-S0) OR
// EXACTLY the one known pre-S0 `$ref` (this map's value) — and FAILS on any OTHER `$ref` shape (a
// novel leak, a wrong target). Once S0 lands, delete the graduated entries here so they fall under
// the hard self-containment assertion like every other tool. A tool NOT in this map is hard-asserted
// self-contained NOW — so reintroducing a `$ref` into any clean tool (or a sibling's NEW tool) fails
// the build immediately.
const KNOWN_PENDING_S0: Readonly<Record<string, string>> = {
  compileDeliveryGraph: "#/components/schemas/DeliveryGraph",
  previewDeliveryGraph: "#/components/schemas/DeliveryGraphPreviewSubmit",
  startConvergenceLoop: "#/components/schemas/ConvergenceStart",
  startPlanFanout: "#/components/schemas/PlanStart",
  startEpicSet: "#/components/schemas/EpicSetStart",
  startFeature: "#/components/schemas/FeatureStart",
  agentCompleteEscalation: "#/components/schemas/AgentCompleteRequest",
  appendBlackboard: "#/components/schemas/BlackboardAppendRequest",
  saveToLibrary: "#/components/schemas/SaveToLibrarySubmit",
  importToLibrary: "#/components/schemas/ImportToLibrarySubmit",
  previewProposalBpmn: "#/components/schemas/DeliveryGraphProposalBpmnRequest",
  enrolAgenticWorker: "#/components/schemas/EnrolRequest",
  revertEscalationCompletion: "#/components/schemas/RevertCompletionRequest",
};

/** Collect every `$ref` string anywhere in a parsed JSON Schema. */
function collectRefs(schema: unknown, acc: string[] = []): string[] {
  if (Array.isArray(schema)) {
    for (const item of schema) collectRefs(item, acc);
  } else if (schema && typeof schema === "object") {
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (key === "$ref" && typeof value === "string") acc.push(value);
      else collectRefs(value, acc);
    }
  }
  return acc;
}

/** Audit one tool's projected schema against the S0 self-containment contract, tolerating exactly
 *  the one documented pre-S0 leak for a {@link KNOWN_PENDING_S0} tool (see that map's comment). */
function auditToolSchema(tool: McpTool): void {
  const pendingRef = KNOWN_PENDING_S0[tool.name];
  if (pendingRef === undefined) {
    // Not pending an S0 fix → the schema must already be self-contained. This is the live guard that
    // fails the build the moment a `$ref` is (re)introduced into a clean or newly-added tool.
    assertSchemaSelfContained(tool.inputSchema, tool.name);
    return;
  }
  // Pending an S0 fix: accept the post-S0 clean shape, OR the exact known pre-S0 `$ref`.
  if (!schemaHasRef(tool.inputSchema)) {
    assertSchemaSelfContained(tool.inputSchema, tool.name);
    return;
  }
  const refs = collectRefs(tool.inputSchema);
  const unexpected = refs.filter((r) => r !== pendingRef);
  assert.equal(
    unexpected.length,
    0,
    `tool "${tool.name}": unexpected \`$ref\`(s) ${JSON.stringify(unexpected)} — only the known ` +
      `pre-S0 leak "${pendingRef}" is tolerated (issue #606 / nano-ide#502). Any other \`$ref\` is a defect.`,
  );
}

describe("MCP surface e2e — the runtime-served /app/mcp handshake, per tool (S1 / #607)", () => {
  let h: McpHarness;
  let tools: McpTool[];
  let toolNames: Set<string>;

  before(async () => {
    h = await bootMcpHarness();
    tools = await h.listTools();
    toolNames = new Set(tools.map((t) => t.name));
  });

  after(async () => {
    await h?.stop();
  });

  test("initialize handshake succeeds and tools/list projects the covered tools", () => {
    assert.ok(h.sessionId, "the initialize handshake must yield an Mcp-Session-Id");
    assert.ok(tools.length > 0, "tools/list must project at least one tool");
    for (const name of [...READ_TOOLS, ...OBJECT_BODY_DOORS, "previewDeliveryGraph"]) {
      assert.ok(toolNames.has(name), `tools/list must expose "${name}"`);
    }
    // The operator-only doors stay OFF the MCP surface (ADR 0067 §2 — `x-mcp` excluded).
    for (const excluded of ["stageDeliveryGraph", "dispatchDeliveryGraph", "dismissProposal"]) {
      assert.ok(!toolNames.has(excluded), `"${excluded}" is operator-only and must NOT be projected`);
    }
  });

  test("every projected tool schema is $ref-free with an explicit type (S0 contract)", () => {
    for (const tool of tools) auditToolSchema(tool);
  });

  test("read tools answer with parseable responses", async () => {
    for (const name of READ_TOOLS) {
      const res = await h.callTool(name, {});
      assert.ok(!res.isError, `read "${name}" must not error: ${res.text}`);
      assert.ok(res.text.length > 0, `read "${name}" must return content`);
      // Every read but the markdown guide answers JSON; the guide answers a non-empty string.
      if (name !== "getAgentInstructions") {
        assert.notEqual(res.json, undefined, `read "${name}" must return parseable JSON: ${res.text.slice(0, 120)}`);
      }
    }
  });

  test("previewDeliveryGraph accepts a structured object body and stays pure (nothing staged)", async () => {
    const res = await h.callTool("previewDeliveryGraph", { body: { graphJson: JSON.stringify(MINIMAL_VALID_GRAPH) } });
    assertObjectBodyAccepted(res, "previewDeliveryGraph");
    assert.ok(!res.isError, `previewDeliveryGraph must compile a valid graph: ${res.text}`);
    const json = res.json as { ok?: boolean; staged?: boolean } | undefined;
    assert.equal(json?.ok, true, `previewDeliveryGraph must report ok:true: ${res.text}`);
    assert.equal(json?.staged, false, "previewDeliveryGraph is a PURE preview — it must never stage");
  });

  test("object-body doors receive the argument as an object, not a string (uniform validation)", async () => {
    // A deliberately-invalid-but-object body per door: validation rejects it (persisting nothing),
    // which proves the object argument reached the door AS AN OBJECT — never the S0 stringified body.
    for (const name of OBJECT_BODY_DOORS) {
      const args = name === "appendBlackboard" ? { token: "harness-invalid", body: {} } : { body: {} };
      const res = await h.callTool(name, args);
      assert.ok(res.isError, `door "${name}" must reject an empty body with a validation error`);
      assertValidationIssues(res, name); // also asserts the object body was NOT stringified
    }
  });

  test("mutating framework tools are gated without the shared secret (set-variables)", async () => {
    // This harness boots WITHOUT `NANO_PR_WEBHOOK_SECRET`. Since #698 declares the `hookSecret`
    // shared-secret scheme (`x-nano-secret-env`), a remote-exposed mutation now fails CLOSED as a
    // misconfiguration ("secret env … is not set") rather than the pre-#698 no-scheme refusal — the
    // credential the guard requires cannot exist until the operator sets the env var. Either fail-closed
    // shape is a valid "gated" outcome; both keep the mutation refused.
    const res = await h.callTool("urban_debug_set_variables", { processInstanceKey: "1", variables: {} });
    assert.ok(res.isError, "urban_debug_set_variables must refuse a credential-free mutation");
    assert.match(
      res.text,
      /shared secret|allowMutations|secret env .* is not set|misconfigured/i,
      `the refusal must name the guard: ${res.text}`,
    );
  });

  // The falsifiable core (issue #607 acceptance): DELIBERATELY reintroducing the SCHEMA half of the S0
  // defect makes the harness fail. These pin the detector's teeth independently of whether S0 has
  // landed — so the guard cannot silently rot into a no-op. The object-body-stringification half
  // (nano-ide#503) is now fixed UPSTREAM — @nanobpm/urban 0.87 lands ADR 0067 "faithful object-body
  // transport" (`normalizeBodyArg`), so the door PARSES a stringified object body and forwards it
  // faithfully instead of rejecting it. That retired the nwf-local reject mitigation (docs/mcp-runbook.md
  // §4): the live door can no longer produce the S0 signature to exercise end-to-end, so that half is
  // now covered by a live faithful-parse assertion plus a synthetic detector-teeth check below.
  describe("reintroducing the S0 defect fails the build", () => {
    test("a $ref in a tool schema is caught by the self-containment assertion", () => {
      const good = { type: "object", properties: { body: { type: "object", properties: { n: { type: "number" } } } } };
      assert.doesNotThrow(() => assertSchemaSelfContained(good, "synthetic-clean"));
      const withRef = { type: "object", properties: { body: { $ref: "#/components/schemas/DeliveryGraph" } }, required: ["body"] };
      assert.throws(() => assertSchemaSelfContained(withRef, "synthetic-ref"), /\$ref/, "a reintroduced $ref must throw");
    });

    test("a typeless schema is caught by the self-containment assertion", () => {
      const typeless = { properties: { body: { type: "object" } } };
      assert.throws(() => assertSchemaSelfContained(typeless, "synthetic-typeless"), /type/, "a typeless schema must throw");
    });

    test("a stringified object body is faithfully parsed by the door (ADR 0067 / nano-ide#503)", async () => {
      // Simulate the old S0 client coercion: send the body as a JSON STRING instead of an object.
      // @nanobpm/urban 0.87's faithful object-body transport (ADR 0067 `normalizeBodyArg`) now PARSES
      // it and forwards it faithfully — no longer the "expected object, got string" rejection the
      // nwf-local S0 mitigation used to raise. Drive the PURE previewDeliveryGraph door so the
      // parsed-and-compiled graph stages nothing.
      const res = await h.callTool("previewDeliveryGraph", {
        body: JSON.stringify({ graphJson: JSON.stringify(MINIMAL_VALID_GRAPH) }),
      });
      assert.ok(!res.isError, `the door must faithfully parse a stringified object body: ${res.text}`);
      assert.ok(
        !res.text.includes(STRINGIFIED_BODY_MESSAGE),
        `faithful transport must not reject with "${STRINGIFIED_BODY_MESSAGE}": ${res.text}`,
      );
      assert.doesNotThrow(
        () => assertObjectBodyAccepted(res, "previewDeliveryGraph"),
        "a faithfully parsed object body must pass assertObjectBodyAccepted",
      );
      const json = res.json as { ok?: boolean; staged?: boolean } | undefined;
      assert.equal(json?.ok, true, `previewDeliveryGraph must compile the parsed graph: ${res.text}`);
      assert.equal(json?.staged, false, "previewDeliveryGraph is PURE — it must never stage");
    });

    test("assertObjectBodyAccepted still flags an S0 stringified-body signature (detector teeth)", () => {
      // The live door can no longer produce the S0 signature (fixed upstream, ADR 0067), so pin the
      // detector's teeth SYNTHETICALLY — mirroring the $ref/typeless guards above — so the helper
      // cannot rot into a no-op if the signature ever re-surfaces from another surface.
      const s0Result = {
        isError: true,
        text: `validation failed: body: ${STRINGIFIED_BODY_MESSAGE}`,
        json: undefined,
        httpStatus: 422,
        raw: undefined,
      };
      assert.throws(
        () => assertObjectBodyAccepted(s0Result, "synthetic-stringified"),
        /stringified/,
        "assertObjectBodyAccepted must flag a stringified-body result",
      );
    });
  });

  test("side-effecting calls leave no live staged proposals behind (repeatable)", async () => {
    const res = await h.callTool("listStagedProposals", {});
    assert.ok(!res.isError, `listStagedProposals must not error: ${res.text}`);
    const json = res.json as { count?: number; proposals?: unknown[] } | undefined;
    assert.equal(json?.count, 0, `the harness must stage nothing: ${res.text}`);
    assert.deepEqual(json?.proposals, [], "no live staged proposals may remain");
  });
});

// Framework mutation-guard authorization (issue #698).
// --------------------------------------------------------------------------
// The framework-owned mutating `urban_debug_*` tools (set_variables/retry_job/resolve_incident/
// cancel_instance) are gated by @nanobpm/urban's OWN mutation guard (`authorizeMutation`), distinct
// from nwf's app-operation guard. On a REMOTE-exposed instance (the harness always boots with
// `URBAN_MCP_ALLOW_REMOTE: "true"`) the loopback bypass is off, so the ONLY door left is the
// shared-secret apiKey scheme — which the guard recognizes only when an apiKey *header* scheme
// declares `x-nano-secret-env`. nwf now declares `x-nano-secret-env: NANO_PR_WEBHOOK_SECRET` on the
// `hookSecret` scheme (this issue), so a mutating call carrying `x-hook-secret: <secret>` is
// authorized past the guard, while a missing/wrong header stays 401. This pins that contract.
const HOOK_SECRET = "issue-698-shared-secret";

describe("MCP surface e2e — framework mutation guard authorizes with the shared secret (#698)", () => {
  let h: McpHarness;

  before(async () => {
    // Remote-exposed (harness default) + a shared secret set: the exact condition of #698, where the
    // loopback bypass is off and the shared-secret scheme is the only authorization door.
    h = await bootMcpHarness({ env: { NANO_PR_WEBHOOK_SECRET: HOOK_SECRET } });
  });

  after(async () => {
    await h?.stop();
  });

  test("a mutating urban_debug_* call is refused WITHOUT the shared-secret header", async () => {
    const res = await h.callTool("urban_debug_set_variables", { processInstanceKey: "1", variables: {} });
    assert.ok(res.isError, "a credential-free mutation must be refused on a remote-exposed instance");
    assert.match(
      res.text,
      /unauthorized|401/i,
      `a missing shared-secret header must 401: ${res.text}`,
    );
  });

  test("a mutating urban_debug_* call is refused WITH A WRONG shared-secret header", async () => {
    const res = await h.callTool(
      "urban_debug_set_variables",
      { processInstanceKey: "1", variables: {} },
      { "x-hook-secret": "not-the-secret" },
    );
    assert.ok(res.isError, "a wrong-secret mutation must still be refused");
    assert.match(
      res.text,
      /unauthorized|401/i,
      `a wrong shared-secret header must 401: ${res.text}`,
    );
  });

  test("a mutating urban_debug_* call carrying the correct x-hook-secret is authorized past the guard", async () => {
    const res = await h.callTool(
      "urban_debug_set_variables",
      { processInstanceKey: "1", variables: {} },
      { "x-hook-secret": HOOK_SECRET },
    );
    // The correct credential clears the shared-secret guard. The call may still fail downstream (the
    // hermetic engine has no instance `1`), but it must NO LONGER be the shared-secret refusal — that
    // is the falsifiable proof the `x-nano-secret-env` declaration made the scheme authorizable.
    assert.doesNotMatch(
      res.text,
      /shared secret|allowMutations|NO_SHARED_SECRET/i,
      `the authorized call must clear the shared-secret guard, got: ${res.text}`,
    );
  });
});
