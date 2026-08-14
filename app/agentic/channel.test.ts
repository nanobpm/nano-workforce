// Integration tests for the agentic channel mount (ADR 0056, H0 / #143).
//
// Exercises the acceptance surface against a locally-constructed `node:http` server: a valid WS
// client upgrades on `/agentic`, an invalid one is rejected, normal HTTP routes keep working, the
// hub is visible via `inspect()`, families mount/tear-down through the seam, and shutdown is clean.
import { type AddressInfo, createServer, type Server } from "node:http";
import { test } from "node:test";
import { createLogger } from "@nanobpm/urban/runtime";
import { WebSocket } from "ws";
import { assert, assertEquals } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import { type AgenticChannelHandle, LOCAL_AGENTIC_TOKEN, mountAgenticChannel } from "./channel.ts";
import { type AgenticContext, AgenticFamilyRegistry } from "./registry.ts";

const SECRET = "test-agentic-secret";

/** Start a bare HTTP server with one health route, on an ephemeral port. */
async function startHttp(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, port };
}

/** Close an HTTP server and resolve only once it has stopped listening (server.close() is async). */
function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/** Open a ws client and resolve on open. Rejects (with the close code) if it closes before opening. */
function connect(port: number, query: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/agentic${query}`);
  return new Promise<WebSocket>((resolve, reject) => {
    let opened = false;
    ws.on("open", () => {
      opened = true;
      resolve(ws);
    });
    ws.on("error", () => {
      /* the close frame carries the reason; swallow the paired error event */
    });
    ws.on("close", (code, reason) => {
      if (!opened) reject(new Error(`closed ${code}: ${reason.toString()}`));
    });
  });
}

/**
 * The application close code an authenticator rejection delivers. The hub authenticates AFTER the
 * WebSocket upgrade completes, so a rejected peer momentarily opens and is then closed with the app
 * code (4401/4403) — this waits for that close and returns the code.
 */
/** How long rejectionCode waits for the close frame before failing (generous for slow CI). */
const REJECTION_TIMEOUT_MS = 2000;

function rejectionCode(port: number, query: string): Promise<number> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/agentic${query}`);
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("connection neither closed nor timed out")),
      REJECTION_TIMEOUT_MS,
    );
    timer.unref?.();
    ws.on("error", () => {
      /* swallow the paired error event; the close frame carries the code */
    });
    ws.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function mount(
  _port: number,
  server: Server,
  families?: () => AgenticFamilyRegistry,
): Promise<AgenticChannelHandle> {
  return mountAgenticChannel({
    server,
    secret: SECRET,
    data: undefined,
    log: noopLog(),
    families,
  });
}

test("a valid identity token + capability credential upgrades on /agentic", async (t) => {
  const { server, port } = await startHttp();
  const channel = await mount(port, server);
  t.after(async () => {
    await channel.teardown();
    await closeServer(server);
  });

  const ws = await connect(port, `?token=${SECRET}&capability=cap-1`);
  assertEquals(ws.readyState, WebSocket.OPEN);
  // The hub tracked exactly this one connection.
  assertEquals(channel.hub.connectionCount, 1);
  ws.close();
});

test("an invalid identity token is rejected (4401)", async (t) => {
  const { server, port } = await startHttp();
  const channel = await mount(port, server);
  t.after(async () => {
    await channel.teardown();
    await closeServer(server);
  });

  const closedCode = await rejectionCode(port, "?token=wrong&capability=cap-1");
  assertEquals(closedCode, 4401);
  assertEquals(channel.hub.connectionCount, 0);
});

test("a missing capability credential is rejected (4403)", async (t) => {
  const { server, port } = await startHttp();
  const channel = await mount(port, server);
  t.after(async () => {
    await channel.teardown();
    await closeServer(server);
  });

  const closedCode = await rejectionCode(port, `?token=${SECRET}`);
  assertEquals(closedCode, 4403);
});

test("normal HTTP routes keep working alongside the channel", async (t) => {
  const { server, port } = await startHttp();
  const channel = await mount(port, server);
  t.after(async () => {
    await channel.teardown();
    await closeServer(server);
  });

  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "ok");
});

test("the hub is visible via inspect() and mounts registered families", async (t) => {
  const { server, port } = await startHttp();
  const trace: string[] = [];
  const families = () => {
    const reg = new AgenticFamilyRegistry();
    reg.register({
      name: "probe",
      mount(ctx: AgenticContext) {
        trace.push("mount");
        // Prove the real hub handle is threaded through: registering a family handler must work.
        ctx.hub.registerFamilyHandler("register", () => {});
      },
      teardown() {
        trace.push("teardown");
      },
    });
    return reg;
  };
  const channel = await mount(port, server, families);
  t.after(() => closeServer(server));

  const snap = channel.inspect();
  assertEquals(snap.path, "/agentic");
  assertEquals(snap.families, ["probe"]);
  assertEquals(trace, ["mount"]);
  assert(channel.hub.router.has("register"), "family handler should be registered");

  await channel.teardown();
  assertEquals(trace, ["mount", "teardown"]);
});

