// Unit tests for the SUPPLY cockpit boot layer's engine-native AGENT-HISTORY panel (issue #745/#747).
//
// The testable heart of the consumer half: the cockpit renders a settled agent-history list (sourced
// from engine searchAgentInstances) beside the live supply + relay past-sessions panels; selecting a
// run renders its ordered conversation turns + metrics (sourced from engine searchAgentInstanceHistory)
// keyed by agentInstanceKey — never a relay stream id. No browser, no engine, no socket.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeDocument, FakeElement, FakeSocket } from "../../../test/agentic-cockpit-doubles.ts";
import type {
  AgentHistory as AgentHistoryReport,
  AgentInstanceList as AgentInstanceListReport,
} from "../../../nano-generated/api-io.d.ts";
import { bootSupplyCockpit, type SupplyCockpitEnv } from "./supply-boot.ts";
import type { SupplyReport } from "./supply-view.ts";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const supply: SupplyReport = { count: 0, workers: [], leaves: [] };

const instances: AgentInstanceListReport = {
  count: 2,
  instances: [
    { agentInstanceKey: "ai-old", status: "COMPLETED", processInstanceKey: "pi-1", elementId: "implement-task", completionDate: "2024-01-01T00:00:00Z", metrics: { inputTokens: 100, outputTokens: 20, modelCalls: 2, toolCalls: 1 } },
    { agentInstanceKey: "ai-new", status: "IDLE", processInstanceKey: "pi-2", lastUpdatedDate: "2024-02-01T00:00:00Z" },
  ],
};

const history: AgentHistoryReport = {
  agentInstanceKey: "ai-old",
  count: 1,
  instance: instances.instances[0],
  records: [
    { historyItemKey: "h-0", agentInstanceKey: "ai-old", loopIteration: 0, role: "ASSISTANT", commitStatus: "COMMITTED", content: [{ contentType: "TEXT", text: "did the thing" }], toolCalls: [] },
  ],
};

interface Rig {
  readonly env: SupplyCockpitEnv;
  readonly host: FakeElement;
  requestedHistoryKey: string | undefined;
  errors: unknown[];
}

function rig(withAgentHistory = true): Rig {
  const host = new FakeElement("body");
  const state: Rig = {
    host,
    requestedHistoryKey: undefined,
    errors: [],
    env: {
      host,
      doc: new FakeDocument(),
      fetchSupply: () => Promise.resolve(supply),
      ...(withAgentHistory
        ? {
            fetchAgentInstances: () => Promise.resolve(instances),
            fetchAgentHistory: (agentInstanceKey: string) => {
              state.requestedHistoryKey = agentInstanceKey;
              return Promise.resolve(history);
            },
          }
        : {}),
      connectRelay: () => new FakeSocket(),
      createTerminal: (terminalHost) => {
        terminalHost.appendChild(new FakeElement("pre"));
        return { write: () => {}, dispose: () => {} };
      },
      setTimer: () => 0,
      clearTimer: () => {},
      onError: (err) => state.errors.push(err),
    },
  };
  return state;
}

test("refresh renders the engine agent-history list, sorted newest-first", async () => {
  const r = rig();
  const cockpit = bootSupplyCockpit(r.env);
  await cockpit.refresh();
  await flush();
  const rows = r.host.byClass("cockpit-agent-session");
  assert.equal(rows.length, 2, "one row per engine agent instance");
  assert.equal(rows[0]?.getAttribute("data-agent-instance-key"), "ai-new", "newest-updated run first");
  assert.equal(r.host.byData("summary", "agent-history").length, 1);
  assert.deepEqual(r.errors, []);
});

test("selecting a run renders its engine history keyed by agentInstanceKey", async () => {
  const r = rig();
  const cockpit = bootSupplyCockpit(r.env);
  await cockpit.refresh();
  await flush();

  await cockpit.viewAgentHistory("ai-old");
  await flush();
  assert.equal(r.requestedHistoryKey, "ai-old", "history fetched by agent-instance key, not a stream id");
  assert.equal(cockpit.currentAgentInstanceKey, "ai-old");
  const transcript = r.host.byClass("cockpit-agent-transcript")[0];
  assert.equal(transcript?.getAttribute("data-agent-instance-key"), "ai-old");
  assert.equal(r.host.byClass("cockpit-agent-turn-text")[0]?.text(), "did the thing");
  assert.deepEqual(r.errors, []);
});

test("clicking a run button drives viewAgentHistory", async () => {
  const r = rig();
  const cockpit = bootSupplyCockpit(r.env);
  await cockpit.refresh();
  await flush();
  const button = r.host.byClass("cockpit-agent-select").find((b) => b.getAttribute("data-agent-instance-key") === "ai-old");
  button?.dispatch("click");
  await flush();
  assert.equal(cockpit.currentAgentInstanceKey, "ai-old");
});

test("the embedded shell renders the terminal directly beneath the supply list, matching mount.js", async () => {
  const r = rig();
  bootSupplyCockpit(r.env);
  const shell = r.host.byClass("cockpit-shell")[0];
  const order = (shell?.children ?? []).map((c) => c.className);
  assert.deepEqual(order, [
    "cockpit-supply-region",
    "cockpit-terminal",
    "cockpit-agent-region",
    "cockpit-agent-detail-region",
  ]);
});

test("no agent-history panel is rendered when the engine read endpoints are unwired", async () => {
  const r = rig(false);
  const cockpit = bootSupplyCockpit(r.env);
  await cockpit.refresh();
  await flush();
  assert.equal(r.host.byClass("cockpit-agent-region").length, 0);
  assert.equal(cockpit.currentAgentInstanceKey, undefined);
});

test("fetchAgentInstances without fetchAgentHistory fails loudly (matched-pair guard)", () => {
  const r = rig(false);
  assert.throws(
    () => bootSupplyCockpit({ ...r.env, fetchAgentInstances: () => Promise.resolve(instances) }),
    /fetchAgentInstances and fetchAgentHistory must be provided together/,
  );
});
