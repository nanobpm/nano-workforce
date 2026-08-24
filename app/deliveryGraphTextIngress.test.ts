// Coverage for the shared text-ingress helper's "never throws / never a 500" promise
// (`parseAndCompileText`). The four doors that call it (preview/stage/save/import) DON'T wrap the
// call, so a throw from the compiler's layout pass (`layoutDeliveryDiagram` fails loud when
// `layoutBpmn` produces no DI — e.g. the `bpmn-auto-layout` peer is missing) would otherwise escape
// as a raw, unhandled 500. That fault is a server-side infra condition, not reproducible from input
// alone, so we inject a rejecting compiler through the helper's test seam to pin the guard.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { parseAndCompileText } from "./deliveryGraphTextIngress.ts";

// A SHAPE-valid graph (the openapi `DeliveryGraph` schema requires `nodes.minItems: 1`) so it reaches
// the injected compiler seam — the shape gate now runs BEFORE compile, so an empty-nodes body would be
// rejected as malformed and never exercise the never-throws guard.
const VALID_BODY = {
  graphJson: JSON.stringify({
    name: "x",
    nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:feature" } }],
  }),
};

test("a compiler that throws is mapped to a clean 400 — never an unhandled 500", async () => {
  const result = await parseAndCompileText(VALID_BODY, {
    compile: () => Promise.reject(new Error("layoutBpmn produced no bpmndi:BPMNDiagram")),
  });
  assert(!result.ok, "a thrown compile must surface as ok:false, not a resolved success");
  assertEquals(result.status, 400, "a caught compile throw must be the door's clean 400, not a 500");
  assert(
    result.body.error.includes("layoutBpmn produced no bpmndi:BPMNDiagram"),
    "the 400 body must carry the underlying compile failure message",
  );
});

test("a non-Error thrown value is still caught and reported, never rethrown", async () => {
  const result = await parseAndCompileText(VALID_BODY, {
    // biome-ignore lint/suspicious/useError: exercising the non-Error catch branch on purpose.
    compile: () => Promise.reject("kaboom"),
  });
  assert(!result.ok, "a non-Error rejection must also be caught as ok:false");
  assertEquals(result.status, 400, "a non-Error compile throw is still a clean 400");
  assert(result.body.error.includes("kaboom"), "the stringified non-Error cause must be surfaced");
});

// The reused OpenAPI shape gate closes the `graphJson`-string bypass: a nested-type violation the
// semantic validator does NOT re-enumerate is now rejected at the door with a path-qualified error,
// BEFORE compile runs (so a throwing compiler is never reached for these malformed bodies).
for (const [label, graph, needle] of [
  [
    "wait.poll.backoff wrong type",
    { nodes: [{ id: "w", kind: "wait", wait: { kind: "http", target: "http://x", poll: { backoff: 42 } } }] },
    "nodes[0]/wait/poll/backoff",
  ],
  [
    "human.prompt wrong type",
    { nodes: [{ id: "h", kind: "human", human: { prompt: 42 } }] },
    "nodes[0]/human/prompt",
  ],
  [
    "unknown top-level property",
    { nodes: [{ id: "a", kind: "agent", agent: { jobType: "senior:feature" } }], bogus: 1 },
    "bogus",
  ],
] as const) {
  test(`shape gate rejects a nested-shape violation before compile: ${label}`, async () => {
    let compileCalled = false;
    const result = await parseAndCompileText(
      { graphJson: JSON.stringify(graph) },
      {
        compile: () => {
          compileCalled = true;
          return Promise.reject(new Error("compile must not run on a shape-invalid graph"));
        },
      },
    );
    assert(!result.ok, "a shape-invalid graph must be ok:false");
    assertEquals(result.status, 400, "a shape-invalid graph is a clean 400");
    assert(!compileCalled, "the shape gate must short-circuit BEFORE the compiler runs");
    assert(
      Array.isArray(result.body.errors) && result.body.errors.length > 0,
      "the 400 body must carry path-qualified shape errors",
    );
    assert(
      result.body.errors.some((e: { path: string; message: string }) => e.path.includes(needle)),
      `a shape error must point at ${needle}`,
    );
  });
}

test("shape gate accepts a valid graph — a not-yet-resolvable capability probe passes structurally", async () => {
  let compileCalled = false;
  const result = await parseAndCompileText(
    {
      graphJson: JSON.stringify({
        nodes: [
          {
            id: "c",
            kind: "wait",
            wait: { kind: "capability", target: "pkg@1.0.0", match: { capabilityRef: "o/r#1", package: "pkg" } },
          },
        ],
      }),
    },
    {
      compile: () => {
        compileCalled = true;
        return Promise.reject(new Error("reached compile"));
      },
    },
  );
  // The shape gate passed (compile was reached — it only rejects because the seam is a stub), proving a
  // structurally-valid but deferred-resolution probe is NOT falsely rejected at shape time.
  assert(compileCalled, "a shape-valid capability probe must pass the shape gate and reach compile");
  assert(!result.ok, "the injected stub compiler still rejects");
});
