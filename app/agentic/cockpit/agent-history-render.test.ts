// DOM-render tests for the cockpit engine-native agent-history renderer (issue #745/#747). Exercises
// the pure renderer against the in-memory FakeDocument/FakeElement doubles — no browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeDocument, FakeElement } from "../../../test/agentic-cockpit-doubles.ts";
import type { AgentHistoryView, AgentSessionsView } from "./agent-history-view.ts";
import { renderAgentHistory, renderAgentSessions } from "./agent-history-render.ts";

const doc = new FakeDocument();

test("renderAgentSessions lists runs and wires onSelect to the instance key", () => {
  const host = new FakeElement("div");
  const view: AgentSessionsView = {
    count: 1,
    sessions: [
      {
        agentInstanceKey: "ai-1",
        label: "feature \u00b7 implement-task",
        status: "COMPLETED",
        processInstanceKey: "pi-1",
        metrics: "1.5k in \u00b7 340 out \u00b7 3 calls \u00b7 5 tools",
        capturedAt: "2024-01-01T00:00:00Z",
      },
    ],
  };
  const selected: string[] = [];
  renderAgentSessions(host, doc, view, { onSelect: (k) => selected.push(k), activeInstanceKey: "ai-1" });

  const rows = host.byClass("cockpit-agent-session");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.getAttribute("data-agent-instance-key"), "ai-1");
  assert.equal(rows[0]?.getAttribute("data-active"), "true");
  const button = host.byClass("cockpit-agent-select")[0];
  assert.ok(button);
  button?.dispatch("click");
  assert.deepEqual(selected, ["ai-1"]);
});

test("renderAgentSessions renders an explicit empty state (read-as-absence)", () => {
  const host = new FakeElement("div");
  renderAgentSessions(host, doc, { count: 0, sessions: [] });
  assert.equal(host.byData("empty", "true").length, 1);
  assert.equal(host.byClass("cockpit-agent-session").length, 0);
});

test("renderAgentHistory renders turns with role, text, tool calls and per-turn metrics", () => {
  const host = new FakeElement("div");
  const view: AgentHistoryView = {
    agentInstanceKey: "ai-1",
    count: 1,
    instance: {
      agentInstanceKey: "ai-1",
      label: "feature",
      status: "COMPLETED",
      processInstanceKey: "pi-1",
      metrics: "20 in \u00b7 8 out \u00b7 2 calls \u00b7 1 tools",
    },
    turns: [
      {
        historyItemKey: "h-1",
        loopIteration: 1,
        role: "ASSISTANT",
        text: "on it",
        toolCalls: [{ toolCallId: "t-1", toolName: "grep", elementId: "tool" }],
        metrics: "12 in \u00b7 4 out \u00b7 900ms",
      },
    ],
  };
  renderAgentHistory(host, doc, view);

  const root = host.byClass("cockpit-agent-transcript")[0];
  assert.equal(root?.getAttribute("data-agent-instance-key"), "ai-1");
  assert.equal(host.byData("summary", "agent-instance-metrics").length, 1);
  const turn = host.byClass("cockpit-agent-turn")[0];
  assert.equal(turn?.getAttribute("data-role"), "ASSISTANT");
  assert.equal(host.byClass("cockpit-agent-turn-text")[0]?.text(), "on it");
  assert.equal(host.byClass("cockpit-agent-turn-tool")[0]?.text(), "grep (tool)");
  assert.equal(host.byClass("cockpit-agent-turn-metrics")[0]?.text(), "12 in \u00b7 4 out \u00b7 900ms");
});

test("renderAgentHistory renders an empty history state", () => {
  const host = new FakeElement("div");
  renderAgentHistory(host, doc, { agentInstanceKey: "ai-9", count: 0, turns: [] });
  assert.equal(host.byData("empty", "true").length, 1);
});
