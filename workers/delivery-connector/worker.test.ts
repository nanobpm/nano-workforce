// Unit coverage for the pr.delivery-connector worker's input validation (workers/delivery-connector/worker.ts).
// Job variables are UNTYPED at runtime, so the worker must not forward a misconfigured node's garbage
// into the (side-effecting) connector I/O surface: a blank `target` fails CLOSED, and a wrong-shaped
// `payload`/`boundFacts` is coerced to null with a surfaced warning rather than passed through.
import { test } from "node:test";
import { assert, assertEquals, assertThrows } from "#test-assert";
import { PROCESS_ID } from "../../app/service.ts";
import { withTrackingViews } from "../../test/trackingViews.ts";
import handler, { readConnectorInput, readConvergeInput, safeStringify } from "./worker.ts";

function memTable(rows: Record<string, unknown>[], key: string) {
  return {
    get: (k: unknown) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
    all: () => Promise.resolve([...rows]),
    find: (q: Record<string, unknown>) =>
      Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
    findOne: (q: Record<string, unknown>) =>
      Promise.resolve(rows.find((r) => Object.entries(q).every(([f, v]) => r[f] === v)) ?? null),
    insert: (r: Record<string, unknown>) => {
      rows.push(r);
      return Promise.resolve(r);
    },
    update: (k: unknown, patch: Record<string, unknown>) => {
      const r = rows.find((x) => x[key] === k);
      if (r) Object.assign(r, patch);
      return Promise.resolve(r);
    },
    delete: (k: unknown) => {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i][key] === k) rows.splice(i, 1);
      return Promise.resolve();
    },
  };
}

/** A hermetic `app` over in-memory tables + a createInstance-capturing engine, with the GitHub
 * transport forced off so `submitPr`'s best-effort meta fetch is skipped. Returns the created
 * convergence-loop instances so a test can assert the exact enrollment `submitPr` performed. */
function fakeApp() {
  const stores: Record<string, { rows: Record<string, unknown>[]; key: string }> = {
    pull_requests: { rows: [], key: "pr_key" },
    escalations: { rows: [], key: "id" },
    pr_dependencies: { rows: [], key: "pr_key" },
    delivery_connector_dispatches: { rows: [], key: "id" },
  };
  const created: { processDefinitionId?: string; variables?: Record<string, unknown> }[] = [];
  let nextId = 1;
  const data = {
    table: withTrackingViews((name: string, key: string) => {
      const store = stores[name] ?? { rows: [], key };
      stores[name] ??= store;
      // The ledger PK is auto-assigned on insert (mimics the RAD Table<T> autoincrement).
      if (name === "delivery_connector_dispatches") {
        const base = memTable(store.rows, store.key);
        return { ...base, insert: (r: Record<string, unknown>) => {
          const id = nextId++;
          store.rows.push({ ...r, id });
          return Promise.resolve(id);
        } } as ReturnType<typeof memTable>;
      }
      return memTable(store.rows, store.key);
    }),
  };
  const engine = {
    createInstance: (req: { processDefinitionId?: string; variables?: Record<string, unknown> }) => {
      created.push(req);
      return Promise.resolve({ processInstanceKey: `PI-${created.length}` });
    },
  };
  const app = { data, engine, log: { info() {}, warn() {}, error() {} } };
  return { app: app as unknown as Parameters<typeof handler>[1], stores, created };
}

function withGithubOff(run: () => Promise<void>): Promise<void> {
  const prevMode = process.env.NANO_PR_GITHUB_TRANSPORT;
  const prevTok = process.env.GITHUB_TOKEN;
  process.env.NANO_PR_GITHUB_TRANSPORT = "token"; // no token below -> fetchPrMeta returns null
  delete process.env.GITHUB_TOKEN;
  return run().finally(() => {
    if (prevMode !== undefined) process.env.NANO_PR_GITHUB_TRANSPORT = prevMode;
    else delete process.env.NANO_PR_GITHUB_TRANSPORT;
    if (prevTok !== undefined) process.env.GITHUB_TOKEN = prevTok;
  });
}

