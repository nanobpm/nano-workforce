// Session self-heal regression — the dominant #715 gap (gap 1).
//
// WHAT THIS PINS
// ==============
// The runtime-served MCP surface (`/app/mcp`, ADR 0067) is a **stateful streamable-HTTP** transport:
// every `tools/call` MUST carry a valid `mcp-session-id`. Per the MCP Streamable-HTTP spec the runtime
// distinguishes two refusals (urban ≥ 0.90.1): a session id that is SUPPLIED but unknown / stale /
// evicted / deleted is a terminated session, answered `404` with JSON-RPC `-32001 "Session not found:
// unknown or expired mcp-session-id."` so the client transparently re-initializes; only a GENUINELY
// MISSING id (no header at all) is the `400` / `-32000 "Bad Request: no valid session id, and not an
// initialize request."` bad-client case (mcp.ts). In the field (issue #715) a single hiccup — a
// heavy-tool timeout, an idle drop, a proxy reset, or LRU eviction (`MAX_SESSIONS`) — loses the
// session and then bricks the ENTIRE surface for a client that does not re-`initialize`: every
// subsequent tool reads as "tool does not exist". The stateless/resumable transport that would remove
// the session dependency lives in the urban runtime and is tracked upstream (nano-ide#488); until it
// lands, the **workforce-visible requirement** (this issue) is that the surface is RECOVERABLE — a
// client that re-`initialize`s after a gone-session refusal gets the WHOLE surface back in one round
// trip, not a degraded one.
//
// This is the acceptance regression: "kill the session mid-flight and assert the next call still
// works." It kills the session two faithful ways — an unknown/stale id, and a server-side `DELETE`
// (the spec session-termination verb) of a live id — asserts each bricks a call with a session-gone
// signature (a supplied-unknown id → `404` / `-32001`, a DELETEd id → the SDK transport's `Session
// not found`), then asserts a single client `reinitialize()` fully restores the surface
// (a working `tools/call` AND the complete `tools/list`). If a future runtime makes the transport
// stateless/resumable (nano-ide#488), the stale-id call simply stops erroring — this test then
// tightens to that stronger contract with a one-line change, never silently passing on a regression.
//
// Run with `npm run e2e`.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { bootMcpHarness, type McpHarness } from "./support/mcp-harness.ts";

/** Any "the session is gone" refusal, in either faithful form: the runtime's `-32001` "Session not
 *  found: unknown or expired …" for a SUPPLIED but unknown / stale / evicted / DELETEd id (urban
 *  ≥ 0.90.1), OR the SDK transport's own "Session not found" for a terminated id. Either proves the
 *  call was refused because the session no longer exists — the field failure #715 gap 1 is about. A
 *  recovered surface must NOT answer with this after a re-`initialize`. */
const SESSION_GONE = /session not found|unknown or expired|no valid session id/i;

/** A safe, side-effect-free read used as the "does the surface answer?" probe. */
const PROBE_TOOL = "getVersion";

describe("#715 gap 1 — a lost MCP session self-heals on client re-initialize", () => {
  let h: McpHarness;
  before(async () => {
    h = await bootMcpHarness();
  });
  after(async () => {
    await h.stop();
  });

  test("baseline: a call on the live session works", async () => {
    const res = await h.callTool(PROBE_TOOL);
    assert(!res.isError, `baseline ${PROBE_TOOL} should succeed on a live session: ${res.text}`);
  });

  test("an unknown/stale session id bricks a call with 404 / -32001, and re-initialize restores the surface", async () => {
    // A stale id models an evicted (LRU / idle-dropped) or proxy-reset session the client still holds.
    const staleId = `stale-${randomUUID()}`;
    const bricked = await h.callToolAs(staleId, PROBE_TOOL);
    assert(bricked.isError, "a call carrying a stale session id must be refused, not answered");
    // A SUPPLIED-but-unknown id is a terminated session: per the MCP Streamable-HTTP spec the runtime
    // answers 404 / -32001 "Session not found: unknown or expired …" (urban ≥ 0.90.1) so the client
    // transparently re-initializes, rather than the 400 / -32000 reserved for a genuinely missing id.
    assert.equal(
      bricked.httpStatus,
      404,
      `a stale (supplied-but-unknown) session id must be refused 404 so the client re-initializes, got HTTP ${bricked.httpStatus}: ${bricked.text}`,
    );
    assert(
      SESSION_GONE.test(bricked.text),
      `a stale-session call must fail with a session-gone signature, got: ${bricked.text}`,
    );

    // Client self-heal: re-run the handshake. The pinned runtime is stateful, so this is how a real
    // client recovers (nano-ide#488 would make it unnecessary).
    const newId = await h.reinitialize();
    assert(newId && newId !== staleId, "reinitialize must mint a fresh session id");

    // The NEXT call works — the whole surface is back, not a degraded subset.
    const healed = await h.callTool(PROBE_TOOL);
    assert(!healed.isError, `after reinitialize the surface must answer again: ${healed.text}`);
    assert(
      !SESSION_GONE.test(healed.text),
      "a healed call must not still report a gone session",
    );

    // And the FULL projected catalogue is restored — the field failure was "every tool vanished".
    const tools = await h.listTools();
    assert(tools.length > 1, `the full tools/list must be restored after self-heal, got ${tools.length}`);
    assert(
      tools.some((t) => t.name === PROBE_TOOL),
      `the restored catalogue must still project ${PROBE_TOOL}`,
    );
  });

  test("a server-side DELETE ends the session mid-flight; the old id then bricks and re-initialize heals it", async () => {
    // Prove the harness's current session is live first.
    const before = await h.callTool(PROBE_TOOL);
    assert(!before.isError, `session should be live before DELETE: ${before.text}`);
    const killedId = h.sessionId;

    // Kill it the spec way — DELETE terminates the session server-side (mcp.ts: "POST, DELETE").
    const status = await h.deleteSession(killedId);
    assert(status < 500, `DELETE session should not server-error, got ${status}`);

    // The now-terminated id bricks a call — the mid-flight hiccup. Both a DELETEd/terminated id and a
    // supplied-but-unknown id now surface a "Session not found" gone-signal (the SDK transport's own,
    // or the runtime's 404 / -32001 "unknown or expired") — either means the session is gone and the
    // call was refused, not answered.
    const bricked = await h.callToolAs(killedId, PROBE_TOOL);
    assert(bricked.isError, "a call on a DELETEd session id must be refused");
    assert(
      SESSION_GONE.test(bricked.text),
      `a DELETEd-session call must be refused as a gone session, got: ${bricked.text}`,
    );

    // Client re-initialize → the very next call works again.
    await h.reinitialize();
    const healed = await h.callTool(PROBE_TOOL);
    assert(!healed.isError, `after reinitialize the surface must answer again: ${healed.text}`);
  });
});
