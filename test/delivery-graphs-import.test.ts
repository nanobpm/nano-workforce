// Contract guard for the filesystem IMPORT wiring on the Delivery Graphs compose App-View (issue #524,
// epic #519 S5). The Import control is ADDED into the PRE-EXISTING compose mount (pages/delivery-graphs/
// mount.js — the one #523 reshaped), alongside #523's inbound reuse-fill seam. It must: render an
// `<input type=file accept=.json>`, read the picked file's text client-side, POST it to the
// importToLibrary door (base-relative, App-View #279 resolution class), route a successful import back
// through #523's SINGLE `fillComposer()` seam (no second inbound fill path), and render path-qualified
// compile errors inline on a 400. This test pins that wiring so it can't silently regress.
import { test } from "node:test";
import { assert } from "#test-assert";
import { readFileSync } from "node:fs";

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);
const DIR = `${ROOT}pages/delivery-graphs`;
const MOUNT_JS = readFileSync(`${DIR}/mount.js`, "utf8");
const CSS = readFileSync(`${DIR}/delivery-graphs.css`, "utf8");
const EMBED_HTML = readFileSync(`${DIR}/embed.html`, "utf8");
const STANDALONE_HTML = readFileSync(`${DIR}/standalone.html`, "utf8");

// Pull the module-anchored default URL *spec* (the "<spec>" literal inside
// `new URL("<spec>", import.meta.url)`, e.g. "../app/api/…") out of
// `const <name> = config.<name> ?? <CONST>;` where the CONST is declared
// `const <CONST> = new URL("<spec>", import.meta.url).href;`. This is the unresolved
// relative spec, not a resolved URL string — hence `Spec`, not `Url`.
function defaultSpec(name: string): string {
  const m = MOUNT_JS.match(new RegExp(`${name}\\s*=\\s*config\\.\\w+\\s*\\?\\?\\s*(\\w+);`));
  assert(m, `mount.js must default ${name} from config with a fallback constant`);
  const constM = MOUNT_JS.match(
    new RegExp(`const ${m![1]}\\s*=\\s*new URL\\(\\s*"([^"]*)"\\s*,\\s*import\\.meta\\.url\\s*\\)\\s*\\.href`),
  );
  assert(
    constM,
    `mount.js must default ${m![1]} to new URL("<spec>", import.meta.url) so the door is anchored ` +
      `to the module's own served location, not the document base (#467/#536)`,
  );
  return constM![1];
}

test("#524: the compose mount renders a file-input Import control accepting .json", () => {
  assert(/id="dg-import"/.test(MOUNT_JS), "mount.js must render an Import file input with id=dg-import");
  assert(/type="file"/.test(MOUNT_JS), "the Import control must be an <input type=file>");
  assert(/accept="[^"]*\.json[^"]*"/.test(MOUNT_JS), "the Import file input must accept .json files");
});

test("#524: Import wires the importToLibrary door (base-relative), reading the file text client-side", () => {
  const importSpec = defaultSpec("importUrl");
  assert(
    importSpec.endsWith("actions/delivery-graph/library/import"),
    `importUrl default spec "${importSpec}" must hit the importToLibrary door`,
  );
  assert(!importSpec.startsWith("/"), `default importUrl spec "${importSpec}" must be base-relative (App-View #279 resolution class)`);
  // The file's text is read CLIENT-SIDE and POSTed as graphJson to the import door.
  assert(/\.text\(\)/.test(MOUNT_JS), "mount.js must read the selected file's text client-side via File.text()");
  assert(/post\(importUrl,\s*\{\s*graphJson:/.test(MOUNT_JS), "the Import handler must POST the file text as graphJson to the import door");
  // The <input> must actually be WIRED to the handler: without a change listener that invokes
  // importFile(), the door + handler could stay intact while Import is inert (every other assertion
  // here still green). Pin the change→importFile wiring so removing the listener fails the suite.
  assert(
    /addEventListener\(\s*["']change["'][\s\S]{0,200}?importFile\(/.test(MOUNT_JS),
    "the Import file input's change listener must invoke importFile() so picking a file triggers an import",
  );
});

test("#524: a successful import routes through #523's single fillComposer() seam", () => {
  // #523 owns the inbound fill seam; #524 builds on it rather than adding a second inbound fill path.
  assert(/function fillComposer\(/.test(MOUNT_JS), "the #523 fillComposer() seam must still be present");
  const importHandler = MOUNT_JS.slice(MOUNT_JS.indexOf("async function importFile"));
  assert(importHandler.length > 0, "mount.js must define the importFile handler");
  assert(/fillComposer\(text\b/.test(importHandler), "a successful import must route the imported text through the fillComposer() seam");
});

test("#524: an import failure renders the door's path-qualified compile errors inline", () => {
  const importHandler = MOUNT_JS.slice(MOUNT_JS.indexOf("async function importFile"));
  assert(
    /renderErrors\(body\.error,\s*body\.errors\)/.test(importHandler),
    "an import 400 must render the door's path-qualified errors inline",
  );
});

test("#524: both shells forward importUrl into the mount (embed via cfg, standalone via ?import=)", () => {
  // The mount resolves `config.importUrl ?? DEFAULT_IMPORT_URL`, so the default-URL guard above passes
  // even if a shell drops the `importUrl` forwarding entirely — silently breaking embedded custom
  // deployments and the standalone `?import=` override. Pin BOTH forwardings, exactly as the shells
  // already forward previewUrl/stageUrl.
  assert(
    /importUrl:\s*cfg\.importUrl/.test(EMBED_HTML),
    "embed.html must forward the console-injected importUrl (importUrl: cfg.importUrl) into the mount",
  );
  assert(
    /importUrl:\s*params\.get\("import"\)/.test(STANDALONE_HTML),
    "standalone.html must forward the ?import= override (importUrl: params.get(\"import\")) into the mount",
  );
  // mount.js must actually read config.importUrl (not hard-code the default), so the forwarding matters.
  assert(
    /const importUrl\s*=\s*config\.importUrl\s*\?\?/.test(MOUNT_JS),
    "mount.js must resolve importUrl from config.importUrl with a fallback default",
  );
});

test("#524: the native file input is visually hidden and the label reads as a button", () => {
  assert(/\.dg-import-input/.test(CSS), "the CSS must style the Import file input");
  assert(/clip:\s*rect\(0,\s*0,\s*0,\s*0\)/.test(CSS), "the native file input must be visually hidden (the label is the button)");
});
