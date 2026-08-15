// The SUPPLY-only cockpit boot/orchestration layer (ADR 0056, H5 / #148).
//
// Wires the supply cockpit together from injected capabilities, with NO direct dependency on the
// browser, a socket implementation, or xterm.js — everything is passed in ({@link SupplyCockpitEnv}).
// That is what lets the same page render identically embedded (console App View, ADR 0057) and
// standalone (the shells differ only in the `host` element and the concrete capabilities), and what
// makes the live-refresh + drill-in + resume-on-reconnect path unit-testable on Node.
//
// It mirrors the packaged `@nanobpm/agentic/cockpit` boot DISCIPLINE (a self-scheduling poll; a
// persistent terminal region a refresh never wipes; drill-in that resumes-from-offset on every
// reconnect) but renders the SUPPLY-only worker list ({@link ./supply-render.ts}) instead of the
// demand×supply matrix. The genuinely reusable, correctness-critical parts — the relay client and the
// resume-from-offset terminal session — are REUSED from the package ({@link RelayChannelClient},
// {@link TerminalSession}); only the supply projection the package does not provide is authored here.
//
// Responsibilities:
//  - a self-scheduling poll of the app's SUPPLY report that re-renders the worker list each pass (a
//    slow fetch can't overlap the next — mirrors the nano-workforce review-poller discipline);
//  - drill-into-a-worker: open a {@link RelayChannelClient} + {@link TerminalSession} for the selected
//    stream, mount its output into a PERSISTENT terminal region (so a list refresh never wipes it),
//    and re-attach on every reconnect so the terminal SURVIVES a cockpit reconnect via resume-from-offset.
import {
  type DocumentLike,
  type ElementLike,
  RelayChannelClient,
  type Scheduler,
  type SocketFactory,
  TerminalSession,
  type TerminalSink,
} from "@nanobpm/agentic/cockpit";
import { renderSupply } from "./supply-render.ts";
import type { SupplyReport } from "./supply-view.ts";
import { supplyView } from "./supply-view.ts";
import { renderTranscripts, replayTranscript, type TranscriptDataReport } from "./transcript-render.ts";
import type { TranscriptListReport } from "./transcript-view.ts";
import { transcriptsView } from "./transcript-view.ts";

/** Mounts a terminal into `host` and returns the sink relay output is written to. */
export type CreateTerminal = (host: ElementLike) => TerminalSink;

/** The terminal region's playback mode: a LIVE relay stream vs a REPLAYED (static) stored transcript. */
export type TerminalMode = "live" | "replay";

/** An opaque poll-timer handle (a Node `Timeout` or a browser timer id). */
export type TimerHandle = unknown;

export interface SupplyCockpitEnv {
  /** The element the cockpit renders into (standalone: `document.body`; embedded: the App View host). */
  readonly host: ElementLike;
  /** The document the renderer creates elements from. */
  readonly doc: DocumentLike;
  /** Fetches the latest SUPPLY report (e.g. over HTTP from the app's `/agentic/supply` endpoint). */
  readonly fetchSupply: () => Promise<SupplyReport>;
  /**
   * Fetches the captured-session list (`GET /agentic/transcripts`) for the "past sessions" history.
   * Optional: when omitted the past-sessions panel is not rendered (live-only cockpit).
   */
  readonly fetchTranscripts?: () => Promise<TranscriptListReport>;
  /**
   * Fetches a stored transcript's bytes (`GET /agentic/transcripts/{stream}`) for static replay.
   * Required for the "past sessions" replay to work; must be provided together with {@link fetchTranscripts}.
   */
  readonly fetchTranscript?: (stream: string, from?: number) => Promise<TranscriptDataReport>;
  /** Opens a socket to the app relay channel (one per drill-in connection). */
  readonly connectRelay: SocketFactory;
  /** Mounts the terminal widget (xterm.js in the browser) and returns its write sink. */
  readonly createTerminal: CreateTerminal;
  /** Reconnect scheduler for the relay client. Default `setTimeout(run, 0)`. */
  readonly schedule?: Scheduler;
  /** Poll scheduler. Default `setTimeout`. Injected so tests drive it by hand. Must pair with {@link clearTimer}. */
  readonly setTimer?: (run: () => void, ms: number) => TimerHandle;
  /** Cancels a poll timer. Default `clearTimeout`. Must pair with {@link setTimer}. */
  readonly clearTimer?: (handle: TimerHandle) => void;
  /** Poll interval in ms. Default 2000. */
  readonly refreshMs?: number;
  /** Bulk credit granted per terminal (re)subscribe. Default 1024. */
  readonly credit?: number;
  /** A live worker idle longer than this (ms) grades `stale`. Default 15000. */
  readonly staleAfterMs?: number;
  /**
   * Upper bound (ms) on a single "past sessions" transcripts fetch. Default 15000. `#refreshPast` is
   * single-flight, so a fetch that HANGS (never settles) would otherwise wedge the past panel forever;
   * this timeout guarantees the wait settles so the flag clears and the next poll retries.
   */
  readonly pastFetchTimeoutMs?: number;
  /** Notified of a fetch/render/relay error (the poll keeps going). */
  readonly onError?: (err: unknown) => void;
}

