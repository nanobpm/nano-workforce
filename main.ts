// nano-workforce — Urban App entrypoint (ADR 0055).
//
// The whole app is declared in `nano.app.json` (models, sqlite datasource, app-hosted record
// workers, the schema-driven pages surface, and the OpenAPI control surface) and materialized by the
// `@nanobpm/urban` runtime via `runFromEnv`:
//   • deploys the BPMN + hosts the `pr.*` record workers (workers/*/worker.ts),
//   • serves the schema-driven page runtime (ADR 0042) from `pages/home.page.json`,
//   • mounts the OpenAPI operations (openapi.yaml → operations/*.ts) — the start/cancel/message
//     control endpoints plus the webhook operations under `/app/api/hooks/*` (ADR 0059).
//
// The only thing that isn't declarative is the review-ready poller: it does arbitrary GitHub
// polling and then correlates the canonical `readiness-ready` wait-gate message (#259). A cron
// trigger can only fire an engine
// start/message action, not this custom I/O glue, so it stays app-side here — driving the same
// engine client the runtime uses, over `app.data`.
//
// The reviewer agent (job type `senior:pr-review`) is deliberately NOT hosted here — it is an
// EXTERNAL worker. Point a coding-agent harness at that job type (the same one that services
// the code-first twin) so the automated review stays decoupled from the orchestration.
import { Server } from "node:http";
import { createNanoSdkEngineClient, runFromEnv, selectHost } from "@nanobpm/urban";
import { type AgenticChannelHandle, mountAgenticChannel } from "./app/agentic/channel.ts";
import { makeElementInstanceResolver } from "./app/agentic/element-instance.ts";
import { announceEngine, resolveEngineAddress } from "./app/enginePreflight.ts";
import { runEngineReconcile } from "./app/reconcile.ts";
import { MAX_ROUNDS, pollOnce } from "./app/service.ts";
import { envVar } from "./app/version.ts";

const PORT = Number(process.env.PR_REVIEW_PORT ?? 3000);
const POLL_MS = Number(process.env.NANO_PR_POLL_MS ?? 60_000);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";

const host = selectHost();

// One engine client, shared by the runtime (surfaces/actions/workers) and the poller. The address
// resolution (CAMUNDA_REST_ADDRESS wins, else NANOBPMN_BASE_URL + /v2, else localhost:8080) is the
// canonical `resolveEngineAddress`, shared with the demand reader. A non-rejecting startup preflight
// then echoes the resolved address and announces which engine answered (nano-workforce#391) so a
// misconfigured address is obvious at boot rather than as a cryptic mid-run engine error.
const engineAddress = resolveEngineAddress();
await announceEngine(engineAddress, {
  info: (msg) => host.log("info", msg),
  warn: (msg) => host.log("warn", msg),
}, { token: process.env.CAMUNDA_TOKEN });
const engine = await createNanoSdkEngineClient({
  restAddress: engineAddress.restAddress,
  token: process.env.CAMUNDA_TOKEN,
  transport: process.env.CAMUNDA_TRANSPORT ?? "auto",
  log: host.log,
});

// Manage our own shutdown so the poller is stopped and the process exits (the runtime
// signal handler would only stop the HTTP server, leaving the poller keeping us alive).
const app = await runFromEnv({ engine, host, port: PORT, handleSignals: false });

