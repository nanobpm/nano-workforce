// Regression coverage for the numeric-XML-entity portability fix (scripts/xml-entities.ts).
//
// WHY THIS GATE EXISTS. `resources/processes/*.bpmn` is deployed to the engine BY CONVENTION
// (nano.app.json declares no `models`), i.e. the committed bytes are what the engine parses. The
// nano engine's BPMN/FEEL parser decodes the five NAMED predefined XML entities but NOT numeric
// character references (`&#34;`, `&#62;`, …). `bpmn-auto-layout` (used by `npm run layout`) emits
// numeric refs, so a FEEL string literal / comparison operator inside a `zeebe:output` `source`
// silently fails to evaluate — a routing variable is left unset, an exclusive gateway takes a
// default self-loop, and the engine spins to a crash. `layout-bpmn.ts` now runs
// `normalizeXmlEntities` to rewrite those refs to named entities; this test pins BOTH the pure
// rewrite and the invariant that no committed model still ships an engine-undecodable ref.
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { normalizeXmlEntities } from "./xml-entities.ts";
import { assert, assertEquals } from "#test-assert";

// The predefined entities the engine CAN decode by name — every numeric spelling of these must be
// rewritten. Numeric refs WITHOUT a named equivalent (notably `&#10;` newline) are deliberately out
// of scope: no named entity exists, so they are left as-is and tracked against the upstream engine
// defect (the engine should decode numeric refs per the XML spec). This gate therefore checks only
// the five predefined entities, in decimal and hex, so the residual `&#10;` does not trip it.
const UNDECODABLE_PREDEFINED = /&#0*(?:34|38|39|60|62);|&#[xX]0*(?:22|26|27|3[cCeE]);/;

test("normalizeXmlEntities rewrites every numeric spelling of the five predefined entities", () => {
  assertEquals(normalizeXmlEntities("&#34;&#38;&#60;&#62;&#39;"), "&quot;&amp;&lt;&gt;&apos;");
  // Hex, uppercase/lowercase, and zero-padded forms all normalize identically.
  assertEquals(normalizeXmlEntities("&#x22;&#X26;&#x3c;&#x3E;&#x27;"), "&quot;&amp;&lt;&gt;&apos;");
  assertEquals(normalizeXmlEntities("&#034;&#0038;"), "&quot;&amp;");
});

test("normalizeXmlEntities preserves a realistic FEEL output mapping", () => {
  const before = '<zeebe:output source="=if tier = &#34;light&#34; then &#34;plan&#34; else &#34;other&#34;" target="stage" />';
  const after = '<zeebe:output source="=if tier = &quot;light&quot; then &quot;plan&quot; else &quot;other&quot;" target="stage" />';
  assertEquals(normalizeXmlEntities(before), after);
});

test("normalizeXmlEntities leaves &#10; (newline, no named equivalent) untouched", () => {
  assertEquals(normalizeXmlEntities("a&#10;b"), "a&#10;b");
});

test("normalizeXmlEntities is idempotent and leaves already-named entities alone", () => {
  const named = "&quot;&amp;&lt;&gt;&apos;";
  assertEquals(normalizeXmlEntities(named), named);
  assertEquals(normalizeXmlEntities(normalizeXmlEntities("&#34;&#38;")), normalizeXmlEntities("&#34;&#38;"));
});

test("no committed process model ships an engine-undecodable predefined-entity numeric ref", () => {
  const dir = "resources/processes";
  const models = readdirSync(dir).filter((f) => f.endsWith(".bpmn"));
  assert(models.length > 0, "expected at least one process model to guard");
  const offenders = models.filter((f) => UNDECODABLE_PREDEFINED.test(readFileSync(`${dir}/${f}`, "utf8")));
  assertEquals(
    offenders,
    [],
    `these deployed-by-convention models still carry numeric char refs the engine cannot decode; ` +
      `re-run \`npm run layout\` to normalize them: ${offenders.join(", ")}`,
  );
});