test("teardown closes live connections and is idempotent", async (t) => {
  const { server, port } = await startHttp();
  const channel = await mount(port, server);
  t.after(() => closeServer(server));

  const ws = await connect(port, `?token=${SECRET}&capability=cap-1`);
  const closed = new Promise<void>((resolve) => ws.on("close", () => resolve()));
  assertEquals(channel.hub.connectionCount, 1);

  await channel.teardown();
  await channel.teardown(); // second call is a no-op, must not throw
  await closed;
  assertEquals(ws.readyState, WebSocket.CLOSED);
});

test("a family mount failure tears down already-mounted families and closes the hub", async (t) => {
  const { server, port } = await startHttp();
  t.after(() => closeServer(server));
  const trace: string[] = [];
  const families = () => {
    const reg = new AgenticFamilyRegistry();
    reg.register({
      name: "ok",
      mount() {
        trace.push("mount-ok");
      },
      teardown() {
        trace.push("teardown-ok");
      },
    });
    reg.register({
      name: "boom",
      mount() {
        trace.push("mount-boom");
        throw new Error("family boom failed to mount");
      },
    });
    return reg;
  };

  let threw = false;
  try {
    await mount(port, server, families);
  } catch {
    threw = true;
  }
  assert(threw, "mountAgenticChannel must reject when a family mount throws");
  // The already-mounted family was torn down (reverse order) — no family left half-mounted, and the
  // hub was closed on the same path (see mountAgenticChannel's failure handler).
  assertEquals(trace, ["mount-ok", "mount-boom", "teardown-ok"]);
});

test("a missing secret is refused (never mount an open channel)", async (t) => {
  const { server, port } = await startHttp();
  t.after(() => closeServer(server));
  let threw = false;
  try {
    await mountAgenticChannel({ server, secret: "", data: undefined, log: noopLog() });
  } catch {
    threw = true;
  }
  assert(threw, "mountAgenticChannel must reject an empty secret");
  assertEquals(port > 0, true);
});

test("LOCAL mode (secure:false): the well-known token upgrades with NO credential", async (t) => {
  const { server, port } = await startHttp();
  // Local-first default-on: no secret, no credential — a `nano work` worker appears live with the
  // well-known localhost token alone (security opt-in).
  const channel = await mountAgenticChannel({
    server,
    secret: "",
    secure: false,
    data: undefined,
    log: noopLog(),
  });
  t.after(async () => {
    await channel.teardown();
    await closeServer(server);
  });

  const ws = await connect(port, `?token=${LOCAL_AGENTIC_TOKEN}`);
  assertEquals(ws.readyState, WebSocket.OPEN);
  assertEquals(channel.hub.connectionCount, 1);
  assertEquals(channel.inspect().mode, "local");
  ws.close();
});

test("LOCAL mode still rejects a wrong token (4401)", async (t) => {
  const { server, port } = await startHttp();
  const channel = await mountAgenticChannel({
    server,
    secret: "",
    secure: false,
    data: undefined,
    log: noopLog(),
  });
  t.after(async () => {
    await channel.teardown();
    await closeServer(server);
  });

  const closedCode = await rejectionCode(port, "?token=not-the-local-token");
  assertEquals(closedCode, 4401);
  assertEquals(channel.hub.connectionCount, 0);
});

/** A capturing `Logger`: records every `(level, msg)` pair the sink receives. */
function capturingLog(): { log: ReturnType<typeof noopLog>; records: Array<{ level: string; msg: string }> } {
  const records: Array<{ level: string; msg: string }> = [];
  const log = createLogger((level: string, msg: string) => {
    records.push({ level, msg });
  });
  return { log, records };
}

test("LOCAL mode warns when the server is bound to a non-loopback interface", async (t) => {
  const server = createServer((_req, res) => res.end());
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const { log, records } = capturingLog();
  const channel = await mountAgenticChannel({
    server,
    secret: "",
    secure: false,
    data: undefined,
    log,
  });
  t.after(async () => {
    await channel.teardown();
    await closeServer(server);
  });

  const warned = records.some((r) => r.level === "warn" && r.msg.includes("not bound to loopback"));
  assert(warned, "LOCAL mode on a non-loopback bind must warn that the well-known token is exposed");
});

test("LOCAL mode does NOT warn when the server is bound to loopback", async (t) => {
  const { server } = await startHttp();
  const { log, records } = capturingLog();
  const channel = await mountAgenticChannel({
    server,
    secret: "",
    secure: false,
    data: undefined,
    log,
  });
  t.after(async () => {
    await channel.teardown();
    await closeServer(server);
  });

  const warned = records.some((r) => r.level === "warn" && r.msg.includes("not bound to loopback"));
  assert(!warned, "a loopback-bound LOCAL channel is the expected safe case and must not warn");
});
