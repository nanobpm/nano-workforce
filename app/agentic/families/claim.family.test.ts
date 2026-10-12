// Unit tests for the agentic `claim` / `release` job-ownership family (#713).
//
// Drives REAL `claim` / `release` frames through a live AgenticHub over an in-memory transport —
// exactly as the presence family is exercised — so the singleton the supply operation reads is the
// live one. Pins: mount attaches the two handlers and installs the registry singleton; a `claim`
// populates jobKeys with ZERO transcript; ONE connection attributes N distinct instances by the
// frame's EXPLICIT `instance` (never `conn.id`); `release` clears it and a late/duplicate release is a
// no-op; a reconnect re-`claim` never blanks a still-running job; a malformed payload is rejected
// without touching the registry; teardown clears the singleton.
import { test } from "node:test";
import { AgenticHub } from "@nanobpm/agentic/channel";
import type { Authenticator, ChannelConnection, ChannelTransport } from "@nanobpm/agentic/channel";
import { encodeFrame, type Frame } from "@nanobpm/agentic/protocol";
import { assert, assertEquals } from "#test-assert";
import { composeStreamId } from "@nanobpm/agentic/emit";
import { noopLog } from "../../../test/log.ts";
import { currentClaimRegistry } from "../claim-registry.ts";
import type { AgenticContext } from "../registry.ts";
import { CLAIM_FAMILY, family, RELEASE_FAMILY } from "./claim.family.ts";

interface FakeConn {
  readonly conn: ChannelConnection;
  feed(frame: Frame): void;
}

function fakeConn(id: string, identity: string): FakeConn {
  let onMessage: ((bytes: Uint8Array) => void) | undefined;
  const conn: ChannelConnection = {
    id,
    handshake: { query: { identity }, token: "t", credential: "c" },
    send: () => {},
    close: () => {},
    onMessage: (l) => { onMessage = l; },
    onClose: () => {},
  };
  return { conn, feed: (frame) => onMessage?.(encodeFrame(frame)) };
}

function memTransport(): { transport: ChannelTransport; connect(conn: ChannelConnection): void } {
  let onConnection: ((conn: ChannelConnection) => void) | undefined;
  const transport: ChannelTransport = {
    onConnection: (l) => { onConnection = l; },
    address: { port: 0 },
    close: async () => {},
  };
  return { transport, connect: (conn) => onConnection?.(conn) };
}

const authenticator: Authenticator = (req) => ({ ok: true, grant: { identity: req.query?.identity ?? "anon" } });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function claimFrame(instance: string, jobKey: string): Frame {
  return { lane: "control", family: CLAIM_FAMILY, seq: 1, payload: { instance, jobKey } };
}
function releaseFrame(instance: string, jobKey: string): Frame {
  return { lane: "control", family: RELEASE_FAMILY, seq: 1, payload: { instance, jobKey } };
}

function resyncFrame(instance: string, jobKeys: string[]): Frame {
  return { lane: "control", family: CLAIM_FAMILY, seq: 1, payload: { instance, jobKeys } };
}

function mountClaim(): { hub: AgenticHub; transport: ReturnType<typeof memTransport> } {
  const transport = memTransport();
  const hub = new AgenticHub({ transport: transport.transport, authenticator, sweepIntervalMs: 0 });
  const ctx: AgenticContext = {
    hub,
    registry: hub.registry,
    transport: transport.transport as never,
    data: undefined,
    log: noopLog(),
  };
  family.mount(ctx);
  return { hub, transport };
}

test("mount attaches the claim and release handlers and installs the registry singleton", () => {
  const { hub } = mountClaim();
  try {
    assertEquals(hub.router.families().sort(), ["claim", "release"]);
    assert(currentClaimRegistry() !== undefined, "the claim family installs the singleton");
  } finally {
    family.teardown?.();
  }
});

test("a claim populates the worker's jobKeys with ZERO transcript (visibility no longer needs the relay)", async () => {
  const { transport } = mountClaim();
  try {
    const peer = fakeConn("c1", "leafA");
    transport.connect(peer.conn);
    await flush();
    peer.feed(claimFrame("wk-a", "8420"));
    await flush();

    const reg = currentClaimRegistry();
    assert(reg, "registry mounted");
    assertEquals(reg.jobKeysFor("wk-a"), ["8420"]);
    assertEquals(reg.primaryStreamFor("wk-a"), composeStreamId("wk-a", "8420"), "the drill stream repoints at the claimed job");
  } finally {
    family.teardown?.();
  }
});

test("ONE connection attributes N distinct instances by the frame's EXPLICIT instance (never conn.id)", async () => {
  const { transport } = mountClaim();
  try {
    // A single per-host supervisor multiplexes two workers over ONE connection.
    const supervisor = fakeConn("c1", "host-supervisor");
    transport.connect(supervisor.conn);
    await flush();
    supervisor.feed(claimFrame("wk-a", "8420"));
    supervisor.feed(claimFrame("wk-b", "8500"));
    await flush();

    const reg = currentClaimRegistry();
    assert(reg);
    assertEquals(reg.jobKeysFor("wk-a"), ["8420"], "attributed to the frame's instance, not the connection");
    assertEquals(reg.jobKeysFor("wk-b"), ["8500"]);
    assertEquals(reg.count(), 2);
  } finally {
    family.teardown?.();
  }
});

