import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCockpitRoute, parseHostCockpitParam } from "./cockpit-route.ts";

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

test("#833: parses a process-focus hash into the process route", () => {
  assert.deepEqual(parseCockpitRoute("#/cockpit/process/2251799813685249"), { kind: "process", processInstanceKey: "2251799813685249" });
  assert.deepEqual(parseCockpitRoute("#/cockpit/process/"), { kind: "main" });
});

test("#833: the host page's #/cockpit/<process_key> param (an 'Agent' grid link) focuses that process", () => {
  assert.equal(parseHostCockpitParam("#/cockpit/2251799813685249"), "2251799813685249");
  assert.equal(parseHostCockpitParam("#/cockpit/a%20b"), "a b");
  assert.equal(parseHostCockpitParam("#/cockpit"), undefined);
  assert.equal(parseHostCockpitParam("#/cockpit/"), undefined);
  assert.equal(parseHostCockpitParam("#/overview/123"), undefined);
  assert.equal(parseHostCockpitParam("#/cockpit/%E0%A4%A"), undefined);
});