test("readConnectorInput: a blank/missing target fails closed (a connector with no destination is meaningless)", () => {
  for (const target of [undefined, "", "   "]) {
    assertThrows(() => readConnectorInput({ target }), Error, "target");
  }
});

test("readConnectorInput: a valid target is trimmed and passed through; well-shaped payload/boundFacts survive", () => {
  const facts = [{ from: "n1", name: "mergedSha", value: "abc" }];
  const r = readConnectorInput({ target: "  slack  ", payload: { channel: "#rel" }, boundFacts: facts });
  assertEquals(r.target, "slack");
  assertEquals(r.payload, { channel: "#rel" });
  assertEquals(r.boundFacts, facts);
  assertEquals(r.warnings.length, 0);
});

test("readConnectorInput: absent payload/boundFacts default to null with no warning", () => {
  const r = readConnectorInput({ target: "slack" });
  assertEquals(r.payload, null);
  assertEquals(r.boundFacts, null);
  assertEquals(r.warnings.length, 0);
});

test("readConnectorInput: a non-object payload / non-array boundFacts is coerced to null and warned (never forwarded)", () => {
  const r = readConnectorInput({ target: "slack", payload: "oops" as unknown as Record<string, unknown>, boundFacts: "nope" as unknown as [] });
  assertEquals(r.payload, null, "a scalar payload never reaches the connector surface");
  assertEquals(r.boundFacts, null, "a non-array boundFacts never reaches the connector surface");
  assertEquals(r.warnings.length, 2, "both coercions are surfaced for logging (not silent)");
  assert(r.warnings.some((w) => w.includes("payload")), "the payload coercion is named");
  assert(r.warnings.some((w) => w.includes("boundFacts")), "the boundFacts coercion is named");
});

test("readConnectorInput: an array payload is rejected (arrays are not plain objects)", () => {
  const r = readConnectorInput({ target: "slack", payload: [1, 2, 3] as unknown as Record<string, unknown> });
  assertEquals(r.payload, null);
  assertEquals(r.warnings.length, 1);
});

// --- converge / converge-merge targets: enroll a PR into the shared convergence loop (issue #500) ---

test("readConvergeInput: parses pr; convergeOnly defaults from the target; dependsOn is optional", () => {
  // `converge-merge` drives the merge loop → convergeOnly defaults false.
  const merge = readConvergeInput("converge-merge", { pr: "owner/repo#7" });
  assertEquals(merge.parsed.prKey, "owner/repo#7");
  assertEquals(merge.convergeOnly, false);
  assertEquals(merge.dependsOn, []);
  // `converge` is review-only → convergeOnly defaults true.
  const conv = readConvergeInput("converge", { pr: "owner/repo#7" });
  assertEquals(conv.convergeOnly, true);
});

test("readConvergeInput: an explicit payload.convergeOnly overrides the target default; dependsOn threads through", () => {
  const r = readConvergeInput("converge-merge", { pr: "owner/repo#7", convergeOnly: true, dependsOn: ["owner/repo#5", 42] as unknown as string[] });
  assertEquals(r.convergeOnly, true, "the explicit boolean wins over the target default");
  assertEquals(r.dependsOn, ["owner/repo#5"], "non-string dependsOn entries are dropped");
});

test("readConvergeInput: a missing / unparseable pr fails CLOSED (a converge connector with no target PR is meaningless)", () => {
  assertThrows(() => readConvergeInput("converge-merge", null), Error, "payload.pr");
  assertThrows(() => readConvergeInput("converge-merge", {}), Error, "payload.pr");
  assertThrows(() => readConvergeInput("converge", { pr: "not-a-pr" }), Error, "payload.pr");
});

test("readConvergeInput: an unparseable pr whose value is not JSON-serializable still fails CLOSED with the intended error (not a serializer TypeError)", () => {
  // `p.pr` is user-controlled payload data; a BigInt (or a circular object) makes JSON.stringify
  // throw, which must NOT mask the intended "requires payload.pr" error.
  assertThrows(() => readConvergeInput("converge", { pr: 10n as unknown as string }), Error, "payload.pr");
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assertThrows(() => readConvergeInput("converge", { pr: circular as unknown as string }), Error, "payload.pr");
});

