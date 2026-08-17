// Drift-guard: exactly ONE parser of the transcript log (ADR 0056, #251).
//
// Acceptance criterion (#251): "the cockpit renders from a single derive*() fold, with no independent
// re-parse of raw bytes (drift-guard test asserts one parser)". This is that guard. It enforces
// structurally — by scanning the app-tier source — that the raw-chunk → typed-event classification
// lives in exactly one module (`transcript-events.ts`), so a second, divergent parser of the same
// bytes cannot creep in. The whole point of the event-sourced model is "the log IS the state": every
// view derives from the one fold, none re-parses the bytes itself.
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

const PARSER_MODULE = join(AGENTIC_DIR, "transcript-events.ts");

test("the transcript-event marker literal is DEFINED in exactly one module (no second parser)", () => {
  // Consumers reference the marker via the imported `TRANSCRIPT_EVENT_MARKER` identifier; only the ONE
  // parser embeds the marker's string literal. A second module hardcoding it would be a second parser.
  const owners = sourceFiles(AGENTIC_DIR).filter((path) => readFileSync(path, "utf8").includes(`"${TRANSCRIPT_EVENT_MARKER}"`));
  assertEquals(owners, [PARSER_MODULE]);
});

test("no transcript consumer re-parses raw chunks — JSON.parse of the log lives only in the parser", () => {
  // The cockpit + read projections must fold through the single parser, never JSON.parse a chunk
  // themselves. Scan the transcript-facing consumers and assert none contains a raw JSON.parse.
  const consumers = sourceFiles(AGENTIC_DIR).filter(
    (path) => path !== PARSER_MODULE && /transcript-(read|render|view|derive|fork)\.ts$/.test(path),
  );
  assert(consumers.length >= 3, "expected to scan several transcript consumers");
  for (const path of consumers) {
    const src = readFileSync(path, "utf8");
    assert(!src.includes("JSON.parse"), `${path} must derive through parseTranscriptEvent, not re-parse the log itself`);
  }
});
