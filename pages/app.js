// nano-workforce selectable themes (issue #840).
//
// Loaded by the urban page shell by convention (`pages/app.js`, nano-ide#578), after the
// page runtime. It stamps the chosen theme onto <html data-nwf-theme="…"> — which every
// rule in `pages/app.css` keys on — and mounts a small floating picker. The choice is
// persisted per browser in localStorage.
//
// THEMES is the single source of truth for the theme list: the picker options, the
// validation of a stored value, and the guard test (test/themes.test.ts, which checks every
// non-default theme has rules in app.css) all derive from it.

/** @type {ReadonlyArray<{ id: string, label: string, font?: string }>} */
export const THEMES = Object.freeze([
  { id: "classic", label: "Classic" },
  { id: "soft", label: "Soft", font: "Nunito:wght@400;600;700" },
  { id: "cartoon", label: "Cartoon", font: "Fredoka:wght@400;500;600;700" },
]);

export const DEFAULT_THEME = "classic";
export const STORAGE_KEY = "nwf.theme";

/** A stored/requested value → a known theme id (anything unknown falls back to the default). */
export function resolveTheme(value) {
  return THEMES.some((t) => t.id === value) ? value : DEFAULT_THEME;
}

function readStored() {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null; // storage blocked (e.g. sandboxed iframe) → default
  }
}

function writeStored(id) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, id);
  } catch {
    /* storage blocked → the choice just lasts for this page view */
  }
}

function loadFont(doc, theme) {
  if (!theme.font || doc.getElementById(`nwf-font-${theme.id}`)) return;
  const link = doc.createElement("link");
  link.id = `nwf-font-${theme.id}`;
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${theme.font}&display=swap`;
  doc.head.appendChild(link);
}

/** Apply a theme to the document (idempotent). */
export function applyTheme(doc, value) {
  const id = resolveTheme(value);
  doc.documentElement.dataset.nwfTheme = id;
  const theme = THEMES.find((t) => t.id === id);
  if (theme) loadFont(doc, theme);
  return id;
}

function mountPicker(doc) {
  if (doc.getElementById("nwf-theme-picker")) return;
  const wrap = doc.createElement("label");
  wrap.id = "nwf-theme-picker";
  wrap.className = "nwf-theme-picker";
  wrap.title = "Theme";
  const icon = doc.createElement("span");
  icon.textContent = "🎨";
  icon.setAttribute("aria-hidden", "true");
  const select = doc.createElement("select");
  select.setAttribute("aria-label", "Theme");
  for (const t of THEMES) {
    const opt = doc.createElement("option");
    opt.value = t.id;
    opt.textContent = t.label;
    select.appendChild(opt);
  }
  select.value = doc.documentElement.dataset.nwfTheme ?? DEFAULT_THEME;
  select.addEventListener("change", () => {
    writeStored(applyTheme(doc, select.value));
  });
  wrap.append(icon, select);
  doc.body.appendChild(wrap);
}

if (typeof document !== "undefined") {
  applyTheme(document, readStored());
  mountPicker(document);
}
