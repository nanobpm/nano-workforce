// Drift guard for the curated MCP tool block in the runbook (issue #715).
//
// The curated `"tools"` allowlist is authored once in `app/mcpToolSurface.ts` and rendered into
// `docs/mcp-runbook.md` by `scripts/sync-mcp-curated.ts`. This test — run under `npm test`, which CI
// already gates — fails if the runbook block drifts from the source of truth, so the enforcement does
// not depend on a separate workflow step (AGENTS.md: "Derivation over duplication: no drift
// surfaces"). Run `npm run sync:mcp-curated` to reconcile. Mirrors `scripts/sync-nav.test.ts`.
import { test } from "node:test";
import { assert } from "#test-assert";
import { reconciledRunbook } from "./sync-mcp-curated.ts";

test("docs/mcp-runbook.md curated-tools block is in sync with app/mcpToolSurface.ts", () => {
  const { current, next } = reconciledRunbook();
  assert(
    current === next,
    "docs/mcp-runbook.md curated-tools block is STALE vs app/mcpToolSurface.ts — " +
      "run `npm run sync:mcp-curated` and commit the result.",
  );
});
