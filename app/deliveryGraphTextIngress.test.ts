// Coverage for the shared text-ingress helper's "never throws / never a 500" promise
// (`parseAndCompileText`). The four doors that call it (preview/stage/save/import) DON'T wrap the
// call, so a throw from the compiler's layout pass (`layoutDeliveryDiagram` fails loud when
// `layoutBpmn` produces no DI — e.g. the `bpmn-auto-layout` peer is missing) would otherwise escape
// as a raw, unhandled 500. That fault is a server-side infra condition, not reproducible from input
// alone, so we inject a rejecting compiler through the helper's test seam to pin the guard.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { parseAndCompileText } from "./deliveryGraphTextIngress.ts";

const VALID_BODY = { graphJson: JSON.stringify({ name: "x", nodes: [] }) };

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
