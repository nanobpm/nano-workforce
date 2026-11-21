// Issue #988 (part 4): cancelling a run must drop its open escalations from the inbox instead of
// leaving them listed until an operator `ack pr`s the PR.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { freshData } from "../test/reconcileDb.ts";
import { closeCancelledRunEscalations } from "./service.ts";

test("closeCancelledRunEscalations retires the cancelled run's open escalations and inbox rows (#988)", async () => {
  const { data, raw } = freshData();
  const at = "2026-11-21T00:00:00Z";
  raw.prepare("INSERT INTO pull_requests (pr_key, repo, number, url, status, process_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run("o/r#1", "o/r", 1, "u", "escalated", "322", at, at);
  raw.prepare("INSERT INTO pull_requests (pr_key, repo, number, url, status, process_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run("o/r#2", "o/r", 2, "u", "escalated", "999", at, at);
  const esc = raw.prepare("INSERT INTO escalations (pr_key, round_no, kind, question, status, asked_at) VALUES (?,?,?,?,?,?)");
  esc.run("o/r#1", 1, "noprogress", "q1", "open", at);
  esc.run("o/r#1", 1, "noprogress", "q0", "answered", at);
  esc.run("o/r#2", 1, "noprogress", "q2", "open", at);

  const retired = await closeCancelledRunEscalations(data, "322");
  assertEquals(retired, 1);
  const rows = raw.prepare("SELECT pr_key, question, status FROM escalations ORDER BY id").all();
  assertEquals(
    rows.map((r) => `${r.pr_key}:${r.question}:${r.status}`),
    ["o/r#1:q1:stale", "o/r#1:q0:answered", "o/r#2:q2:open"],
  );
  assertEquals(await closeCancelledRunEscalations(data, "322"), 0, "idempotent");
});
