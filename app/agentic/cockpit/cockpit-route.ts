export type CockpitRoute = { readonly kind: "main" } | { readonly kind: "worker"; readonly instance: string };

/** Parse the cockpit hash route. Unknown or malformed hashes fall back to the main list. */
export function parseCockpitRoute(hash: string): CockpitRoute {
  const route = hash.startsWith("#") ? hash.slice(1) : hash;
  if (route === "" || route === "/cockpit" || route === "/cockpit/") return { kind: "main" };
  const prefix = "/cockpit/worker/";
  if (!route.startsWith(prefix)) return { kind: "main" };
  const raw = route.slice(prefix.length);
  if (raw === "") return { kind: "main" };
  try {
    const instance = decodeURIComponent(raw);
    return instance === "" ? { kind: "main" } : { kind: "worker", instance };
  } catch {
    return { kind: "main" };
  }
}
