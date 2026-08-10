// Red/green regression for record-plan-review's defensive stringify (PR #26 review).
//
// `str()` normalizes an agent-emitted `findings` variable to a string before it is recorded and
// re-emitted as `planFindings`. `JSON.stringify` can THROW (BigInt, circular refs) or return
// `undefined` (functions/symbols); either would fail the whole job and wedge the process in a
// retry loop. `str()` must never throw and must always yield a string.
import { assertEquals } from "jsr:@std/assert@1";
import { str } from "../workers/record-plan-review/worker.ts";

Deno.test("strings pass through unchanged", () => {
  assertEquals(str("hello"), "hello");
  assertEquals(str(""), "");
});

Deno.test("null/undefined → empty string", () => {
  assertEquals(str(null), "");
  assertEquals(str(undefined), "");
});

Deno.test("plain objects/arrays → JSON", () => {
  assertEquals(str({ a: 1 }), '{"a":1}');
  assertEquals(str([1, 2]), "[1,2]");
});

Deno.test("BigInt does not throw (JSON.stringify would) → String fallback", () => {
  assertEquals(str(10n), "10");
});

Deno.test("circular structure does not throw → String fallback", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const out = str(circular);
  assertEquals(typeof out, "string");
});

Deno.test("value JSON.stringify renders as undefined → String fallback", () => {
  assertEquals(str(() => 1), String(() => 1));
});
