export type CockpitRoute =
  | { readonly kind: "main" }
  | { readonly kind: "worker"; readonly instance: string }
  /** Focused on one process instance (#833) — the target of an "Agent" grid link. */
  | { readonly kind: "process"; readonly processInstanceKey: string };

function decodeSegment(raw: string): string | undefined {
  if (raw === "") return undefined;
  try {
    const value = decodeURIComponent(raw);
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

/** Parse the cockpit hash route. Unknown or malformed hashes fall back to the main list. */
export function parseCockpitRoute(hash: string): CockpitRoute {
  const route = hash.startsWith("#") ? hash.slice(1) : hash;
  const worker = "/cockpit/worker/";
  if (route.startsWith(worker)) {
    const instance = decodeSegment(route.slice(worker.length));
    return instance === undefined ? { kind: "main" } : { kind: "worker", instance };
  }
  const process = "/cockpit/process/";
  if (route.startsWith(process)) {
    const processInstanceKey = decodeSegment(route.slice(process.length));
    return processInstanceKey === undefined ? { kind: "main" } : { kind: "process", processInstanceKey };
  }
  return { kind: "main" };
}

/**
 * The process-instance key carried by the HOST page's `#/cockpit/<param>` route (#833). An "Agent" grid
 * link (`{ kind: "page", page: "cockpit", keyField: "process_key" }`) navigates the host page — the
 * cockpit embed is an iframe with its own hash — so the embed reads the param from its same-origin
 * parent. Only a single, decodable segment counts; anything else is undefined (no focus).
 */
export function parseHostCockpitParam(hash: string): string | undefined {
  const route = hash.startsWith("#") ? hash.slice(1) : hash;
  const prefix = "/cockpit/";
  if (!route.startsWith(prefix)) return undefined;
  const raw = route.slice(prefix.length);
  if (raw.includes("/")) return undefined;
  return decodeSegment(raw);
}
