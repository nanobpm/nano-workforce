// #660 — the DEPLOYED browser adapter (pages/cockpit/mount.js) renders the transcript for BOTH a live
// drill and a past-session replay, and NEVER surfaces a raw `nwfTranscriptEvent` chunk verbatim.
//
// This drives mount.js end-to-end on Node against a real (linkedom) DOM, a stub relay WebSocket, and a
// stub `fetch`, so it exercises the actual live-drill sink wiring and the replay fetch→render path — the
// two seams that used to write relay chunks straight to xterm. It also asserts the rendered transcript
// region sits directly beneath the Workers — supply table.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { encodeFrame } from "@nanobpm/agentic/protocol";
import { parseHTML } from "linkedom";
import { TRANSCRIPT_EVENT_MARKER, TRANSCRIPT_EVENT_VERSION } from "../transcript-events.ts";

function envChunk(kind: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ [TRANSCRIPT_EVENT_MARKER]: TRANSCRIPT_EVENT_VERSION, kind, ...extra });
}

/** A stub browser WebSocket that records instances and lets a test drive open + inbound frames by hand. */
class StubWebSocket {
  static readonly instances: StubWebSocket[] = [];
  binaryType = "";
  readonly url: string;
  readonly #listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(url: string) {
    this.url = url;
    StubWebSocket.instances.push(this);
  }
  addEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(handler);
    this.#listeners.set(type, list);
  }
  send(): void {}
  close(): void {}
  fireOpen(): void {
    for (const h of this.#listeners.get("open") ?? []) h({});
  }
  /** Deliver one relay frame (as the browser would: an ArrayBuffer message event). */
  deliver(frame: unknown): void {
    const bytes = encodeFrame(frame as never);
    for (const h of this.#listeners.get("message") ?? []) h({ data: bytes.buffer });
  }
}

/** Install a linkedom DOM + stub WebSocket/fetch as globals mount.js reads; returns a cleanup fn. */
function installEnv(fetchImpl: (url: string) => Promise<unknown>): () => void {
  const { window, document } = parseHTML("<!doctype html><html><body><main id='root'></main></body></html>");
  const g = globalThis as Record<string, unknown>;
  const saved = {
    window: g.window,
    document: g.document,
    location: g.location,
    WebSocket: g.WebSocket,
    fetch: g.fetch,
  };
  g.window = window;
  g.document = document;
  g.location = { hash: "", href: "http://app.test/cockpit/", pathname: "/cockpit/", search: "" };
  g.WebSocket = StubWebSocket;
  g.fetch = (url: unknown) => fetchImpl(String(url));
  StubWebSocket.instances.length = 0;
  return () => {
    g.window = saved.window;
    g.document = saved.document;
    g.location = saved.location;
    g.WebSocket = saved.WebSocket;
    g.fetch = saved.fetch;
  };
}

const SUPPLY = { leaves: [], correlations: [] };

/** A fetch stub answering the supply poll, the past-sessions list, and a single-stream replay. */
function fetchStub(replay?: unknown) {
  return (url: string): Promise<unknown> => {
    const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
    if (url.includes("/supply")) return ok(SUPPLY);
    if (replay !== undefined && /\/transcripts\/[^/]+$/.test(url)) return ok(replay);
    if (url.includes("/transcripts")) return ok({ sessions: [] });
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  };
}

const OPTS = {
  reportUrl: "http://app.test/app/api/agentic/supply",
  transcriptsUrl: "http://app.test/app/api/agentic/transcripts",
  relayUrl: "ws://app.test/agentic",
  refreshMs: 1_000_000, // effectively disable the self-scheduling poll; we dispose() at the end.
};

test("the rendered transcript region sits directly beneath the Workers — supply table", async () => {
  const restore = installEnv(fetchStub());
  try {
    const { mountCockpit } = await import("../../../pages/cockpit/mount.js");
    const handle = mountCockpit(document.getElementById("root"), OPTS);
    const shell = document.querySelector(".cockpit-shell");
    const order = [...(shell?.children ?? [])].map((c: { className: string }) => c.className);
    assertEquals(order, ["cockpit-supply-region", "cockpit-terminal", "cockpit-past-region"]);
    handle.dispose();
  } finally {
    restore();
  }
});

test("live drill renders the transcript — a nwfTranscriptEvent chunk is never surfaced verbatim", async () => {
  const restore = installEnv(fetchStub());
  try {
    const { mountCockpit } = await import("../../../pages/cockpit/mount.js");
    const handle = mountCockpit(document.getElementById("root"), OPTS);
    handle.drill("job:live");
    const socket = StubWebSocket.instances[0];
    assert(socket !== undefined, "a relay socket was opened for the drill");
    socket.fireOpen();
    socket.deliver({ lane: "control", family: "relay", seq: 0, payload: { op: "subscribed", stream: "job:live", gap: false, nextOffset: 0 } });
    socket.deliver({
      lane: "bulk",
      family: "relay",
      seq: 1,
      payload: { stream: "job:live", offset: 0, chunk: envChunk("message", { role: "assistant", text: "hello from the agent" }) },
    });

    const host = document.querySelector('[data-terminal="host"]');
    const rendered = host?.querySelector(".cockpit-transcript-derived");
    assert(rendered != null, "the derived transcript is rendered into the terminal host");
    assert((host?.textContent ?? "").includes("hello from the agent"), "the message text is rendered");
    assert(!(host?.textContent ?? "").includes(TRANSCRIPT_EVENT_MARKER), "the raw nwfTranscriptEvent marker is never shown");
    assertEquals(document.querySelector(".cockpit-terminal")?.getAttribute("data-terminal-mode"), "live");
    handle.dispose();
  } finally {
    restore();
  }
});

test("replay renders a past session's transcript — never a raw nwfTranscriptEvent dump", async () => {
  const replay = {
    stream: "job:past",
    from: 0,
    gap: false,
    nextOffset: 3,
    entries: [
      { offset: 0, chunk: envChunk("message", { role: "user", text: "kick off" }) },
      { offset: 1, chunk: envChunk("tool-call", { name: "grep", callId: "c1" }) },
      { offset: 2, chunk: envChunk("tool-result", { callId: "c1", ok: true, content: "match" }) },
    ],
  };
  const restore = installEnv(fetchStub(replay));
  try {
    const { mountCockpit } = await import("../../../pages/cockpit/mount.js");
    const handle = mountCockpit(document.getElementById("root"), OPTS);
    await handle.replay("job:past");

    const host = document.querySelector('[data-terminal="host"]');
    assert(host?.querySelector(".cockpit-transcript-derived") != null, "the derived transcript is rendered on replay");
    assert((host?.textContent ?? "").includes("kick off"), "the message text is rendered");
    assert(host?.querySelector('[data-tool="grep"]') != null, "the tool card is rendered");
    assert(!(host?.textContent ?? "").includes(TRANSCRIPT_EVENT_MARKER), "the raw nwfTranscriptEvent marker is never shown");
    assertEquals(document.querySelector(".cockpit-terminal")?.getAttribute("data-terminal-mode"), "replay");
    handle.dispose();
  } finally {
    restore();
  }
});
