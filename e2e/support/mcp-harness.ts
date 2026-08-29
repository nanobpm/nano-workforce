// Reusable MCP end-to-end harness (epic #605 slice S1, issue #607).
//
// WHAT THIS IS
// ============
// The shared, importable module that drives the app's REAL runtime-served MCP surface (ADR 0067,
// `/app/mcp`) exactly the way a Streamable-HTTP MCP client does — `initialize` → capture the
// `Mcp-Session-Id` → `notifications/initialized` → `tools/list` → `tools/call` — against a locally
// booted, hermetic instance (`@nanobpm/urban-testkit`'s `bootTestApp`, in-process, no socket, no
// network). It exists so an object-body / serialization regression on the MCP projection layer
// (the S0 defect: a leaked `$ref` in a tool schema, or an object argument coerced to a string)
// FAILS THE BUILD from nwf's side instead of reaching an agent at runtime.
//
// It is deliberately a *module of helpers*, not a monolithic test: sibling slices S2 (#608, the
// write→read `listStagedProposals` test), S4 (#610, the `sequenceIssues` test) and S5 (#611, the
// addressable-guide test) each add THEIR OWN per-tool regression case by importing
// `bootMcpHarness` and calling `harness.callTool(...)` / `harness.listTools()`, never
// re-implementing the handshake. See "EXTENSION SEAM" below.
//
// WHY `URBAN_MCP_ALLOW_REMOTE`
// ============================
// `bootTestApp` binds the app to all interfaces (`bind: "all"`), and the MCP surface is
// loopback-only by default. The in-process router carries no real peer address, so a loopback-only
// surface refuses EVERY in-process request with a 403. `bootMcpHarness` therefore boots with
// `URBAN_MCP_ALLOW_REMOTE: "true"` so the hermetic harness can reach the surface. This flips only
// the loopback gate; the projection, validation, dispatch and session handshake under test are the
// production code paths, unchanged.
//
// EXTENSION SEAM — how to register a new per-tool case (S2 / S4 / S5)
// ===================================================================
// In your own `e2e/<slice>.e2e.ts`:
//
//   import { after, before, describe, test } from "node:test";
//   import assert from "node:assert/strict";
//   import { bootMcpHarness, type McpHarness } from "./support/mcp-harness.ts";
//
//   describe("S<n> — <your regression>", () => {
//     let h: McpHarness;
//     before(async () => { h = await bootMcpHarness(); });   // handshake already done
//     after(async () => { await h.stop(); });                 // teardown + tmpdir cleanup
//
//     test("my tool round-trips", async () => {
//       // (optional) assert the tool's projected schema is client-usable:
//       const tools = await h.listTools();
//       const mine = tools.find((t) => t.name === "myNewTool");
//       assert(mine, "myNewTool must be projected onto the MCP surface");
//       assertSchemaSelfContained(mine.inputSchema, "myNewTool"); // exported below
//
//       // drive an actual tools/call and assert the client-visible contract:
//       const res = await h.callTool("myNewTool", { body: { /* an OBJECT, never a string */ } });
//       assert(!res.isError, res.text);
//       // side-effecting? keep the harness repeatable: call with an invalid/no-op body so
//       // validation rejects it (nothing is persisted), OR clean up what you created before
//       // `after` — the harness leaves no live staged proposals behind between runs.
//     });
//   });
//
// The handshake, session management and teardown are OWNED HERE. A slice adds a `test(...)`, not a
// second transport.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";

/** The app root (repo root — a sibling of this `e2e/support/` dir). */
const APP_ROOT = resolve(import.meta.dirname, "..", "..");

/** The mount path of the runtime-served MCP endpoint (ADR 0067). */
export const MCP_PATH = "/app/mcp";

/** The Streamable-HTTP session header (MCP spec). Lower-cased — the runtime seam lower-cases
 *  response header keys. */
export const SESSION_HEADER = "mcp-session-id";

/** The exact validation-issue message the door returns when an object body arrives coerced to a
 *  string — the client-visible signature of the S0 object-body stringification defect. The harness
 *  asserts a real object body NEVER produces this, and the reintroduction guard asserts a
 *  deliberately-stringified body DOES. */
