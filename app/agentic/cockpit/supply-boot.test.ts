// Unit tests for the SUPPLY cockpit boot layer (H5 / #148), on the injected fake DOM + fake sockets.
//
// These are the acceptance's testable heart: the cockpit renders the live worker/supply list; drilling
// a worker streams its terminal; the terminal survives a poll refresh AND a reconnect (resume-from-
// offset, no loss/dup); the poll is self-scheduling. No real browser, no real socket, single run.
import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeDocument, FakeElement, FakeSocket } from "../../../test/agentic-cockpit-doubles.ts";
import { TRANSCRIPT_EVENT_MARKER, TRANSCRIPT_EVENT_VERSION } from "../transcript-events.ts";
import { bootSupplyCockpit, type SupplyCockpitEnv } from "./supply-boot.ts";
import type { SupplyReport } from "./supply-view.ts";
import type { TranscriptDataReport } from "./transcript-render.ts";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const served: SupplyReport = {
  count: 1,
  workers: [{ instance: "wk-a", identity: "leaf-1", stream: "wk-a", family: "senior", host: "h1", jobKeys: [], live: true, staleMs: 0 }],
  leaves: [
    {
      token: "leaf-1",
      workers: [{ instance: "wk-a", identity: "leaf-1", stream: "wk-a", family: "senior", host: "h1", jobKeys: [], live: true, staleMs: 0 }],
    },
  ],
};

interface Rig {
  readonly env: SupplyCockpitEnv;
  readonly host: FakeElement;
  readonly sockets: FakeSocket[];
  readonly terminalWrites: string[];
  terminalMounts: number;
  terminalDisposes: number;
  readonly timers: Array<{ run: () => void; ms: number }>;
  reconnect: (() => void) | undefined;
  report: SupplyReport;
  errors: unknown[];
}

function rig(): Rig {
  const host = new FakeElement("body");
  const sockets: FakeSocket[] = [];
  const terminalWrites: string[] = [];
  const timers: Array<{ run: () => void; ms: number }> = [];
  const state: Rig = {
    host,
    sockets,
    terminalWrites,
    terminalMounts: 0,
    terminalDisposes: 0,
    timers,
    reconnect: undefined,
    report: served,
    errors: [],
    env: {
      host,
      doc: new FakeDocument(),
      fetchSupply: () => Promise.resolve(state.report),
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
      schedule: (run) => {
        state.reconnect = run;
      },
      setTimer: (run, ms) => {
        timers.push({ run, ms });
        return timers.length - 1;
      },
      clearTimer: () => {},
      onError: (err) => state.errors.push(err),
    },
  };
  return state;
}

test("refresh renders the live worker/supply list into the host", async () => {
  const r = rig();
  const cockpit = bootSupplyCockpit(r.env);
  await cockpit.refresh();
  assert.equal(r.host.byData("leaf", "leaf-1").length, 1);
  assert.equal(r.host.byData("worker", "wk-a").length, 1);
});

test("a later poll reflects a changed report (a worker going down)", async () => {
  const r = rig();
  const cockpit = bootSupplyCockpit(r.env);
  await cockpit.refresh();
  assert.equal(r.host.byData("worker", "wk-a")[0]?.getAttribute("data-liveness"), "live");

  r.report = {
    count: 1,
    workers: [{ instance: "wk-a", identity: "leaf-1", stream: "wk-a", family: "senior", host: "h1", jobKeys: [], live: false, staleMs: 0 }],
    leaves: [
      {
        token: "leaf-1",
        workers: [{ instance: "wk-a", identity: "leaf-1", stream: "wk-a", family: "senior", host: "h1", jobKeys: [], live: false, staleMs: 0 }],
      },
    ],
  };
  await cockpit.refresh();
  assert.equal(r.host.byData("worker", "wk-a")[0]?.getAttribute("data-liveness"), "down");
});

