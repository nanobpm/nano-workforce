// Pure view-model tests for the cockpit engine-native agent-history view (issue #745/#747).
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentHistory as AgentHistoryReport,
  AgentInstanceList as AgentInstanceListReport,
} from "../../../nano-generated/api-io.d.ts";
import { agentHistoryView, agentSessionsView } from "./agent-history-view.ts";

const list = (instances: AgentInstanceListReport["instances"]): AgentInstanceListReport => ({
  count: instances.length,
  instances,
});

test("agentSessionsView labels, rolls up metrics, and sorts newest-captured first", () => {
  const view = agentSessionsView(
    list([
      {
        agentInstanceKey: "old",
        status: "COMPLETED",
        processInstanceKey: "pi-1",
        processDefinitionId: "feature",
        elementId: "implement-task",
        completionDate: "2024-01-01T00:00:00Z",
        metrics: { inputTokens: 1500, outputTokens: 340, modelCalls: 3, toolCalls: 5 },
      },
      {
        agentInstanceKey: "new",
        status: "THINKING",
        processInstanceKey: "pi-2",
        lastUpdatedDate: "2024-02-01T00:00:00Z",
      },
    ]),
  );
  assert.deepEqual(
    view.sessions.map((s) => s.agentInstanceKey),
    ["new", "old"],
  );
  const old = view.sessions[1];
  assert.equal(old?.label, "feature \u00b7 implement-task \u00b7 inst pi-1");
  assert.equal(old?.metrics, "1.5k in \u00b7 340 out \u00b7 3 calls \u00b7 5 tools");
  assert.equal(old?.capturedAt, "2024-01-01T00:00:00Z");
  // No metrics reported -> no metrics string.
  assert.equal(view.sessions[0]?.metrics, undefined);
});

test("agentHistoryView projects turns in transport order with text, tool calls and per-turn metrics", () => {
  const report: AgentHistoryReport = {
    agentInstanceKey: "ai-1",
    count: 2,
    instance: {
      agentInstanceKey: "ai-1",
      status: "COMPLETED",
      processInstanceKey: "pi-1",
      metrics: { inputTokens: 20, outputTokens: 8, modelCalls: 2, toolCalls: 1 },
    },
    records: [
      {
        historyItemKey: "h-0",
        agentInstanceKey: "ai-1",
        loopIteration: 0,
        role: "USER",
        commitStatus: "COMMITTED",
        content: [{ contentType: "TEXT", text: "do the thing" }],
        toolCalls: [],
      },
      {
        historyItemKey: "h-1",
        agentInstanceKey: "ai-1",
        loopIteration: 1,
        role: "ASSISTANT",
        commitStatus: "COMMITTED",
        content: [
          { contentType: "TEXT", text: "on it" },
          { contentType: "OBJECT", object: { ignored: true } },
        ],
        toolCalls: [{ toolCallId: "t-1", toolName: "grep", elementId: "tool", arguments: {} }],
        metrics: {
          inputTokens: 12,
          outputTokens: 4,
          reasoningTokenCount: 0,
          cacheCreationTokenCount: 0,
          cacheReadTokenCount: 0,
          durationMs: 900,
        },
      },
    ],
  };
  const view = agentHistoryView(report);
  assert.equal(view.count, 2);
  assert.equal(view.instance?.metrics, "20 in \u00b7 8 out \u00b7 2 calls \u00b7 1 tools");
  assert.equal(view.turns[0]?.text, "do the thing");
  // OBJECT blocks drop out of the rendered text; only TEXT joins.
  assert.equal(view.turns[1]?.text, "on it");
  assert.equal(view.turns[1]?.toolCalls[0]?.toolName, "grep");
  assert.equal(view.turns[1]?.metrics, "12 in \u00b7 4 out \u00b7 900ms");
});

test("agentHistoryView read-as-absence: an empty history yields zero turns", () => {
  const view = agentHistoryView({ agentInstanceKey: "ai-9", count: 0, records: [] });
  assert.equal(view.count, 0);
  assert.equal(view.turns.length, 0);
  assert.equal(view.instance, undefined);
});
