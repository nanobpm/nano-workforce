// Tests for the published vocab view (epic #152 / N1 #145). The endpoint contract promises a
// deterministic, sorted `requirements` list so a worker sees a stable ordering regardless of the
// resolver's internal role ordering.
import { test } from "node:test";
import { assertEquals } from "#test-assert";
import { CREW_VOCAB_VERSION } from "./crew-vocab.ts";
import { vocabRequirements, vocabView } from "./publish.ts";

test("vocabRequirements are sorted by token (deterministic response order)", () => {
  const tokens = vocabRequirements().map((r) => r.token);
  const sorted = [...tokens].sort((a, b) => a.localeCompare(b));
  assertEquals(tokens, sorted);
});

test("vocabView carries the crew-vocab version and the sorted requirements", () => {
  const view = vocabView();
  assertEquals(view.version, CREW_VOCAB_VERSION);
  const tokens = view.requirements.map((r) => r.token);
  assertEquals(tokens, [...tokens].sort((a, b) => a.localeCompare(b)));
});
