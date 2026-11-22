// Issue #1011 / PR review: the implement-task's ioMapping outputs must export the agent's `pr` into
// the cell's process scope. Without it, a keyed task-local `pr` never overwrites the process's seeded
// `pr: null`, so the cell returns null to the parent and skips convergence despite an existing PR.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assert } from "#test-assert";

test("implement-cell exports the agent's pr from implement-task into process scope", () => {
  const xml = readFileSync(new URL("../resources/processes/implement-cell.bpmn", import.meta.url), "utf8");
  const start = xml.indexOf('<bpmn:serviceTask id="implement-task"');
  const end = xml.indexOf("</bpmn:serviceTask>", start);
  assert(start >= 0 && end > start, "implement-task must exist");
  const body = xml.slice(start, end);
  assert(/<zeebe:output source="[^"]*\bpr\b[^"]*" target="pr" \/>/.test(body), "implement-task must output pr");
});

// PR review (#1013): after escalation → Answer, `record-implementing` re-enters implement-task with the
// PREVIOUS attempt's `pr` still in process scope. A keyless `opened` result must not inherit it (the
// `is defined(pr)` output would re-export the stale key and `ic_done` would skip reconciliation). The
// task-local `pr` is therefore reset to null on every entry, so only the current attempt's result sets it.
test("implement-task resets the task-local pr on entry so a re-attempt never inherits a stale key", () => {
  const xml = readFileSync(new URL("../resources/processes/implement-cell.bpmn", import.meta.url), "utf8");
  const start = xml.indexOf('<bpmn:serviceTask id="implement-task"');
  const end = xml.indexOf("</bpmn:serviceTask>", start);
  const body = xml.slice(start, end);
  assert(/<zeebe:input source="=null" target="pr" \/>/.test(body), "implement-task must shadow pr with null on entry");
});
