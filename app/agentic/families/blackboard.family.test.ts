// Tests for H4's channel-side `blackboard` family module (#147). These prove the generalized
// agentic-channel path is a faithful bridge to the SAME per-plan board the HTTP hook serves:
//   - a channel `append` frame writes the very rows `readBlackboard(data, planKey)` (the HTTP path)
//     reads back — one canonical store, no drift surface;
//   - `file-claim` conflict-of-intent is reported on the channel exactly as over HTTP;
//   - board scope is capability-derived (the plan's blackboard token → plan_key), so a connection
//     only ever touches the board its credential authorises;
//   - an unknown/absent credential is rejected (advisory — the frame is dropped, never a hard-lock).
import test from "node:test";
import { AgenticHub, type HubConnection, sharedSecretAuthenticator } from "@nanobpm/agentic/channel";
import type { ChannelTransport, HandshakeRequest } from "@nanobpm/agentic/channel";
import type { Frame } from "@nanobpm/agentic/protocol";
import { assert, assertEquals } from "#test-assert";
import { noopLog } from "../../../test/log.ts";
import { memBlackboardData } from "../../../test/blackboardDb.ts";
import { readBlackboard } from "../../blackboard.ts";
import type { AgenticContext } from "../registry.ts";
import { family } from "./blackboard.family.ts";

/** A do-nothing transport just to satisfy the hub constructor; the tests drive the router directly. */
function fakeTransport(): ChannelTransport {
  return {
    onConnection() {},
    address: null,
    async close() {},
  };
}

/** Build a hub + mount the blackboard family over a real in-memory DataLayer. */
function mountFamily() {
  const { data, db, close } = memBlackboardData();
  const hub = new AgenticHub({
    transport: fakeTransport(),
    authenticator: sharedSecretAuthenticator({ secret: "s3cr3t" }),
    sweepIntervalMs: 0,
  });
  const ctx: AgenticContext = {
    hub,
    registry: hub.registry,
    // The blackboard family never touches the transport; a minimal stand-in is enough.
    transport: undefined as unknown as AgenticContext["transport"],
    data,
    log: noopLog(),
  };
  family.mount(ctx);
  return { hub, data, db, close };
}

/** A HubConnection whose sends are captured, presenting `credential` at the handshake. */
function conn(hub: AgenticHub, credential: string | undefined, sent: Frame[]): HubConnection {
  const handshake: HandshakeRequest = credential === undefined ? {} : { credential };
  return {
    id: `c-${credential ?? "anon"}`,
    identity: "peer",
    handshake,
    registry: hub.registry,
    send: (frame) => sent.push(frame),
    close() {},
  };
}

function seedToken(db: { run(sql: string, params?: unknown[]): unknown }, planKey: string, token: string): void {
  db.run("INSERT INTO plans (plan_key, blackboard_token) VALUES (?, ?)", [planKey, token]);
}

function appendFrame(seq: number, payload: Record<string, unknown>): Frame {
  return { lane: "control", family: "blackboard", seq, payload: { op: "append", ...payload } };
}

function readFrame(seq: number, since?: number): Frame {
  return { lane: "control", family: "blackboard", seq, payload: since === undefined ? { op: "read" } : { op: "read", since } };
}

test("channel append writes the SAME board the HTTP readBlackboard path reads", async () => {
  const { hub, data, db, close } = mountFamily();
  try {
    seedToken(db, "o/r#1", "tok-1");
    const sent: Frame[] = [];
    const c = conn(hub, "tok-1", sent);

    const ran = await hub.router.route(
      appendFrame(1, { authorTask: "gap-2", kind: "note", body: "hello board" }),
      c,
    );
    assertEquals(ran, true);
    assertEquals(sent.length, 1);
    const reply = sent[0].payload as { op: string; inserted: boolean; id: number };
    assertEquals(reply.op, "append");
    assertEquals(reply.inserted, true);
    assert(reply.id > 0);

    // Parity: the HTTP-side reader sees exactly what the channel wrote, under the same plan scope.
    const entries = await readBlackboard(data, "o/r#1");
    assertEquals(entries.length, 1);
    assertEquals(entries[0].author_task, "gap-2");
    assertEquals(entries[0].body, "hello board");
    assertEquals(entries[0].kind, "note");
  } finally {
    await hub.close();
    close();
  }
});

test("channel file-claim reports conflicts with a prior claim by another author", async () => {
  const { hub, data, db, close } = mountFamily();
  try {
    seedToken(db, "o/r#1", "tok-1");
    const sent: Frame[] = [];
    const c = conn(hub, "tok-1", sent);

    await hub.router.route(
      appendFrame(1, { authorTask: "gap-1", kind: "file-claim", files: ["engine/state.rs"], body: "own state.rs" }),
      c,
    );
    await hub.router.route(
      appendFrame(2, { authorTask: "gap-2", kind: "file-claim", files: ["engine/state.rs"], body: "also want state.rs" }),
      c,
    );

    const second = sent[1].payload as { conflicts: { authorTask: string; file: string }[] };
    assertEquals(second.conflicts.length, 1);
    assertEquals(second.conflicts[0].authorTask, "gap-1");
    assertEquals(second.conflicts[0].file, "engine/state.rs");

    // And both rows landed on the shared board.
    const entries = await readBlackboard(data, "o/r#1");
    assertEquals(entries.length, 2);
  } finally {
    await hub.close();
    close();
  }
});

test("channel read returns entries appended over HTTP (bidirectional bridge parity)", async () => {
  const { hub, data, db, close } = mountFamily();
  try {
    seedToken(db, "o/r#1", "tok-1");
    // Write via the HTTP-path adapter…
    const { appendEntry } = await import("../../blackboard.ts");
    await appendEntry(data, "o/r#1", { author_task: "gap-3", kind: "note", body: "via http" });

    // …and read it back over the channel.
    const sent: Frame[] = [];
    const ran = await hub.router.route(readFrame(9), conn(hub, "tok-1", sent));
    assertEquals(ran, true);
    const reply = sent[0].payload as { op: string; entries: { authorTask: string; body: string }[] };
    assertEquals(reply.op, "read");
    assertEquals(reply.entries.length, 1);
    assertEquals(reply.entries[0].authorTask, "gap-3");
    assertEquals(reply.entries[0].body, "via http");
  } finally {
    await hub.close();
    close();
  }
});

test("an unknown credential is rejected — no board is touched, no reply sent", async () => {
  const { hub, data, db, close } = mountFamily();
  try {
    seedToken(db, "o/r#1", "tok-1");
    const sent: Frame[] = [];
    const ran = await hub.router.route(
      appendFrame(1, { authorTask: "gap-2", kind: "note", body: "should not land" }),
      conn(hub, "bogus-token", sent),
    );
    assertEquals(ran, true); // the handler ran (and rejected) — the family owns the frame
    assertEquals(sent.length, 0); // no reply: scope could not be resolved
    // Nothing was written under any scope.
    const [{ n }] = db.all<{ n: number }>("SELECT COUNT(*) AS n FROM agentic_blackboard");
    assertEquals(n, 0);
    assertEquals((await readBlackboard(data, "o/r#1")).length, 0);
  } finally {
    await hub.close();
    close();
  }
});

test("an absent credential is rejected too", async () => {
  const { hub, db, close } = mountFamily();
  try {
    seedToken(db, "o/r#1", "tok-1");
    const sent: Frame[] = [];
    await hub.router.route(appendFrame(1, { kind: "note", body: "x" }), conn(hub, undefined, sent));
    assertEquals(sent.length, 0);
  } finally {
    await hub.close();
    close();
  }
});