test("release clears the jobKey; a late / duplicate release is a no-op", async () => {
  const { transport } = mountClaim();
  try {
    const peer = fakeConn("c1", "leafA");
    transport.connect(peer.conn);
    await flush();
    peer.feed(claimFrame("wk-a", "8420"));
    await flush();
    peer.feed(releaseFrame("wk-a", "8420"));
    await flush();

    const reg = currentClaimRegistry();
    assert(reg);
    assertEquals(reg.jobKeysFor("wk-a"), []);
    // Late / duplicate release — a no-op, never throws or wedges the handler.
    peer.feed(releaseFrame("wk-a", "8420"));
    await flush();
    assertEquals(reg.count(), 0);
  } finally {
    family.teardown?.();
  }
});

test("reconnect-resync: a mid-job re-claim over a fresh connection never blanks the still-running job", async () => {
  const { transport } = mountClaim();
  try {
    const first = fakeConn("c1", "leafA");
    transport.connect(first.conn);
    await flush();
    first.feed(claimFrame("wk-a", "8420"));
    await flush();

    // The WS reconnects on a new connection; the supervisor re-claims every active jobKey.
    const second = fakeConn("c2", "leafA");
    transport.connect(second.conn);
    await flush();
    second.feed(claimFrame("wk-a", "8420"));
    await flush();

    const reg = currentClaimRegistry();
    assert(reg);
    assertEquals(reg.jobKeysFor("wk-a"), ["8420"], "the jobKey survived the reconnect");
    assertEquals(reg.count(), 1);
  } finally {
    family.teardown?.();
  }
});

test("a malformed claim payload is rejected without touching the registry (advisory, connection kept)", async () => {
  const { transport } = mountClaim();
  try {
    const peer = fakeConn("c1", "leafA");
    transport.connect(peer.conn);
    await flush();
    // Missing jobKey → validatePayload rejects it.
    peer.feed({ lane: "control", family: CLAIM_FAMILY, seq: 1, payload: { instance: "wk-a" } });
    await flush();
    // A well-formed claim still works afterwards — the handler was not wedged.
    peer.feed(claimFrame("wk-a", "8420"));
    await flush();

    const reg = currentClaimRegistry();
    assert(reg);
    assertEquals(reg.jobKeysFor("wk-a"), ["8420"]);
    assertEquals(reg.count(), 1);
  } finally {
    family.teardown?.();
  }
});

test("a resync snapshot frame REPLACES an instance's claims — a RELEASE lost during an outage no longer strands the job", async () => {
  const { transport } = mountClaim();
  try {
    const peer = fakeConn("c1", "host-supervisor");
    transport.connect(peer.conn);
    await flush();
    peer.feed(claimFrame("wk-a", "8420"));
    peer.feed(claimFrame("wk-a", "8421"));
    await flush();

    const reg = currentClaimRegistry();
    assert(reg);
    assertEquals(reg.jobKeysFor("wk-a"), ["8420", "8421"]);

    // The hub missed the `release` for 8420 during an outage. On reconnect the supervisor restates its
    // authoritative snapshot: wk-a now owns only 8421. The non-re-asserted 8420 is dropped.
    peer.feed(resyncFrame("wk-a", ["8421"]));
    await flush();
    assertEquals(reg.jobKeysFor("wk-a"), ["8421"], "the stranded claim was dropped on resync");
    assertEquals(reg.count(), 1);
  } finally {
    family.teardown?.();
  }
});

test("a resync snapshot does NOT blank a jobKey that moved to another instance", async () => {
  const { transport } = mountClaim();
  try {
    const peer = fakeConn("c1", "host-supervisor");
    transport.connect(peer.conn);
    await flush();
    peer.feed(claimFrame("wk-a", "8420"));
    peer.feed(claimFrame("wk-b", "8420")); // 8420 moved to wk-b
    await flush();

    // wk-a's authoritative resync no longer mentions 8420 — and must not blank the live owner wk-b.
    peer.feed(resyncFrame("wk-a", []));
    await flush();

    const reg = currentClaimRegistry();
    assert(reg);
    assertEquals(reg.jobKeysFor("wk-b"), ["8420"], "the current owner's claim survives");
    assertEquals(reg.ownerOf("8420"), "wk-b");
  } finally {
    family.teardown?.();
  }
});

test("a supervisor that never sends a resync snapshot keeps today's additive claim behaviour", async () => {
  const { transport } = mountClaim();
  try {
    const peer = fakeConn("c1", "host-supervisor");
    transport.connect(peer.conn);
    await flush();
    // Only per-job claims, no snapshot frame — a claim is never dropped except by an explicit release.
    peer.feed(claimFrame("wk-a", "8420"));
    peer.feed(claimFrame("wk-a", "8421"));
    await flush();

    const reg = currentClaimRegistry();
    assert(reg);
    assertEquals(reg.jobKeysFor("wk-a"), ["8420", "8421"], "additive — neither claim is dropped");
    assertEquals(reg.count(), 2);
  } finally {
    family.teardown?.();
  }
});

