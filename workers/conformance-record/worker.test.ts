import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { noopLog } from "../../test/log.ts";
import handler from "./worker.ts";

function fakeApp() {
  const stores: Record<string, any[]> = { plan_conformance: [] };
  const seq: Record<string, number> = {};
  function tbl(name: string, pk = "id") {
    const rows = (stores[name] ??= [] as any[]);
    const match = (r: any, where: any) => Object.entries(where).every(([k, v]) => r[k] === v);
    return {
      async insert(row: any) {
        const id = (seq[name] = (seq[name] ?? 0) + 1);
        rows.push(pk === "id" ? { id, ...row } : { ...row });
        return pk === "id" ? id : row[pk];
      },
      async find(where: any = {}) {
        return rows.filter((r) => match(r, where));
      },
      async findOne(where: any = {}) {
        return rows.find((r) => match(r, where));
      },
      async get(id: any) {
        return rows.find((row) => row[pk] === id);
      },
      async update(id: any, patch: any) {
        const r = rows.find((row) => row[pk] === id);
        if (r) Object.assign(r, patch);
      },
    };
  }
  const app = { data: { table: (n: string, pk?: string) => tbl(n, pk) }, log: noopLog() };
  return { app, stores };
}

test("conformance-record: persists a filed conformance from hoisted result vars", async () => {
  const { app, stores } = fakeApp();
  const out = await handler(
    {
      processInstanceKey: "retro-inst-5",
      variables: {
        planKey: "o/r#5",
        status: "filed",
        commentUrl: "https://github.com/o/r/issues/5#issuecomment-1",
        slicesMet: 4,
        slicesReduced: 1,
        slicesNotVerified: 1,
        deviationsRaised: 2,
        deviationsUnraised: 1,
        hasDeviations: true,
        summary: "6 items, 4 met",
        "io.nanobpm.agentResult": { output: "the full conformance report" },
      },
    } as any,
    app as any,
  );

  assertEquals(stores.plan_conformance.length, 1);
  const row = stores.plan_conformance[0];
  assertEquals(row.status, "filed");
  assertEquals(row.comment_url, "https://github.com/o/r/issues/5#issuecomment-1");
  assertEquals(row.slices_met, 4);
  assertEquals(row.slices_reduced, 1);
  assertEquals(row.slices_not_verified, 1);
  assertEquals(row.deviations_raised, 2);
  assertEquals(row.deviations_unraised, 1);
  assertEquals(row.has_deviations, 1);
  assertEquals(row.report, "the full conformance report");
  // Tracks the retro instance and enters the inbox scan (issue #216) — a deviation escalates.
  assertEquals(row.process_key, "retro-inst-5");
  assertEquals(row.review_status, "reviewing");
  // The gateway routes off the returned ground-truth flag, not the agent's hoisted var.
  assertEquals(out, { hasDeviations: true });
});

test("conformance-record: derives has_deviations from ground truth even when the agent flag is absent", async () => {
  const { app, stores } = fakeApp();
  await handler(
    { variables: { planKey: "o/r#6", status: "filed", commentUrl: "https://x/6#c", slicesNotVerified: 1 } } as any,
    app as any,
  );
  // The agent didn't set hasDeviations, but a not-verified item means the epic didn't cleanly meet spec.
  assertEquals(stores.plan_conformance[0].has_deviations, 1);
});

test("conformance-record: a clean epic records has_deviations = 0", async () => {  const { app, stores } = fakeApp();
  const out = await handler(
    { processInstanceKey: "retro-inst-7", variables: { planKey: "o/r#7", status: "filed", commentUrl: "https://x/7#c", slicesMet: 3, hasDeviations: false } } as any,
    app as any,
  );
  assertEquals(stores.plan_conformance[0].has_deviations, 0);
  assertEquals(stores.plan_conformance[0].slices_met, 3);
  // No deviation → settles straight to `reviewed`, never entering the inbox scan.
  assertEquals(stores.plan_conformance[0].review_status, "reviewed");
  assertEquals(out, { hasDeviations: false });
});

test("conformance-record: coerces filed without a comment URL to skipped", async () => {
  const { app, stores } = fakeApp();
  await handler(
    { variables: { planKey: "o/r#8", status: "filed", summary: "forgot to post" } } as any,
    app as any,
  );
  assertEquals(stores.plan_conformance[0].status, "skipped");
  assertEquals(stores.plan_conformance[0].comment_url, null);
});

