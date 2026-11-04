// The variables the Urban Tasks inbox (and the pages `engineForm` drawer) load for a user task and
// PREFILL its form inputs from (nanobpm/nano-ide#603, issue #915). Mirrors `taskVariablesResponse` in
// `@nanobpm/urban` `dist/runtime/core/modules/forms.js` (not exported from the package): only
// PROCESS-level variables (`scopeKey === processInstanceKey`) are included, truncated previews are
// omitted, and each serialized value is `JSON.parse`d. A form key present here with a non-null value
// is what an operator would see prefilled when the task opens.
import type { WasmEngineClient } from "@nanobpm/urban-testkit";

export async function inboxContext(engine: WasmEngineClient, processInstanceKey: string): Promise<Record<string, unknown>> {
  const rows = await engine.searchVariables({ processInstanceKey });
  const vars: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.scopeKey !== processInstanceKey || row.isTruncated) continue;
    try {
      vars[row.name] = JSON.parse(row.value);
    } catch {
      vars[row.name] = row.value;
    }
  }
  return vars;
}

/** The form keys that would open PREFILLED (present with a non-null, non-empty value). */
export async function prefilledKeys(engine: WasmEngineClient, processInstanceKey: string, keys: readonly string[]): Promise<string[]> {
  const ctx = await inboxContext(engine, processInstanceKey);
  return keys.filter((k) => ctx[k] !== undefined && ctx[k] !== null && ctx[k] !== "");
}