export const STRINGIFIED_BODY_MESSAGE = "expected object, got string";

/** A minimal, valid `DeliveryGraph` (a single bare `human` node — its config is optional). Compiles
 *  cleanly through `previewDeliveryGraph` (a PURE door — nothing is staged), so it is the canonical
 *  side-effect-free positive object-body payload. Exported for siblings that need a known-good graph. */
export const MINIMAL_VALID_GRAPH: Readonly<{ nodes: ReadonlyArray<Record<string, unknown>> }> = {
  nodes: [{ id: "h", kind: "human" }],
};

/** One tool as projected onto `tools/list`. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** The parsed result of a `tools/call`. `text` is the first text content block (the app operations
 *  and framework tools always answer with a single JSON text block); `json` is that block parsed
 *  when it is JSON. `isError` is the MCP tool-level error flag (a door 4xx/5xx surfaces here, not as
 *  a JSON-RPC error). `httpStatus` is the transport status of the POST itself (200 for any
 *  well-formed JSON-RPC exchange, including a tool-level error). */
export interface McpToolResult {
  isError: boolean;
  text: string;
  json: unknown;
  httpStatus: number;
  /** The raw JSON-RPC envelope, for a case that needs more than the first content block. */
  raw: unknown;
}

/** The low-level result of a single JSON-RPC POST to `/app/mcp`. */
export interface McpRpcResult {
  httpStatus: number;
  headers: Record<string, string>;
  /** The parsed JSON-RPC response body, or `undefined` for a notification (which has no response). */
  body: unknown;
}

/** The booted harness: a live MCP session against a hermetic instance, with the handshake already
 *  performed. Reusable across many `tools/call`s; call {@link McpHarness.stop} once at teardown. */
export interface McpHarness {
  /** The underlying booted app — exposed for a slice that needs to seed/inspect the app DB or drive
   *  an operator-only (`x-mcp`-excluded) cleanup route the MCP surface does not expose. */
  readonly app: TestApp;
  /** The negotiated MCP session id (the captured `Mcp-Session-Id`). */
  readonly sessionId: string;
  /** `tools/list` — the projected tool catalogue (app operations + framework debug tools). */
  listTools(): Promise<McpTool[]>;
  /** `tools/call` — invoke a tool by name with its argument object. */
  callTool(name: string, args?: Record<string, unknown>): Promise<McpToolResult>;
  /** A raw JSON-RPC request against `/app/mcp` (escape hatch for a bespoke case). `params` omitted →
   *  no `params` field; a `notifications/*` method is sent as a notification (no `id`, no response). */
  rpc(method: string, params?: unknown): Promise<McpRpcResult>;
  /** Tear down: stop the app (workers, engine, DB) and remove the temp DB dir. Idempotent. */
  stop(): Promise<void>;
}

/** Options for {@link bootMcpHarness}. */
export interface BootMcpHarnessOptions {
  /** Extra environment overlaid on the harness defaults (e.g. to enable a shared-secret guard, or a
   *  GitHub transport). Merged over the defaults; the caller wins on a key collision. */
  env?: Record<string, string>;
}

/** The MCP JSON-RPC protocol version the harness negotiates. Kept in one place so a spec bump is a
 *  one-line change every slice inherits. */
const PROTOCOL_VERSION = "2025-06-18";

/**
 * Boot a hermetic app instance and complete the MCP handshake, returning a live {@link McpHarness}.
 *
 * The handshake is the real client sequence against the real `/app/mcp` surface:
 *   1. `initialize` — negotiate the protocol; the runtime mints and returns the `Mcp-Session-Id`.
 *   2. `notifications/initialized` — the client's post-init notification, carrying the session id.
 * After this the returned harness is ready for `listTools()` / `callTool(...)`.
 */
