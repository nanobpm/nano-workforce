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

/** Mounts a terminal into `host` and returns the sink relay output is written to. */
export type CreateTerminal = (host: ElementLike) => TerminalSink;

/** An opaque poll-timer handle (a Node `Timeout` or a browser timer id). */
export type TimerHandle = unknown;

export interface SupplyCockpitEnv {
  /** The element the cockpit renders into (standalone: `document.body`; embedded: the App View host). */
  readonly host: ElementLike;
  /** The document the renderer creates elements from. */
  readonly doc: DocumentLike;
  /** Fetches the latest SUPPLY report (e.g. over HTTP from the app's `/agentic/supply` endpoint). */
  readonly fetchSupply: () => Promise<SupplyReport>;
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
  /** Drill into a worker's relay stream, opening a resumable live terminal. */
  drill(stream: string): void;
  /** The stream currently drilled into, if any. */
  readonly currentStream: string | undefined;
  /** Stop everything and release the terminal connection. */
  dispose(): void;
}

const DEFAULT_REFRESH_MS = 2000;

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
  readonly #terminalHost: ElementLike;
  readonly #refreshMs: number;
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
        this.#timeouts.set(
          id,
          setTimeout(() => {
            this.#timeouts.delete(id);
            run();
          }, ms),
        );
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

    // Build the stable skeleton once: a volatile list region the poll re-renders, and a PERSISTENT
    // terminal region a refresh never touches.
    env.host.replaceChildren();
    const shell = env.doc.createElement("div");
    shell.className = "cockpit-shell";
    this.#listRegion = env.doc.createElement("div");
    this.#listRegion.className = "cockpit-supply-region";
    const terminalPanel = env.doc.createElement("section");
    terminalPanel.className = "cockpit-terminal";
    const title = env.doc.createElement("h2");
    title.className = "cockpit-panel-title";
    title.textContent = "Worker terminal";
    terminalPanel.appendChild(title);
    this.#terminalHost = env.doc.createElement("div");
    this.#terminalHost.className = "cockpit-terminal-host";
    this.#terminalHost.setAttribute("data-terminal", "host");
    terminalPanel.appendChild(this.#terminalHost);
    shell.appendChild(this.#listRegion);
    shell.appendChild(terminalPanel);
    env.host.appendChild(shell);
  }

  get currentStream(): string | undefined {
    return this.#drill?.stream;
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
    if (this.#drill?.stream === stream) return;
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
    } catch (err) {
      this.#env.onError?.(err);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.stop();
    this.#drill?.client.close();
    this.#drill = undefined;
    this.#terminal?.dispose?.();
    this.#terminal = undefined;
  }
}

/** Boot the supply cockpit against an injected environment. Call {@link SupplyCockpitHandle.start} to poll. */
export function bootSupplyCockpit(env: SupplyCockpitEnv): SupplyCockpitHandle {
  return new SupplyCockpit(env);
}
