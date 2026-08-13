// Unit tests for the SUPPLY cockpit DOM renderer (H5 / #148), on the in-memory fake DOM.
import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeDocument, FakeElement } from "../../../test/agentic-cockpit-doubles.ts";
import { renderSupply } from "./supply-render.ts";
import { type SupplyReport, supplyView } from "./supply-view.ts";

const doc = new FakeDocument();

const sample: SupplyReport = {
  count: 2,
  workers: [
    { instance: "wk-a", identity: "leaf-1", stream: "wk-a", family: "senior", host: "h1", jobKeys: ["job-1"], live: true, staleMs: 0 },
    { instance: "wk-b", identity: "leaf-1", stream: "wk-b", family: "junior", host: "h2", jobKeys: [], live: false, staleMs: 0 },
  ],
  leaves: [
    {
      token: "leaf-1",
      workers: [
        { instance: "wk-a", identity: "leaf-1", stream: "wk-a", family: "senior", host: "h1", jobKeys: ["job-1"], live: true, staleMs: 0 },
        { instance: "wk-b", identity: "leaf-1", stream: "wk-b", family: "junior", host: "h2", jobKeys: [], live: false, staleMs: 0 },
      ],
    },
  ],
};

test("renders one leaf section with a worker row per worker (family, host, jobs, liveness)", () => {
  const host = new FakeElement("body");
  renderSupply(host, doc, supplyView(sample));

  assert.equal(host.byData("leaf", "leaf-1").length, 1);
  const rows = host.byClass("cockpit-supply-worker");
  assert.equal(rows.length, 2);

  const rowA = host.byData("worker", "wk-a")[0];
  assert.equal(rowA?.getAttribute("data-liveness"), "live");
  assert.equal(rowA?.byClass("cockpit-supply-family")[0]?.text(), "senior");
  assert.equal(rowA?.byClass("cockpit-supply-host")[0]?.text(), "h1");
  assert.equal(rowA?.byClass("cockpit-supply-jobs")[0]?.text(), "job-1");

  const rowB = host.byData("worker", "wk-b")[0];
  assert.equal(rowB?.getAttribute("data-liveness"), "down");
  assert.equal(rowB?.byClass("cockpit-supply-jobs")[0]?.text(), "—");
});

test("worker buttons carry the drill stream and fire onDrill on click", () => {
  const host = new FakeElement("body");
  const drilled: string[] = [];
  renderSupply(host, doc, supplyView(sample), { onDrill: (stream) => drilled.push(stream) });

  const button = host.byClass("cockpit-worker").find((b) => b.getAttribute("data-stream") === "wk-a");
  assert.ok(button, "the worker button was rendered with its stream id");
  button?.dispatch("click");
  assert.deepEqual(drilled, ["wk-a"]);
});

test("does NOT render any demand matrix, missing-agent reds, or diversity light", () => {
  const host = new FakeElement("body");
  renderSupply(host, doc, supplyView(sample));
  // Those widgets belong to the packaged demand renderer / enrolment epic #152 — never here.
  assert.equal(host.byClass("cockpit-matrix").length, 0);
  assert.equal(host.byClass("cockpit-network").length, 0);
  assert.equal(host.byClass("cockpit-missing").length, 0);
  assert.equal(
    host.byClass("cockpit-light").filter((l) => l.getAttribute("data-light-id") === "diversity").length,
    0,
  );
});

test("renders an empty state when no workers are connected", () => {
  const host = new FakeElement("body");
  renderSupply(host, doc, supplyView({ count: 0, workers: [], leaves: [] }));
  assert.equal(host.byData("empty", "true").length, 1);
  assert.equal(host.byClass("cockpit-supply-worker").length, 0);
});

test("H6: renders a process/plan cell that drills into the job's stream", () => {
  const host = new FakeElement("body");
  const drilled: string[] = [];
  const correlated: SupplyReport = {
    count: 1,
    workers: [{ instance: "wk-a", identity: "leaf-1", stream: "job:6494", family: "senior", host: "h1", jobKeys: ["6494"], live: true, staleMs: 0 }],
    leaves: [
      {
        token: "leaf-1",
        workers: [{ instance: "wk-a", identity: "leaf-1", stream: "job:6494", family: "senior", host: "h1", jobKeys: ["6494"], live: true, staleMs: 0 }],
      },
    ],
    correlations: [{ jobKey: "6494", stream: "job:6494", bpmnProcessId: "plan-fanout", processInstanceKey: "4612", planKey: "o/r#142" }],
  };
  renderSupply(host, doc, supplyView(correlated), { onDrill: (stream) => drilled.push(stream) });

  const cell = host.byData("worker", "wk-a")[0]?.byClass("cockpit-supply-process")[0];
  assert.ok(cell);
  assert.equal(cell?.getAttribute("data-correlations"), "1");
  const link = host.byClass("cockpit-correlation")[0];
  assert.ok(link, "the correlation drill button was rendered");
  assert.equal(link?.getAttribute("data-job-key"), "6494");
  assert.equal(link?.getAttribute("data-stream"), "job:6494");
  assert.equal(link?.text(), "plan-fanout · inst 4612 · o/r#142");
  link?.dispatch("click");
  assert.deepEqual(drilled, ["job:6494"], "drilling the process/plan cell opens the live job's stream");
});

test("H6: a worker with no correlation renders an em-dash process cell", () => {
  const host = new FakeElement("body");
  renderSupply(host, doc, supplyView(sample));
  const cell = host.byData("worker", "wk-b")[0]?.byClass("cockpit-supply-process")[0];
  assert.equal(cell?.text(), "—");
  assert.equal(cell?.getAttribute("data-correlations"), "0");
});
