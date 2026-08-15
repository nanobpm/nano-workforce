// Coverage for the advisory-only reconcile pass's URL decoding (scripts/reconcile-contracts.ts, PR
// #229). The pass is designed to NEVER fail the build. `fileUrlToPath` decodes NANO_APP_DB_URL, and a
// literal `%` (or any malformed %-escape) makes `decodeURIComponent` throw — which would crash an
// "advisory, never gate CI" script. Decoding is now best-effort, so a malformed URL degrades to the
// raw path instead of throwing.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { fileUrlToPath } from "./reconcile-contracts.ts";

test("fileUrlToPath: decodes a well-formed percent-escape", () => {
  assertEquals(fileUrlToPath("file:./my%20app.db"), "./my app.db");
});

test("fileUrlToPath: a malformed percent-escape does not throw (best-effort)", () => {
  // A bare `%` is not a valid escape; decodeURIComponent would throw. The pass must not crash — a
  // successful call that returns the raw path proves the decode is best-effort.
  assertEquals(fileUrlToPath("file:./100%done.db"), "./100%done.db");
});

test("fileUrlToPath: a non-file URL yields undefined", () => {
  assertEquals(fileUrlToPath("postgres://localhost/db"), undefined);
});

test("fileUrlToPath: a malformed file:// URL yields undefined, never throws (PR #229)", () => {
  // `new URL("file://…")` throws on a malformed authority/host. The advisory pass must degrade to
  // undefined (best-effort: file simply not found) rather than crash a "never gate CI" script.
  assertEquals(fileUrlToPath("file://%zz/bad host/db.sqlite"), undefined);
});

test("fileUrlToPath: strips a query/hash suffix on an opaque file: URL (PR #229)", () => {
  // A valid SQLite-style URL carries connection params (`?mode=ro`). The opaque `file:` branch must
  // drop the `?…`/`#…` suffix so the path resolves to a real on-disk file, else reconciliation is
  // silently disabled by a path that never exists.
  assertEquals(fileUrlToPath("file:./app.db?mode=ro"), "./app.db");
  assertEquals(fileUrlToPath("file:./app.db#frag"), "./app.db");
  assertEquals(fileUrlToPath("file:./app.db?mode=ro&cache=shared#x"), "./app.db");
});

