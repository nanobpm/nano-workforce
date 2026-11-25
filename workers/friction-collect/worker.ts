// pr.friction-collect — the friction sweep's first step (issue #1073). Deterministic host code: reads
// the window `(watermark, now]` from engine records + engine-stored agent transcripts, extracts and
// REDACTS typed friction signals, and persists signals + a bounded digest + the advanced watermark in
// one transaction (app/friction.ts `collectFriction`). Only the bounded, redacted digest leaves this
// step — raw transcripts never reach the analyst agent.
//
// It also seeds `agentSlaTimeout`: the sweep is started by a timer start event, which carries no
// variables, so the analyst's SLA boundary (`=agentSlaTimeout`) reads the value this step returns.
import type { AppJobHandler } from "@nanobpm/urban";
import { AGENT_SLA_TIMEOUT } from "../../app/agentSla.ts";
import { collectFriction, frictionAppBaseUrl, frictionConfig, frictionGithub } from "../../app/friction.ts";

interface Out extends Record<string, unknown> {
  collectStatus: string;
  windowStart: string;
  windowEnd: string;
  runsSwept: number;
  signalCount: number;
  frictionDigest: string;
  openFindings: string[];
  agentSlaTimeout: string;
}

const handler: AppJobHandler<Record<string, unknown>, Out> = async (job, app) => {
  const sweepKey = job.processInstanceKey != null ? String(job.processInstanceKey) : `friction-${Date.now()}`;
  let res: Awaited<ReturnType<typeof collectFriction>>;
  try {
    res = await collectFriction({
    data: app.data,
    engine: app.engine,
    sweepKey,
    now: new Date(),
    config: frictionConfig(),
    github: frictionGithub(process.env.GITHUB_TOKEN ?? ""),
    baseUrl: frictionAppBaseUrl(),
    log: app.log,
    });
  } catch (err) {
    // A failed read commits nothing (the watermark stays put, so the window is re-swept next time);
    // report `failed` so the model releases the singleton lease rather than parking on an incident.
    app.log.warn("friction collect failed", { sweepKey, error: String(err) });
    return {
      collectStatus: "failed",
      windowStart: "",
      windowEnd: "",
      runsSwept: 0,
      signalCount: 0,
      frictionDigest: "",
      openFindings: [],
      agentSlaTimeout: AGENT_SLA_TIMEOUT,
    };
  }
  app.log.info("friction collect", {
    sweepKey,
    status: res.status,
    window: `${res.windowStart}..${res.windowEnd}`,
    runs: res.runsSwept,
    signals: res.signalCount,
  });
  return {
    collectStatus: res.status,
    windowStart: res.windowStart,
    windowEnd: res.windowEnd,
    runsSwept: res.runsSwept,
    signalCount: res.signalCount,
    frictionDigest: res.digest,
    openFindings: res.openFindings,
    agentSlaTimeout: AGENT_SLA_TIMEOUT,
  };
};

export default handler;
