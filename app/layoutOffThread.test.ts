// Guard coverage for the off-main-thread BPMN autolayout (issue #854). `layoutBpmn`
// (`bpmn-auto-layout`) is superlinear and used to run SYNCHRONOUSLY on the app's event loop inside
// `compileDeliveryGraph` → `layoutDeliveryDiagram`, freezing the whole app (no HTTP, no poll passes)
// for the entire layout — a 3287ms single gap locally on the 54-node merlin graph, minutes under load
// (#852). It now runs in a `node:worker_threads` worker bounded by a timeout. These tests assert:
//   • the event loop KEEPS TICKING (bounded max gap) while a large graph lays out off-thread — the
//     core liveness property this fixes,
//   • the timeout TERMINATES a runaway layout and fails CLEANLY (rejects) rather than hanging,
//   • the canonical `compileDeliveryGraph` path still produces a diagram through the off-thread bridge.
import { test } from "node:test";
import { assert, assertRejects, assertStringIncludes } from "#test-assert";
import type { DeliveryGraph } from "../nano-generated/api-io.d.ts";
import { compileDeliveryGraph } from "./deliveryGraphCompiler.ts";
import { layoutBpmnOffThread, layoutMaxConcurrency, layoutTimeoutMs, Semaphore } from "./layoutOffThread.ts";

/** Build a wide-and-deep delivery graph with `count` agent nodes wired into a chain with periodic
 * fan-out, so the autolayout has enough nodes/edges to spend real CPU time laying it out. */
function bigGraph(count: number): DeliveryGraph {
  const nodes: DeliveryGraph["nodes"] = [];
  const edges: DeliveryGraph["edges"] = [];
  for (let i = 0; i < count; i++) {
    nodes.push({ id: `n${i}`, kind: "agent", agent: { jobType: "senior:feature", prompt: `slice ${i}` } });
    if (i > 0) edges.push({ from: `n${i - 1}`, to: `n${i}` });
    // Periodic fan-out to widen the graph (more edges → more layout work).
    if (i >= 3 && i % 3 === 0) edges.push({ from: `n${i - 3}`, to: `n${i}` });
  }
  return { name: "big-layout-graph", nodes, edges } as DeliveryGraph;
}

test("#854 the main event loop keeps servicing queued work while a large graph lays out off-thread", async () => {
  const graph = bigGraph(60);

  // ORDER-based liveness proof (not a wall-clock threshold): race a trivial main-thread `setImmediate`
  // checkpoint against the layout. Off-thread, the loop reaches the next tick and fires the immediate
  // in microseconds while the worker chews on the superlinear layout for far longer, so the checkpoint
  // ALWAYS wins. Inline (the regression), `compileDeliveryGraph`'s synchronous `layoutBpmn` call would
  // block the loop for the whole layout and its promise would then resolve via a microtask BEFORE any
  // queued `setImmediate` macrotask could run, so the layout would win — failing this test. Because the
  // worker's real CPU work dwarfs a single queued-tick dispatch by orders of magnitude, the winner is
  // deterministic under any scheduler load (AGENTS.md deterministic-test rule) — no elapsed-time bound.
  let compiled: Awaited<ReturnType<typeof compileDeliveryGraph>> | undefined;
  const checkpoint = new Promise<"checkpoint">((resolve) => {
    setImmediate(() => resolve("checkpoint"));
  });
  const layoutDone = compileDeliveryGraph(graph).then((c): "layout" => {
    compiled = c;
    return "layout";
  });

  const winner = await Promise.race([checkpoint, layoutDone]);
  assert(
    winner === "checkpoint",
    "a queued main-thread setImmediate must win the race against the off-thread layout; if layout ran " +
      "inline it would block the loop and its promise would resolve before the immediate could fire",
  );

  await layoutDone; // let the worker finish and tear down so the test leaks no worker/handle
  assert(compiled !== undefined && compiled.ok, `expected ok:true, got ${JSON.stringify(compiled)}`);
  assert(compiled.bpmn.includes("<bpmndi:BPMNDiagram"), "off-thread layout should still attach diagram interchange");
});

test("#854 a layout that exceeds its timeout fails cleanly (rejects) instead of hanging", async () => {
  // A 1ms bound is unsatisfiable for any real graph, so the worker is terminated and the call rejects.
  const semantic = "<?xml version=\"1.0\"?><bpmn:definitions xmlns:bpmn=\"http://www.omg.org/spec/BPMN/20100524/MODEL\" id=\"d\"><bpmn:process id=\"p\" isExecutable=\"true\"><bpmn:startEvent id=\"s\"/></bpmn:process></bpmn:definitions>";
  const err = await assertRejects(() => layoutBpmnOffThread(semantic, 1));
  assertStringIncludes(err.message, "854");
});

