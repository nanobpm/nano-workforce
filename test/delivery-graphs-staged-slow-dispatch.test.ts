// #852 — a large graph's dispatch legitimately takes minutes (layout + deploy: ~105 s for 54 nodes on
// merlin). The staged view aborted EVERY request at a 30 s timeout and rendered the AbortError as the
// dispatch failure — the operator saw a "crash" while the server was still launching. The dispatch POST
// must outlive a slow-but-healthy launch (bounded by its own, much longer budget) and tell the operator
// it is still working.
import { mock, test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { parseHTML } from "linkedom";
import { mountStagedProposals } from "../pages/delivery-graphs/staged.mount.js";

const STAGED_URL = "https://app.test/app/api/delivery-graph/staged";
const DISPATCH_URL = "https://app.test/app/api/actions/delivery-graph/dispatch";
const PROPOSAL = {
  digest: "abc123def456",
  title: "Big graph",
  sideEffecting: true,
  nodeCount: 54,
  humanNodeCount: 2,
  sideEffectCount: 34,
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-02T00:00:00.000Z",
};

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
};

test("#852: a dispatch slower than the generic 30 s request timeout is NOT aborted — it completes and reports success", async () => {
  const { window: domWindow, document } = parseHTML("<!doctype html><html><body><div id='host'></div></body></html>");
  const host = document.getElementById("host");
  assert(host, "host");
  let resolveDispatch: (() => void) | undefined;
  let aborted = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === STAGED_URL) return new Response(JSON.stringify({ proposals: [PROPOSAL] }), { status: 200 });
    if (url === DISPATCH_URL) {
      return await new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("signal is aborted without reason", "AbortError"));
        });
        resolveDispatch = () => resolve(new Response(JSON.stringify({ ok: true, status: "running" }), { status: 202 }));
      });
    }
    return new Response("{}", { status: 404 });
  };
  const win = { confirm: () => false, prompt: () => null, location: { href: "https://app.test/delivery-graphs/", origin: "https://app.test" }, parent: undefined as unknown };
  win.parent = win;
  const origWindow = Reflect.get(globalThis, "window");
  Reflect.set(globalThis, "window", win);
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const dispose = mountStagedProposals(host, { stagedUrl: STAGED_URL, dispatchUrl: DISPATCH_URL, refreshMs: 1_000_000_000 });
  const click = (sel: string) => {
    const el = host.querySelector(sel);
    assert(el, `missing ${sel}`);
    el.dispatchEvent(new domWindow.Event("click", { bubbles: true, cancelable: true }));
  };
  try {
    await flush();
    click("[data-dispatch]");
    await flush();
    click("[data-dispatch-confirm]");
    await flush();
    assert(resolveDispatch, "the dispatch POST was sent");
    // Two minutes of a healthy-but-slow launch (layout + deploy) — well past the old 30 s abort.
    for (let s = 0; s < 120; s++) {
      mock.timers.tick(1000);
      await flush();
    }
    assertEquals(aborted, false, "the dispatch request must not be aborted while the server is still launching");
    const working = host.querySelector(".status")?.textContent ?? "";
    assert(/dispatching/i.test(working), `the operator is told it is still working, got: ${working}`);
    resolveDispatch();
    await flush();
    const status = host.querySelector(".status")?.textContent ?? "";
    assert(/dispatched/i.test(status), `expected success, got: ${status}`);
  } finally {
    dispose();
    mock.timers.reset();
    globalThis.fetch = origFetch;
    Reflect.set(globalThis, "window", origWindow);
  }
});