test("conformance-record: a non-filed status carries no verdict counts or deviations", async () => {
  const { app, stores } = fakeApp();
  // A "filed" that downgrades to skipped (no comment) must not persist the agent's counts /
  // has_deviations — a skipped/blocked audit produced no verified verdict, so the row would be
  // internally inconsistent (status=skipped yet has_deviations=1 with non-zero counts).
  await handler(
    {
      variables: {
        planKey: "o/r#11",
        status: "filed",
        slicesMet: 4,
        slicesReduced: 1,
        slicesNotVerified: 1,
        deviationsRaised: 2,
        deviationsUnraised: 1,
        hasDeviations: true,
        summary: "audit ran but never posted",
        "io.nanobpm.agentResult": { output: "transcript explaining why" },
      },
    } as any,
    app as any,
  );
  const row = stores.plan_conformance[0];
  assertEquals(row.status, "skipped");
  assertEquals(row.slices_met, 0);
  assertEquals(row.slices_reduced, 0);
  assertEquals(row.slices_not_verified, 0);
  assertEquals(row.deviations_raised, 0);
  assertEquals(row.deviations_unraised, 0);
  assertEquals(row.has_deviations, 0);
  // summary + report are human-readable context — retained so a skipped/blocked row still explains itself.
  assertEquals(row.summary, "audit ran but never posted");
  assertEquals(row.report, "transcript explaining why");
});

test("conformance-record: coerces string-encoded numeric counts hoisted by the agent", async () => {
  const { app, stores } = fakeApp();
  // The agentTask runner hoists result-JSON keys as-is; an agent may emit counts as strings ("1").
  // These must be parsed, not silently coerced to 0 (which would wrongly clear the verdict).
  await handler(
    {
      variables: {
        planKey: "o/r#12",
        status: "filed",
        commentUrl: "https://x/12#c",
        slicesMet: "4",
        slicesReduced: "1",
        slicesNotVerified: "0",
        deviationsRaised: "2",
        deviationsUnraised: "0",
        hasDeviations: false,
      },
    } as any,
    app as any,
  );
  const row = stores.plan_conformance[0];
  assertEquals(row.slices_met, 4);
  assertEquals(row.slices_reduced, 1);
  assertEquals(row.deviations_raised, 2);
  // A reduced item is ground truth for a deviation even though the agent's flag was false.
  assertEquals(row.has_deviations, 1);
});

test("conformance-record: honours a string-encoded hasDeviations flag", async () => {
  const { app, stores } = fakeApp();
  // A clean epic (no reduced / not-verified / unraised) where the agent emits hasDeviations as the
  // string "true" must still record a deviation — a stringified boolean can't silently be dropped.
  await handler(
    {
      variables: {
        planKey: "o/r#13",
        status: "filed",
        commentUrl: "https://x/13#c",
        slicesMet: 3,
        hasDeviations: "true",
      },
    } as any,
    app as any,
  );
  assertEquals(stores.plan_conformance[0].has_deviations, 1);
});

test("conformance-record: honours an explicit blocked status", async () => {
  const { app, stores } = fakeApp();
  await handler(
    { variables: { planKey: "o/r#9", status: "blocked", summary: "no read access" } } as any,
    app as any,
  );
  assertEquals(stores.plan_conformance[0].status, "blocked");
});

test("conformance-record: defaults to skipped when the agent reported nothing", async () => {
  const { app, stores } = fakeApp();
  await handler(
    { variables: { planKey: "o/r#10", summary: "nothing shipped" } } as any,
    app as any,
  );
  assertEquals(stores.plan_conformance[0].status, "skipped");
});

test("conformance-record: coerces a numeric processInstanceKey to a string (TEXT process_key never drifts)", async () => {
  const { app, stores } = fakeApp();
  await handler(
    { processInstanceKey: 220592130 as any, variables: { planKey: "o/r#11", status: "filed", commentUrl: "https://x/11#c", slicesNotVerified: 1 } } as any,
    app as any,
  );
  const row = stores.plan_conformance[0];
  assertEquals(row.process_key, "220592130");
  assertEquals(typeof row.process_key, "string");
  assertEquals(row.review_status, "reviewing");
});
