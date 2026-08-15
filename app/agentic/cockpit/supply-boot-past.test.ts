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

test("the bounded-wait timeout clears its own timer handle (no leak / no double-fire under custom timers)", async () => {
  const r = rig();
  // A hand-driven timer seam: setTimer records the handle, clearTimer records + drops it. Only clearTimer
  // removes a handle from the map — firing a timer callback does not — so a surviving handle after the
  // timeout arm fires is a genuine leak the custom clearTimer never got to reclaim.
  const timers = new Map<number, () => void>();
  const cleared: number[] = [];
  let nextId = 0;
  const env: SupplyCockpitEnv = {
    ...r.env,
    setTimer: (run) => {
      const id = nextId++;
      timers.set(id, run);
      return id;
    },
    clearTimer: (handle) => {
      cleared.push(handle as number);
      timers.delete(handle as number);
    },
    pastFetchTimeoutMs: 5000,
    // The replay fetch hangs forever, so the bounded wait settles via its TIMEOUT arm (not the fetch arm).
    fetchTranscript: () => new Promise<TranscriptDataReport>(() => {}),
  };
  const cockpit = bootSupplyCockpit(env);
  await cockpit.refresh(); // the list fetch resolves, clearing its own bounded timer
  await flush();

  // Capture exactly the timer the replay's bounded wait schedules.
  const before = new Set(timers.keys());
  const replaying = cockpit.replay("job:past");
  await flush();
  const replayTimers = [...timers.keys()].filter((id) => !before.has(id));
  assert.equal(replayTimers.length, 1, "replay scheduled exactly one bounded-wait timer");
  const replayTimerId = replayTimers[0];

  // Fire the timeout arm: the wait rejects and replay() settles.
  timers.get(replayTimerId)?.();
  await replaying;
  await flush();

  // The timeout arm MUST clear its own handle — otherwise a custom scheduler leaks it and can re-fire it.
  assert.ok(cleared.includes(replayTimerId), "the timeout arm called clearTimer on its own handle");
  assert.equal(timers.has(replayTimerId), false, "no leaked timer handle survives the timeout");
  cockpit.dispose();
});

test("a synchronously-throwing fetch clears the bounded-wait timer (no leaked handle) and still settles", async () => {
  const r = rig();
  // Same hand-driven timer seam as the timeout-clear test: only clearTimer removes a handle from the map,
  // so a handle that survives after the bounded wait settles is a genuine leak the custom scheduler never
  // reclaimed — and, worse, one it could later re-fire.
  const timers = new Map<number, () => void>();
  const cleared: number[] = [];
  let nextId = 0;
  const boom = new Error("fetchTranscript threw synchronously");
  const env: SupplyCockpitEnv = {
    ...r.env,
    setTimer: (run) => {
      const id = nextId++;
      timers.set(id, run);
      return id;
    },
    clearTimer: (handle) => {
      cleared.push(handle as number);
      timers.delete(handle as number);
    },
    pastFetchTimeoutMs: 5000,
    // The replay fetch throws SYNCHRONOUSLY (not a rejected promise): before the fix the Promise executor's
    // throw rejected the bounded wait, but its timeout handle was never cleared — it leaked and would fire
    // (and under a custom scheduler could re-fire) long after replay() had already settled.
    fetchTranscript: () => {
      throw boom;
    },
  };
  const cockpit = bootSupplyCockpit(env);
  await cockpit.refresh(); // the list fetch resolves, clearing its own bounded timer
  await flush();

  // Capture exactly the timer the replay's bounded wait schedules. Track every handle seen so far (live
  // or already-cleared) so the earlier list-fetch's cleared timer isn't miscounted as the replay's.
  const before = new Set<number>([...timers.keys(), ...cleared]);
  await cockpit.replay("job:past"); // must settle (reject → caught), not throw out of replay()
  await flush();
  const replayTimers = [...new Set([...timers.keys(), ...cleared])].filter((id) => !before.has(id));
  assert.equal(replayTimers.length, 1, "replay scheduled exactly one bounded-wait timer");
  const replayTimerId = replayTimers[0];

  // The sync-throw arm MUST clear its own handle — otherwise a custom scheduler leaks it and can re-fire it.
  assert.ok(cleared.includes(replayTimerId), "the sync-throw arm called clearTimer on its own handle");
  assert.equal(timers.has(replayTimerId), false, "no leaked timer handle survives a synchronous fetch throw");
  // The synchronous failure surfaced as an error and left the terminal idle, not stuck in replay.
  assert.ok(r.errors.includes(boom), "the synchronous fetch throw surfaced as the replay error");
  assert.equal(cockpit.currentMode, undefined, "a sync-throwing replay leaves the terminal idle, not stuck in replay");
  cockpit.dispose();
});