test("drilling into a worker subscribes its relay stream on connect", async () => {
  const r = rig();
  const cockpit = bootSupplyCockpit(r.env);
  await cockpit.refresh();
  cockpit.drill("wk-a");
  assert.equal(cockpit.currentStream, "wk-a");
  assert.equal(r.sockets.length, 1);

  r.sockets[0]?.fireOpen();
  const subs = r.sockets[0]?.subscribeFrames() ?? [];
  assert.equal(subs.length, 1);
  assert.deepEqual(subs[0]?.payload, { op: "subscribe", stream: "wk-a", from: 0, credit: 1024 });
});

test("clicking a rendered worker drill button drills its stream", async () => {
  const r = rig();
  // Only a worker that currently holds a job renders an inline drill button (an idle worker's stream
  // has no producer — drilling it would blank). Give wk-a a job so its drill affordance is present.
  // A busy worker relays on the jobKey-scoped `job:<jobKey>` stream (the supply endpoint repoints its
  // `stream` there — see supply-view.ts), so the fixture uses that scoped id, not the bare instance id.
  const drillable = { instance: "wk-a", identity: "leaf-1", stream: "job:j-a", family: "senior", host: "h1", jobKeys: ["j-a"], live: true, staleMs: 0 };
  r.report = { count: 1, workers: [drillable], leaves: [{ token: "leaf-1", workers: [drillable] }] };
  const cockpit = bootSupplyCockpit(r.env);
  await cockpit.refresh();
  const button = r.host.byClass("cockpit-worker-drill").find((b) => b.getAttribute("data-stream") === "job:j-a");
  button?.dispatch("click");
  assert.equal(cockpit.currentStream, "job:j-a");
  assert.equal(r.sockets.length, 1);
});

test("an idle worker (no current job) renders NO inline drill button — its stream has no producer", async () => {
  const r = rig(); // the default served fixture worker wk-a has jobKeys: [] → idle
  const cockpit = bootSupplyCockpit(r.env);
  await cockpit.refresh();
  const drills = r.host.byClass("cockpit-worker-drill");
  assert.equal(drills.length, 0, "no drill button is rendered for an idle worker");
  // The worker is still openable (its name button) and simply has nothing live to stream.
  assert.equal(r.host.byData("worker", "wk-a").length, 1);
});

test("relay output is written to the drilled worker's terminal", async () => {
  const r = rig();
  const cockpit = bootSupplyCockpit(r.env);
  await cockpit.refresh();
  cockpit.drill("wk-a");
  r.sockets[0]?.fireOpen();
  r.sockets[0]?.deliver({ lane: "bulk", family: "relay", seq: 0, payload: { stream: "wk-a", offset: 0, chunk: "boot\n" } });
  assert.deepEqual(r.terminalWrites, ["boot\n"]);
});

test("a live drill shows a 'waiting for output' note until the first frame, then clears it", async () => {
  const r = rig();
  const cockpit = bootSupplyCockpit(r.env);
  await cockpit.refresh();
  const note = () => r.host.byClass("cockpit-terminal-note")[0];

  cockpit.drill("wk-a");
  r.sockets[0]?.fireOpen();
  assert.equal(note()?.getAttribute("data-terminal-note"), "waiting", "note armed on a connected-but-quiet stream");
  assert.match(note()?.textContent ?? "", /waiting for live output/i);

  r.sockets[0]?.deliver({ lane: "bulk", family: "relay", seq: 0, payload: { stream: "wk-a", offset: 0, chunk: "hi\n" } });
  assert.equal(note()?.getAttribute("data-terminal-note"), "none", "note cleared the instant the first frame is written");
  assert.equal(note()?.textContent, "");
});

test("switching to a new stream re-arms the 'waiting' note (the prior stream's cleared note does not persist)", async () => {
  const r = rig();
  const cockpit = bootSupplyCockpit(r.env);
  await cockpit.refresh();
  const note = () => r.host.byClass("cockpit-terminal-note")[0];

  cockpit.drill("wk-a");
  r.sockets[0]?.fireOpen();
  r.sockets[0]?.deliver({ lane: "bulk", family: "relay", seq: 0, payload: { stream: "wk-a", offset: 0, chunk: "x" } });
  assert.equal(note()?.getAttribute("data-terminal-note"), "none");

  cockpit.drill("wk-b");
  assert.equal(note()?.getAttribute("data-terminal-note"), "waiting", "the new drill re-arms the waiting note");
});

