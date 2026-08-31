// Red/green behavioural guard for the delivery-graph Preview & Reuse "honest toast" fix (issue #645).
//
// The DEFECT: both cross-frame producers printed an UNCONDITIONAL "✓ …" success toast synchronously
// right after `postMessage`, even though the message can be dropped by the host relay boundary — so the
// UI claimed success while nothing happened. The FIX makes the success EARNED, not assumed:
//   • Library "Reuse" (library.mount.js `doReuse`) posts the compose-fill UP to the host (relayed across
//     to the compose sibling App-View by nano-ide #518), shows a NEUTRAL in-progress status, and only
//     renders "✓ Loaded…" when the compose mount acks the fill (matching a correlation token) — a clear
//     "Couldn't reach the composer" on a short timeout.
//   • Compose "Preview generated DI" (mount.js `doPreviewDi`) posts `nano-navigate` UP to the console,
//     shows a NEUTRAL in-progress status, and only renders "✓ Opened…" on a host `nano-navigate-ack` —
//     "Couldn't reach the console explorer" on a short timeout.
//
// These tests drive the REAL mounts over a linkedom DOM inside a fake EMBEDDED App-View window whose
// `parent.postMessage` is recorded and whose `message` listeners can be fed synthetic acks. They fail
// against the pre-fix mounts (which render "✓" synchronously with no ack) and pass after.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { parseHTML } from "linkedom";
import { mountDeliveryGraphs, DG_COMPOSE_FILL_ACK_MESSAGE, NANO_NAVIGATE_ACK_MESSAGE } from "../pages/delivery-graphs/mount.js";
import { mountDeliveryGraphLibrary } from "../pages/delivery-graphs/library.mount.js";

const ORIGIN = "https://app.test";
const CHECK = "\u2713"; // the "✓" a success toast must EARN, never assume

interface PostedMessage {
  data: { type?: string; graphJson?: string; token?: string | null; target?: string; params?: unknown };
  targetOrigin: string;
}

/** Boot a mount inside a fake EMBEDDED App-View window (parent !== window) with a recording
 *  parent.postMessage and a capturable `message` listener set, over a linkedom DOM. */