test("safeStringify: always returns a string, even for values JSON.stringify serializes to undefined (Symbol/undefined/function)", () => {
  // JSON.stringify returns `undefined` (WITHOUT throwing) for a Symbol, a bare undefined, or a
  // function. safeStringify is typed `: string`, so it must fall back to String(value) rather than
  // leak that `undefined` through and violate its own contract.
  assertEquals(typeof safeStringify(Symbol("x")), "string");
  assertEquals(typeof safeStringify(undefined), "string");
  assertEquals(typeof safeStringify(() => 0), "string");
  // A normal serializable value still round-trips through JSON.stringify.
  assertEquals(safeStringify({ a: 1 }), '{"a":1}');
});

test("handler: a `converge-merge` connector enrolls the PR into the convergence loop via submitPr (row + started convergence-loop instance)", async () => {
  await withGithubOff(async () => {
    const { app, stores, created } = fakeApp();
    await handler(
      { variables: { target: "converge-merge", payload: { pr: "owner/repo#7" } }, processInstanceKey: "PI-graph", elementId: "n2" } as never,
      app,
    );
    // The identical row + loop a `converge-feature` enrollment produces.
    assertEquals(stores.pull_requests.rows.length, 1, "exactly one pull_requests row is registered");
    const pr = stores.pull_requests.rows[0];
    assertEquals(pr.pr_key, "owner/repo#7");
    assertEquals(pr.status, "converging");
    assertEquals(created.length, 1, "the convergence-loop instance was started");
    assertEquals(created[0]?.processDefinitionId, PROCESS_ID);
    // converge-merge → not converge-only, so the merge loop is authorised.
    assertEquals(created[0]?.variables?.convergeOnly, false);
    assertEquals(created[0]?.variables?.prKey, "owner/repo#7");
    // Lineage roots on the stable per-node dedupe key (graph-derived here).
    assertEquals(created[0]?.variables?.rootRequestKey, "PI-graph:n2");
    // The connector ledger still recorded the dispatch (the at-most-once fence around the stub).
    assertEquals(stores.delivery_connector_dispatches.rows.length, 1);
  });
});

test("handler: a `converge` connector enrolls converge-ONLY (stops at converged, never hands to the merge loop)", async () => {
  await withGithubOff(async () => {
    const { app, created } = fakeApp();
    await handler(
      { variables: { target: "converge", payload: { pr: "owner/repo#8" } }, processInstanceKey: "PI-g", elementId: "n1" } as never,
      app,
    );
    assertEquals(created.length, 1);
    assertEquals(created[0]?.variables?.convergeOnly, true);
  });
});

test("handler: re-dispatch (at-least-once redelivery) does NOT double-enroll (ledger fence + submitPr prKey idempotency)", async () => {
  await withGithubOff(async () => {
    const { app, stores, created } = fakeApp();
    const job = { variables: { target: "converge-merge", payload: { pr: "owner/repo#9" } }, processInstanceKey: "PI-graph", elementId: "n2" } as never;
    await handler(job, app);
    await handler(job, app); // the graph resumes / the job is redelivered
    assertEquals(stores.pull_requests.rows.length, 1, "still exactly one PR row");
    assertEquals(created.length, 1, "the convergence-loop is started exactly once (submitPr collapses the repeat)");
    assertEquals(stores.delivery_connector_dispatches.rows.length, 1, "one ledger row — the dispatch fence deduped");
  });
});

test("handler: a redelivery AFTER the PR reached a terminal state does NOT re-enroll (the connector's at-most-once fence, not submitPr's short-circuit)", async () => {
  await withGithubOff(async () => {
    const { app, stores, created } = fakeApp();
    const job = { variables: { target: "converge-merge", payload: { pr: "owner/repo#11" } }, processInstanceKey: "PI-graph", elementId: "n2" } as never;
    await handler(job, app);
    assertEquals(created.length, 1, "the first delivery enrolls the PR");
    // The convergence (+ merge) loop ran to completion; the PR row is now TERMINAL.
    stores.pull_requests.rows[0].status = "merged";
    // An at-least-once redelivery (worker restart / lost ack / graph resume) lands AFTER settlement.
    // `submitPr` deliberately RE-OPENS a terminal row, so the connector must not call it again — the
    // node instance already fired exactly once, and the ledger fence must suppress the redelivery.
    await handler(job, app);
    assertEquals(created.length, 1, "the settled PR is NOT re-enrolled — no second convergence-loop instance");
    assertEquals(stores.pull_requests.rows[0].status, "merged", "the terminal PR is never flipped back to converging");
    assertEquals(stores.delivery_connector_dispatches.rows.length, 1, "still one ledger row — the connector fence deduped the redelivery");
  });
});

