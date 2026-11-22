// Issue #1023: every agent dispatch in the convergence loop (review-round, adversarial-review and classify-scope) is
// preceded by a `pr.liveness-check` whose gateway ends the loop at EndPrGone when the PR is merged or
// closed — so no agent job is ever sent for a branch that may already be deleted.
import { test } from "node:test";
import { assert } from "#test-assert";
import { readFileSync } from "node:fs";

const flat = readFileSync("resources/processes/convergence-loop.bpmn", "utf8").replace(/\s+/g, " ");
const flows = [...flat.matchAll(/<bpmn:sequenceFlow\b([^>]*?)(\/>|>(.*?)<\/bpmn:sequenceFlow>)/g)].map((m) => ({
  id: /\bid="([^"]+)"/.exec(m[1])?.[1],
  source: /\bsourceRef="([^"]+)"/.exec(m[1])?.[1],
  target: /\btargetRef="([^"]+)"/.exec(m[1])?.[1],
  cond: m[3] ?? "",
}));
const taskType = (id: string) =>
  new RegExp(`<bpmn:serviceTask\\b[^>]*\\bid="${id}"[\\s\\S]*?<zeebe:taskDefinition type="([^"]+)"`).exec(flat)?.[1];

for (const agent of ["review-round", "adversarial-review", "classify-scope"]) {
  test(`every flow into ${agent} comes from a PR-liveness gate`, () => {
    const inbound = flows.filter((f) => f.target === agent);
    assert(inbound.length > 0);
    for (const f of inbound) {
      const gw = f.source ?? "";
      const gone = flows.find((g) => g.source === gw && g.target === "EndPrGone");
      assert(gone, `${f.id} into ${agent} must leave a gateway with an EndPrGone arm (#1023)`);
      assert(gone!.cond.includes('prGone = "merged"') && gone!.cond.includes('prGone = "closed"'));
      const feeder = flows.find((g) => g.target === gw);
      assert(feeder && taskType(feeder.source ?? "") === "pr.liveness-check", `${gw} must be fed by pr.liveness-check`);
    }
  });
}
