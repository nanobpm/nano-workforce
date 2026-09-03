// Session self-heal regression — the dominant #715 gap (gap 1).
//
// WHAT THIS PINS
// ==============
// The runtime-served MCP surface (`/app/mcp`, ADR 0067) is a **stateful streamable-HTTP** transport:
// every `tools/call` MUST carry a valid `mcp-session-id`, and a call with a missing / stale / evicted
// / deleted session id is refused with JSON-RPC `-32000 "Bad Request: no valid session id, and not an
// initialize request."` (mcp.ts). In the field (issue #715) a single hiccup — a heavy-tool timeout,
// an idle drop, a proxy reset, or LRU eviction (`MAX_SESSIONS`) — loses the session and then bricks
// the ENTIRE surface for a client that does not re-`initialize`: every subsequent tool reads as
// "tool does not exist". The stateless/resumable transport that would remove the session dependency
// lives in the urban runtime and is tracked upstream (nano-ide#488); until it lands, the
// **workforce-visible requirement** (this issue) is that the surface is RECOVERABLE — a client that
// re-`initialize`s after a `-32000` gets the WHOLE surface back in one round trip, not a degraded one.
//
// This is the acceptance regression: "kill the session mid-flight and assert the next call still
// works." It kills the session two faithful ways — an unknown/stale id, and a server-side `DELETE`
// (the spec session-termination verb) of a live id — asserts each bricks a call with the exact
// `-32000` signature, then asserts a single client `reinitialize()` fully restores the surface
// (a working `tools/call` AND the complete `tools/list`). If a future runtime makes the transport
// stateless/resumable (nano-ide#488), the stale-id call simply stops erroring — this test then
// tightens to that stronger contract with a one-line change, never silently passing on a regression.
//
// Run with `npm run e2e`.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { bootMcpHarness, type McpHarness } from "./support/mcp-harness.ts";

/** The exact runtime signature of a lost/absent session (mcp.ts). A recovered surface must NOT
 *  answer with this after a re-`initialize`. */
const NO_SESSION_SIGNATURE = "no valid session id";

/** Any "the session is gone" refusal: the runtime's own `-32000` "no valid session id" (unknown id)
 *  OR the SDK transport's "Session not found" (a terminated/DELETEd id). Either proves the call was
 *  refused because the session no longer exists — the field failure #715 gap 1 is about. */
const SESSION_GONE = /no valid session id|session not found/i;

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

  test("an unknown/stale session id bricks a call with -32000, and re-initialize restores the surface", async () => {
    // A stale id models an evicted (LRU / idle-dropped) or proxy-reset session the client still holds.
    const staleId = `stale-${randomUUID()}`;
    const bricked = await h.callToolAs(staleId, PROBE_TOOL);
    assert(bricked.isError, "a call carrying a stale session id must be refused, not answered");
    assert(
      bricked.text.includes(NO_SESSION_SIGNATURE),
      `a stale-session call must fail with the "${NO_SESSION_SIGNATURE}" signature, got: ${bricked.text}`,
    );

    // Client self-heal: re-run the handshake. The pinned runtime is stateful, so this is how a real
    // client recovers (nano-ide#488 would make it unnecessary).
    const newId = await h.reinitialize();
    assert(newId && newId !== staleId, "reinitialize must mint a fresh session id");

    // The NEXT call works — the whole surface is back, not a degraded subset.
    const healed = await h.callTool(PROBE_TOOL);
    assert(!healed.isError, `after reinitialize the surface must answer again: ${healed.text}`);
    assert(
      !healed.text.includes(NO_SESSION_SIGNATURE),
      "a healed call must not still report a missing session",
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

    // The now-terminated id bricks a call — the mid-flight hiccup. A terminated session surfaces the
    // SDK transport's "Session not found"; an unknown id surfaces the runtime's "no valid session id"
    // — both mean the session is gone and the call was refused, not answered.
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
