// Categorical parity test for the FOUR acknowledge/dismiss ops (issue #654), driven off the read
// models' derived `ack_open` — NOT a hand-maintained per-op terminal-status list. It proves the ONE
// shared `acknowledgeVia` helper (app/acknowledge.ts) gates every op on the SAME oracle the UI's
// Dismiss button consumes (`ack_open`), so the affordance and the guard cannot drift.
//
// The bug this guards against (manifested for PR as #652, latent for the other three): each op used to
// re-derive terminality from its BASE `status` column while the button read the read model's folded
// `derived_status`. When an instance is terminated OUT-OF-BAND the base `status` freezes non-terminal
// (`running`/`escalated`/`dispatched`) while the read model folds `derived_status='abandoned'` — so the
// button showed Dismiss but the op 409'd "not terminal". Each surface's RED case below is exactly that
// shape: a DERIVE-ONLY terminated row (base status frozen non-terminal, `derived_status='abandoned'`).
//
// FIDELITY. The fake `data.table(<view>)` computes each row's `ack_open`/`list_bucket` from the REAL
// read model applied to the base store row (PR/feature/DG via `ReadModel.evaluate`; epic via the
// `deriveEpicBucket`/`epicIsAcknowledgeable` oracles the `plan_read_model` VIEW mirrors) — so the fake
// VIEW is genuinely the read model over the base row, and stamping `acknowledged_at` on the base store
// re-folds the row to History on the next read, exactly as the SQL VIEW does in production.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { acknowledgeVia } from "../app/acknowledge.ts";
import { deliveryGraphReadModel, PR_COUNTS_LOOKUP } from "../app/deliveryGraphReadModel.ts";
import { deriveEpicBucket, epicIsAcknowledgeable } from "../app/delivery.ts";
import { featureReadModel, USER_TASKS_PROJECTION } from "../app/featureReadModel.ts";
import { planReadModel } from "../app/planReadModel.ts";
import { pullRequestReadModel } from "../app/pullRequestReadModel.ts";
import { noopLog } from "../test/log.ts";
import doneHandler from "./acknowledgeDone.ts";
import dgHandler from "./acknowledgeDeliveryGraph.ts";
import epicHandler from "./acknowledgeEpic.ts";
import prHandler from "./acknowledgePr.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-only dynamic row shapes.
type Row = any;
// biome-ignore lint/suspicious/noExplicitAny: test-only op handler signature.
type Handler = (ctx: any, app: AppApi) => Promise<any>;

/** One dismissable surface under test: how to seed its base row, which VIEW the op reads `ack_open`
 * off, and how that VIEW derives from the base row (the real read model, not a duplicated status set). */
interface Surface {
  readonly id: string;
  /** The read-model VIEW name the op reads `ack_open` off. */
  readonly view: string;
  /** The base RECORD store the op stamps `acknowledged_at` onto. */
  readonly baseStore: string;
  /** The primary-key column both are keyed on. */
  readonly keyColumn: string;
  /** The op handler. */
  readonly handler: Handler;
  /** The op's request-body key field (for 400/200 bodies). */
  readonly bodyKey: string;
  /** Base row for a DERIVE-ONLY terminated (dismissable) row: base `status` frozen NON-terminal, the
   * derive edge folds `derived_status='abandoned'` — the exact out-of-band-terminate shape that
   * manifested for PR. Extra join fields (`delivery`) let the epic VIEW fold from its slices. */
  readonly terminalRow: (key: string) => Row;
  /** Base row for a LIVE, non-dismissable row (`ack_open=0`, unacknowledged). */
  readonly liveRow: (key: string) => Row;
  /** Compute the read-model VIEW row (`ack_open`/`list_bucket` + pass-throughs) from the base row —
   * the REAL read model over the base row. */
  readonly deriveView: (baseRow: Row) => Row;
}

/** The effective (terminal-folded) status the tracking VIEW exposes: an explicit `derived_status`
 * override (a terminated instance) else the frozen base `status` (the `ELSE base.status` branch). */
const effective = (row: Row): string => row.derived_status ?? row.status;