export async function bootMcpHarness(opts: BootMcpHarnessOptions = {}): Promise<McpHarness> {
  const dbDir = mkdtempSync(join(tmpdir(), "nwf-mcp-e2e-"));
  const env: Record<string, string> = {
    NANO_APP_DB_URL: `file:${join(dbDir, "app.db")}`,
    // Hermetic: never reach GitHub. `pr` probes/connectors are not exercised by the surface harness.
    NANO_PR_GITHUB_TRANSPORT: "token",
    GITHUB_TOKEN: "",
    // See the module header: the in-process router has no real peer address, so the loopback-only
    // MCP surface must be told to answer. This flips ONLY the loopback gate.
    URBAN_MCP_ALLOW_REMOTE: "true",
    ...opts.env,
  };

  let app: TestApp;
  try {
    app = await bootTestApp(APP_ROOT, { env });
  } catch (err) {
    rmSync(dbDir, { recursive: true, force: true });
    throw err;
  }

  let idCounter = 0;
  const rpc = async (method: string, params?: unknown, sessionId?: string): Promise<McpRpcResult> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // The Streamable-HTTP transport inspects Accept; a real client offers both even when the
      // server answers JSON (the runtime sets `enableJsonResponse`).
      accept: "application/json, text/event-stream",
    };
    if (sessionId) headers[SESSION_HEADER] = sessionId;
    const isNotification = method.startsWith("notifications/");
    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    if (!isNotification) message.id = ++idCounter;

    const res = await app.ui.call({
      method: "POST",
      path: MCP_PATH,
      headers,
      body: JSON.stringify(message),
    });
    const rawBody = res.body ?? "";
    return {
      httpStatus: res.status ?? 200,
      headers: res.headers ?? {},
      body: rawBody ? JSON.parse(rawBody) : undefined,
    };
  };

  // Any step of the handshake below can throw — a JSON-parse failure inside `rpc`, a non-200
  // initialize, a missing session header, or the post-init notification. A single try/catch keeps
  // failure deterministic: whatever throws, always stop the in-process app and remove the temp DB
  // dir so a failed boot never leaks host resources into a CI run.
  const teardown = async (): Promise<void> => {
    await app.stop().catch(() => {});
    rmSync(dbDir, { recursive: true, force: true });
  };

  let sessionId: string;
  try {
    // 1. initialize — capture the runtime-minted session id.
    const initRes = await rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "nwf-mcp-e2e-harness", version: "1.0.0" },
    });
    if (initRes.httpStatus !== 200) {
      throw new Error(
        `MCP initialize failed (status ${initRes.httpStatus}): ${JSON.stringify(initRes.body)}`,
      );
    }
    const mintedId = initRes.headers[SESSION_HEADER];
    if (!mintedId) {
      throw new Error(
        `MCP initialize returned no ${SESSION_HEADER} header — headers: ${JSON.stringify(initRes.headers)}`,
      );
    }
    sessionId = mintedId;

    // 2. notifications/initialized — the client's post-init notification (no response expected).
    await rpc("notifications/initialized", undefined, sessionId);
  } catch (err) {
    await teardown();
    throw err;
  }

  let stopped = false;
  const harness: McpHarness = {
    app,
    sessionId,
    rpc: (method, params) => rpc(method, params, sessionId),
    async listTools(): Promise<McpTool[]> {
      const res = await rpc("tools/list", {}, sessionId);
      const body = res.body as { result?: { tools?: McpTool[] }; error?: unknown } | undefined;
      if (!body?.result?.tools) {
        throw new Error(`tools/list returned no result.tools: ${JSON.stringify(body)}`);
      }
      return body.result.tools;
    },
    async callTool(name, args = {}): Promise<McpToolResult> {
      const res = await rpc("tools/call", { name, arguments: args }, sessionId);
      const body = res.body as
        | { result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> }; error?: { message?: string } }
        | undefined;
      if (body?.error) {
        // A JSON-RPC-level error (e.g. an unknown tool name / protocol error) — distinct from a
        // tool-level `isError` door failure. Surface it as an errored result carrying the message.
        const text = body.error.message ?? JSON.stringify(body.error);
        return { isError: true, text, json: safeParse(text), httpStatus: res.httpStatus, raw: body };
      }
      const first = body?.result?.content?.find((c) => c.type === "text");
      const text = first?.text ?? "";
      return {
        isError: body?.result?.isError === true,
        text,
        json: safeParse(text),
        httpStatus: res.httpStatus,
        raw: body,
      };
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      try {
        await app.stop();
      } finally {
        rmSync(dbDir, { recursive: true, force: true });
      }
    },
  };
  return harness;
}

