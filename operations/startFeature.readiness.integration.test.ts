// Integration coverage for the intake READINESS gate (issue #295) driven through the operation EDGE —
// `startFeature` → `parseFeatureReadiness` → the started run's variables. The unit tests in
// app/featureReadiness.test.ts already prove the parser derives `probes`/`probeTimeout`/`probePollEvery`
// correctly in isolation, and app/feature.test.ts proves `startFeature` seeds them onto the run. What
// nothing asserted — and what regressed in issue #579 — is that the OPERATION threads the parser's
// output through to `startFeature` intact: a too-narrow local dropped `probePollEvery` on the floor, so
// every gated start (`blockedOn`/`readiness`) 500'd on startFeature's invariant. This file locks the
// composed door behaviour: a gated start returns 202 and the run it fans out carries non-blank bounds.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { AppApi } from "@nanobpm/urban";
import { resetDefaultBranchCache } from "../app/github.ts";
import { noopLog } from "../test/log.ts";
import { withTrackingViews } from "../test/trackingViews.ts";
import startFeature from "./startFeature.ts";

// ── in-memory github model (default branch = main, so `confirmDefaultBase` is required) ───────────
function githubFetch(repo: string) {
  return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = u.pathname;
    const json = (obj: unknown, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && path === `/repos/${repo}`) return Promise.resolve(json({ default_branch: "main" }));
    const refPrefix = `/repos/${repo}/git/ref/heads/`;
    if (method === "GET" && path.startsWith(refPrefix)) {
      const branch = decodeURIComponent(path.slice(refPrefix.length));
      if (branch !== "main") return Promise.resolve(new Response("Not Found", { status: 404 }));
      return Promise.resolve(json({ ref: `refs/heads/${branch}`, object: { sha: `${branch}-sha` } }));
    }
    return Promise.resolve(new Response(`unexpected ${method} ${path}`, { status: 500 }));
  };
}

async function withGithub<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const prevMode = process.env["NANO_PR_GITHUB_TRANSPORT"];
  const prevTok = process.env["GITHUB_TOKEN"];
  const prevFetch = globalThis.fetch;
  process.env["NANO_PR_GITHUB_TRANSPORT"] = "token";
  process.env["GITHUB_TOKEN"] = "tok";
  resetDefaultBranchCache();
  globalThis.fetch = githubFetch(repo) as typeof fetch;
  try {
    return await fn();
  } finally {
    resetDefaultBranchCache();
    globalThis.fetch = prevFetch;
    if (prevMode === undefined) delete process.env["NANO_PR_GITHUB_TRANSPORT"];
    else process.env["NANO_PR_GITHUB_TRANSPORT"] = prevMode;
    if (prevTok === undefined) delete process.env["GITHUB_TOKEN"];
    else process.env["GITHUB_TOKEN"] = prevTok;
  }
}

// ── in-memory app (data + engine) ────────────────────────────────────────────
// `started` records each engine.createInstance call so a test can assert the run's seeded variables.
function makeApp() {
  const tables = new Map<string, Record<string, unknown>[]>();
  const started: { processDefinitionId?: string; variables?: Record<string, unknown> }[] = [];
  const table = (name: string, key: string) => {
    const rows = tables.get(name) ?? (() => {
      const fresh: Record<string, unknown>[] = [];
      tables.set(name, fresh);
      return fresh;
    })();
    return {
      get: (k: unknown) => Promise.resolve(rows.find((r) => r[key] === k) ?? null),
      find: (q: Record<string, unknown>) =>
        Promise.resolve(rows.filter((r) => Object.entries(q).every(([f, v]) => r[f] === v))),
      findOne: (q: Record<string, unknown>) =>
        Promise.resolve(rows.find((r) => Object.entries(q).every(([f, v]) => r[f] === v)) ?? null),
      insert: (r: Record<string, unknown>) => {
        rows.push(r);
        return Promise.resolve(r);
      },
      update: (k: unknown, patch: Record<string, unknown>) => {
        const row = rows.find((r) => r[key] === k);
        if (row) Object.assign(row, patch);
        return Promise.resolve(row);
      },
      delete: (k: unknown) => {
        const i = rows.findIndex((r) => r[key] === k);
        if (i >= 0) rows.splice(i, 1);
        return Promise.resolve();
      },
    };
  };
  const app = {
    data: { table: withTrackingViews(table) },
    engine: {
      createInstance: (req: { processDefinitionId?: string; variables?: Record<string, unknown> }) => {
        started.push(req);
        return Promise.resolve({ processInstanceKey: "PI-F1" });
      },
    },
    log: noopLog(),
  } as any as AppApi;
  return { app, started };
}

