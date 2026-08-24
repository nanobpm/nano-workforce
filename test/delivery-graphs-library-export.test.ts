// Contract guard for the delivery-graph LIBRARY Export affordance (issue #525, epic #519 S6).
//
// Export is a purely client-side Blob download of a saved library entry's stored graph JSON as
// `<name>.deliverygraph.json` — no backend door. It builds directly on the S4 Library App-View (#523,
// `pages/delivery-graphs/library.mount.js`): each rendered library entry gains an Export button
// alongside Reuse/Delete. This test pins BOTH halves so the affordance cannot silently regress:
//   • a behavioural guard on the pure, DOM-free `buildDeliveryGraphExport()` helper — it "builds a
//     download from the entry's graph JSON": the download contents are the entry's stored graph
//     verbatim and the filename is the sanitised name + `.deliverygraph.json`; and
//   • a source guard that the mount renders the per-row Export control and assembles the Blob download
//     (createObjectURL → anchor.download → revokeObjectURL) from that helper.
import { test } from "node:test";
import { assert, assertEquals } from "#test-assert";
import { readFileSync } from "node:fs";
import { buildDeliveryGraphExport, DELIVERY_GRAPH_EXPORT_SUFFIX } from "../pages/delivery-graphs/library.mount.js";

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);
const LIBRARY_JS = readFileSync(`${ROOT}pages/delivery-graphs/library.mount.js`, "utf8");

test("#525: the export filename suffix is the pinned .deliverygraph.json contract", () => {
  assertEquals(DELIVERY_GRAPH_EXPORT_SUFFIX, ".deliverygraph.json");
});

test("#525: buildDeliveryGraphExport downloads the entry's stored graph JSON verbatim", () => {
  const graph = '{"nodes":[{"id":"a"}],"edges":[]}';
  const out = buildDeliveryGraphExport({ id: "lib-1", name: "Onboarding", graph });
  // "builds a download from the entry's graph JSON": bytes are the stored graph, unmodified.
  assertEquals(out.contents, graph, "export contents must be the entry's stored graph JSON, byte-for-byte");
  assertEquals(out.mime, "application/json", "an exported delivery graph is application/json");
  assertEquals(out.filename, `Onboarding${DELIVERY_GRAPH_EXPORT_SUFFIX}`, "filename is <name>.deliverygraph.json");
});

test("#525: the export filename sanitises unsafe characters in the entry name", () => {
  const out = buildDeliveryGraphExport({ id: "lib-2", name: "My Graph / v2: final!", graph: "{}" });
  assertEquals(out.filename, `My-Graph-v2-final${DELIVERY_GRAPH_EXPORT_SUFFIX}`);
  // No path separators, and never a leading-dot hidden file.
  assert(!out.filename.includes("/") && !out.filename.includes("\\"), "filename must carry no path separators");
  assert(!out.filename.startsWith("."), "filename must not be a hidden dotfile");
});

test("#525: an unnamed entry falls back to a stable id-derived filename", () => {
  const named = buildDeliveryGraphExport({ id: "lib-3", name: "   ", graph: "{}" });
  assertEquals(named.filename, `delivery-graph-lib-3${DELIVERY_GRAPH_EXPORT_SUFFIX}`, "blank name falls back to the entry id");
  const anon = buildDeliveryGraphExport({ graph: "{}" });
  assertEquals(anon.filename, `delivery-graph${DELIVERY_GRAPH_EXPORT_SUFFIX}`, "no name and no id falls back to a constant");
});

test("#525: an entry with no stored graph yields empty contents (nothing to download)", () => {
  assertEquals(buildDeliveryGraphExport({ id: "x", name: "n" }).contents, "");
  assertEquals(buildDeliveryGraphExport({ id: "x", name: "n", graph: 42 as unknown as string }).contents, "");
});

test("#525: the Library mount renders a per-row Export control wired to a Blob download", () => {
  assert(/data-export=/.test(LIBRARY_JS), "library.mount.js must render a per-row Export affordance carrying the entry id");
  assert(/closest\("\[data-export\]"\)/.test(LIBRARY_JS), "the list click handler must route the Export button");
  assert(/buildDeliveryGraphExport\(entry\)/.test(LIBRARY_JS), "Export must assemble the download from buildDeliveryGraphExport(entry)");
  // The actual client-side download mechanics: Blob → object URL → anchor download → revoke.
  assert(/new Blob\(\[contents\]/.test(LIBRARY_JS), "Export must build a Blob from the entry's graph contents");
  assert(/URL\.createObjectURL\(/.test(LIBRARY_JS), "Export must create an object URL for the download");
  assert(/\.download = filename/.test(LIBRARY_JS), "Export must set the anchor download filename");
  assert(/URL\.revokeObjectURL\(/.test(LIBRARY_JS), "Export must revoke the object URL after triggering the download");
});
