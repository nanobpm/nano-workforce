// Drift-guard: the transcript grammar is DERIVED from its one owner, never re-forked here (#676).
//
// nano-workforce used to carry a byte-for-byte hand-rolled copy of the transcript-event grammar
// (marker/version, the ONE parser, the vocabulary, the derive fold). That grammar now lives in exactly
// one place — `@nanobpm/agentic/transcript` (agentic 0.10.0) — and `transcript-events.ts` is a thin
// re-export barrel over it. This guard secures the *class* of failure ("a consumer hand-rolls the
// transcript grammar instead of importing it") structurally, by scanning the app-tier source: it fails
// if the barrel stops importing agentic, if a local module re-defines the envelope marker literal, or
// if a transcript consumer re-parses a stored chunk itself instead of folding through the one parser.
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "#test-assert";
import { TRANSCRIPT_EVENT_MARKER } from "./transcript-events.ts";

const AGENTIC_DIR = dirname(fileURLToPath(import.meta.url));

/** Every non-test `.ts` source file under app/agentic, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

const BARREL_MODULE = join(AGENTIC_DIR, "transcript-events.ts");
const AGENTIC_TRANSCRIPT_SPECIFIER = "@nanobpm/agentic/transcript";

test("the transcript grammar is imported from @nanobpm/agentic/transcript, never redefined locally", () => {
  // The single source of truth is agentic; nano-workforce derives from it via a re-export barrel.
  const barrel = readFileSync(BARREL_MODULE, "utf8");
  assert(
    barrel.includes(AGENTIC_TRANSCRIPT_SPECIFIER),
    `${BARREL_MODULE} must re-export the grammar from "${AGENTIC_TRANSCRIPT_SPECIFIER}"`,
  );
});

test("no local module re-defines the transcript-event marker literal (no second grammar)", () => {
  // Consumers reference the marker via the imported `TRANSCRIPT_EVENT_MARKER` identifier; only a
  // second, forked grammar would embed the marker's string literal in nano-workforce source. Match
  // every quote form (double, single, backtick) so a re-fork can't bypass the guard by hardcoding the
  // marker in a different literal style. Expect ZERO owners — the literal lives in agentic now.
  const quotedMarkerForms = ['"', "'", "`"].map((q) => `${q}${TRANSCRIPT_EVENT_MARKER}${q}`);
  const owners = sourceFiles(AGENTIC_DIR).filter((path) => {
    const src = readFileSync(path, "utf8");
    return quotedMarkerForms.some((literal) => src.includes(literal));
  });
  assertEquals(owners, []);
});

test("no transcript consumer re-parses raw chunks — the log is folded only through the one parser", () => {
  // The cockpit + read projections must fold through the single parser (in agentic), never JSON.parse a
  // chunk themselves. Scan the transcript-facing consumers and assert none contains a raw JSON.parse.
  const consumers = sourceFiles(AGENTIC_DIR).filter((path) =>
    /transcript-(read|render|view|derive|fork)\.ts$/.test(path),
  );
  assert(consumers.length >= 3, "expected to scan several transcript consumers");
  for (const path of consumers) {
    const src = readFileSync(path, "utf8");
    assert(!src.includes("JSON.parse"), `${path} must derive through parseTranscriptEvent, not re-parse the log itself`);
  }
});
