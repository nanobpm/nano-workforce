// Behavioural guard for the Staged proposals App-View confirmation path (issue #569).
//
// The console loads this view inside a SANDBOXED App-View iframe with no `allow-modals`, where the
// browser SILENTLY SUPPRESSES window.confirm/window.prompt — the call returns false/null. The old mount
// gated Dispatch/Dismiss on `!window.confirm(...)` and Save-to-library on `window.prompt(...) === null`,
// so under the sandbox the suppressed false/null read as "operator declined/cancelled" and the button
// silently no-op'd: no POST, no banner (#569). This test drives the REAL mount over a real (linkedom)
// DOM with window.confirm/window.prompt STUBBED TO THE SANDBOX BEHAVIOUR (false/null), and asserts the
// side-effecting POST still fires — because the approval is now an IN-DOM two-step control, not a native
// modal. It fails against the pre-fix mount (no in-DOM Confirm affordance ever appears, no POST).
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { parseHTML } from "linkedom";
import { mountStagedProposals } from "../pages/delivery-graphs/staged.mount.js";

const STAGED_URL = "https://app.test/app/api/delivery-graph/staged";
const DISPATCH_URL = "https://app.test/app/api/actions/delivery-graph/dispatch";
const DISMISS_URL = "https://app.test/app/api/actions/delivery-graph/dismiss";
const SAVE_URL = "https://app.test/app/api/actions/delivery-graph/library/save";

const PROPOSAL = {
  digest: "abc123def456",
  title: "My delivery graph",
  sideEffecting: true,
  nodeCount: 3,
  humanNodeCount: 1,
  sideEffectCount: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-02T00:00:00.000Z",
};

interface FetchCall {
  url: string;
  method: string;
  body: string;
}

/** Boot the real mount over a linkedom DOM whose `window` mimics a sandboxed App-View iframe (native
 *  confirm/prompt SUPPRESSED → false/null), with a recording fetch double. */
function harness() {
  const { window: domWindow, document } = parseHTML(
    "<!doctype html><html><body><div id='host'></div></body></html>",
  );
  const host = document.getElementById("host");
  assert(host, "harness host element must exist");

  const calls: FetchCall[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init && typeof init.method === "string" ? init.method : "GET";
    const body = init && typeof init.body === "string" ? init.body : "";
    calls.push({ url, method, body });
    if (method === "GET" && url === STAGED_URL) {
      return new Response(JSON.stringify({ proposals: [PROPOSAL] }), { status: 200 });
    }
    if (url === DISPATCH_URL) return new Response(JSON.stringify({ ok: true }), { status: 202 });
    if (url === DISMISS_URL) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (url === SAVE_URL) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 404 });
  };

  // A sandboxed iframe with no `allow-modals`: confirm() returns false, prompt() returns null. If the
  // mount depended on either, the action would silently no-op — which is exactly the #569 bug.
  const sandboxWindow = {
    confirm: () => false,
    prompt: () => null,
    location: { href: "https://app.test/delivery-graphs/", origin: "https://app.test" },
    parent: undefined as unknown,
  };
  sandboxWindow.parent = sandboxWindow; // parent === window ⇒ not embedded (no host explorer to drive)
  const origWindow = Reflect.get(globalThis, "window");
  Reflect.set(globalThis, "window", sandboxWindow);

  const dispose = mountStagedProposals(host, {
    stagedUrl: STAGED_URL,
    dispatchUrl: DISPATCH_URL,
    dismissUrl: DISMISS_URL,
    saveLibraryUrl: SAVE_URL,
    refreshMs: 1_000_000_000, // effectively no background poll during the test
  });

  const teardown = () => {
    dispose();
    globalThis.fetch = origFetch;
    Reflect.set(globalThis, "window", origWindow);
  };

  const flush = async () => {
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const click = (el: { dispatchEvent: (ev: unknown) => boolean }) =>
    el.dispatchEvent(new domWindow.Event("click", { bubbles: true, cancelable: true }));

  return { host, calls, teardown, flush, click };
}

const posts = (calls: FetchCall[], url: string) => calls.filter((c) => c.method === "POST" && c.url === url);