function harness(
  mountFn: (host: unknown, config: Record<string, unknown>) => () => void,
  config: Record<string, unknown>,
  fetchImpl?: (input: unknown, init?: unknown) => Promise<Response>,
) {
  const { window: domWindow, document } = parseHTML("<!doctype html><html><body><div id='host'></div></body></html>");
  const host = document.getElementById("host");
  assert(host, "harness host element must exist");

  const posted: PostedMessage[] = [];
  const messageListeners: Array<(ev: unknown) => void> = [];
  const parentWindow = {
    postMessage: (data: PostedMessage["data"], targetOrigin: string) => {
      posted.push({ data, targetOrigin });
    },
  };
  const fakeWindow = {
    location: { origin: ORIGIN, href: `${ORIGIN}/delivery-graphs/` },
    parent: parentWindow, // parent !== fakeWindow ⇒ embedded
    addEventListener: (type: string, fn: (ev: unknown) => void) => {
      if (type === "message") messageListeners.push(fn);
    },
    removeEventListener: (type: string, fn: (ev: unknown) => void) => {
      if (type !== "message") return;
      const i = messageListeners.indexOf(fn);
      if (i >= 0) messageListeners.splice(i, 1);
    },
  };

  const origFetch = globalThis.fetch;
  if (fetchImpl) globalThis.fetch = fetchImpl as typeof fetch;
  const origWindow = Reflect.get(globalThis, "window");
  Reflect.set(globalThis, "window", fakeWindow);

  const dispose = mountFn(host, config);

  const teardown = () => {
    dispose();
    if (fetchImpl) globalThis.fetch = origFetch;
    Reflect.set(globalThis, "window", origWindow);
  };
  const flush = async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const click = (el: { dispatchEvent: (ev: unknown) => boolean } | null) => {
    assert(el, "click target must exist");
    el!.dispatchEvent(new domWindow.Event("click", { bubbles: true, cancelable: true }));
  };
  // Deliver a synthetic same-origin message from the parent (the console relay) to the mount's listeners.
  const emitFromParent = (data: unknown) => {
    for (const fn of [...messageListeners]) fn({ origin: ORIGIN, source: parentWindow, data });
  };
  const status = () => host!.querySelector(".status") as { textContent: string | null; className: string } | null;

  return { host, posted, teardown, flush, click, emitFromParent, status };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Library "Reuse" ────────────────────────────────────────────────────────────────────────────────
const LIBRARY_URL = `${ORIGIN}/app/api/delivery-graph/library`;
const ENTRY = { id: "lib-1", name: "Onboarding", graph: '{"nodes":[],"edges":[]}' };
const libraryFetch = async (input: unknown) => {
  if (String(input).startsWith(LIBRARY_URL)) return new Response(JSON.stringify({ entries: [ENTRY] }), { status: 200 });
  return new Response(JSON.stringify({}), { status: 404 });
};

function libraryHarness() {
  return harness(
    mountDeliveryGraphLibrary as never,
    { libraryUrl: LIBRARY_URL, refreshMs: 1_000_000_000, ackTimeoutMs: 40 },
    libraryFetch,
  );
}

test("#645: Reuse shows NO optimistic ✓ toast — a neutral in-progress status until the compose acks", async () => {
  const h = libraryHarness();
  try {
    await h.flush();
    h.click(h.host!.querySelector("[data-reuse]"));
    // Synchronously after the post: the fill message went UP to the host, but there is NO success yet.
    const fill = h.posted.find((p) => p.data.type === "nano-delivery-graph-compose-fill");
    assert(fill, "Reuse must post the compose-fill message up to the host");
    assertEquals(fill!.data.graphJson, ENTRY.graph, "the fill carries the saved graph JSON");
    assert(typeof fill!.data.token === "string" && fill!.data.token, "the fill carries a correlation token for the ack");
    const s = h.status();
    assert(s && !s.textContent!.includes(CHECK), "Reuse must NOT render a ✓ success toast synchronously (the #645 defect)");
    assert(s && !/status-ok/.test(s.className), "the pre-ack Reuse status must not carry the success (ok) tone");
  } finally {
    h.teardown();
  }
});

test("#645: Reuse renders ✓ Loaded only once the compose acks the matching fill token", async () => {
  const h = libraryHarness();
  try {
    await h.flush();
    h.click(h.host!.querySelector("[data-reuse]"));
    const fill = h.posted.find((p) => p.data.type === "nano-delivery-graph-compose-fill");
    assert(fill, "Reuse must post the compose-fill message");
    // A stale/mismatched-token ack must NOT complete this Reuse.
    h.emitFromParent({ type: DG_COMPOSE_FILL_ACK_MESSAGE, token: "some-other-token" });
    assert(!h.status()!.textContent!.includes(CHECK), "an ack for a different token must not satisfy this Reuse");
    // The real ack (echoing our token) earns the success toast.
    h.emitFromParent({ type: DG_COMPOSE_FILL_ACK_MESSAGE, token: fill!.data.token });
    const s = h.status();
    assert(s!.textContent!.includes(CHECK) && /Loaded/.test(s!.textContent!), "on ack Reuse renders the ✓ Loaded toast");
    assert(/status-ok/.test(s!.className), "the acked Reuse status carries the success tone");
  } finally {
    h.teardown();
  }
});

test("#645: Reuse ignores an ack with a null/absent token — it can't be correlated, so no ✓", async () => {
  const h = libraryHarness();
  try {
    await h.flush();
    h.click(h.host!.querySelector("[data-reuse]"));
    const fill = h.posted.find((p) => p.data.type === "nano-delivery-graph-compose-fill");
    assert(fill, "Reuse must post the compose-fill message");
    // The compose mount emits `token: null` when a fill arrives without a token; such an ack can't be
    // correlated to this Reuse and must NOT satisfy it (else the #645 false-positive toast returns).
    h.emitFromParent({ type: DG_COMPOSE_FILL_ACK_MESSAGE, token: null });
    assert(!h.status()!.textContent!.includes(CHECK), "a null-token ack must not satisfy this Reuse");
    h.emitFromParent({ type: DG_COMPOSE_FILL_ACK_MESSAGE });
    assert(!h.status()!.textContent!.includes(CHECK), "a token-less ack must not satisfy this Reuse");
    // The real ack (echoing our token) still earns the success toast.
    h.emitFromParent({ type: DG_COMPOSE_FILL_ACK_MESSAGE, token: fill!.data.token });
    assert(h.status()!.textContent!.includes(CHECK), "the matching-token ack still resolves the Reuse");
  } finally {
    h.teardown();
  }
});

test("#645: Reuse surfaces an honest error when the compose never acks (short timeout)", async () => {
  const h = libraryHarness();
  try {
    await h.flush();
    h.click(h.host!.querySelector("[data-reuse]"));
    assert(!h.status()!.textContent!.includes(CHECK), "no success before the timeout");
    await wait(80); // > ackTimeoutMs (40)
    const s = h.status();
    assert(s && /Couldn't reach the composer/.test(s.textContent!), "on timeout Reuse surfaces 'Couldn't reach the composer'");
    assert(!s!.textContent!.includes(CHECK) && /status-err/.test(s!.className), "the timed-out Reuse is an error, never a ✓ success");
  } finally {
    h.teardown();
  }
});

// ── Compose "Preview generated DI" ───────────────────────────────────────────────────────────────────
const PREVIEW_URL = `${ORIGIN}/app/api/actions/delivery-graph/preview`;
const STAGE_URL = `${ORIGIN}/app/api/actions/delivery-graph/stage`;
const IMPORT_URL = `${ORIGIN}/app/api/actions/delivery-graph/library/import`;
const composeFetch = async (input: unknown) => {
  if (String(input) === PREVIEW_URL) {
    return new Response(
      JSON.stringify({ ok: true, title: "T", sideEffecting: false, nodeCount: 1, humanNodeCount: 0, sideEffectCount: 0, digest: "d1", sideEffects: [], mermaid: "graph TD", bpmn: "<xml/>" }),
      { status: 200 },
    );
  }
  return new Response(JSON.stringify({}), { status: 404 });
};

/** Boot the compose mount and drive Preview so a laid-out BPMN exists, then click "Preview generated DI". */
async function composePreviewHarness() {
  const h = harness(
    mountDeliveryGraphs as never,
    { previewUrl: PREVIEW_URL, stageUrl: STAGE_URL, importUrl: IMPORT_URL, ackTimeoutMs: 40 },
    composeFetch,
  );
  const jsonEl = h.host!.querySelector("#dg-json") as { value: string } | null;
  assert(jsonEl, "compose mount must render the #dg-json textarea");
  jsonEl!.value = '{"nodes":[],"edges":[]}';
  h.click(h.host!.querySelector("#dg-preview"));
  await h.flush(); // resolves the preview door → lastBpmn set → renders the "Preview generated DI" button
  return h;
}

test("#645: 'Preview generated DI' shows NO optimistic ✓ toast — a neutral status until the host acks", async () => {
  const h = await composePreviewHarness();
  try {
    const before = h.posted.length;
    h.click(h.host!.querySelector("[data-preview-di]"));
    const nav = h.posted.slice(before).find((p) => p.data.type === "nano-navigate");
    assert(nav, "Preview DI must post nano-navigate up to the console");
    assertEquals(nav!.data.target, "definitionPreview", "the nano-navigate targets the definitionPreview view");
    const s = h.status();
    assert(s && !s.textContent!.includes(CHECK), "Preview DI must NOT render a ✓ 'Opening…' toast synchronously (the #645 defect)");
    assert(s && !/status-ok/.test(s.className), "the pre-ack Preview status must not carry the success (ok) tone");
  } finally {
    h.teardown();
  }
});

test("#645: 'Preview generated DI' renders ✓ Opened only once the host acks the nano-navigate", async () => {
  const h = await composePreviewHarness();
  try {
    h.click(h.host!.querySelector("[data-preview-di]"));
    assert(!h.status()!.textContent!.includes(CHECK), "no success before the host ack");
    h.emitFromParent({ type: NANO_NAVIGATE_ACK_MESSAGE, target: "definitionPreview" });
    const s = h.status();
    assert(s!.textContent!.includes(CHECK) && /Opened/.test(s!.textContent!), "on host ack Preview DI renders the ✓ Opened toast");
    assert(/status-ok/.test(s!.className), "the acked Preview status carries the success tone");
  } finally {
    h.teardown();
  }
});

test("#645: 'Preview generated DI' ignores a target-less nav ack — no forged ✓ Opened", async () => {
  const h = await composePreviewHarness();
  try {
    h.click(h.host!.querySelector("[data-preview-di]"));
    // An ack that omits `target` (or names a different one) could be any unrelated same-origin parent
    // ack — it must NOT resolve the pending Preview (else the #645 false-positive toast returns).
    h.emitFromParent({ type: NANO_NAVIGATE_ACK_MESSAGE });
    assert(!h.status()!.textContent!.includes(CHECK), "a target-less nav ack must not satisfy the Preview");
    h.emitFromParent({ type: NANO_NAVIGATE_ACK_MESSAGE, target: "someOtherView" });
    assert(!h.status()!.textContent!.includes(CHECK), "an ack for a different target must not satisfy the Preview");
    // The real ack (matching target) still earns the success toast.
    h.emitFromParent({ type: NANO_NAVIGATE_ACK_MESSAGE, target: "definitionPreview" });
    assert(h.status()!.textContent!.includes(CHECK), "the matching-target ack still resolves the Preview");
  } finally {
    h.teardown();
  }
});

test("#645: 'Preview generated DI' surfaces an honest error when the host never acks (short timeout)", async () => {
  const h = await composePreviewHarness();
  try {
    h.click(h.host!.querySelector("[data-preview-di]"));
    assert(!h.status()!.textContent!.includes(CHECK), "no success before the timeout");
    await wait(80); // > ackTimeoutMs (40)
    const s = h.status();
    assert(s && /Couldn't reach the console explorer/.test(s.textContent!), "on timeout Preview DI surfaces 'Couldn't reach the console explorer'");
    assert(!s!.textContent!.includes(CHECK) && /status-err/.test(s!.className), "the timed-out Preview is an error, never a ✓ success");
  } finally {
    h.teardown();
  }
});
