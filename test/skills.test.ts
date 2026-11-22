// Shipped agent skills (skills/*/SKILL.md, issue #905). Every skill must have valid frontmatter
// whose `name` matches its directory, so agent runtimes (Copilot CLI, Claude, nano-coder) can load
// it. The HTTP-only operator skill must stay a bootstrap onto the live guide, and must keep the
// traps the guide doesn't cover: the cancel door outside /app/api, and changing a running job's
// settings through engine variables rather than cancel and resubmit (#904).
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "#test-assert";

const SKILLS = join(dirname(dirname(fileURLToPath(import.meta.url))), "skills");

function frontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  assert(m, "SKILL.md starts with a --- frontmatter block");
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-z_-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

const dirs = readdirSync(SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

test("every shipped skill has frontmatter whose name matches its directory", () => {
  assert(dirs.includes("nano-workforce") && dirs.includes("nano-workforce-http"));
  for (const dir of dirs) {
    const fm = frontmatter(readFileSync(join(SKILLS, dir, "SKILL.md"), "utf8"));
    assertEquals(fm.name, dir);
    assert(fm.description && fm.description.length > 40, `${dir} has a useful description`);
  }
});

test("the HTTP operator skill bootstraps onto the live guide and keeps the guide's gaps", () => {
  const md = readFileSync(join(SKILLS, "nano-workforce-http", "SKILL.md"), "utf8");
  assert(md.includes('"$BASE/agent"'), "fetches the live operator guide");
  assert(md.includes("--netrc-file"), "covers Basic-Auth front doors");
  assert(md.includes("x-hook-secret"), "covers the shared-secret guard");
  assert(md.includes("${BASE%/api}/actions/cancel"), "cancel door sits outside /app/api");
  assert(md.includes("/v2/element-instances/<processKey>/variables"), "changes settings in place");
  assert(!/mcp/i.test(frontmatter(md).description.replace(/no MCP|MCP gateway/gi, "")), "HTTP only");
});
