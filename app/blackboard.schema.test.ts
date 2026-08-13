// Schema-drift guard (#147). The `db/migrations/025_agentic_blackboard.sql` CREATE statements MUST be
// the canonical `BLACKBOARD_SCHEMA_SQL` verbatim — the exact DDL `@nanobpm/agentic/blackboard`'s
// `BlackboardStore.ensureSchema()` (and the agentic-channel family) apply. If the two ever drift, a
// board created by a migration on one host and by `ensureSchema()` on another would disagree — this
// test fails the build before that can ship.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BLACKBOARD_SCHEMA_SQL } from "@nanobpm/agentic/blackboard";
import { assert, assertEquals } from "#test-assert";

test("migration 025 CREATE statements equal BLACKBOARD_SCHEMA_SQL verbatim", () => {
  const path = fileURLToPath(new URL("../db/migrations/025_agentic_blackboard.sql", import.meta.url));
  const sql = readFileSync(path, "utf8");
  const start = sql.indexOf("CREATE TABLE IF NOT EXISTS agentic_blackboard");
  const end = sql.indexOf("(scope, id);");
  assert(start !== -1, "migration 025 is missing the `CREATE TABLE IF NOT EXISTS agentic_blackboard` marker");
  assert(end !== -1, "migration 025 is missing the `(scope, id);` index marker");
  const createBlock = sql.slice(start, end + "(scope, id);".length).trim();
  assertEquals(createBlock, BLACKBOARD_SCHEMA_SQL.trim());
});