test("the terminal survives a list refresh — it is not re-mounted and keeps streaming", async () => {
  const r = rig();
  const cockpit = bootSupplyCockpit(r.env);
  await cockpit.refresh();
  cockpit.drill("wk-a");
  r.sockets[0]?.fireOpen();
  r.sockets[0]?.deliver({ lane: "bulk", family: "relay", seq: 0, payload: { stream: "wk-a", offset: 0, chunk: "a" } });

  await cockpit.refresh(); // a poll re-renders the worker list
  assert.equal(r.terminalMounts, 1, "the terminal was not re-mounted by the refresh");

  r.sockets[0]?.deliver({ lane: "bulk", family: "relay", seq: 1, payload: { stream: "wk-a", offset: 1, chunk: "b" } });
  assert.deepEqual(r.terminalWrites, ["a", "b"]);
});

test("the terminal survives a cockpit reconnect — resume-from-offset, no loss, no dup", async () => {
  const r = rig();
  const cockpit = bootSupplyCockpit(r.env);
  await cockpit.refresh();
  cockpit.drill("wk-a");

  const s1 = r.sockets[0];
  s1?.fireOpen();
  s1?.deliver({ lane: "bulk", family: "relay", seq: 0, payload: { stream: "wk-a", offset: 0, chunk: "a" } });
  s1?.deliver({ lane: "bulk", family: "relay", seq: 1, payload: { stream: "wk-a", offset: 1, chunk: "b" } });

  // The cockpit's socket drops; the client schedules a reconnect.
  s1?.fireClose();
  assert.ok(r.reconnect !== undefined, "a reconnect was scheduled");
  r.reconnect?.();
  assert.equal(r.sockets.length, 2, "a fresh socket was opened");

  const s2 = r.sockets[1];
  s2?.fireOpen(); // re-attach → resume from offset 2
  const subs = s2?.subscribeFrames() ?? [];
  assert.deepEqual(subs.at(-1)?.payload, { op: "subscribe", stream: "wk-a", from: 2, credit: 1024 });

  // The hub replays the retained tail (re-sends 1) then continues.
  s2?.deliver({ lane: "bulk", family: "relay", seq: 0, payload: { stream: "wk-a", offset: 1, chunk: "b" } });
  s2?.deliver({ lane: "bulk", family: "relay", seq: 1, payload: { stream: "wk-a", offset: 2, chunk: "c" } });
  assert.deepEqual(r.terminalWrites, ["a", "b", "c"], "no lost and no duplicated output across reconnect");
});

test("drilling the same stream twice does not re-open; a different stream switches + disposes the prior", async () => {
  const r = rig();
  const cockpit = bootSupplyCockpit(r.env);
  await cockpit.refresh();
  cockpit.drill("wk-a");
  cockpit.drill("wk-a");
  assert.equal(r.sockets.length, 1);
  assert.equal(r.terminalMounts, 1);
  assert.equal(r.terminalDisposes, 0);

  cockpit.drill("wk-b");
  assert.equal(r.sockets[0]?.closed, true, "the previous connection was closed");
  assert.equal(r.sockets.length, 2);
  assert.equal(r.terminalMounts, 2);
  assert.equal(r.terminalDisposes, 1, "prior terminal disposed on stream switch");
  assert.equal(cockpit.currentStream, "wk-b");
});

test("start runs a pass and self-schedules the next; stop halts it", async () => {
  const r = rig();
  const cockpit = bootSupplyCockpit(r.env);
  cockpit.start();
  await flush();
  assert.equal(r.host.byData("worker", "wk-a").length, 1, "first pass rendered");
  assert.equal(r.timers.length, 1, "next pass scheduled once");

  r.timers[0]?.run();
  await flush();
  assert.equal(r.timers.length, 2, "a subsequent pass was scheduled");

  cockpit.stop();
  const before = r.timers.length;
  await flush();
  assert.equal(r.timers.length, before, "no further passes after stop");
});