test("#569: Dispatch dispatches via the in-DOM confirmation even when native window.confirm is suppressed", async () => {
  const h = harness();
  try {
    await h.flush();
    const dispatchBtn = h.host.querySelector("[data-dispatch]");
    assert(dispatchBtn, "the mount must render a Dispatch button for the staged proposal");

    // Click Dispatch — with a suppressed native confirm, the PRE-FIX mount POSTs nothing; the fixed
    // mount instead reveals an in-DOM "Confirm dispatch" step and has NOT yet POSTed.
    h.click(dispatchBtn);
    await h.flush();
    assertEquals(posts(h.calls, DISPATCH_URL).length, 0, "Dispatch must not POST before the operator confirms in-DOM");
    const confirmBtn = h.host.querySelector("[data-dispatch-confirm]");
    assert(confirmBtn, "clicking Dispatch must reveal an in-DOM Confirm-dispatch control (#569), not call window.confirm");
    assert(!h.host.querySelector("[data-dispatch]"), "the plain Dispatch button is replaced by the inline confirmation while it is open");

    // Confirm — the digest is POSTed to the dispatch door, with no reliance on a native modal.
    h.click(confirmBtn);
    await h.flush();
    const dispatched = posts(h.calls, DISPATCH_URL);
    assertEquals(dispatched.length, 1, "confirming in-DOM must POST exactly once to the dispatch door");
    assertEquals(JSON.parse(dispatched[0].body), { digest: PROPOSAL.digest }, "the dispatch POST carries the staged digest");
  } finally {
    h.teardown();
  }
});

test("#569: Cancel on the in-DOM Dispatch confirmation aborts without POSTing", async () => {
  const h = harness();
  try {
    await h.flush();
    h.click(h.host.querySelector("[data-dispatch]"));
    await h.flush();
    const cancelBtn = h.host.querySelector("[data-dispatch-cancel]");
    assert(cancelBtn, "the in-DOM Dispatch confirmation must offer a Cancel affordance");
    h.click(cancelBtn);
    await h.flush();
    assertEquals(posts(h.calls, DISPATCH_URL).length, 0, "cancelling must not POST to the dispatch door");
    assert(h.host.querySelector("[data-dispatch]"), "cancelling restores the plain Dispatch button");
  } finally {
    h.teardown();
  }
});

test("#569: Dismiss discards via the in-DOM confirmation even when native window.confirm is suppressed", async () => {
  const h = harness();
  try {
    await h.flush();
    const dismissBtn = h.host.querySelector("[data-dismiss]");
    assert(dismissBtn, "the mount must render a Dismiss button for the staged proposal");
    h.click(dismissBtn);
    await h.flush();
    assertEquals(posts(h.calls, DISMISS_URL).length, 0, "Dismiss must not POST before the operator confirms in-DOM");
    const confirmBtn = h.host.querySelector("[data-dismiss-confirm]");
    assert(confirmBtn, "clicking Dismiss must reveal an in-DOM Confirm-dismiss control (#569)");
    h.click(confirmBtn);
    await h.flush();
    const dismissed = posts(h.calls, DISMISS_URL);
    assertEquals(dismissed.length, 1, "confirming in-DOM must POST exactly once to the dismiss door");
    assertEquals(JSON.parse(dismissed[0].body), { digest: PROPOSAL.digest }, "the dismiss POST carries the staged digest");
  } finally {
    h.teardown();
  }
});

test("#569: Save-to-library names the entry via an in-DOM input even when native window.prompt is suppressed", async () => {
  const h = harness();
  try {
    await h.flush();
    const saveBtn = h.host.querySelector("[data-save-library]");
    assert(saveBtn, "the mount must render a Save-to-library button for the staged proposal");
    h.click(saveBtn);
    await h.flush();
    assertEquals(posts(h.calls, SAVE_URL).length, 0, "Save must not POST before the operator enters a name and confirms in-DOM");
    const nameInput = h.host.querySelector("[data-library-name]");
    assert(nameInput, "clicking Save-to-library must reveal an in-DOM name input (#569), not call window.prompt");
    nameInput.value = "Reusable graph";

    const saveConfirmBtn = h.host.querySelector("[data-save-library-confirm]");
    assert(saveConfirmBtn, "the in-DOM Save-to-library control must offer a Save affordance");
    h.click(saveConfirmBtn);
    await h.flush();
    const saved = posts(h.calls, SAVE_URL);
    assertEquals(saved.length, 1, "confirming in-DOM must POST exactly once to the save-to-library door");
    assertEquals(
      JSON.parse(saved[0].body),
      { name: "Reusable graph", digest: PROPOSAL.digest },
      "the save POST carries the in-DOM-entered name and the staged digest",
    );
  } finally {
    h.teardown();
  }
});
