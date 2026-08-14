// Unit tests for the SUPPLY cockpit boot layer's "past sessions" replay (H3 read path / #222).
//
// The acceptance's testable heart for #222: the cockpit renders a past-sessions history list beside the
// live supply list; selecting a past session statically replays its stored transcript into the SAME
// persistent terminal region (no live worker, no relay socket); and live vs replayed is clearly
// distinguished (currentMode + the panel's data-terminal-mode). No real browser, no real socket.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeDocument, FakeElement, FakeSocket } from "../../../test/agentic-cockpit-doubles.ts";
import { bootSupplyCockpit, type SupplyCockpitEnv } from "./supply-boot.ts";
import type { SupplyReport } from "./supply-view.ts";
import type { TranscriptDataReport } from "./transcript-render.ts";
import type { TranscriptListReport } from "./transcript-view.ts";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const supply: SupplyReport = {
  count: 1,
  workers: [{ instance: "wk-a", identity: "leaf-1", stream: "job:live", family: "senior", host: "h1", jobKeys: ["live"], live: true, staleMs: 0 }],
  leaves: [{ token: "leaf-1", workers: [{ instance: "wk-a", identity: "leaf-1", stream: "job:live", family: "senior", host: "h1", jobKeys: ["live"], live: true, staleMs: 0 }] }],
};

const transcripts: TranscriptListReport = {
  count: 1,
  retentionMs: 86_400_000,
  transcripts: [
    { stream: "job:past", lifecycle: "ephemeral", status: "completed", createdAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:05:00Z", nextOffset: 2, byteLength: 4, chunkCount: 2, jobKey: "past", planKey: "o/r#1" },
  ],
};

const transcriptData: TranscriptDataReport = {
  stream: "job:past",
  from: 0,
  gap: false,
  nextOffset: 2,
  entries: [
    { offset: 0, chunk: "PA" },
    { offset: 1, chunk: "ST" },
  ],
};

interface Rig {
  readonly env: SupplyCockpitEnv;
  readonly host: FakeElement;
  readonly sockets: FakeSocket[];
  readonly terminalWrites: string[];
  terminalMounts: number;
  terminalDisposes: number;
  fetchedTranscript: string | undefined;
  errors: unknown[];
}

function rig(withTranscripts = true): Rig {
  const host = new FakeElement("body");
  const sockets: FakeSocket[] = [];
  const terminalWrites: string[] = [];
  const state: Rig = {
    host,
    sockets,
    terminalWrites,
    terminalMounts: 0,
    terminalDisposes: 0,
    fetchedTranscript: undefined,
    errors: [],
    env: {
      host,
      doc: new FakeDocument(),
      fetchSupply: () => Promise.resolve(supply),
      ...(withTranscripts
        ? {
            fetchTranscripts: () => Promise.resolve(transcripts),
            fetchTranscript: (stream: string) => {
              state.fetchedTranscript = stream;
              return Promise.resolve(transcriptData);
            },
          }
        : {}),
      connectRelay: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      createTerminal: (terminalHost) => {
        state.terminalMounts += 1;
        terminalHost.appendChild(new FakeElement("pre"));
        return {
          write: (chunk) => terminalWrites.push(chunk),
          dispose: () => {
            state.terminalDisposes += 1;
          },
        };
      },
      setTimer: () => 0,
      clearTimer: () => {},
      onError: (err) => state.errors.push(err),
    },
  };
  return state;
}

test("refresh renders the past-sessions history list beside the live supply list", async () => {
  const r = rig();
  const cockpit = bootSupplyCockpit(r.env);
  await cockpit.refresh();
  await flush();
  assert.equal(r.host.byData("worker", "wk-a").length, 1, "live supply list rendered");
  assert.equal(r.host.byData("stream", "job:past").length >= 1, true, "past sessions list rendered");
  assert.equal(r.host.byData("session-count", "1").length, 1);
  assert.deepEqual(r.errors, []);
});

test("replaying a past session feeds its stored bytes into the terminal, in replay mode", async () => {
  const r = rig();
  const cockpit = bootSupplyCockpit(r.env);
  await cockpit.refresh();
  await flush();

  await cockpit.replay("job:past");
  assert.equal(r.fetchedTranscript, "job:past");
  assert.equal(cockpit.currentStream, "job:past");
  assert.equal(cockpit.currentMode, "replay");
  assert.deepEqual(r.terminalWrites, ["PA", "ST"], "the stored transcript renders faithfully");
  // No relay socket opened for a static replay.
  assert.equal(r.sockets.length, 0);
  // The panel plainly marks the region as a replayed past session.
  assert.equal(r.host.byData("terminal-mode", "replay").length, 1);
});

test("clicking a past-session button drives a replay", async () => {
  const r = rig();
  const cockpit = bootSupplyCockpit(r.env);
  await cockpit.refresh();
  await flush();
  const button = r.host.byClass("cockpit-past-replay").find((b) => b.getAttribute("data-stream") === "job:past");
  button?.dispatch("click");
  await flush();
  assert.equal(cockpit.currentMode, "replay");
  assert.deepEqual(r.terminalWrites, ["PA", "ST"]);
});

test("replaying after a live drill tears the live stream down and switches to replay", async () => {
  const r = rig();
  const cockpit = bootSupplyCockpit(r.env);
  await cockpit.refresh();
  await flush();

  cockpit.drill("job:live");
  assert.equal(cockpit.currentMode, "live");
  assert.equal(r.sockets.length, 1);

  await cockpit.replay("job:past");
  assert.equal(cockpit.currentMode, "replay");
  assert.equal(r.sockets[0]?.closed, true, "the live relay socket is closed on switching to replay");
  assert.equal(cockpit.currentStream, "job:past");
});

test("the past-sessions panel is absent when no transcript source is injected (live-only cockpit)", async () => {
  const r = rig(false);
  const cockpit = bootSupplyCockpit(r.env);
  await cockpit.refresh();
  await flush();
  assert.equal(r.host.byData("session-count").length, 0, "no past-sessions region rendered");
  assert.equal(cockpit.currentMode, undefined);
});
