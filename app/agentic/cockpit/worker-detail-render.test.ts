import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeDocument, FakeElement } from "../../../test/agentic-cockpit-doubles.ts";
import { renderWorkerDetail } from "./worker-detail-render.ts";
import { supplyView, type SupplyReport } from "./supply-view.ts";
import { workerDetailView } from "./worker-detail-view.ts";

const doc = new FakeDocument();

const report: SupplyReport = {
  count: 1,
  workers: [
    {
      instance: "wk-a",
      identity: "leaf-1",
      stream: "job:6494",
      family: "senior",
      host: "h1",
      jobKeys: ["6494"],
      live: true,
      staleMs: 0,
    },
  ],
  leaves: [
    {
      token: "leaf-1",
      workers: [
        {
          instance: "wk-a",
          identity: "leaf-1",
          stream: "job:6494",
          family: "senior",
          host: "h1",
          jobKeys: ["6494"],
          live: true,
          staleMs: 0,
        },
      ],
    },
  ],
  correlations: [
    {
      jobKey: "6494",
      stream: "job:6494",
      bpmnProcessId: "plan-fanout",
      processInstanceKey: "4612",
      planKey: "o/r#142",
    },
  ],
};

test("derives and renders the worker detail header and current job drill", () => {
  const host = new FakeElement("body");
  const drilled: string[] = [];
  const backed: string[] = [];
  const detail = workerDetailView(supplyView(report), "wk-a");
  renderWorkerDetail(host, doc, detail, { onBack: () => backed.push("back"), onDrill: (stream) => drilled.push(stream) });

  assert.equal(host.byData("worker-detail", "wk-a").length, 1);
  assert.equal(host.byClass("cockpit-worker-detail-identity")[0]?.text(), "leaf-1");
  assert.equal(host.byClass("cockpit-worker-detail-family")[0]?.text(), "senior");
  assert.equal(host.byClass("cockpit-worker-detail-host")[0]?.text(), "h1");
  assert.equal(host.byData("liveness", "live").length >= 1, true);

  const job = host.byClass("cockpit-worker-current-job")[0];
  assert.equal(job?.getAttribute("data-job-key"), "6494");
  assert.equal(job?.getAttribute("data-stream"), "job:6494");
  assert.equal(job?.text(), "plan-fanout · inst 4612 · o/r#142");
  job?.dispatch("click");
  assert.deepEqual(drilled, ["job:6494"]);

  host.byClass("cockpit-worker-detail-back")[0]?.dispatch("click");
  assert.deepEqual(backed, ["back"]);
});

test("renders a missing-worker detail state with a back action", () => {
  const host = new FakeElement("body");
  const backed: string[] = [];
  renderWorkerDetail(host, doc, workerDetailView(supplyView(report), "missing"), { onBack: () => backed.push("back") });

  assert.equal(host.byData("worker-missing", "missing").length, 1);
  assert.equal(host.byClass("cockpit-worker-detail-empty")[0]?.text(), "Worker missing is not in the current supply report.");
  host.byClass("cockpit-worker-detail-back")[0]?.dispatch("click");
  assert.deepEqual(backed, ["back"]);
});
