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

test("a slow replay fetch that resolves after a newer drill does not clobber the live terminal", async () => {
  const r = rig();
  // A replay fetch we resolve by hand, so the drill can land first while it is still outstanding.
  let releaseReplay: (() => void) | undefined;
  const gated: SupplyCockpitEnv = {
    ...r.env,
    fetchTranscript: (stream: string) => {
      r.fetchedTranscript = stream;
      return new Promise<TranscriptDataReport>((resolve) => {
        releaseReplay = () => resolve(transcriptData);
      });
    },
  };
  const cockpit = bootSupplyCockpit(gated);
  await cockpit.refresh();
  await flush();

  // Start a replay whose fetch is still pending, then drill into a live worker.
  const replaying = cockpit.replay("job:past");
  cockpit.drill("job:live");
  assert.equal(cockpit.currentMode, "live");
  assert.equal(r.sockets.length, 1);

  // The stale replay now resolves — it must NOT overwrite the live terminal or close the live socket.
  releaseReplay?.();
  await replaying;
  await flush();
  assert.equal(cockpit.currentMode, "live", "the newer live drill wins over the stale replay");
  assert.equal(cockpit.currentStream, "job:live");
  assert.equal(r.sockets[0]?.closed, false, "the live relay socket is not torn down by a stale replay");
  assert.deepEqual(r.terminalWrites, [], "the stale transcript bytes are never rendered");
});

test("a hanging transcripts fetch does not stall the supply poll", async () => {
  const r = rig();
  const stalled: SupplyCockpitEnv = {
    ...r.env,
    // Never resolves: before the fix, refresh() awaited this and wedged the poll forever.
    fetchTranscripts: () => new Promise<TranscriptListReport>(() => {}),
  };
  const cockpit = bootSupplyCockpit(stalled);

  // refresh() must resolve despite the hung transcripts fetch, having rendered the live supply list.
  await cockpit.refresh();
  assert.equal(r.host.byData("worker", "wk-a").length, 1, "live supply list rendered despite the hang");

  // A second pass still renders the live list (single-flight skips the still-pending past-fetch).
  await cockpit.refresh();
  assert.equal(r.host.byData("worker", "wk-a").length, 1, "supply poll keeps making progress");
  assert.deepEqual(r.errors, []);
  cockpit.dispose();
});

test("a permanently hung transcripts fetch is bounded by a timeout so the past panel recovers on the next poll", async () => {
  const r = rig();
  // A hand-driven timer seam lets us fire the bounded-wait timeout deterministically.
  const timers = new Map<number, () => void>();
  let nextId = 0;
  let fetchCalls = 0;
  let resolveSecond: ((v: TranscriptListReport) => void) | undefined;
  const env: SupplyCockpitEnv = {
    ...r.env,
    setTimer: (run) => {
      const id = nextId++;
      timers.set(id, run);
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    pastFetchTimeoutMs: 5000,
    fetchTranscripts: () => {
      fetchCalls += 1;
      // The first past-fetch hangs forever; the second (post-recovery) resolves under our control.
      if (fetchCalls === 1) return new Promise<TranscriptListReport>(() => {});
      return new Promise<TranscriptListReport>((resolve) => {
        resolveSecond = resolve;
      });
    },
  };
  const cockpit = bootSupplyCockpit(env);

  await cockpit.refresh(); // starts the hung past-fetch #1 and schedules its timeout timer
  await flush();
  assert.equal(fetchCalls, 1);

  // While the (hung) fetch is outstanding and its timeout has not fired, single-flight blocks a retry.
  await cockpit.refresh();
  await flush();
  assert.equal(fetchCalls, 1, "single-flight: no retry while the outstanding past-fetch is still pending");

  // Fire the bounded-wait timeout: the wait rejects, surfacing one error and clearing the single-flight flag.
  for (const run of [...timers.values()]) run();
  await flush();
  assert.equal(r.errors.length, 1, "the bounded wait surfaces the timeout as one error");

  // The past panel has recovered: the next poll starts a fresh past-fetch (the flag is no longer stuck).
  await cockpit.refresh();
  await flush();
  assert.equal(fetchCalls, 2, "after the timeout the single-flight flag clears, so the next poll retries");

  // And that fresh fetch renders the past-sessions list.
  resolveSecond?.(transcripts);
  await flush();
  assert.equal(r.host.byData("stream", "job:past").length >= 1, true, "the recovered past-sessions list renders");
  cockpit.dispose();
});

test("a permanently hung replay fetch is bounded by a timeout so replay() always settles", async () => {
  const r = rig();
  // A hand-driven timer seam lets us fire the bounded-wait timeout deterministically.
  const timers = new Map<number, () => void>();
  let nextId = 0;
  const env: SupplyCockpitEnv = {
    ...r.env,
    setTimer: (run) => {
      const id = nextId++;
      timers.set(id, run);
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    pastFetchTimeoutMs: 5000,
    // The replay transcript fetch hangs forever: before the fix, replay() awaited it and never settled,
    // leaving the terminal wedged out of live mode with an in-flight request that never completes.
    fetchTranscript: () => new Promise<TranscriptDataReport>(() => {}),
  };
  const cockpit = bootSupplyCockpit(env);
  await cockpit.refresh(); // the list fetch resolves, clearing its bounded timer
  await flush();

  // Start a replay whose transcript fetch never settles; it must not hang forever.
  const replaying = cockpit.replay("job:past");
  await flush();

  // Fire the bounded-wait timeout: replay() must settle (reject → caught), surfacing the timeout as an
  // error, rather than hanging the caller forever.
  for (const run of [...timers.values()]) run();
  await replaying;
  await flush();
  assert.equal(r.errors.length >= 1, true, "the bounded replay wait surfaces the timeout as an error");
  assert.equal(cockpit.currentMode, undefined, "a timed-out replay leaves the terminal idle, not stuck in replay");
  cockpit.dispose();
});