test("a resync snapshot with a non-string instance is ignored (advisory, connection kept)", async () => {
  const { transport } = mountClaim();
  try {
    const peer = fakeConn("c1", "host-supervisor");
    transport.connect(peer.conn);
    await flush();
    peer.feed(claimFrame("wk-a", "8420"));
    await flush();
    // A malformed snapshot (no instance) is rejected without touching the registry.
    peer.feed({ lane: "control", family: CLAIM_FAMILY, seq: 1, payload: { jobKeys: ["8421"] } });
    await flush();

    const reg = currentClaimRegistry();
    assert(reg);
    assertEquals(reg.jobKeysFor("wk-a"), ["8420"], "the registry was untouched by the malformed snapshot");
    assertEquals(reg.count(), 1);
  } finally {
    family.teardown?.();
  }
});

test("a snapshot frame carrying BOTH jobKeys and a malformed jobKey is rejected — the snapshot branch never bypasses validation", async () => {
  const { transport } = mountClaim();
  try {
    const peer = fakeConn("c1", "host-supervisor");
    transport.connect(peer.conn);
    await flush();
    peer.feed(claimFrame("wk-a", "8420"));
    await flush();
    // The bypass the reviewer flagged: `jobKeys` present routed the frame straight to replaceInstance,
    // so a smuggled empty `jobKey` was never validated. The union validator rejects it.
    peer.feed({ lane: "control", family: CLAIM_FAMILY, seq: 1, payload: { instance: "wk-a", jobKey: "", jobKeys: ["8421"] } });
    await flush();

    const reg = currentClaimRegistry();
    assert(reg);
    assertEquals(reg.jobKeysFor("wk-a"), ["8420"], "the malformed both-fields frame touched nothing");
    assertEquals(reg.count(), 1);
  } finally {
    family.teardown?.();
  }
});

test("a frame with a valid jobKey but a PRESENT malformed jobKeys is rejected — a broken snapshot can't launder as a per-job claim", async () => {
  const { transport } = mountClaim();
  try {
    const peer = fakeConn("c1", "host-supervisor");
    transport.connect(peer.conn);
    await flush();
    peer.feed(claimFrame("wk-a", "8420"));
    await flush();
    // The reviewer's case: `jobKeys` is PRESENT but malformed ("invalid"), while `jobKey` is valid.
    // Presence — not validity — selects the snapshot variant, so a broken `jobKeys` must be rejected,
    // never treated as absent and accepted as a bare per-job claim that mutates ownership.
    peer.feed({ lane: "control", family: CLAIM_FAMILY, seq: 1, payload: { instance: "wk-a", jobKey: "8421", jobKeys: "invalid" } });
    await flush();

    const reg = currentClaimRegistry();
    assert(reg);
    assertEquals(reg.jobKeysFor("wk-a"), ["8420"], "the malformed-snapshot frame touched nothing");
    assertEquals(reg.count(), 1);
  } finally {
    family.teardown?.();
  }
});

test("a snapshot frame with a PRESENT malformed jobKeys array is rejected as a broken snapshot (presence is the discriminant)", async () => {
  const { transport } = mountClaim();
  try {
    const peer = fakeConn("c1", "host-supervisor");
    transport.connect(peer.conn);
    await flush();
    peer.feed(claimFrame("wk-a", "8420"));
    await flush();
    // `jobKeys` present but not a string array → a broken snapshot; it is rejected outright, never
    // mistaken for a per-job claim. (No `jobKey` here either, but presence alone is enough to reject.)
    peer.feed({ lane: "control", family: CLAIM_FAMILY, seq: 1, payload: { instance: "wk-a", jobKeys: "8421" } });
    await flush();

    const reg = currentClaimRegistry();
    assert(reg);
    assertEquals(reg.jobKeysFor("wk-a"), ["8420"], "the malformed frame touched nothing");
    assertEquals(reg.count(), 1);
  } finally {
    family.teardown?.();
  }
});

test("an EMPTY snapshot is a valid authoritative resync — the supervisor asserting it now owns nothing", async () => {
  const { transport } = mountClaim();
  try {
    const peer = fakeConn("c1", "host-supervisor");
    transport.connect(peer.conn);
    await flush();
    peer.feed(claimFrame("wk-a", "8420"));
    await flush();

    const reg = currentClaimRegistry();
    assert(reg);
    assertEquals(reg.jobKeysFor("wk-a"), ["8420"]);

    // The producer emits one snapshot per instance INCLUDING empty sets — an empty `jobKeys` is the
    // meaningful "owns nothing now" resync, not a malformed frame.
    peer.feed(resyncFrame("wk-a", []));
    await flush();
    assertEquals(reg.jobKeysFor("wk-a"), [], "the empty snapshot cleared the instance's claims");
    assertEquals(reg.count(), 0);
  } finally {
    family.teardown?.();
  }
});

test("teardown clears the singleton", () => {
  mountClaim();
  assert(currentClaimRegistry() !== undefined);
  family.teardown?.();
  assertEquals(currentClaimRegistry(), undefined);
});