const SURFACES: Surface[] = [
  {
    id: "acknowledgePr",
    view: pullRequestReadModel.decl.name,
    baseStore: "pull_requests",
    keyColumn: "pr_key",
    handler: prHandler as Handler,
    bodyKey: "pr_key",
    terminalRow: (key) => ({ pr_key: key, status: "converging", derived_status: "abandoned", acknowledged_at: null }),
    liveRow: (key) => ({ pr_key: key, status: "converging", acknowledged_at: null }),
    deriveView: (r) => ({ ...r, ...pullRequestReadModel.evaluate({ ...r, derived_status: effective(r) }) }),
  },
  {
    id: "acknowledgeDone",
    view: featureReadModel.decl.name,
    baseStore: "feature_runs",
    keyColumn: "feature_key",
    handler: doneHandler as Handler,
    bodyKey: "feature_key",
    terminalRow: (key) => ({ feature_key: key, status: "running", derived_status: "abandoned", acknowledged_at: null }),
    liveRow: (key) => ({ feature_key: key, status: "running", acknowledged_at: null }),
    deriveView: (r) => ({
      ...r,
      ...featureReadModel.evaluate({ ...r, derived_status: effective(r) }, { [USER_TASKS_PROJECTION]: [] }),
    }),
  },
  {
    id: "acknowledgeDeliveryGraph",
    view: deliveryGraphReadModel.decl.name,
    baseStore: "delivery_graph_runs",
    keyColumn: "run_key",
    handler: dgHandler as Handler,
    bodyKey: "run_key",
    terminalRow: (key) => ({ run_key: key, status: "running", derived_status: "abandoned", acknowledged_at: null }),
    liveRow: (key) => ({ run_key: key, status: "running", acknowledged_at: null }),
    deriveView: (r) => ({
      ...r,
      ...deliveryGraphReadModel.evaluate({ ...r, derived_status: effective(r) }, undefined, { [PR_COUNTS_LOOKUP]: [] }),
    }),
  },
  {
    id: "acknowledgeEpic",
    view: planReadModel.decl.name,
    baseStore: "plans",
    keyColumn: "plan_key",
    handler: epicHandler as Handler,
    bodyKey: "plan_key",
    // A `done` epic whose base status is frozen (modelled here) while the derive edge folds it
    // `abandoned` — resolved-not-landed (`delivery=null`), so dismissable.
    terminalRow: (key) => ({ plan_key: key, status: "dispatched", derived_status: "abandoned", delivery: null, acknowledged_at: null }),
    liveRow: (key) => ({ plan_key: key, status: "dispatched", delivery: null, acknowledged_at: null }),
    deriveView: (r) => {
      const eff = effective(r);
      const ackable = epicIsAcknowledgeable(eff, r.delivery ?? null);
      return {
        ...r,
        ack_open: ackable && r.acknowledged_at == null ? 1 : 0,
        list_bucket: deriveEpicBucket(eff, r.delivery ?? null, r.acknowledged_at ?? null),
      };
    },
  },
];

/** A fake `AppApi` whose `data.table(name)` serves the four read-model VIEWs off the base stores by
 * applying the surface's real `deriveView`, and serves the base RECORD stores for the `acknowledged_at`
 * stamp. Writes to a VIEW are never attempted (the helper stamps the base store). */
function memApp(surface: Surface, seed: Row[]): { app: AppApi; rows: Row[] } {
  const stores: Record<string, Row[]> = { [surface.baseStore]: seed };
  function baseTbl(name: string) {
    const rows = (stores[name] ??= []);
    return {
      async get(id: unknown) {
        return rows.find((r) => r[surface.keyColumn] === id);
      },
      async update(id: unknown, patch: Row) {
        const r = rows.find((row) => row[surface.keyColumn] === id);
        if (r) Object.assign(r, patch);
        return r ? 1 : 0;
      },
    };
  }
  function viewTbl() {
    const rows = stores[surface.baseStore];
    return {
      async get(id: unknown) {
        const base = rows.find((r) => r[surface.keyColumn] === id);
        return base ? surface.deriveView(base) : undefined;
      },
    };
  }
  const app = {
    data: { table: (n: string) => (n === surface.view ? viewTbl() : baseTbl(n)) },
    log: noopLog(),
  } as unknown as AppApi;
  return { app, rows: stores[surface.baseStore] };
}