test("a supply fetch that rejects AFTER dispose does not surface onError to the torn-down cockpit", async () => {
  // The success path guards the render with `if (this.#disposed) return;` after awaiting the fetch, but
  // the catch must honour the same guard: an in-flight fetch that rejects post-dispose must not report an
  // error into a UI that is already gone. Drive fetchSupply with a promise we reject only after dispose().
  const r = rig();
  let rejectSupply: ((err: unknown) => void) | undefined;
  const env: SupplyCockpitEnv = {
    ...r.env,
    fetchSupply: () => new Promise<SupplyReport>((_resolve, reject) => {
      rejectSupply = reject;
    }),
  };
  const cockpit = bootSupplyCockpit(env);

  const refreshing = cockpit.refresh(); // awaits the (pending) supply fetch
  await flush();
  cockpit.dispose(); // tear the cockpit down while the fetch is still outstanding
  rejectSupply?.(new Error("supply endpoint died after teardown"));
  await refreshing;
  await flush();

  assert.deepEqual(r.errors, [], "a post-dispose supply rejection is swallowed, not surfaced to a dead UI");
});

test("a hung past-list fetch that times out AFTER dispose does not surface onError", async () => {
  // Same class as the supply path: #refreshPast()'s catch runs when the bounded wait rejects. If dispose()
  // already fired, surfacing that timeout as an error reports into a torn-down cockpit. Drive the bounded
  // timeout by hand and fire it only after dispose().
  const r = rig();
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
    fetchTranscripts: () => new Promise<TranscriptListReport>(() => {}), // hangs forever
  };
  const cockpit = bootSupplyCockpit(env);

  await cockpit.refresh(); // starts the hung past-fetch and schedules its bounded timeout
  await flush();
  cockpit.dispose(); // tear down while the past-fetch is still outstanding
  for (const run of [...timers.values()]) run(); // fire the bounded timeout -> the wait rejects
  await flush();

  assert.deepEqual(r.errors, [], "a post-dispose past-list timeout is swallowed, not surfaced to a dead UI");
});

test("a hung replay fetch that times out AFTER dispose does not surface onError", async () => {
  // replay()'s catch mirrors the same class. Its success path guards on `this.#disposed || token !== opToken`;
  // the error path must too, so a replay whose bounded transcript fetch times out after dispose() stays silent.
  const r = rig();
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
    fetchTranscript: () => new Promise<TranscriptDataReport>(() => {}), // hangs forever
  };
  const cockpit = bootSupplyCockpit(env);
  await cockpit.refresh(); // the list fetch resolves, clearing its bounded timer
  await flush();

  const replaying = cockpit.replay("job:past"); // starts the hung replay fetch + its bounded timeout
  await flush();
  cockpit.dispose(); // tear down while the replay fetch is still outstanding
  for (const run of [...timers.values()]) run(); // fire the bounded timeout -> the wait rejects
  await replaying;
  await flush();

  assert.deepEqual(r.errors, [], "a post-dispose replay timeout is swallowed, not surfaced to a dead UI");
});

test("constructing with fetchTranscripts but no fetchTranscript fails fast (replay would silently no-op)", () => {
  const r = rig(false);
  assert.throws(
    () => bootSupplyCockpit({ ...r.env, fetchTranscripts: () => Promise.resolve(transcripts) }),
    /fetchTranscripts and fetchTranscript must be provided together/,
    "a past list source without a replay source is a half-wired env",
  );
});

test("constructing with fetchTranscript but no fetchTranscripts fails fast (unreachable replay source)", () => {
  const r = rig(false);
  assert.throws(
    () => bootSupplyCockpit({ ...r.env, fetchTranscript: () => Promise.resolve(transcriptData) }),
    /fetchTranscripts and fetchTranscript must be provided together/,
    "a replay source with no past list to launch it from is half-wired too",
  );
});

test("constructing with both transcript sources (or neither) is accepted", () => {
  const both = rig(true);
  const neither = rig(false);
  assert.doesNotThrow(() => bootSupplyCockpit(both.env), "both sources together is the wired-up case");
  assert.doesNotThrow(() => bootSupplyCockpit(neither.env), "neither source is the transcripts-off case");
});
