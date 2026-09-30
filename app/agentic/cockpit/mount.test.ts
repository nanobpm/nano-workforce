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

/** A fetch stub answering the supply poll, the past-sessions list, and a single-stream replay. The
 * replay READ is matched by its `stream` query param — the proxy-safe form (#744) the deployed
 * client builds; a slash-bearing id must never appear as a path segment. */
function fetchStub(replay?: unknown) {
  return (url: string): Promise<unknown> => {
    const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
    if (url.includes("/supply")) return ok(SUPPLY);
    if (replay !== undefined && /[?&]stream=/.test(url)) return ok(replay);
    if (url.includes("/agent-instances")) return ok({ count: 0, instances: [] });
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
    assertEquals(order, [
      "cockpit-focus",
      "cockpit-supply-region",
      "cockpit-terminal",
      "cockpit-past-region",
      "cockpit-agent-region",
      "cockpit-agent-detail-region",
    ]);
    handle.dispose();
  } finally {
    restore();
  }
});

// #802 — the DEPLOYED browser twin (mount.js) must surface a STALE harness as a distinct badge, and
// a healthy one with none. The typed renderer (`supply-render.ts`) has its own test, but the twin is
// hand-maintained and previously had no non-empty supply-row coverage, so it could silently stop
// surfacing stale harnesses while the typed test stayed green.
test("#802: mount.js renders a stale-harness badge for a stale worker and none for a healthy one", async () => {
  const worker = (instance: string, harnessStale: boolean, harnessProtocol?: number) => ({
    instance,
    identity: "senior",
    stream: instance,
    family: "senior",
    host: "h1",
    jobKeys: [],
    live: true,
    staleMs: 0,
    harnessStale,
    ...(harnessProtocol !== undefined ? { harnessProtocol } : {}),
  });
  const workers = [worker("wk-stale", true, 0), worker("wk-ok", false, 3)];
  const report = { count: workers.length, workers, leaves: [{ token: "senior", workers }], correlations: [] };
  const restore = installEnv((url) => {
    const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
    if (url.includes("/supply")) return ok(report);
    if (url.includes("/agent-instances")) return ok({ count: 0, instances: [] });
    if (url.includes("/transcripts")) return ok({ sessions: [] });
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  });
  try {
    const { mountCockpit } = await import("../../../pages/cockpit/mount.js");
    const handle = mountCockpit(document.getElementById("root"), OPTS);
    try {
      await handle.refresh();
      const staleRow = document.querySelector('.cockpit-supply-worker[data-worker="wk-stale"]');
      const okRow = document.querySelector('.cockpit-supply-worker[data-worker="wk-ok"]');
      assert(staleRow != null && okRow != null, "both worker rows rendered");
      const badge = staleRow?.querySelector('.cockpit-supply-harness-stale[data-harness-stale="true"]');
      assert(badge != null, "the stale worker carries the harness-stale badge");
      assertEquals(badge?.textContent, "stale harness (v0)", "the badge shows the advertised protocol");
      assertEquals(
        okRow?.querySelector(".cockpit-supply-harness-stale"),
        null,
        "the healthy worker carries no harness-stale badge",
      );
    } finally {
      handle.dispose();
    }
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

// #744 — the deployed cockpit's replay READ must be proxy-safe: the stream id rides the QUERY
// (`?stream=`), never a path segment. A worker-instance stream id contains a real `/`
// (`34:<instance>/<jobKey>`); the console gateway decodes an encoded %2F in a PATH segment back
// to `/` before the app routes, splitting the id into an extra segment → 404 {"error":"no such
// operation"} → replayInto's fetch throws → the terminal region renders empty ("nothing").
test("#744: replay fetches the proxy-safe ?stream= query form — a slash-bearing id never lands in a path segment", async () => {
  const stream = "34:joshs-macbook-pro-copilot-3d6ee882/13859";
  const replay = {
    stream,
    from: 0,
    gap: false,
    nextOffset: 1,
    entries: [{ offset: 0, chunk: envChunk("message", { role: "user", text: "past session bytes" }) }],
  };
  const urls: string[] = [];
  const stub = fetchStub(replay);
  const restore = installEnv((url) => {
    urls.push(url);
    return stub(url);
  });
  try {
    const { mountCockpit } = await import("../../../pages/cockpit/mount.js");
    const handle = mountCockpit(document.getElementById("root"), OPTS);
    // Dispose in a finally: mountCockpit auto-starts a poll whose next-tick timer (refreshMs) is a
    // live handle — a mid-test assertion failure that skipped dispose would hold the event loop
    // open and hang the whole test runner.
    try {
      await handle.replay(stream);

      // The auto-started supply poll and the past-sessions list also hit the wire; the READ fetch is
      // the only one carrying the stream id (in either URL form — that's what's under test).
      const readUrl = urls.find((u) => u.includes(encodeURIComponent(stream)) || u.includes(stream));
      assert(readUrl !== undefined, `the replay fetched a transcript read URL for the stream (saw: ${urls.join(", ")})`);
      const parsed = new URL(readUrl);
      // The pathname STAYS the collection route: no %-encoded (or raw) slash-bearing id segment the
      // gateway peel could split — this is the structural fix for the whole failure class, not just
      // this one stream shape.
      assertEquals(parsed.pathname, "/app/api/agentic/transcripts");
      assertEquals(parsed.searchParams.get("stream"), stream, "the slash-bearing id round-trips intact as a query value");
      // And the fetched bytes still render through the derive path.
      const host = document.querySelector('[data-terminal="host"]');
      assert((host?.textContent ?? "").includes("past session bytes"), "the past session rendered");
      assertEquals(document.querySelector(".cockpit-terminal")?.getAttribute("data-terminal-mode"), "replay");
    } finally {
      handle.dispose();
    }
  } finally {
    restore();
  }
});

// Engine-native SETTLED agent-history panel (issue #745/#747): the browser twin renders the run list
// from /agent-instances and a selected run's turns from /agent-instances/{key}/history, keyed by the
// agent-instance key — never a relay stream id. mount.js has no byte-drift guard, so this behaviour
// test is the browser twin's coverage.
test("agent-history panel renders the engine run list and a selected run's turns", async () => {
  const instances = {
    count: 1,
    instances: [
      {
        agentInstanceKey: "ai-42",
        status: "COMPLETED",
        processInstanceKey: "pi-1",
        elementId: "implement-task",
        completionDate: "2024-01-01T00:00:00Z",
        metrics: { inputTokens: 1500, outputTokens: 340, modelCalls: 3, toolCalls: 2 },
      },
    ],
  };
  const history = {
    agentInstanceKey: "ai-42",
    count: 1,
    instance: instances.instances[0],
    records: [
      {
        historyItemKey: "h-0",
        agentInstanceKey: "ai-42",
        loopIteration: 0,
        role: "ASSISTANT",
        commitStatus: "COMMITTED",
        content: [{ contentType: "TEXT", text: "did the thing" }],
        toolCalls: [{ toolCallId: "t-1", toolName: "grep", elementId: "tool", arguments: {} }],
        metrics: { inputTokens: 12, outputTokens: 4, reasoningTokenCount: 0, cacheCreationTokenCount: 0, cacheReadTokenCount: 0, durationMs: 900 },
      },
    ],
  };
  const requested: string[] = [];
  const restore = installEnv((url) => {
    const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
    if (url.includes("/supply")) return ok(SUPPLY);
    if (/\/agent-instances\/[^/]+\/history/.test(url)) {
      requested.push(url);
      return ok(history);
    }
    if (url.includes("/agent-instances")) return ok(instances);
    if (url.includes("/transcripts")) return ok({ sessions: [] });
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  });
  try {
    const { mountCockpit } = await import("../../../pages/cockpit/mount.js");
    const handle = mountCockpit(document.getElementById("root"), OPTS);
    try {
      await handle.refresh();
      // refresh() kicks the agent-history list fetch fire-and-forget; let it settle.
      await new Promise((r) => setTimeout(r, 0));
      const row = document.querySelector('.cockpit-agent-session[data-agent-instance-key="ai-42"]');
      assert(row != null, "the engine agent run is listed");

      await handle.viewAgentHistory("ai-42");
      assert(requested.some((u) => u.includes("/agent-instances/ai-42/history")), `history fetched by key (saw: ${requested.join(", ")})`);
      const transcript = document.querySelector('.cockpit-agent-transcript[data-agent-instance-key="ai-42"]');
      assert(transcript != null, "the selected run's history rendered");
      assert((transcript?.textContent ?? "").includes("did the thing"), "the turn text rendered");
      assert((transcript?.textContent ?? "").includes("grep"), "the tool call rendered");
    } finally {
      handle.dispose();
    }
  } finally {
    restore();
  }
});

// #745 — the browser twin must treat an empty-string tool-call elementId as ABSENT (matching the
// server SSOT `present()` in app/agentic/agent-history.ts, which drops empty elementIds), rendering
// just the tool name — never `toolName ()`.
test("agent-history tool call with an empty-string elementId renders no empty () suffix", async () => {
  const instances = {
    count: 1,
    instances: [{ agentInstanceKey: "ai-77", status: "COMPLETED", processInstanceKey: "pi-1", elementId: "impl" }],
  };
  const history = {
    agentInstanceKey: "ai-77",
    count: 1,
    instance: instances.instances[0],
    records: [
      {
        historyItemKey: "h-0",
        agentInstanceKey: "ai-77",
        loopIteration: 0,
        role: "ASSISTANT",
        commitStatus: "COMMITTED",
        content: [{ contentType: "TEXT", text: "did the thing" }],
        toolCalls: [
          { toolCallId: "t-1", toolName: "grep", elementId: "", arguments: {} },
          { toolCallId: "t-2", toolName: "view", elementId: "tool", arguments: {} },
        ],
      },
    ],
  };
  const restore = installEnv((url) => {
    const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
    if (url.includes("/supply")) return ok(SUPPLY);
    if (/\/agent-instances\/[^/]+\/history/.test(url)) return ok(history);
    if (url.includes("/agent-instances")) return ok(instances);
    if (url.includes("/transcripts")) return ok({ sessions: [] });
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  });
  try {
    const { mountCockpit } = await import("../../../pages/cockpit/mount.js");
    const handle = mountCockpit(document.getElementById("root"), OPTS);
    try {
      await handle.refresh();
      await new Promise((r) => setTimeout(r, 0));
      await handle.viewAgentHistory("ai-77");
      const tools = [...document.querySelectorAll(".cockpit-agent-turn-tool")].map((n) => n.textContent ?? "");
      assert(tools.includes("grep"), `empty elementId renders bare tool name (saw: ${tools.join(", ")})`);
      assert(!tools.some((t) => t.includes("()")), `no empty () suffix rendered (saw: ${tools.join(", ")})`);
      assert(tools.includes("view (tool)"), `a present elementId still renders its suffix (saw: ${tools.join(", ")})`);
    } finally {
      handle.dispose();
    }
  } finally {
    restore();
  }
});

// #833 — an "Agent" grid link lands on the cockpit focused on ONE process instance. The agent may run
// in a CHILD instance (call activity), so the focus resolves the engine AgentInstances whose ROOT is
// the linked key and matches live job correlations against every instance in that tree.
const PI_ROOT = "pi-root";
const FOCUS_INSTANCE = {
  agentInstanceKey: "ai-7",
  status: "THINKING",
  processInstanceKey: "pi-child",
  rootProcessInstanceKey: PI_ROOT,
  elementId: "implement-task",
  creationDate: "2024-01-01T00:00:00Z",
};
const FOCUS_HISTORY = {
  agentInstanceKey: "ai-7",
  count: 1,
  instance: FOCUS_INSTANCE,
  records: [
    {
      historyItemKey: "h-0",
      agentInstanceKey: "ai-7",
      loopIteration: 0,
      role: "ASSISTANT",
      commitStatus: "COMMITTED",
      content: [{ contentType: "TEXT", text: "working on the focused process" }],
      toolCalls: [],
    },
  ],
};

function focusStub(opts: { correlations: unknown[]; transcripts?: unknown[]; replay?: unknown; seen?: string[] }) {
  return (url: string): Promise<unknown> => {
    opts.seen?.push(url);
    const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
    if (url.includes("/supply")) return ok({ leaves: [], workers: [], correlations: opts.correlations });
    if (/\/agent-instances\/[^/?]+\/history/.test(url)) return ok(FOCUS_HISTORY);
    if (url.includes("/agent-instances")) {
      const root = url.includes(`rootProcessInstanceKey=${PI_ROOT}`);
      return ok(root ? { count: 1, instances: [FOCUS_INSTANCE] } : { count: 0, instances: [] });
    }
    if (/[?&]stream=/.test(url)) return ok(opts.replay);
    if (url.includes("/transcripts")) {
      const mine = (opts.transcripts ?? []).filter((t) => url.includes(`processInstanceKey=${(t as { processInstanceKey: string }).processInstanceKey}`));
      return ok({ count: mine.length, transcripts: mine });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

test("#833: a process-focus route live-drills the worker running a job of a CHILD instance and shows its agent history", async () => {
  const restore = installEnv(focusStub({ correlations: [{ jobKey: "j1", stream: "wk-a/j1", processInstanceKey: "pi-child" }] }));
  (globalThis as { location: { hash: string } }).location.hash = `#/cockpit/process/${PI_ROOT}`;
  try {
    const { mountCockpit } = await import("../../../pages/cockpit/mount.js");
    const handle = mountCockpit(document.getElementById("root"), OPTS);
    try {
      await settle();
      assert((document.querySelector(".cockpit-focus")?.textContent ?? "").includes(PI_ROOT), "the focus banner names the process");
      assertEquals(document.querySelector(".cockpit-terminal")?.getAttribute("data-terminal-mode"), "live");
      assert(StubWebSocket.instances.length > 0, "a relay socket was opened for the focused job");
      const transcript = document.querySelector('.cockpit-agent-transcript[data-agent-instance-key="ai-7"]');
      assert((transcript?.textContent ?? "").includes("working on the focused process"), "the focused agent's history is shown");
    } finally {
      handle.dispose();
    }
  } finally {
    restore();
  }
});

test("#833: with no live job, the process focus replays the newest captured transcript of that process", async () => {
  const replay = {
    stream: "wk-a/j9",
    from: 0,
    gap: false,
    nextOffset: 1,
    entries: [{ offset: 0, chunk: envChunk("message", { role: "assistant", text: "finished earlier" }) }],
  };
  const transcripts = [
    { stream: "wk-a/j9", lifecycle: "ephemeral", status: "completed", createdAt: "2024-01-01T00:00:00Z", nextOffset: 1, byteLength: 10, chunkCount: 1, processInstanceKey: "pi-child" },
  ];
  const restore = installEnv(focusStub({ correlations: [], transcripts, replay }));
  (globalThis as { location: { hash: string } }).location.hash = `#/cockpit/process/${PI_ROOT}`;
  try {
    const { mountCockpit } = await import("../../../pages/cockpit/mount.js");
    const handle = mountCockpit(document.getElementById("root"), OPTS);
    try {
      await settle();
      assertEquals(document.querySelector(".cockpit-terminal")?.getAttribute("data-terminal-mode"), "replay");
      assert((document.querySelector('[data-terminal="host"]')?.textContent ?? "").includes("finished earlier"));
    } finally {
      handle.dispose();
    }
  } finally {
    restore();
  }
});

test("#833: embedded, the host page's #/cockpit/<process_key> (the grid 'Agent' link) focuses the cockpit", async () => {
  const restore = installEnv(focusStub({ correlations: [] }));
  const win = (globalThis as { window: Record<string, unknown> }).window;
  const savedParent = win.parent;
  win.parent = { location: { hash: `#/cockpit/${PI_ROOT}` } };
  try {
    const { mountCockpit } = await import("../../../pages/cockpit/mount.js");
    const handle = mountCockpit(document.getElementById("root"), OPTS);
    try {
      await settle();
      assert((document.querySelector(".cockpit-focus")?.textContent ?? "").includes(PI_ROOT), "the host param focused the cockpit");
    } finally {
      handle.dispose();
    }
  } finally {
    win.parent = savedParent;
    restore();
  }
});

test("#833: no focus route → no focus banner", async () => {
  const restore = installEnv(fetchStub());
  try {
    const { mountCockpit } = await import("../../../pages/cockpit/mount.js");
    const handle = mountCockpit(document.getElementById("root"), OPTS);
    try {
      await settle();
      assertEquals(document.querySelector(".cockpit-focus")?.getAttribute("data-focus"), "none");
    } finally {
      handle.dispose();
    }
  } finally {
    restore();
  }
});

// #834 review — a MUTABLE fetch stub: the supply correlations and per-tree transcripts can change
// between polls, so a test can model a focused live job finishing and its session becoming a capture.
function mutableFocusStub(state: { correlations: unknown[]; transcripts: unknown[]; replay?: unknown; roots?: string[] }) {
  return (url: string): Promise<unknown> => {
    const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
    if (url.includes("/supply")) return ok({ leaves: [], workers: [], correlations: state.correlations });
    if (/\/agent-instances\/[^/?]+\/history/.test(url)) return ok(FOCUS_HISTORY);
    if (url.includes("/agent-instances")) {
      const root = (state.roots ?? [PI_ROOT]).some((r) => url.includes(`rootProcessInstanceKey=${r}`));
      return ok(root ? { count: 1, instances: [FOCUS_INSTANCE] } : { count: 0, instances: [] });
    }
    if (/[?&]stream=/.test(url)) return ok(state.replay);
    if (url.includes("/transcripts")) {
      const mine = state.transcripts.filter((t) => url.includes(`processInstanceKey=${(t as { processInstanceKey: string }).processInstanceKey}`));
      return ok({ count: mine.length, transcripts: mine });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  };
}

test("#834: when the auto-followed live job finishes, the focus falls back to the newest capture", async () => {
  const replay = {
    stream: "wk-a/j1",
    from: 0,
    gap: false,
    nextOffset: 1,
    entries: [{ offset: 0, chunk: envChunk("message", { role: "assistant", text: "captured after finish" }) }],
  };
  const state = {
    correlations: [{ jobKey: "j1", stream: "wk-a/j1", processInstanceKey: "pi-child" }] as unknown[],
    transcripts: [] as unknown[],
    replay,
  };
  const restore = installEnv(mutableFocusStub(state));
  (globalThis as { location: { hash: string } }).location.hash = `#/cockpit/process/${PI_ROOT}`;
  try {
    const { mountCockpit } = await import("../../../pages/cockpit/mount.js");
    const handle = mountCockpit(document.getElementById("root"), OPTS);
    try {
      await settle();
      assertEquals(document.querySelector(".cockpit-terminal")?.getAttribute("data-terminal-mode"), "live");
      // The followed job finishes: its live correlation drops out and its session becomes a capture.
      state.correlations = [];
      state.transcripts = [
        { stream: "wk-a/j1", lifecycle: "ephemeral", status: "completed", createdAt: "2024-01-01T00:00:00Z", nextOffset: 1, byteLength: 10, chunkCount: 1, processInstanceKey: "pi-child" },
      ];
      await handle.refresh();
      await settle();
      assertEquals(document.querySelector(".cockpit-terminal")?.getAttribute("data-terminal-mode"), "replay");
      assert((document.querySelector('[data-terminal="host"]')?.textContent ?? "").includes("captured after finish"), "the newest capture replays after the live job ends");
    } finally {
      handle.dispose();
    }
  } finally {
    restore();
  }
});

test("#834: changing the focused process resets the terminal — it never keeps showing the old process's live stream", async () => {
  const state = {
    correlations: [{ jobKey: "j1", stream: "wk-a/j1", processInstanceKey: "pi-child" }] as unknown[],
    transcripts: [] as unknown[],
    replay: undefined as unknown,
  };
  const restore = installEnv(mutableFocusStub(state));
  (globalThis as { location: { hash: string } }).location.hash = `#/cockpit/process/${PI_ROOT}`;
  try {
    const { mountCockpit } = await import("../../../pages/cockpit/mount.js");
    const handle = mountCockpit(document.getElementById("root"), OPTS);
    try {
      await settle();
      assertEquals(document.querySelector(".cockpit-terminal")?.getAttribute("data-terminal-mode"), "live");
      // Focus a DIFFERENT process with no live job and no capture: the terminal must reset to idle,
      // not keep replaying process A's live stream.
      handle.focus("pi-other");
      await settle();
      assert((document.querySelector(".cockpit-focus")?.textContent ?? "").includes("pi-other"), "the banner names the new focus");
      assertEquals(document.querySelector(".cockpit-terminal")?.getAttribute("data-terminal-mode"), "idle");
    } finally {
      handle.dispose();
    }
  } finally {
    restore();
  }
});

test("#834: navigating from a process route to the main route clears the focus", async () => {
  const restore = installEnv(focusStub({ correlations: [] }));
  (globalThis as { location: { hash: string } }).location.hash = `#/cockpit/process/${PI_ROOT}`;
  try {
    const { mountCockpit } = await import("../../../pages/cockpit/mount.js");
    const handle = mountCockpit(document.getElementById("root"), OPTS);
    try {
      await settle();
      assert((document.querySelector(".cockpit-focus")?.textContent ?? "").includes(PI_ROOT), "the process route focused the cockpit");
      // Navigate away to the main route: the URL no longer selects a process, so the focus must clear
      // (the banner and background focus polls must not keep following the process the view left).
      // linkedom's dispatchEvent rejects a native Event, so construct the event from the stub window.
      (globalThis as { location: { hash: string } }).location.hash = "#/cockpit";
      const win = (globalThis as { window: { Event: new (t: string) => unknown; dispatchEvent: (e: unknown) => void } }).window;
      win.dispatchEvent(new win.Event("hashchange"));
      await settle();
      assertEquals(document.querySelector(".cockpit-focus")?.getAttribute("data-focus"), "none");
    } finally {
      handle.dispose();
    }
  } finally {
    restore();
  }
});

test("#834: a failed auto-opened history read is retried on a later poll", async () => {
  // The history read fails on the FIRST attempt (ok:false → boundedJson throws), then succeeds. The
  // focus must not latch the run as shown on the failed read: a later poll re-fires it and lands the detail.
  let historyCalls = 0;
  const state = { correlations: [] as unknown[], transcripts: [] as unknown[], replay: undefined as unknown };
  const base = mutableFocusStub(state);
  const restore = installEnv((url: string) => {
    if (/\/agent-instances\/[^/?]+\/history/.test(url)) {
      historyCalls++;
      if (historyCalls === 1) return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
    }
    return base(url);
  });
  (globalThis as { location: { hash: string } }).location.hash = `#/cockpit/process/${PI_ROOT}`;
  try {
    const { mountCockpit } = await import("../../../pages/cockpit/mount.js");
    const handle = mountCockpit(document.getElementById("root"), OPTS);
    try {
      await settle();
      assertEquals(historyCalls, 1, "the focus auto-opened the newest run's history once");
      assert(
        (document.querySelector(".cockpit-agent-transcript")?.textContent ?? "").includes("working on the focused process") === false,
        "the failed read rendered nothing",
      );
      // A later poll retries the failed read; the detail now renders.
      await handle.refresh();
      await settle();
      assert(historyCalls >= 2, "the failed auto-open was retried on a later poll");
      assert(
        (document.querySelector(".cockpit-agent-transcript")?.textContent ?? "").includes("working on the focused process"),
        "the retried read rendered the focused agent's history",
      );
    } finally {
      handle.dispose();
    }
  } finally {
    restore();
  }
});

test("#834: 'Show all' clears the focus route from the URL so a refresh does not reopen the process", async () => {
  const restore = installEnv(focusStub({ correlations: [] }));
  (globalThis as { location: { hash: string } }).location.hash = `#/cockpit/process/${PI_ROOT}`;
  try {
    const { mountCockpit } = await import("../../../pages/cockpit/mount.js");
    const handle = mountCockpit(document.getElementById("root"), OPTS);
    try {
      await settle();
      assert((document.querySelector(".cockpit-focus")?.textContent ?? "").includes(PI_ROOT), "the process route focused the cockpit");
      // Clicking "Show all" must navigate the focus route out of the URL, not just hide the banner —
      // otherwise refreshing/sharing `#/cockpit/process/<key>` reopens the process just cleared (#834).
      const clear = document.querySelector(".cockpit-focus-clear");
      assert(clear != null, "the focus banner offers a 'Show all' control");
      const win = (globalThis as { window: { Event: new (t: string) => unknown; dispatchEvent: (e: unknown) => void } }).window;
      (clear as { dispatchEvent: (e: unknown) => void }).dispatchEvent(new win.Event("click"));
      assertEquals((globalThis as { location: { hash: string } }).location.hash, "#/cockpit", "'Show all' navigated the URL back to the cockpit root");
      // The resulting hashchange then clears the focus, exactly as a real browser navigation would.
      win.dispatchEvent(new win.Event("hashchange"));
      await settle();
      assertEquals(document.querySelector(".cockpit-focus")?.getAttribute("data-focus"), "none");
    } finally {
      handle.dispose();
    }
  } finally {
    restore();
  }
});

test("#834: switching the focused process clears the old focus's agent-history list immediately", async () => {
  const state = { correlations: [] as unknown[], transcripts: [] as unknown[], replay: undefined as unknown };
  const restore = installEnv(mutableFocusStub(state));
  (globalThis as { location: { hash: string } }).location.hash = `#/cockpit/process/${PI_ROOT}`;
  try {
    const { mountCockpit } = await import("../../../pages/cockpit/mount.js");
    const handle = mountCockpit(document.getElementById("root"), OPTS);
    try {
      await settle();
      assert(document.querySelector(".cockpit-agent-region .cockpit-agent-history") != null, "focus A rendered its agent-history list");
      // The switch must blank the list SYNCHRONOUSLY, not leave A's rows up until B's reads land: a click
      // on a stale A row would otherwise start a detail read under B's focus generation (#834).
      handle.focus("pi-other");
      assertEquals(document.querySelector(".cockpit-agent-region")?.childElementCount, 0, "the old focus's history list was cleared immediately on focus change");
    } finally {
      handle.dispose();
    }
  } finally {
    restore();
  }
});

test("#834: a superseded focus's in-flight transcript scan does not block the new focus's scan", async () => {
  // Park focus A's per-tree transcript scan on a never-settling fetch, then switch to B. With a shared
  // scan lock, B would skip its scan until A's request settled (up to the 15s timeout); the lock must be
  // scoped to the focus generation so B scans immediately and replays its own capture (#834).
  let releaseA: () => void = () => {};
  const aParked = new Promise<void>((r) => {
    releaseA = r;
  });
  const bReplay = {
    stream: "wk-b/j9",
    from: 0,
    gap: false,
    nextOffset: 1,
    entries: [{ offset: 0, chunk: envChunk("message", { role: "assistant", text: "B capture replays" }) }],
  };
  const state = { correlations: [] as unknown[], transcripts: [] as unknown[], replay: bReplay, roots: [] as string[] };
  const base = mutableFocusStub(state);
  const restore = installEnv(async (url: string) => {
    if (url.includes("/transcripts") && url.includes(`processInstanceKey=${PI_ROOT}`)) {
      await aParked; // focus A's scan hangs here until released
      return { ok: true, status: 200, json: async () => ({ count: 0, transcripts: [] }) };
    }
    return base(url);
  });
  (globalThis as { location: { hash: string } }).location.hash = `#/cockpit/process/${PI_ROOT}`;
  try {
    const { mountCockpit } = await import("../../../pages/cockpit/mount.js");
    const handle = mountCockpit(document.getElementById("root"), OPTS);
    try {
      await settle();
      // A is focused; its transcript scan is parked awaiting `aParked` and holds the scan lock.
      assertEquals(document.querySelector(".cockpit-terminal")?.getAttribute("data-terminal-mode"), "idle");
      // Switch to B, which HAS a capture: its scan must run despite A's lock still being held.
      state.transcripts = [
        { stream: "wk-b/j9", lifecycle: "ephemeral", status: "completed", createdAt: "2024-01-01T00:00:00Z", nextOffset: 1, byteLength: 10, chunkCount: 1, processInstanceKey: "pi-bee" },
      ];
      handle.focus("pi-bee");
      await settle();
      assertEquals(document.querySelector(".cockpit-terminal")?.getAttribute("data-terminal-mode"), "replay");
      assert(
        (document.querySelector('[data-terminal="host"]')?.textContent ?? "").includes("B capture replays"),
        "the new focus replayed its capture even though the superseded focus's scan is still in flight",
      );
    } finally {
      releaseA();
      handle.dispose();
    }
  } finally {
    restore();
  }
});
