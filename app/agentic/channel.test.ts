// Integration tests for the agentic channel mount (ADR 0056, H0 / #143).
//
// Exercises the acceptance surface against a locally-constructed `node:http` server: a valid WS
// client upgrades on `/agentic`, an invalid one is rejected, normal HTTP routes keep working, the
// hub is visible via `inspect()`, families mount/tear-down through the seam, and shutdown is clean.
import { type AddressInfo, createServer, type Server } from "node:http";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { assert, assertEquals } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import { type AgenticChannelHandle, mountAgenticChannel } from "./channel.ts";
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
function rejectionCode(port: number, query: string): Promise<number> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/agentic${query}`);
  return new Promise<number>((resolve, reject) => {
    ws.on("error", () => {
      /* swallow the paired error event; the close frame carries the code */
    });
    ws.on("close", (code) => resolve(code));
    setTimeout(() => reject(new Error("connection neither closed nor timed out")), 2000).unref?.();
  });
}

async function mount(
  port: number,
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

test("a valid identity token + capability credential upgrades on /agentic", async () => {
  const { server, port } = await startHttp();
  const channel = await mount(port, server);
  after(async () => {
    await channel.teardown();
    server.close();
  });

  const ws = await connect(port, `?token=${SECRET}&capability=cap-1`);
  assertEquals(ws.readyState, WebSocket.OPEN);
  // The hub tracked exactly this one connection.
  assertEquals(channel.hub.connectionCount, 1);
  ws.close();
});

test("an invalid identity token is rejected (4401)", async () => {
  const { server, port } = await startHttp();
  const channel = await mount(port, server);
  after(async () => {
    await channel.teardown();
    server.close();
  });

  const closedCode = await rejectionCode(port, "?token=wrong&capability=cap-1");
  assertEquals(closedCode, 4401);
  assertEquals(channel.hub.connectionCount, 0);
});

test("a missing capability credential is rejected (4403)", async () => {
  const { server, port } = await startHttp();
  const channel = await mount(port, server);
  after(async () => {
    await channel.teardown();
    server.close();
  });

  const closedCode = await rejectionCode(port, `?token=${SECRET}`);
  assertEquals(closedCode, 4403);
});

test("normal HTTP routes keep working alongside the channel", async () => {
  const { server, port } = await startHttp();
  const channel = await mount(port, server);
  after(async () => {
    await channel.teardown();
    server.close();
  });

  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "ok");
});

test("the hub is visible via inspect() and mounts registered families", async () => {
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
  after(() => server.close());

  const snap = channel.inspect();
  assertEquals(snap.path, "/agentic");
  assertEquals(snap.families, ["probe"]);
  assertEquals(trace, ["mount"]);
  assert(channel.hub.router.has("register"), "family handler should be registered");

  await channel.teardown();
  assertEquals(trace, ["mount", "teardown"]);
});

test("teardown closes live connections and is idempotent", async () => {
  const { server, port } = await startHttp();
  const channel = await mount(port, server);
  after(() => server.close());

  const ws = await connect(port, `?token=${SECRET}&capability=cap-1`);
  const closed = new Promise<void>((resolve) => ws.on("close", () => resolve()));
  assertEquals(channel.hub.connectionCount, 1);

  await channel.teardown();
  await channel.teardown(); // second call is a no-op, must not throw
  await closed;
  assertEquals(ws.readyState, WebSocket.CLOSED);
});

test("a missing secret is refused (never mount an open channel)", async () => {
  const { server, port } = await startHttp();
  after(() => server.close());
  let threw = false;
  try {
    await mountAgenticChannel({ server, secret: "", data: undefined, log: noopLog() });
  } catch {
    threw = true;
  }
  assert(threw, "mountAgenticChannel must reject an empty secret");
  assertEquals(port > 0, true);
});
