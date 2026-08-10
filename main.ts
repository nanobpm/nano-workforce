// nano-workforce — Urban App entrypoint (ADR 0055).
//
// The whole app is declared in `nano.app.json` (models, sqlite datasource, app-hosted record
// workers, the schema-driven pages surface, and the action overrides) and materialized by the
// `@nanobpm/urban` runtime via `runFromEnv`:
//   • deploys the BPMN + hosts the `pr.*` record workers (workers/*/worker.ts),
//   • serves the schema-driven page runtime (ADR 0042) from `pages/home.page.json`,
//   • mounts the app-specific action overrides (actions/*.ts) that wrap the generic
//     start/cancel/message actions, plus the `/hooks/submit` webhook.
//
// The only thing that isn't declarative is the review-ready poller: it does arbitrary GitHub
// polling and then correlates a `review-ready` message. A cron trigger can only fire an engine
// start/message action, not this custom I/O glue, so it stays app-side here — driving the same
// engine client the runtime uses, over `app.data`.
//
// The reviewer agent (job type `senior:pr-review`) is deliberately NOT hosted here — it is an
// EXTERNAL worker. Point a coding-agent harness at that job type (the same one that services
// the code-first twin) so the automated review stays decoupled from the orchestration.
import { createNanoSdkEngineClient, runFromEnv, selectHost } from "@nanobpm/urban";
import { MAX_ROUNDS, pollOnce } from "./app/service.ts";

const PORT = Number(process.env.PR_REVIEW_PORT ?? 3000);
const POLL_MS = Number(process.env.NANO_PR_POLL_MS ?? 60_000);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";

const host = selectHost();

// One engine client, shared by the runtime (surfaces/actions/workers) and the poller. Honour
// the app's documented NANOBPMN_BASE_URL as well as the runtime's CAMUNDA_REST_ADDRESS.
const restAddress = process.env.CAMUNDA_REST_ADDRESS ??
  `${(process.env.NANOBPMN_BASE_URL ?? "http://localhost:8080").replace(/\/+$/, "")}/v2`;
const engine = await createNanoSdkEngineClient({
  restAddress,
  token: process.env.CAMUNDA_TOKEN,
  transport: process.env.CAMUNDA_TRANSPORT ?? "auto",
  log: host.log,
});

// Manage our own shutdown so the poller is stopped and the process exits (the runtime
// signal handler would only stop the HTTP server, leaving the poller keeping us alive).
const app = await runFromEnv({ engine, host, port: PORT, handleSignals: false });

// Review-ready poller. Self-scheduling (not setInterval) so a slow GitHub call can never
// overlap two passes (which could double-signal `review-ready`); the next pass is scheduled
// only after the previous one settles.
let shuttingDown = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
async function pollLoop(): Promise<void> {
  try {
    if (app.data) await pollOnce(app.data, engine, GITHUB_TOKEN, { restAddress, token: process.env.CAMUNDA_TOKEN });
  } catch (err) {
    console.error("poll error:", err);
  }
  if (!shuttingDown) pollTimer = setTimeout(() => void pollLoop(), POLL_MS);
}
if (app.data) pollTimer = setTimeout(() => void pollLoop(), POLL_MS);

async function drainAndExit(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (pollTimer) clearTimeout(pollTimer);
  try {
    await app.stop();
  } catch { /* already stopped */ }
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void drainAndExit());
}

console.log(`nano-workforce serving on :${PORT} (poll ${POLL_MS}ms, maxRounds ${MAX_ROUNDS})`);