/** The running supply cockpit; dispose to stop polling and tear down the terminal. */
export interface SupplyCockpitHandle {
  /** Run one fetch→render pass now (also the poll body). Resolves when rendered. */
  refresh(): Promise<void>;
  /** Start the self-scheduling poll loop (runs one pass immediately). */
  start(): void;
  /** Stop the poll loop (leaves the last render in place). */
  stop(): void;
  /** Drill into a worker's relay stream, opening a resumable LIVE terminal. */
  drill(stream: string): void;
  /** Replay a captured past session's stored transcript statically into the terminal (no live worker). */
  replay(stream: string): Promise<void>;
  /** The stream currently drilled into or replayed, if any. */
  readonly currentStream: string | undefined;
  /** Whether the terminal is showing a LIVE stream or a REPLAYED transcript (undefined when idle). */
  readonly currentMode: TerminalMode | undefined;
  /** Stop everything and release the terminal connection. */
  dispose(): void;
}

const DEFAULT_REFRESH_MS = 2000;
const DEFAULT_PAST_FETCH_TIMEOUT_MS = 15000;

function isPosInt(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

interface Drill {
  readonly stream: string;
  readonly client: RelayChannelClient;
}

class SupplyCockpit implements SupplyCockpitHandle {
  readonly #env: SupplyCockpitEnv;
  readonly #listRegion: ElementLike;
  readonly #pastRegion: ElementLike | undefined;
  readonly #terminalHost: ElementLike;
  readonly #terminalTitle: ElementLike;
  readonly #terminalPanel: ElementLike;
  readonly #refreshMs: number;
  readonly #pastFetchTimeoutMs: number;
  readonly #setTimer: (run: () => void, ms: number) => TimerHandle;
  readonly #clearTimer: (handle: TimerHandle) => void;
  readonly #timeouts = new Map<number, ReturnType<typeof setTimeout>>();
  #nextTimerId = 0;
  #timer: TimerHandle | undefined;
  #running = false;
  #disposed = false;
  #drill: Drill | undefined;
  // The currently mounted terminal, tracked so switching streams (and dispose) tears down the prior
  // xterm instance instead of leaking it + its listeners.
  #terminal: TerminalSink | undefined;
  // The terminal region's current playback: a LIVE relay stream or a REPLAYED stored transcript, and
  // the stream it is showing — so the past-sessions list can highlight the active replay and the
  // panel title can distinguish live from replayed.
  #mode: TerminalMode | undefined;
  #shownStream: string | undefined;
  // Bumped by every drill()/replay()/dispose() that takes over the terminal region. replay() is async
  // (it awaits a transcript fetch); capturing this token before the await and re-checking it after lets
  // a slow replay drop its result when a newer drill/replay has since claimed the terminal — so a
  // late-resolving stale fetch can never clobber a newer selection (or leak the newer drill's client).
  #opToken = 0;
  // True while a #refreshPast() fetch is in flight, so the supply poll never stacks past-fetches and a
  // hung transcripts endpoint can't accumulate pending calls.
  #pastRefreshing = false;
  // Bumped by every start()/stop() so an in-flight #tick() from a previous start cycle can't
  // reschedule after a stop→start race and leave two overlapping poll chains running.
  #generation = 0;

  constructor(env: SupplyCockpitEnv) {
    this.#env = env;
    this.#refreshMs = env.refreshMs ?? DEFAULT_REFRESH_MS;
    // refreshMs feeds setTimeout as a poll delay. A negative/NaN/fractional/unsafe value silently
    // collapses to a ~0ms delay, turning the poll into a hot loop that hammers the endpoint. Require
    // a positive safe integer up-front so a bad env option fails loudly instead.
    if (!isPosInt(this.#refreshMs)) {
      throw new RangeError(`SupplyCockpitEnv.refreshMs must be a positive safe integer, got ${this.#refreshMs}`);
    }
    this.#pastFetchTimeoutMs = env.pastFetchTimeoutMs ?? DEFAULT_PAST_FETCH_TIMEOUT_MS;
    if (!isPosInt(this.#pastFetchTimeoutMs)) {
      throw new RangeError(
        `SupplyCockpitEnv.pastFetchTimeoutMs must be a positive safe integer, got ${this.#pastFetchTimeoutMs}`,
      );
    }
    // setTimer/clearTimer are a matched pair: a caller-supplied setTimer returns opaque handles the
    // default clearTimer (which only understands the internal numeric-handle Map) cannot cancel,
    // leaving an un-stoppable poll loop. Fail fast rather than silently accept one without the other.
    if ((env.setTimer === undefined) !== (env.clearTimer === undefined)) {
      throw new Error("SupplyCockpitEnv.setTimer and clearTimer must be provided together (or neither)");
    }
    this.#setTimer =
      env.setTimer ??
      ((run, ms) => {
        const id = this.#nextTimerId++;
        const timeout = setTimeout(() => {
          this.#timeouts.delete(id);
          run();
        }, ms);
        // A pending default timer (poll delay or the past-fetch timeout below) must never keep the
        // process alive on its own — a no-op in the browser, where timer handles have no `unref`.
        timeout.unref?.();
        this.#timeouts.set(id, timeout);
        return id;
      });
    this.#clearTimer =
      env.clearTimer ??
      ((handle) => {
        if (typeof handle !== "number") return;
        const timeout = this.#timeouts.get(handle);
        if (timeout !== undefined) {
          clearTimeout(timeout);
          this.#timeouts.delete(handle);
        }
      });

    // Build the stable skeleton once: a volatile list region the poll re-renders, an optional volatile
    // "past sessions" region (rendered only when the transcript read endpoints are wired), and a
    // PERSISTENT terminal region a refresh never touches (so a drilled-in/replayed terminal survives).
    env.host.replaceChildren();
    const shell = env.doc.createElement("div");
    shell.className = "cockpit-shell";
    this.#listRegion = env.doc.createElement("div");
    this.#listRegion.className = "cockpit-supply-region";
    // The past-sessions history list only exists when a transcript list source is injected.
    if (env.fetchTranscripts !== undefined) {
      this.#pastRegion = env.doc.createElement("div");
      this.#pastRegion.className = "cockpit-past-region";
    }
    this.#terminalPanel = env.doc.createElement("section");
    this.#terminalPanel.className = "cockpit-terminal";
    this.#terminalPanel.setAttribute("data-terminal-mode", "idle");
    this.#terminalTitle = env.doc.createElement("h2");
    this.#terminalTitle.className = "cockpit-panel-title";
    this.#terminalTitle.textContent = "Worker terminal";
    this.#terminalPanel.appendChild(this.#terminalTitle);
    this.#terminalHost = env.doc.createElement("div");
    this.#terminalHost.className = "cockpit-terminal-host";
    this.#terminalHost.setAttribute("data-terminal", "host");
    this.#terminalPanel.appendChild(this.#terminalHost);
    shell.appendChild(this.#listRegion);
    if (this.#pastRegion !== undefined) shell.appendChild(this.#pastRegion);
    shell.appendChild(this.#terminalPanel);
    env.host.appendChild(shell);
  }

  get currentStream(): string | undefined {
    return this.#shownStream;
  }

  get currentMode(): TerminalMode | undefined {
    return this.#mode;
  }

  /** Reflect the terminal region's playback mode on the panel (title + `data-terminal-mode`). */
  #setMode(mode: TerminalMode | undefined, stream: string | undefined): void {
    this.#mode = mode;
    this.#shownStream = stream;
    this.#terminalPanel.setAttribute("data-terminal-mode", mode ?? "idle");
    if (mode === "live") this.#terminalTitle.textContent = "Worker terminal — live";
    else if (mode === "replay") this.#terminalTitle.textContent = "Worker terminal — replay (past session)";
    else this.#terminalTitle.textContent = "Worker terminal";
  }

  async refresh(): Promise<void> {
    if (this.#disposed) return;
    let report: SupplyReport;
    try {
      report = await this.#env.fetchSupply();
    } catch (err) {
      this.#env.onError?.(err);
      return;
    }
    if (this.#disposed) return;
    try {
      renderSupply(this.#listRegion, this.#env.doc, supplyView(report, { staleAfterMs: this.#env.staleAfterMs }), {
        onDrill: (stream) => this.drill(stream),
      });
    } catch (err) {
      this.#env.onError?.(err);
    }
    // Fire-and-forget: the "past sessions" refresh must never gate the supply poll's next tick. A
    // transcripts endpoint that hangs (not just rejects) would otherwise stall #refresh() forever and
    // wedge the live worker list. #refreshPast is single-flight, so a slow fetch can't pile up either.
    void this.#refreshPast();
  }

  /** Fetch + render the "past sessions" history list, when a transcript source is wired. Independent
   * of the supply fetch: a transcript-endpoint fault (or hang) never blocks the live worker list. */
  async #refreshPast(): Promise<void> {
    const fetchTranscripts = this.#env.fetchTranscripts;
    if (fetchTranscripts === undefined || this.#pastRegion === undefined) return;
    // Single-flight: while one past-fetch is outstanding (including a hung one), skip starting another
    // so the poll can't stack pending fetches against a slow/unresponsive transcripts endpoint.
    if (this.#pastRefreshing) return;
    this.#pastRefreshing = true;
    try {
      let report: TranscriptListReport;
      try {
        report = await this.#fetchTranscriptsBounded(fetchTranscripts);
      } catch (err) {
        this.#env.onError?.(err);
        return;
      }
      if (this.#disposed || this.#pastRegion === undefined) return;
      try {
        renderTranscripts(this.#pastRegion, this.#env.doc, transcriptsView(report), {
          onReplay: (stream) => void this.replay(stream),
          ...(this.#mode === "replay" && this.#shownStream !== undefined ? { activeStream: this.#shownStream } : {}),
        });
      } catch (err) {
        this.#env.onError?.(err);
      }
    } finally {
      this.#pastRefreshing = false;
    }
  }

  /**
   * Fetch the past-sessions list with a bounded wait. {@link #refreshPast} is single-flight so a
   * still-pending fetch is never stacked — but an injected transcripts fetch that HANGS (never settles,
   * not merely rejects) would otherwise leave `#pastRefreshing` stuck `true` forever, permanently
   * disabling the past panel even after the endpoint recovers. Racing the fetch against a timeout
   * guarantees the wait always settles, so `#refreshPast`'s `finally` clears the flag and the next poll
   * retries. A hung fetch that resolves late is ignored (the `settled` latch drops it).
   */
  #fetchTranscriptsBounded(
    fetchTranscripts: () => Promise<TranscriptListReport>,
  ): Promise<TranscriptListReport> {
    return new Promise<TranscriptListReport>((resolve, reject) => {
      let settled = false;
      const handle = this.#setTimer(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`transcripts fetch timed out after ${this.#pastFetchTimeoutMs}ms`));
      }, this.#pastFetchTimeoutMs);
      fetchTranscripts().then(
        (report) => {
          if (settled) return;
          settled = true;
          this.#clearTimer(handle);
          resolve(report);
        },
        (err) => {
          if (settled) return;
          settled = true;
          this.#clearTimer(handle);
          reject(err);
        },
      );
    });
  }

  start(): void {
    if (this.#disposed || this.#running) return;
    this.#running = true;
    const generation = ++this.#generation;
    this.#tick(generation);
  }

  stop(): void {
    this.#running = false;
    // Invalidate any in-flight tick so its finally can't reschedule after this.
    this.#generation++;
    if (this.#timer !== undefined) {
      this.#clearTimer(this.#timer);
      this.#timer = undefined;
    }
  }

  #tick(generation: number): void {
    // Self-scheduling: schedule the NEXT pass only after this one settles, so a slow fetch can never
    // overlap its successor. The generation guard drops a stale tick whose start cycle was already
    // stopped (and possibly restarted), so a stop→start race never leaves two poll chains scheduling.
    void this.refresh().finally(() => {
      if (generation !== this.#generation || !this.#running || this.#disposed) return;
      this.#timer = this.#setTimer(() => this.#tick(generation), this.#refreshMs);
    });
  }

  drill(stream: string): void {
    if (this.#disposed) return;
    if (this.#mode === "live" && this.#drill?.stream === stream) return;
    // Claim the terminal region: bump the op token so any in-flight replay (whose fetch has not yet
    // resolved) drops its result instead of overwriting this live drill once it lands.
    this.#opToken++;
    // Close and drop the prior drill up-front so a synchronous failure while building the new one
    // (createTerminal, an invalid TerminalSession credit, or connect throwing) can't leave #drill
    // pointing at an already-closed client. #drill is re-set only once the new client is fully wired.
    this.#drill?.client.close();
    this.#drill = undefined;
    // Tear down the prior terminal before mounting a fresh one so repeated drills don't leak xterm
    // instances/listeners (replaceChildren only drops the DOM node, not the widget).
    this.#terminal?.dispose?.();
    this.#terminal = undefined;

    try {
      // Fresh terminal for the newly selected worker.
      this.#terminalHost.replaceChildren();
      const sink = this.#env.createTerminal(this.#terminalHost);
      this.#terminal = sink;

      let session: TerminalSession | undefined;
      const client = new RelayChannelClient({
        connect: this.#env.connectRelay,
        onRelay: (message) => session?.handle(message),
        // Re-attach on EVERY (re)connect → resume-from-offset: the terminal survives a cockpit
        // reconnect without losing or double-writing output.
        onOpen: () => session?.attach(),
        schedule: this.#env.schedule,
        onError: (err) => this.#env.onError?.(err),
      });
      session = new TerminalSession({
        stream,
        sink,
        send: (message) => client.sendRelay(message),
        credit: this.#env.credit,
      });
      client.open();
      this.#drill = { stream, client };
      this.#setMode("live", stream);
    } catch (err) {
      this.#env.onError?.(err);
    }
  }

  /**
   * Replay a captured PAST session's stored transcript into the terminal region — static playback of a
   * closed stream with NO live worker and NO relay connection. Tears down any live drill first, fetches
   * the transcript's bytes, and feeds them through the SAME resume-from-offset {@link TerminalSession}
   * renderer a live stream uses, so the exited agent's terminal renders faithfully. The panel is marked
   * `replay` so the operator plainly sees it is a past session, not a live one.
   */
  async replay(stream: string): Promise<void> {
    if (this.#disposed) return;
    const fetchTranscript = this.#env.fetchTranscript;
    if (fetchTranscript === undefined) return;
    // Claim the terminal region under a fresh op token, captured for the post-fetch re-check below.
    const token = ++this.#opToken;
    // Drop any live drill and the prior terminal before fetching so a replay never runs alongside a
    // live stream in the same region.
    this.#drill?.client.close();
    this.#drill = undefined;
    this.#terminal?.dispose?.();
    this.#terminal = undefined;
    this.#setMode(undefined, undefined);

    let data: TranscriptDataReport;
    try {
      data = await fetchTranscript(stream);
    } catch (err) {
      this.#env.onError?.(err);
      return;
    }
    // A newer drill()/replay() (or dispose()) claimed the terminal while this fetch was outstanding —
    // drop this stale result rather than clobber the newer selection with an out-of-date replay.
    if (this.#disposed || token !== this.#opToken) return;
    try {
      this.#terminalHost.replaceChildren();
      const sink = this.#env.createTerminal(this.#terminalHost);
      this.#terminal = sink;
      const session = new TerminalSession({ stream, sink, send: () => {}, from: data.from });
      replayTranscript(session, data);
      this.#setMode("replay", stream);
      // Re-render the past list so the just-selected session shows as active (best-effort).
      void this.#refreshPast();
    } catch (err) {
      this.#env.onError?.(err);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#opToken++;
    this.stop();
    this.#drill?.client.close();
    this.#drill = undefined;
    this.#terminal?.dispose?.();
    this.#terminal = undefined;
    this.#setMode(undefined, undefined);
  }
}

/** Boot the supply cockpit against an injected environment. Call {@link SupplyCockpitHandle.start} to poll. */
export function bootSupplyCockpit(env: SupplyCockpitEnv): SupplyCockpitHandle {
  return new SupplyCockpit(env);
}