test("a stop→start race does not leave two overlapping poll chains scheduling", async () => {
  const r = rig();
  const cockpit = bootSupplyCockpit(r.env);
  cockpit.start();
  cockpit.stop();
  cockpit.start();
  await flush();
  assert.equal(r.timers.length, 1, "exactly one poll chain scheduled after the race");
  cockpit.stop();
});

test("a fetch error is reported and does not wedge the poll", async () => {
  const r = rig();
  const failing: SupplyCockpitEnv = { ...r.env, fetchSupply: () => Promise.reject(new Error("boom")) };
  const cockpit = bootSupplyCockpit(failing);
  await cockpit.refresh();
  assert.equal(r.errors.length, 1);
});

test("dispose stops polling and closes the terminal connection", async () => {
  const r = rig();
  const cockpit = bootSupplyCockpit(r.env);
  await cockpit.refresh();
  cockpit.drill("wk-a");
  cockpit.dispose();
  assert.equal(r.sockets[0]?.closed, true);
  assert.equal(r.terminalDisposes, 1);
});

test("an invalid refreshMs fails fast at construction", () => {
  const base = rig().env;
  for (const refreshMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    assert.throws(
      () => bootSupplyCockpit({ ...base, refreshMs }),
      /refreshMs must be a positive safe integer/,
      `refreshMs ${refreshMs} should be rejected`,
    );
  }
});

test("injecting setTimer without clearTimer (or vice versa) fails fast", () => {
  const base = rig().env;
  const noop = () => 0;
  assert.throws(
    () => bootSupplyCockpit({ ...base, setTimer: noop, clearTimer: undefined }),
    /setTimer and clearTimer must be provided together/,
  );
  assert.throws(
    () => bootSupplyCockpit({ ...base, setTimer: undefined, clearTimer: () => {} }),
    /setTimer and clearTimer must be provided together/,
  );
});

test("a drill whose terminal build throws resets the panel to idle instead of leaving a stale live indicator", async () => {
  const r = rig();
  const cockpit = bootSupplyCockpit(r.env);
  await cockpit.refresh();

  // First drill succeeds: the panel is live on wk-a.
  cockpit.drill("wk-a");
  assert.equal(cockpit.currentMode, "live");
  assert.equal(cockpit.currentStream, "wk-a");
  const disposesBefore = r.terminalDisposes;

  // The next drill tears down the live wk-a terminal up-front, then fails to build the new one.
  const baseCreate = r.env.createTerminal;
  r.env.createTerminal = () => {
    throw new Error("createTerminal boom");
  };
  cockpit.drill("wk-b");
  r.env.createTerminal = baseCreate;

  // The failure is surfaced and the prior live terminal was disposed by the up-front teardown.
  assert.equal(r.errors.length, 1, "the build failure is surfaced to onError");
  assert.equal(r.terminalDisposes, disposesBefore + 1, "the prior live terminal was torn down");

  // The defect: the panel must NOT keep showing a stale "live wk-a" backed by a terminal that is
  // gone — the region resets to idle, symmetric with replay() which clears mode up-front.
  assert.equal(cockpit.currentMode, undefined, "mode reset to idle after a failed drill");
  assert.equal(cockpit.currentStream, undefined, "stream cleared after a failed drill");

  // And the region recovers: a subsequent successful drill mounts a fresh live terminal.
  cockpit.drill("wk-a");
  assert.equal(cockpit.currentMode, "live");
  assert.equal(cockpit.currentStream, "wk-a");
});

// A transcript envelope (marker + kind + fields), matching the one event grammar the fold parses.
function env(kind: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ [TRANSCRIPT_EVENT_MARKER]: TRANSCRIPT_EVENT_VERSION, kind, ...extra });
}

