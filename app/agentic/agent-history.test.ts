// Pure projection tests for the engine-native AgentInstance/AgentHistory READ path (issue #745/#747).
// Exercises app/agentic/agent-history.ts against a fake AgentHistoryReader — no engine, no I/O — so the
// engine→wire projection, keying, ordering, optional-field dropping, and read-as-absence are pinned on
// Node. Behavioural parity against a LIVE engine is validated separately; the testkit WASM double
// records nothing (read-as-absence), which the boot test asserts.
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentHistoryFilter,
  AgentHistoryRecord,
  AgentInstanceFilter,
  AgentInstanceSummary,
} from "@nanobpm/urban";
import {
  type AgentHistoryReader,
  listAgentInstances,
  readAgentHistory,
  toWireInstance,
  toWireRecord,
} from "./agent-history.ts";

class FakeReader implements AgentHistoryReader {
  instanceFilter: AgentInstanceFilter | undefined;
  historyFilter: AgentHistoryFilter | undefined;
  historyKey: string | undefined;
  readonly #instances: readonly AgentInstanceSummary[];
  readonly #history: readonly AgentHistoryRecord[];
  readonly #byKey: Record<string, AgentInstanceSummary>;
  constructor(
    instances: readonly AgentInstanceSummary[],
    history: readonly AgentHistoryRecord[] = [],
    byKey: Record<string, AgentInstanceSummary> = {},
  ) {
    this.#instances = instances;
    this.#history = history;
    this.#byKey = byKey;
  }
  async searchAgentInstances(filter?: AgentInstanceFilter): Promise<readonly AgentInstanceSummary[]> {
    this.instanceFilter = filter;
    return this.#instances;
  }
  async searchAgentInstanceHistory(
    agentInstanceKey: string,
    filter?: AgentHistoryFilter,
  ): Promise<readonly AgentHistoryRecord[]> {
    this.historyKey = agentInstanceKey;
    this.historyFilter = filter;
    return this.#history;
  }
  async getAgentInstance(agentInstanceKey: string): Promise<AgentInstanceSummary | null> {
    return this.#byKey[agentInstanceKey] ?? null;
  }
}

const instance = (over: Partial<AgentInstanceSummary> & { agentInstanceKey: string }): AgentInstanceSummary => ({
  status: "COMPLETED",
  processInstanceKey: "pi-1",
  ...over,
});

const record = (over: Partial<AgentHistoryRecord> & { historyItemKey: string }): AgentHistoryRecord => ({
  agentInstanceKey: "ai-1",
  loopIteration: 0,
  role: "ASSISTANT",
  content: [],
  toolCalls: [],
  commitStatus: "COMMITTED",
  ...over,
});

test("toWireInstance drops unreported optional fields and copies metrics", () => {
  const bare = toWireInstance(instance({ agentInstanceKey: "ai-1", elementId: "", creationDate: "" }));
  assert.deepEqual(bare, { agentInstanceKey: "ai-1", status: "COMPLETED", processInstanceKey: "pi-1" });

  const full = toWireInstance(
    instance({
      agentInstanceKey: "ai-2",
      elementId: "implement-task",
      elementInstanceKeys: ["ei-9"],
      rootProcessInstanceKey: "root-1",
      metrics: { inputTokens: 10, outputTokens: 4, modelCalls: 2, toolCalls: 1 },
      creationDate: "2024-01-01T00:00:00Z",
      completionDate: "2024-01-01T00:05:00Z",
    }),
  );
  assert.equal(full.elementId, "implement-task");
  assert.deepEqual(full.elementInstanceKeys, ["ei-9"]);
  assert.deepEqual(full.metrics, { inputTokens: 10, outputTokens: 4, modelCalls: 2, toolCalls: 1 });
  assert.equal(full.completionDate, "2024-01-01T00:05:00Z");
});

test("toWireRecord preserves conversation grammar and per-turn metrics", () => {
  const wire = toWireRecord(
    record({
      historyItemKey: "h-1",
      loopIteration: 3,
      role: "ASSISTANT",
      content: [
        { contentType: "TEXT", text: "hello" },
        { contentType: "OBJECT", object: { a: 1 } },
      ],
      toolCalls: [{ toolCallId: "t-1", toolName: "grep", elementId: "tool-task", arguments: { q: "x" } }],
      metrics: {
        inputTokens: 5,
        outputTokens: 2,
        reasoningTokenCount: 1,
        cacheCreationTokenCount: 0,
        cacheReadTokenCount: 0,
        durationMs: 1200,
      },
      elementInstanceKey: "ei-3",
    }),
  );
  assert.equal(wire.content.length, 2);
  assert.equal(wire.content[0]?.text, "hello");
  assert.deepEqual(wire.content[1]?.object, { a: 1 });
  assert.equal(wire.toolCalls[0]?.elementId, "tool-task");
  assert.deepEqual(wire.toolCalls[0]?.arguments, { q: "x" });
  assert.equal(wire.metrics?.durationMs, 1200);
  assert.equal(wire.elementInstanceKey, "ei-3");
});

test("listAgentInstances applies only non-blank selectors and sorts newest-created first", async () => {
  const reader = new FakeReader([
    instance({ agentInstanceKey: "old", creationDate: "2024-01-01T00:00:00Z" }),
    instance({ agentInstanceKey: "new", creationDate: "2024-02-01T00:00:00Z" }),
  ]);
  const out = await listAgentInstances(reader, { processInstanceKey: "pi-1", status: "", elementId: undefined });
  assert.deepEqual(reader.instanceFilter, { processInstanceKey: "pi-1" });
  assert.equal(out.count, 2);
  assert.deepEqual(
    out.instances.map((i) => i.agentInstanceKey),
    ["new", "old"],
  );
});

test("readAgentHistory sorts by loopIteration then key, enriches with the owning instance", async () => {
  const owner = instance({ agentInstanceKey: "ai-1", metrics: { inputTokens: 1, outputTokens: 1, modelCalls: 1, toolCalls: 0 } });
  const reader = new FakeReader(
    [],
    [
      record({ historyItemKey: "h-2", loopIteration: 1 }),
      record({ historyItemKey: "h-1", loopIteration: 1 }),
      record({ historyItemKey: "h-0", loopIteration: 0 }),
    ],
    { "ai-1": owner },
  );
  const out = await readAgentHistory(reader, "ai-1", { role: "ASSISTANT", loopIteration: 1, elementInstanceKey: "" });
  assert.equal(reader.historyKey, "ai-1");
  assert.deepEqual(reader.historyFilter, { role: "ASSISTANT", loopIteration: 1 });
  assert.deepEqual(
    out.records.map((r) => r.historyItemKey),
    ["h-0", "h-1", "h-2"],
  );
  assert.equal(out.instance?.agentInstanceKey, "ai-1");
  assert.equal(out.instance?.metrics?.inputTokens, 1);
});

test("readAgentHistory read-as-absence: a blank key yields an empty history and no engine call", async () => {
  const reader = new FakeReader([instance({ agentInstanceKey: "x" })], [record({ historyItemKey: "h" })]);
  const out = await readAgentHistory(reader, "");
  assert.equal(out.count, 0);
  assert.equal(out.agentInstanceKey, "");
  assert.equal(reader.historyKey, undefined);
});