/** Parse `text` as JSON, returning `undefined` when it is not JSON (a non-JSON text block, or empty). */
function safeParse(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Deep predicate: does any node of the (already-parsed) JSON Schema carry a `$ref` key? A projected
 *  MCP tool input schema MUST be self-contained — a `$ref` is unresolvable in the MCP context and is
 *  exactly the S0 leak. */
export function schemaHasRef(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(schemaHasRef);
  if (schema && typeof schema === "object") {
    const obj = schema as Record<string, unknown>;
    if ("$ref" in obj) return true;
    return Object.values(obj).some(schemaHasRef);
  }
  return false;
}

/**
 * Assert a projected tool input schema is client-usable (the S0 contract): a top-level
 * `type: "object"`, and `$ref`-free ANYWHERE in the tree. Throws (with the tool name and the
 * offending schema) on a violation — this is the regression detector S2/S4/S5 reuse for their new
 * tools, and the guard whose teeth the reintroduction test pins.
 */
export function assertSchemaSelfContained(schema: unknown, toolName: string): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error(`tool "${toolName}": input schema must be an object, got ${JSON.stringify(schema)}`);
  }
  const obj = schema as Record<string, unknown>;
  if (obj.type !== "object") {
    throw new Error(
      `tool "${toolName}": input schema must declare an explicit \`type: "object"\` (got ${JSON.stringify(obj.type)}) — ` +
        `a client cannot encode arguments against a typeless schema (S0 / nano-ide#502).`,
    );
  }
  if (schemaHasRef(obj)) {
    throw new Error(
      `tool "${toolName}": input schema leaks a \`$ref\` — it must be self-contained (inline the ` +
        `component). A \`$ref\` is unresolvable in the MCP context and coerces object-body callers to ` +
        `stringify (S0 / nano-ide#502). Schema: ${JSON.stringify(obj)}`,
    );
  }
}

/**
 * Assert a `tools/call` result did NOT come back as the object-body stringification failure — i.e.
 * the object argument reached the door AS AN OBJECT. Throws if the result carries the
 * {@link STRINGIFIED_BODY_MESSAGE} signature. Use after any object-body `callTool`.
 */
export function assertObjectBodyAccepted(result: McpToolResult, toolName: string): void {
  if (result.text.includes(STRINGIFIED_BODY_MESSAGE)) {
    throw new Error(
      `tool "${toolName}": object argument arrived stringified — the door reported "${STRINGIFIED_BODY_MESSAGE}". ` +
        `This is the S0 object-body serialization defect (nano-ide#503). Result: ${result.text}`,
    );
  }
}

/**
 * Assert a `tools/call` result is a uniform validation failure: the door's
 * `{ error, issues: [{ path, message }] }` contract. Throws otherwise. Lets a slice drive a
 * side-effecting door with a deliberately-invalid (but object-shaped) body — proving the tool is
 * reachable AND the body arrived as an object — WITHOUT persisting anything.
 */
export function assertValidationIssues(result: McpToolResult, toolName: string): void {
  const json = result.json as { error?: unknown; issues?: Array<{ path?: unknown; message?: unknown }> } | undefined;
  if (!json || !Array.isArray(json.issues) || json.issues.length === 0) {
    throw new Error(
      `tool "${toolName}": expected a validation failure carrying issues[{path,message}], got: ${result.text}`,
    );
  }
  for (const issue of json.issues) {
    if (typeof issue.path !== "string" || typeof issue.message !== "string") {
      throw new Error(
        `tool "${toolName}": each validation issue must carry a string {path,message}; got ${JSON.stringify(issue)}`,
      );
    }
  }
  assertObjectBodyAccepted(result, toolName);
}