// A captured transcript carrying a pending ESCALATE permission request, for the structured replay path.
function permissionTranscript(stream: string): TranscriptDataReport {
  const chunks = [
    env("turn", { index: 0 }),
    env("message", { role: "assistant", text: "I need to run a command" }),
    env("permission", {
      phase: "request",
      callId: "perm-1",
      policy: "escalate",
      title: "Run `rm -rf build`?",
      options: [
        { optionId: "allow", name: "Allow", kind: "allow-once" },
        { optionId: "deny", name: "Deny", kind: "reject-once" },
      ],
    }),
  ];
  return { stream, from: 0, gap: false, nextOffset: chunks.length, entries: chunks.map((chunk, offset) => ({ offset, chunk })) };
}

// A rig whose replay endpoints (list + per-session bytes) are wired, plus an optional permission hook.
function replayRig(onPermissionResolve?: SupplyCockpitEnv["onPermissionResolve"]): {
  readonly env: SupplyCockpitEnv;
  readonly host: FakeElement;
  readonly data: TranscriptDataReport;
} {
  const r = rig();
  const data = permissionTranscript("job:done");
  const env: SupplyCockpitEnv = {
    ...r.env,
    fetchTranscripts: () => Promise.resolve({ count: 0, transcripts: [] }),
    fetchTranscript: () => Promise.resolve(data),
    ...(onPermissionResolve !== undefined ? { onPermissionResolve } : {}),
  };
  return { env, host: r.host, data };
}

test("replay MOUNTS the structured derived view beside the byte replay (typed boot/replay path)", async () => {
  const { env, host } = replayRig();
  const cockpit = bootSupplyCockpit(env);
  await cockpit.replay("job:done");

  // The dedicated structured region exists and now holds the derived view (the byte terminal replay,
  // asserted elsewhere, is untouched — this is additive beside it).
  const region = host.byData("structured", "region")[0];
  assert.ok(region !== undefined, "the structured region is present");
  assert.equal(region?.byClass("cockpit-transcript-derived").length, 1, "the derived structured view is mounted");
  assert.equal(host.byData("permission", "request").length, 1, "the permission prompt is rendered in the structured view");
});

test("a SupplyCockpitEnv.onPermissionResolve hook is threaded into the structured render so a click reaches it", async () => {
  const resolutions: Array<{ callId: string; optionId: string; allowed: boolean }> = [];
  const { env, host } = replayRig((resolution) => resolutions.push(resolution));
  const cockpit = bootSupplyCockpit(env);
  await cockpit.replay("job:done");

  const allow = host.byClass("cockpit-transcript-permission-option").find((b) => b.getAttribute("data-option-id") === "allow");
  assert.ok(allow !== undefined, "the Allow button rendered");
  allow?.dispatch("click");
  assert.deepEqual(resolutions, [{ callId: "perm-1", optionId: "allow", allowed: true }]);
});

test("the structured view renders even without an onPermissionResolve hook (buttons are inert, no throw)", async () => {
  const { env, host } = replayRig();
  const cockpit = bootSupplyCockpit(env);
  await cockpit.replay("job:done");
  const allow = host.byClass("cockpit-transcript-permission-option").find((b) => b.getAttribute("data-option-id") === "allow");
  assert.ok(allow !== undefined, "the Allow button rendered without a hook");
  allow?.dispatch("click"); // no handler wired — must not throw
});

test("switching from replay to a LIVE drill CLEARS the stale structured derived view (no wrong-callId clicks)", async () => {
  const { env, host } = replayRig();
  const cockpit = bootSupplyCockpit(env);
  await cockpit.replay("job:done");
  // The structured region is populated with the derived view + pending permission prompt.
  assert.equal(host.byData("permission", "request").length, 1, "the permission prompt is mounted on replay");

  // Drilling into a live stream must tear the stale structured view down — leaving a clickable permission
  // prompt over a live terminal risks an operator action against the wrong callId.
  cockpit.drill("wk-a");
  assert.equal(cockpit.currentMode, "live");
  const region = host.byData("structured", "region")[0];
  assert.ok(region !== undefined, "the structured region element persists (it is cleared, not removed)");
  assert.equal(region?.byClass("cockpit-transcript-derived").length, 0, "the derived structured view is cleared on live drill");
  assert.equal(host.byData("permission", "request").length, 0, "the stale permission prompt is gone in live mode");
});