test("handler: a converge redelivery whose prior claim CRASHED before recording delivery still enrolls (resume, not lost)", async () => {
  await withGithubOff(async () => {
    const { app, stores, created } = fakeApp();
    const job = { variables: { target: "converge-merge", payload: { pr: "owner/repo#12" } }, processInstanceKey: "PI-graph", elementId: "n2" } as never;
    // Simulate a crash BETWEEN claiming the ledger row and recording delivery: a `claimed` row with no
    // enrollment yet. The redelivery must RESUME (perform the enrollment), never dedupe on the un-acted claim.
    stores.delivery_connector_dispatches.rows.push({ id: 1, dedupe_key: "PI-graph:n2", target: "converge-merge", outcome: "claimed", detail: null, dispatched_at: "t0" });
    await handler(job, app);
    assertEquals(created.length, 1, "the crashed claim is resumed — the enrollment fires exactly once now");
    assertEquals(stores.pull_requests.rows.length, 1, "the PR was enrolled on resume");
    assertEquals(stores.delivery_connector_dispatches.rows[0].outcome, "delivered", "the resumed claim is recorded delivered");
  });
});

test("handler: a crash-window RESUME whose PR already SETTLED to terminal does NOT re-open it (the enrollment action is terminal-safe)", async () => {
  await withGithubOff(async () => {
    const { app, stores, created } = fakeApp();
    const job = { variables: { target: "converge-merge", payload: { pr: "owner/repo#13" } }, processInstanceKey: "PI-graph", elementId: "n2" } as never;
    // The first attempt claimed the ledger AND enrolled the PR, which then ran the convergence (+ merge)
    // loop to completion (`merged`) — but the worker crashed BEFORE recording `delivered`, leaving a
    // still-`claimed` row. A redelivery RESUMES that claim (perform-again, since it never recorded done).
    stores.delivery_connector_dispatches.rows.push({ id: 1, dedupe_key: "PI-graph:n2", target: "converge-merge", outcome: "claimed", detail: null, dispatched_at: "t0" });
    stores.pull_requests.rows.push({ pr_key: "owner/repo#13", status: "merged" });
    // `submitPr` deliberately RE-OPENS a terminal PR (it only short-circuits a NON-terminal row), so a
    // resumed re-perform would flip the settled PR back to `converging`. The enrollment action must be
    // terminal-safe: on resume against an already-settled PR it no-ops (no submitPr, no new instance).
    await handler(job, app);
    assertEquals(created.length, 0, "the settled PR is NOT re-enrolled on resume — no new convergence-loop instance");
    assertEquals(stores.pull_requests.rows[0].status, "merged", "the terminal PR stays terminal (never flipped back to converging)");
    assertEquals(stores.delivery_connector_dispatches.rows[0].outcome, "delivered", "the resumed claim is recorded delivered (the dispatch is done, no side effect was needed)");
  });
});

test("handler: a misconfigured converge connector (no parseable pr) fails CLOSED and writes NO ledger row", async () => {
  await withGithubOff(async () => {
    const { app, stores, created } = fakeApp();
    let threw = false;
    try {
      await handler(
        { variables: { target: "converge-merge", payload: { pr: "garbage" } }, processInstanceKey: "PI", elementId: "n1" } as never,
        app,
      );
    } catch {
      threw = true;
    }
    assert(threw, "a converge connector with no target PR fails closed");
    assertEquals(created.length, 0, "no convergence-loop instance is started");
    assertEquals(stores.delivery_connector_dispatches.rows.length, 0, "no junk ledger row is claimed");
  });
});
