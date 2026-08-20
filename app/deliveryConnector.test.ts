// Unit coverage for the delivery-graph `connector` node's idempotency envelope (ADR 0005 slice S4,
// Decision 7). The connector is the epic's one side-effecting node kind, so it MUST fire its outbound
// action AT-MOST-ONCE per dedupe key even though the engine delivers a job AT-LEAST-ONCE. These tests
// exercise the durable-fence ledger + claim→act envelope directly against an in-memory app data layer,
// no engine:
//   • a first dispatch DELIVERS (performs the action, records the claim),
//   • a redelivery on the same key DEDUPES (never re-acts, reports the original detail),
//   • distinct keys each deliver once,
//   • the graph-derived key falls back to `<processInstanceKey>:<elementId>` when no author key is set.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";
import { connectorDedupeKey, deliveryConnectorDispatches, dispatchConnector } from "./deliveryConnector.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");

/** Boot an app purely for its provisioned data layer (migration 055 applied), run `fn`, tear down. */
async function withApp(fn: (app: TestApp) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-connector-"));
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dir, "app.db")}` } });
  try {
    await fn(app);
  } finally {
    await app.stop?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("connectorDedupeKey: author key wins; else derives <processInstanceKey>:<elementId>; else null", () => {
  assertEquals(connectorDedupeKey({ dedupeKey: "author-1" }), "author-1");
  assertEquals(connectorDedupeKey({ dedupeKey: "  spaced  " }), "spaced");
  assertEquals(connectorDedupeKey({ processInstanceKey: "pi9", elementId: "n3" }), "pi9:n3");
  assertEquals(connectorDedupeKey({ dedupeKey: "  ", processInstanceKey: "pi9", elementId: "n3" }), "pi9:n3");
  assertEquals(connectorDedupeKey({ dedupeKey: null }), null);
  assertEquals(connectorDedupeKey({ processInstanceKey: "pi9" }), null);
  // The engine can return a NUMERIC processInstanceKey — it must still derive a key, not fail closed.
  assertEquals(connectorDedupeKey({ processInstanceKey: 12345, elementId: "n3" }), "12345:n3");
});

test("first dispatch delivers exactly once; a redelivery on the same key dedupes and never re-acts", async () => {
  await withApp(async (app) => {
    const at = "2025-01-01T00:00:00.000Z";
    const first = await dispatchConnector(app.db, { dedupeKey: "k1", target: "slack" }, at);
    assertEquals(first.connectorOutcome, "delivered");
    assert(first.connectorDetail.length > 0, "delivered dispatch carries an action detail");

    // A redelivery (at-least-once) of the SAME job — same key — must NOT perform the action again.
    const replay = await dispatchConnector(app.db, { dedupeKey: "k1", target: "slack" }, "2025-01-01T01:00:00.000Z");
    assertEquals(replay.connectorOutcome, "deduped");
    assertEquals(replay.connectorDetail, first.connectorDetail);

    // Exactly one durable ledger row exists for the key — the side effect fired at most once.
    const rows = await deliveryConnectorDispatches(app.db).find({ dedupe_key: "k1" });
    assertEquals(rows.length, 1);
    assertEquals(rows[0].outcome, "delivered");
  });
});

test("a redelivery of a CLAIMED-but-not-delivered row RESUMES the action (never wedges on a permanent dedupe)", async () => {
  await withApp(async (app) => {
    const ledger = deliveryConnectorDispatches(app.db);
    // Simulate a worker that crashed AFTER claiming the key but BEFORE recording delivery: a lone
    // `claimed` row whose action never fired.
    await ledger.insert({ dedupe_key: "wedged-1", target: "slack", outcome: "claimed", detail: null, dispatched_at: "2025-01-01T00:00:00.000Z" });

    // A redelivery must RESUME (perform the action + record delivery), not report `deduped` forever.
    const resumed = await dispatchConnector(app.db, { dedupeKey: "wedged-1", target: "slack" }, "2025-01-01T01:00:00.000Z");
    assertEquals(resumed.connectorOutcome, "delivered");
    assert(resumed.connectorDetail.length > 0, "the resumed dispatch carries an action detail");

    const rows = await ledger.find({ dedupe_key: "wedged-1" });
    assertEquals(rows.length, 1, "resume records on the existing row — no duplicate ledger entry");
    assertEquals(rows[0].outcome, "delivered");

    // And a subsequent redelivery of the now-DELIVERED row terminally dedupes.
    const replay = await dispatchConnector(app.db, { dedupeKey: "wedged-1", target: "slack" }, "2025-01-01T02:00:00.000Z");
    assertEquals(replay.connectorOutcome, "deduped");
    assertEquals(replay.connectorDetail, resumed.connectorDetail);
  });
});

test("distinct dedupe keys each deliver once", async () => {
  await withApp(async (app) => {
    const a = await dispatchConnector(app.db, { dedupeKey: "a", target: "t" }, "2025-01-01T00:00:00.000Z");
    const b = await dispatchConnector(app.db, { dedupeKey: "b", target: "t" }, "2025-01-01T00:00:00.000Z");
    assertEquals(a.connectorOutcome, "delivered");
    assertEquals(b.connectorOutcome, "delivered");
    const rows = await deliveryConnectorDispatches(app.db).find({});
    assertEquals(rows.length, 2);
  });
});
