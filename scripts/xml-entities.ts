// Shared XML-entity normalization for laid-out / compiled BPMN.
//
// `bpmn-auto-layout` (used by `@nanobpm/urban`'s `layoutBpmn` and
// `@nanobpm/workflow`'s `toDeployableBpmn`, via bpmn-moddle) re-serializes
// attribute values with NUMERIC character references (`&#34;`, `&#62;`, …).
// The nano engine's BPMN/FEEL parser decodes the five NAMED predefined XML
// entities but NOT numeric character references, so a FEEL expression carrying
// a string literal (e.g. `="ready"`) or a `>`/`<` operator inside a
// `zeebe:output`/`zeebe:input` `source` attribute silently fails to evaluate at
// runtime — the engine raises `EXTRACT_VALUE_ERROR: unexpected character '&'`
// (or, in some positions, sets no value with no incident), so the mapped
// variable is never assigned. When that variable drives an exclusive gateway,
// the gateway takes its default flow; a default self-loop with no wait state
// then spins the engine at ~99% CPU. Because `nano.app.json` declares no
// `models`, `resources/processes/*.bpmn` is deployed to the engine BY
// CONVENTION as-is, so the committed bytes must already be engine-parseable.
//
// Rewriting the numeric refs to the named entities the engine understands
// preserves each model's meaning byte-for-byte while making it parseable.
//
// NOTE: this covers only the five predefined entities. Numeric refs with no
// named equivalent — notably `&#10;` (newline, emitted for literal newlines
// inside FEEL string literals) — are left untouched; the engine's inability to
// decode those is a separate upstream engine defect (it should decode numeric
// character references per the XML spec).
const NUMERIC_ENTITY_TO_NAMED: ReadonlyArray<readonly [RegExp, string]> = [
  [/&#0*34;|&#[xX]0*22;/g, "&quot;"],
  [/&#0*38;|&#[xX]0*26;/g, "&amp;"],
  [/&#0*60;|&#[xX]0*3[cC];/g, "&lt;"],
  [/&#0*62;|&#[xX]0*3[eE];/g, "&gt;"],
  [/&#0*39;|&#[xX]0*27;/g, "&apos;"],
];

export function normalizeXmlEntities(xml: string): string {
  return NUMERIC_ENTITY_TO_NAMED.reduce((acc, [re, named]) => acc.replace(re, named), xml);
}