async function call(app: AppApi, handler: Handler, body: unknown) {
  return (await handler({ req: {} as unknown, params: {}, query: {}, body } as unknown, app)) as {
    status: number;
    body: { ok: boolean; error?: string; message?: string };
  };
}

for (const s of SURFACES) {
  test(`${s.id}: a derive-only-terminated row (base status frozen, derived_status='abandoned') is dismissable → 200, stamps, and folds to History`, async () => {
    const key = "o/r#1";
    const { app, rows } = memApp(s, [s.terminalRow(key)]);
    // Precondition: the read-model VIEW offers Dismiss (ack_open=1) even though base status is frozen
    // non-terminal — the exact drift that used to 409 the op.
    assertEquals((await memApp(s, [s.terminalRow(key)]).app.data.table(s.view).get(key)).ack_open, 1);

    const res = await call(app, s.handler, { [s.bodyKey]: key });

    assertEquals(res.status, 200, `${s.id}: dismissable row returns 200`);
    assertEquals(res.body.ok, true);
    assertEquals(typeof rows[0].acknowledged_at, "string", `${s.id}: acknowledged_at stamped`);
    // After the stamp the VIEW re-folds the row to History with the Dismiss affordance closed.
    const folded = await app.data.table(s.view).get(key);
    assertEquals(folded.list_bucket, "history", `${s.id}: folds to history`);
    assertEquals(folded.ack_open, 0, `${s.id}: ack_open closes after dismissal`);
  });

  test(`${s.id}: a live (non-terminal) row is NOT dismissable → 409 and stays unstamped`, async () => {
    const key = "o/r#2";
    const { app, rows } = memApp(s, [s.liveRow(key)]);
    assertEquals((await app.data.table(s.view).get(key)).ack_open, 0, `${s.id}: precondition ack_open=0`);

    const res = await call(app, s.handler, { [s.bodyKey]: key });

    assertEquals(res.status, 409, `${s.id}: live row rejected`);
    assertEquals(res.body.ok, false);
    assertEquals(rows[0].acknowledged_at, null, `${s.id}: no premature stamp`);
  });

  test(`${s.id}: an already-acknowledged row is an idempotent no-op → 200, no double-stamp`, async () => {
    const key = "o/r#3";
    const stamp = "2026-02-02T00:00:00Z";
    const { app, rows } = memApp(s, [{ ...s.terminalRow(key), acknowledged_at: stamp }]);
    // An acknowledged terminal row reads ack_open=0 (folded to History) via the VIEW.
    assertEquals((await app.data.table(s.view).get(key)).ack_open, 0);

    const res = await call(app, s.handler, { [s.bodyKey]: key });

    assertEquals(res.status, 200, `${s.id}: re-acknowledge is idempotent 200`);
    assertEquals(res.body.ok, true);
    assertEquals(rows[0].acknowledged_at, stamp, `${s.id}: NOT re-stamped (no double-stamp)`);
  });

  test(`${s.id}: no such row → 404`, async () => {
    const { app } = memApp(s, []);
    assertEquals((await call(app, s.handler, { [s.bodyKey]: "o/r#404" })).status, 404);
  });

  test(`${s.id}: a missing/blank key → 400`, async () => {
    const { app } = memApp(s, []);
    assertEquals((await call(app, s.handler, {})).status, 400);
    assertEquals((await call(app, s.handler, { [s.bodyKey]: "  " })).status, 400);
  });
}

// A direct helper-level guard: the 404 path when the read-model VIEW has no such row, independent of
// any single op's body parsing.
test("acknowledgeVia: absent VIEW row → 404", async () => {
  const app = {
    data: { table: () => ({ get: async () => undefined }) },
    log: noopLog(),
  } as unknown as AppApi;
  const res = await acknowledgeVia(
    app,
    { view: "v", baseTable: "t", keyColumn: "k", label: "thing", notDismissableError: "not terminal" },
    "missing",
  );
  assertEquals(res.status, 404);
  assertEquals(res.body.ok, false);
});