test("#854 layoutTimeoutMs honours the env knob and ignores garbage", () => {
  assert(layoutTimeoutMs({}) === 300000, "unset → registered default");
  assert(layoutTimeoutMs({ NANO_DELIVERY_LAYOUT_TIMEOUT_MS: "90000" }) === 90000, "valid override honoured");
  assert(layoutTimeoutMs({ NANO_DELIVERY_LAYOUT_TIMEOUT_MS: "nope" }) === 300000, "garbage → default");
  assert(layoutTimeoutMs({ NANO_DELIVERY_LAYOUT_TIMEOUT_MS: "-5" }) === 300000, "non-positive → default");
  // Node's setTimeout ceiling is a signed 32-bit ms value (2_147_483_647); a larger delay wraps to
  // 1ms and would abort every layout immediately, so an overflowing override must degrade to the
  // registered default rather than be honoured (issue #854 review).
  assert(layoutTimeoutMs({ NANO_DELIVERY_LAYOUT_TIMEOUT_MS: "2147483647" }) === 2147483647, "ceiling value honoured");
  assert(layoutTimeoutMs({ NANO_DELIVERY_LAYOUT_TIMEOUT_MS: "2147483648" }) === 300000, "above Node timer ceiling → default");
  assert(layoutTimeoutMs({ NANO_DELIVERY_LAYOUT_TIMEOUT_MS: "999999999999" }) === 300000, "far above ceiling → default");
});

test("#854 layoutMaxConcurrency honours the env knob and degrades a bad bound to the default", () => {
  assert(layoutMaxConcurrency({}) === 2, "unset → registered default");
  assert(layoutMaxConcurrency({ NANO_DELIVERY_LAYOUT_MAX_CONCURRENCY: "4" }) === 4, "valid override honoured");
  assert(layoutMaxConcurrency({ NANO_DELIVERY_LAYOUT_MAX_CONCURRENCY: "nope" }) === 2, "garbage → default");
  assert(layoutMaxConcurrency({ NANO_DELIVERY_LAYOUT_MAX_CONCURRENCY: "0" }) === 2, "zero (unbounded-by-stall) → default");
  assert(layoutMaxConcurrency({ NANO_DELIVERY_LAYOUT_MAX_CONCURRENCY: "-3" }) === 2, "negative → default");
  // A fractional bound is not a valid holder count; it must degrade rather than round silently.
  assert(layoutMaxConcurrency({ NANO_DELIVERY_LAYOUT_MAX_CONCURRENCY: "1.5" }) === 2, "non-integer → default");
  // An absurdly large bound is effectively "unbounded", which defeats the guard — degrade to default.
  assert(layoutMaxConcurrency({ NANO_DELIVERY_LAYOUT_MAX_CONCURRENCY: "99999" }) === 2, "above ceiling → default");
  assert(layoutMaxConcurrency({ NANO_DELIVERY_LAYOUT_MAX_CONCURRENCY: "1024" }) === 1024, "ceiling value honoured");
});

test("#854 Semaphore rejects a non-positive / non-integer bound (the guard must never be 0/∞)", () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    let threw = false;
    try {
      new Semaphore(bad);
    } catch {
      threw = true;
    }
    assert(threw, `Semaphore(${bad}) should throw — a bad bound would silently defeat the concurrency guard`);
  }
});

test("#854 Semaphore bounds concurrency to `max` and admits waiters in FIFO order", async () => {
  const sem = new Semaphore(2);
  let active = 0;
  let peak = 0;
  const order: number[] = [];

  // A holder records its admission order and the live peak, then yields a few microtasks before
  // releasing so later acquirers genuinely have to queue behind the first `max`.
  const run = async (id: number): Promise<void> => {
    const release = await sem.acquire();
    order.push(id);
    active++;
    peak = Math.max(peak, active);
    try {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    } finally {
      active--;
      release();
    }
  };

  await Promise.all([run(1), run(2), run(3), run(4), run(5)]);

  assert(peak <= 2, `at most 2 holders may run at once, saw ${peak}`);
  // First two get the free slots immediately; 3,4,5 queue and are admitted in arrival order.
  assert(JSON.stringify(order) === JSON.stringify([1, 2, 3, 4, 5]), `expected FIFO admission, got ${order.join(",")}`);
});

test("#854 Semaphore release is idempotent — a double release cannot over-admit", async () => {
  const sem = new Semaphore(1);
  const release = await sem.acquire();
  release();
  release(); // must be a no-op, not a second freed slot

  // With max=1, exactly one holder may be active. Acquire twice without releasing the first; the
  // second must still be waiting (never admitted by the stray double release above).
  const first = await sem.acquire();
  let secondAdmitted = false;
  const second = sem.acquire().then((rel) => {
    secondAdmitted = true;
    return rel;
  });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert(!secondAdmitted, "the second acquire must block — a double release must not have over-admitted");
  first();
  (await second)();
});

test("#854 a holder that releases in `finally` frees its slot even when its work throws", async () => {
  // This is the invariant `layoutBpmnOffThread` relies on: it `release()`s in a `finally`, so a
  // rejecting/terminated layout returns its slot and the next queued layout proceeds instead of the
  // gate wedging forever behind the failure. Prove it at max=1: a throwing holder that releases in
  // `finally` must still admit the waiter behind it.
  const sem = new Semaphore(1);
  const failing = (async () => {
    const release = await sem.acquire();
    try {
      throw new Error("layout blew up");
    } finally {
      release();
    }
  })();
  await assertRejects(() => failing);

  let nextAdmitted = false;
  const next = sem.acquire().then((rel) => {
    nextAdmitted = true;
    rel();
  });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert(nextAdmitted, "the slot held by a throwing holder must be freed, admitting the next layout");
  await next;
});
