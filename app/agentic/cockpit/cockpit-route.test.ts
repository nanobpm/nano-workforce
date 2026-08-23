import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCockpitRoute } from "./cockpit-route.ts";

test("parses empty and main cockpit hashes as the main route", () => {
  assert.deepEqual(parseCockpitRoute(""), { kind: "main" });
  assert.deepEqual(parseCockpitRoute("#/cockpit"), { kind: "main" });
  assert.deepEqual(parseCockpitRoute("#/cockpit/"), { kind: "main" });
});

test("parses URL-decoded worker detail hashes", () => {
  assert.deepEqual(parseCockpitRoute("#/cockpit/worker/wk-a"), { kind: "worker", instance: "wk-a" });
  assert.deepEqual(parseCockpitRoute("#/cockpit/worker/leaf%2Fwk%201"), { kind: "worker", instance: "leaf/wk 1" });
});

test("empty worker and junk hashes fall back to the main route", () => {
  assert.deepEqual(parseCockpitRoute("#/cockpit/worker/"), { kind: "main" });
  assert.deepEqual(parseCockpitRoute("#/elsewhere"), { kind: "main" });
  assert.deepEqual(parseCockpitRoute("#/cockpit/worker/%E0%A4%A"), { kind: "main" });
});
