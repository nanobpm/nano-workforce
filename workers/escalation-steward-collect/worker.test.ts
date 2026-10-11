// Unit coverage for the pr.escalation-steward-collect worker (issue #889) — the steward tick's first
// step. Drives the handler against the real data layer + a searchProcessInstances stub and asserts:
//   • only OPTED-IN, past-min-age, answerable, unclaimed escalations are collected + claimed;
//   • an escalation on non-opted-in work is NEVER collected (the core safety invariant);
//   • the overlap guard: a still-ACTIVE prior steward instance makes the tick a no-op.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import type { DataLayer } from "@nanobpm/urban";
import { bootTestApp } from "@nanobpm/urban-testkit";
import { escalationAutoResolutions } from "../../app/escalationSteward.ts";
import handler from "./worker.ts";

const APP_ROOT = resolve(import.meta.dirname, "..", "..");

async function withApp(
  fn: (data: DataLayer, run: (vars?: Record<string, unknown>, activeSteward?: string[]) => Promise<{ eligibleCount: number; claimed: string[]; skippedOverlap: boolean }>) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nwf-steward-col-"));
  const app = await bootTestApp(APP_ROOT, { env: { NANO_APP_DB_URL: `file:${join(dir, "app.db")}` } });
  try {
    const run = async (vars: Record<string, unknown> = {}, activeSteward: string[] = []) => {
      const engine = {
        searchProcessInstances: (filter?: { processDefinitionId?: string; state?: string }) => {
          // Report the listed keys as ACTIVE steward instances (the overlap probe).
          const list = filter?.processDefinitionId === "escalation-steward"
            ? activeSteward.map((k) => ({ processInstanceKey: k, state: "ACTIVE" }))
            : [];
          return Promise.resolve(list);
        },
      };
      const job = { jobKey: "J-1", processInstanceKey: "PI-THIS", variables: vars };
      return (await handler(job as never, { data: app.db, engine: engine as never, log: { info: () => {}, warn: () => {}, error: () => {} } } as never)) as {
        eligibleCount: number;
        claimed: string[];
        skippedOverlap: boolean;
      };
    };
    await fn(app.db, run);
  } finally {
    await app.stop?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Seed an open user_tasks row + its owning subject (with the given opt-in flag). */
async function seedEscalation(
  data: DataLayer,
  opts: { userTaskKey: string; processKey: string; optedIn: boolean; elementId?: string; ageMinutes?: number; subjectKey?: string },
): Promise<void> {
  const ts = new Date().toISOString();
  const created = new Date(Date.now() - (opts.ageMinutes ?? 10) * 60 * 1000).toISOString();
  await data.table("pull_requests", "pr_key").insert({
    pr_key: opts.subjectKey ?? "o/r#1", repo: "o/r", number: 1, url: "u", status: "converging", current_round: 0,
    process_key: opts.processKey, auto_resolve_escalations: opts.optedIn ? 1 : 0, created_at: ts, updated_at: ts,
  });
  await data.table("user_tasks", "user_task_key").insert({
    user_task_key: opts.userTaskKey, element_id: opts.elementId ?? "wait-answer", kind_label: "PR review",
    subject_type: "pr", subject_key: opts.subjectKey ?? "o/r#1", subject_title: "t", subject_url: "u",
    question: "q", process_key: opts.processKey, form_key: "pr-escalation", created_at: created, updated_at: ts,
  });
}

test("collect worker: collects + claims an opted-in, past-min-age, answerable escalation", async () => {
  await withApp(async (data, run) => {
    await seedEscalation(data, { userTaskKey: "UT-1", processKey: "PI-PR", optedIn: true });
    const out = await run();
    assertEquals(out.skippedOverlap, false);
    assertEquals(out.eligibleCount, 1);
    assertEquals(out.claimed.length, 1);
    // The claim is recorded (a `claimed` placeholder row) so a racing tick is fenced out.
    const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-1" });
    assertEquals(rows.length, 1);
    assertEquals(rows[0].outcome, "claimed");
  });
});

test("collect worker: an escalation on NON-opted-in work is never collected (safety invariant)", async () => {
  await withApp(async (data, run) => {
    await seedEscalation(data, { userTaskKey: "UT-1", processKey: "PI-PR", optedIn: false });
    const out = await run();
    assertEquals(out.eligibleCount, 0, "non-opted-in work is never touched");
    assertEquals(out.claimed.length, 0);
    const rows = await escalationAutoResolutions(data).all();
    assertEquals(rows.length, 0, "no claim row is written");
  });
});

test("collect worker: a human-only kind (merge-approval) is never collected even when opted in", async () => {
  await withApp(async (data, run) => {
    await seedEscalation(data, { userTaskKey: "UT-1", processKey: "PI-PR", optedIn: true, elementId: "merge-approval" });
    const out = await run();
    assertEquals(out.eligibleCount, 0, "a human-only kind is never steward-collected");
  });
});

test("collect worker: a too-fresh escalation (under min age) is left for a human already answering", async () => {
  await withApp(async (data, run) => {
    await seedEscalation(data, { userTaskKey: "UT-1", processKey: "PI-PR", optedIn: true, ageMinutes: 0 });
    const out = await run({ minAgeMs: 300_000 });
    assertEquals(out.eligibleCount, 0, "a just-opened escalation is not yet eligible");
  });
});

test("collect worker: the overlap guard makes a tick a no-op while a prior steward run is ACTIVE", async () => {
  await withApp(async (data, run) => {
    await seedEscalation(data, { userTaskKey: "UT-1", processKey: "PI-PR", optedIn: true });
    const out = await run({}, ["PI-PRIOR"]);
    assertEquals(out.skippedOverlap, true, "a still-active prior run skips this tick");
    assertEquals(out.eligibleCount, 0);
    assertEquals(out.claimed.length, 0);
  });
});

test("collect worker: an escalation the steward ALREADY abstained/resolved is never re-claimed (no repeated abstentions)", async () => {
  await withApp(async (data, run) => {
    const { recordResolution } = await import("../../app/escalationSteward.ts");
    await seedEscalation(data, { userTaskKey: "UT-1", processKey: "PI-PR", optedIn: true });
    // First tick claims + abstains (the task stays OPEN — an abstention does not complete it).
    const first = await run({});
    assertEquals(first.claimed.length, 1, "the first tick claims the eligible escalation");
    await recordResolution(data, "UT-1", { outcome: "abstained", rationale: "unclear — needs a human" });
    // The NEXT tick must NOT re-claim the same `user_task_key`: the partial claim fence no longer
    // covers the finalised row, so without the final-record exclusion the steward would abstain the
    // same open task every tick forever (issue #889 review).
    const second = await run({});
    assertEquals(second.claimed.length, 0, "an already-abstained task is never re-claimed");
    assertEquals(second.eligibleCount, 0);
    const rows = await escalationAutoResolutions(data).find({ user_task_key: "UT-1" });
    assertEquals(rows.length, 1, "exactly ONE durable row — no repeated abstention records");
    assertEquals(rows[0].outcome, "abstained");
  });
});
