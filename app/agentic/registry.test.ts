// Unit tests for the agentic family-registration seam (ADR 0056, H0 / #143).
import { test } from "node:test";
import { assert, assertEquals, assertRejects, assertThrows } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import { type AgenticContext, AgenticFamilyRegistry, type AgenticFamily } from "./registry.ts";

// A minimal context — the seam only threads it through to `mount`, so the tests don't need a real
// hub. `undefined`/no-op handles are fine here; the channel test exercises the real handles.
function fakeCtx(): AgenticContext {
  // biome-ignore lint/suspicious/noExplicitAny: seam only forwards ctx opaquely in these tests
  const stub: any = {};
  return { hub: stub, registry: stub, transport: stub, data: undefined, log: noopLog() };
}

/** A family that records the order of mount/teardown calls into a shared trace. */
function tracer(name: string, trace: string[]): AgenticFamily {
  return {
    name,
    mount() {
      trace.push(`mount:${name}`);
    },
    teardown() {
      trace.push(`teardown:${name}`);
    },
  };
}

test("mounts families in registration order, tears them down in reverse", async () => {
  const trace: string[] = [];
  const reg = new AgenticFamilyRegistry();
  reg.registerAll([tracer("a", trace), tracer("b", trace), tracer("c", trace)]);
  assertEquals(reg.names(), ["a", "b", "c"]);

  await reg.mountAll(fakeCtx());
  assertEquals(trace, ["mount:a", "mount:b", "mount:c"]);

  await reg.teardownAll(noopLog());
  assertEquals(trace, ["mount:a", "mount:b", "mount:c", "teardown:c", "teardown:b", "teardown:a"]);
});

test("mountAll is idempotent — a second call never re-mounts", async () => {
  const trace: string[] = [];
  const reg = new AgenticFamilyRegistry();
  reg.register(tracer("a", trace));
  const ctx = fakeCtx();
  await reg.mountAll(ctx);
  await reg.mountAll(ctx);
  assertEquals(trace, ["mount:a"]);
});

test("teardownAll only reverses families that actually mounted, and is idempotent", async () => {
  const trace: string[] = [];
  const reg = new AgenticFamilyRegistry();
  reg.register(tracer("a", trace));
  await reg.mountAll(fakeCtx());
  await reg.teardownAll();
  await reg.teardownAll();
  assertEquals(trace, ["mount:a", "teardown:a"]);
});

test("a rejected duplicate family name protects one-family-one-slot", () => {
  const reg = new AgenticFamilyRegistry();
  reg.register({ name: "dup", mount() {} });
  assertThrows(() => reg.register({ name: "dup", mount() {} }), Error, "duplicate agentic family");
});

test("registering after mount is refused", async () => {
  const reg = new AgenticFamilyRegistry();
  reg.register({ name: "a", mount() {} });
  await reg.mountAll(fakeCtx());
  assertThrows(() => reg.register({ name: "b", mount() {} }), Error, "after mount");
});

test("a family with no teardown is skipped cleanly on shutdown", async () => {
  const trace: string[] = [];
  const reg = new AgenticFamilyRegistry();
  reg.register({ name: "no-teardown", mount() {
    trace.push("mount");
  } });
  await reg.mountAll(fakeCtx());
  await reg.teardownAll();
  assertEquals(trace, ["mount"]);
});

test("one family's teardown throw is isolated and does not strand siblings", async () => {
  const trace: string[] = [];
  const reg = new AgenticFamilyRegistry();
  reg.register(tracer("a", trace));
  reg.register({
    name: "boom",
    mount() {
      trace.push("mount:boom");
    },
    teardown() {
      throw new Error("teardown boom");
    },
  });
  await reg.mountAll(fakeCtx());
  // Should not throw despite "boom" failing; "a" must still tear down.
  await reg.teardownAll(noopLog());
  assertEquals(trace, ["mount:a", "mount:boom", "teardown:a"]);
});

test("a mount failure only tears down what actually mounted", async () => {
  const trace: string[] = [];
  const reg = new AgenticFamilyRegistry();
  reg.register(tracer("a", trace));
  reg.register({
    name: "fails",
    mount() {
      throw new Error("mount fails");
    },
    teardown() {
      trace.push("teardown:fails");
    },
  });
  await assertRejects(() => reg.mountAll(fakeCtx()), Error, "mount fails");
  await reg.teardownAll();
  // "fails" never completed mount, so its teardown must not run; "a" did mount, so it tears down.
  assertEquals(trace, ["mount:a", "teardown:a"]);
});

test("mountAll self-heals after a mid-mount failure — a retry re-mounts, never a stuck no-op", async () => {
  const trace: string[] = [];
  const reg = new AgenticFamilyRegistry();
  reg.register(tracer("a", trace));
  let shouldFail = true;
  reg.register({
    name: "flaky",
    mount() {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("mount fails once");
      }
      trace.push("mount:flaky");
    },
    teardown() {
      trace.push("teardown:flaky");
    },
  });

  // First attempt fails mid-mount; mountAll must reverse the partial mount and reset its own state
  // (without the caller having to call teardownAll)...
  await assertRejects(() => reg.mountAll(fakeCtx()), Error, "mount fails once");
  assertEquals(trace, ["mount:a", "teardown:a"]);

  // ...so a retry actually re-mounts instead of being a silent no-op (the wedged-state regression).
  await reg.mountAll(fakeCtx());
  assertEquals(trace, ["mount:a", "teardown:a", "mount:a", "mount:flaky"]);

  await reg.teardownAll();
  assertEquals(trace, [
    "mount:a",
    "teardown:a",
    "mount:a",
    "mount:flaky",
    "teardown:flaky",
    "teardown:a",
  ]);
});