// Agentic visibility channel (ADR 0056, epic #142). Ride the app's OWN HTTP server so the channel
// shares the app port (no sidecar). This is the ONLY main.ts wiring for the whole epic — sibling
// slices (H1/H3/H4) extend it by dropping a family module under `app/agentic/families/`, never here.
//
// Trusted-LAN by default (security opt-in): Nano runs on a trusted network, so the channel is ON BY DEFAULT.
//   - No secret configured  -> LOCAL mode: well-known token, no credential required, honoured from
//     any origin, so a `nano work` worker appears live with zero configuration (trusted-LAN posture;
//     a WARN surfaces the exposure on a non-loopback bind).
//   - `NANO_AGENTIC_SECRET` (or `NANO_PR_WEBHOOK_SECRET`) set -> SECURE mode: a shared-secret ADR 0028
//     identity token (the same value on the hub and every peer) required on every upgrade (no
//     capability credential — that was accept-any friction).
//   - `NANO_AGENTIC=off` (or 0/false/no) -> disabled entirely.
// `app.httpServer` is a `node:http` Server once started (undefined on hosts that don't surface one,
// e.g. Deno).
let agentic: AgenticChannelHandle | undefined;
const agenticSecret = envVar("NANO_AGENTIC_SECRET") ?? envVar("NANO_PR_WEBHOOK_SECRET");
const agenticDisabled = /^(0|off|false|no)$/i.test(envVar("NANO_AGENTIC") ?? "");
const httpServer = app.httpServer;
if (httpServer instanceof Server) {
  if (agenticDisabled) {
    app.log.info("agentic channel disabled (NANO_AGENTIC=off)");
  } else {
    const secure = Boolean(agenticSecret);
    agentic = await mountAgenticChannel({
      server: httpServer,
      secret: agenticSecret ?? "",
      secure,
      data: app.data,
      // #544: advisory, read-only element-instance resolution over the shared engine's wait-state
      // read model, so the relay slice can key a captured agent session on the element INSTANCE it
      // occupied (unambiguous across a looping / retried job), not just the static element id. A
      // narrow closure — the agentic families never hold the engine handle itself.
      resolveElementInstance: makeElementInstanceResolver(engine),
      log: app.log,
    });
    if (!secure) {
      app.log.info(
        "agentic channel mounted in LOCAL mode (on by default, token-only — a well-known token, no " +
          "capability credential). Honoured from any origin, so on a non-loopback bind it is reachable " +
          "off-box on the trusted LAN (a WARN surfaces a provably wide bind; it cannot detect exposure " +
          "created by a same-host reverse proxy forwarding /agentic while the app stays loopback-bound). " +
          "Set NANO_AGENTIC_SECRET to require a shared secret (the same value on the hub and every peer), " +
          "or NANO_AGENTIC=off to disable.",
      );
    }
  }
} else if (!agenticDisabled) {
  app.log.warn("agentic channel not mounted: app.httpServer is not a node:http Server on this host");
}

// Engine-reset reconciliation (issues #622, #630). On boot, compare the engine's incarnation epoch
// against the last-seen value; on a REGRESSION (the engine was reset/restored/rewound and re-minted
// its keys, Magikcraft/nano-bpm#1065) drive every dangling engine-backed inflight row to the defined
// `orphaned` terminal WITH PROVENANCE. A second pass also folds any run whose engine instance has
// VANISHED from the read model (no `_urban_instance_state` row, past a grace window — issue #630),
// which the epoch signal alone can't catch — BEFORE the pollers below start projecting off stale,
// dead instances. Guarded: an unreachable engine / an absent projection is a no-op (never orphans
// live work), and any failure degrades to a warn so reconcile can never block boot.
if (app.data) {
  try {
    const reconciled = await runEngineReconcile(
      app.data,
      { restAddress: engineAddress.restAddress, token: process.env.CAMUNDA_TOKEN },
      { log: { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) } },
    );
    if (reconciled.orphanedCount > 0) {
      app.log.warn(
        `startup reconcile: engine reset detected — orphaned ${reconciled.orphanedCount} engine-backed ` +
          `inflight row(s) [run ${reconciled.runId}].`,
      );
    }
  } catch (err) {
    app.log.warn(`startup reconcile skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Review-ready poller. Self-scheduling (not setInterval) so a slow GitHub call can never
// overlap two passes (which could double-signal `readiness-ready`); the next pass is scheduled
// only after the previous one settles.
let shuttingDown = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
async function pollLoop(): Promise<void> {
  try {
    if (app.data) await pollOnce(app.data, engine, GITHUB_TOKEN, { restAddress: engineAddress.restAddress, token: process.env.CAMUNDA_TOKEN });
  } catch (err) {
    console.error("poll error:", err);
  }
  if (!shuttingDown) pollTimer = setTimeout(() => void pollLoop(), POLL_MS);
}
// Run the first pass immediately at boot (not after POLL_MS) so the read-model pollers (delivery,
// wait-gate, promotion, lineage) reconcile before the UI is relied upon rather than after up to
// POLL_MS. The Feature Runs grid/tabs now filter the `feature_read_model` VIEW's derived `stage`/
// `list_bucket` (issue #439), computed from each row's own `status`, so no boot-time backfill of a
// stored projection is required.
if (app.data) void pollLoop();

async function drainAndExit(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (pollTimer) clearTimeout(pollTimer);
  // Tear the agentic families + hub down (releases the WS clients) before the app stops its HTTP
  // server, which the channel shares.
  if (agentic) {
    try {
      await agentic.teardown();
    } catch { /* best-effort channel shutdown */ }
  }
  try {
    await app.stop();
  } catch { /* already stopped */ }
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void drainAndExit());
}

console.log(`nano-workforce serving on :${PORT} (poll ${POLL_MS}ms, maxRounds ${MAX_ROUNDS})`);