function input(body: unknown) {
  return {
    req: { method: "POST", path: "/", query: new URLSearchParams(), headers: new Headers(), text: async () => "" } as any,
    params: {},
    query: {},
    body,
  };
}

const REPO = "owner/repo";
const GATED_BASE = { baseBranch: "main", confirmDefaultBase: true } as const;

// ── the #579 regression: a gated start must reach 202 AND thread the bounds through ───────────────

test("blockedOn gate → 202 and the started run carries non-blank probeTimeout + probePollEvery", async () => {
  await withGithub(REPO, async () => {
    const { app, started } = makeApp();
    const res = (await startFeature(
      input({ issue: `${REPO}#577`, ...GATED_BASE, blockedOn: [`${REPO}#578`] }),
      app,
    )) as any;
    assertEquals(res.status, 202);
    assertEquals(started.length, 1);
    const v = started[0].variables as Record<string, unknown>;
    // The regressed field: it was dropped by a too-narrow local, so the run seeded a blank cadence and
    // startFeature's invariant threw → 500. Both bounds must arrive non-blank.
    assertEquals((v.probeTimeout as string).trim().length > 0, true);
    assertEquals((v.probePollEvery as string).trim().length > 0, true);
    assertEquals(Array.isArray(v.readinessProbes) && (v.readinessProbes as unknown[]).length === 1, true);
  });
});

test("explicit readiness descriptor list → 202 with both bounds threaded to the run", async () => {
  await withGithub(REPO, async () => {
    const { app, started } = makeApp();
    const res = (await startFeature(
      input({
        issue: `${REPO}#577`,
        ...GATED_BASE,
        readiness: [{ kind: "command", target: "gh api repos/owner/repo/issues/578 --jq .state", match: { stdoutIncludes: "closed" } }],
      }),
      app,
    )) as any;
    assertEquals(res.status, 202);
    const v = started[0].variables as Record<string, unknown>;
    assertEquals((v.probeTimeout as string).trim().length > 0, true);
    assertEquals((v.probePollEvery as string).trim().length > 0, true);
  });
});

test("blockedOn + consumerPackage (capability edge) → 202 with both bounds threaded", async () => {
  await withGithub(REPO, async () => {
    const { app, started } = makeApp();
    const res = (await startFeature(
      input({ issue: `${REPO}#577`, ...GATED_BASE, blockedOn: [`${REPO}#578`], consumerPackage: "@nanobpm/engine-wasm" }),
      app,
    )) as any;
    assertEquals(res.status, 202);
    const v = started[0].variables as Record<string, unknown>;
    assertEquals((v.probeTimeout as string).trim().length > 0, true);
    assertEquals((v.probePollEvery as string).trim().length > 0, true);
    const probes = v.readinessProbes as { kind?: string }[];
    assertEquals(probes[0]?.kind, "capability");
  });
});

// ── regression: an UNGATED start still passes null/absent for both bounds (gate skipped) ──────────

test("no readiness ⇒ 202 and the run seeds null probeTimeout + probePollEvery (gate skipped)", async () => {
  await withGithub(REPO, async () => {
    const { app, started } = makeApp();
    const res = (await startFeature(input({ issue: `${REPO}#577`, ...GATED_BASE }), app)) as any;
    assertEquals(res.status, 202);
    const v = started[0].variables as Record<string, unknown>;
    assertEquals(v.probeTimeout, null);
    assertEquals(v.probePollEvery, null);
    assertEquals(v.readinessProbes, null);
  });
});

// ── a malformed gate is a caller-meaningful 400, never a 500 ──────────────────────────────────────

test("malformed readiness descriptor → 400 at the edge (never a 500)", async () => {
  await withGithub(REPO, async () => {
    const { app, started } = makeApp();
    const res = (await startFeature(
      input({ issue: `${REPO}#577`, ...GATED_BASE, blockedOn: [""] }),
      app,
    )) as any;
    assertEquals(res.status, 400);
    assertEquals(typeof res.body.error, "string");
    assertEquals(started.length, 0);
  });
});
