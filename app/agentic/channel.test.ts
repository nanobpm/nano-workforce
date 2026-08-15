// Integration tests for the agentic channel mount (ADR 0056, H0 / #143).
//
// Exercises the acceptance surface against a locally-constructed `node:http` server: a valid WS
// client upgrades on `/agentic`, an invalid one is rejected, normal HTTP routes keep working, the
// hub is visible via `inspect()`, families mount/tear-down through the seam, and shutdown is clean.
import { type AddressInfo, createServer, type Server } from "node:http";
import { test } from "node:test";
import { AUTH_UNAUTHORIZED } from "@nanobpm/agentic/channel";
import { createLogger } from "@nanobpm/urban/runtime";
import { WebSocket } from "ws";
import { assert, assertEquals } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import {
  type AgenticChannelHandle,
  isForwardedConnection,
  isLoopbackRemote,
  LOCAL_AGENTIC_TOKEN,
  loopbackOnly,
  mountAgenticChannel,
} from "./channel.ts";
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

test("LOCAL mode warns when the server bind address is unverifiable (not listening)", async (t) => {
  const { server } = await startHttp();
  // Simulate a server whose bind cannot be verified (e.g. mounted before `listen` resolves):
  // `address()` returns null, so the LOCAL exposure check cannot confirm a loopback-only bind.
  const realAddress = server.address.bind(server);
  server.address = () => null;
  const { log, records } = capturingLog();
  const channel = await mountAgenticChannel({
    server,
    secret: "",
    secure: false,
    data: undefined,
    log,
  });
  t.after(async () => {
    server.address = realAddress;
    await channel.teardown();
    await closeServer(server);
  });

  const warned = records.some(
    (r) => r.level === "warn" && r.msg.includes("bind address could not be verified"),
  );
  assert(warned, "LOCAL mode on an unbound server must warn that the well-known token is unverifiable");
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

// --- Loopback-only enforcement of the LOCAL well-known token (issue #224 / nano-ide#235) ---
//
// The LOCAL token is not a secret, so once the app binds to all interfaces (network.bind: "all") it
// must never be honoured off-box. `isLoopbackRemote` vets the peer's origin; `loopbackOnly` wraps an
// authenticator to refuse a non-loopback peer with 4401 while delegating loopback peers to the base.

test("isLoopbackRemote accepts same-host peers and rejects everything else", () => {
  for (const ok of ["127.0.0.1", "127.0.0.5", "::1", "::ffff:127.0.0.1", "::ffff:127.1.2.3"]) {
    assert(isLoopbackRemote(ok), `${ok} should be loopback`);
  }
  for (const no of [undefined, "", "10.0.0.4", "192.168.1.20", "::ffff:10.0.0.4", "2001:db8::1", "0.0.0.0"]) {
    assert(!isLoopbackRemote(no), `${String(no)} should NOT be loopback`);
  }
});

test("loopbackOnly refuses a non-loopback peer with 4401 and never calls the base authenticator", () => {
  let baseCalls = 0;
  const base = () => {
    baseCalls++;
    return { ok: true as const, grant: { identity: "peer" } };
  };
  const guarded = loopbackOnly(base);

  const remote = guarded({ token: LOCAL_AGENTIC_TOKEN, remote: "10.0.0.4" });
  assert(!("then" in remote), "authenticator result is synchronous here");
  assertEquals((remote as { ok: boolean; code?: number }).ok, false);
  assertEquals((remote as { code?: number }).code, AUTH_UNAUTHORIZED);
  assertEquals(baseCalls, 0);
});

test("loopbackOnly delegates a loopback peer to the base authenticator", () => {
  let baseCalls = 0;
  const base = () => {
    baseCalls++;
    return { ok: true as const, grant: { identity: "peer" } };
  };
  const guarded = loopbackOnly(base);

  const local = guarded({ token: LOCAL_AGENTIC_TOKEN, remote: "127.0.0.1" });
  assertEquals((local as { ok: boolean }).ok, true);
  assertEquals(baseCalls, 1);
});

// A reverse proxy that connects to the app over loopback makes an off-box client appear same-host to
// `req.remote`. `isForwardedConnection` detects the relay from proxy-forwarding headers, so
// `loopbackOnly` fails closed on a proxied peer even when `req.remote` itself is loopback.

test("isForwardedConnection detects proxy-forwarding headers and ignores absent/empty ones", () => {
  assert(isForwardedConnection({ "x-forwarded-for": "10.0.0.4" }), "x-forwarded-for marks a relay");
  assert(isForwardedConnection({ forwarded: "for=10.0.0.4" }), "forwarded marks a relay");
  assert(isForwardedConnection({ "x-real-ip": "10.0.0.4" }), "x-real-ip marks a relay");

  assert(!isForwardedConnection(undefined), "no headers is a direct connection");
  assert(!isForwardedConnection({}), "empty headers is a direct connection");
  assert(!isForwardedConnection({ "x-forwarded-for": "   " }), "whitespace value is treated as absent");
  assert(!isForwardedConnection({ "content-type": "application/json" }), "unrelated headers are ignored");
});

test("loopbackOnly refuses a reverse-proxied peer (loopback remote + forwarding header) with 4401", () => {
  let baseCalls = 0;
  const base = () => {
    baseCalls++;
    return { ok: true as const, grant: { identity: "peer" } };
  };
  const guarded = loopbackOnly(base);

  const proxied = guarded({
    token: LOCAL_AGENTIC_TOKEN,
    remote: "127.0.0.1",
    headers: { "x-forwarded-for": "203.0.113.7" },
  });
  assertEquals((proxied as { ok: boolean; code?: number }).ok, false);
  assertEquals((proxied as { code?: number }).code, AUTH_UNAUTHORIZED);
  assertEquals(baseCalls, 0);
});
