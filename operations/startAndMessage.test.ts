// biome-ignore-all lint/suspicious/noExplicitAny: existing tests use intentionally partial Urban test doubles.
// biome-ignore-all lint/plugin: existing tests use framework-boundary type assertions.
// biome-ignore-all lint/suspicious/noAssignInExpressions: tests use compact in-memory store helpers.
// biome-ignore-all lint/style/noNonNullAssertion: tests assert known fixture state.
// biome-ignore-all lint/complexity/useLiteralKeys: tests use string keys to mirror persisted field names.
// biome-ignore-all lint/correctness/noUnusedFunctionParameters: test doubles preserve framework callback shapes.
// biome-ignore-all lint/correctness/noUnusedVariables: tests keep named captures for readability.
// biome-ignore-all lint/complexity/useOptionalChain: tests keep explicit assertions for fixture state.
// Tests for the start/message operation delegates (ADR 0058 OpenAPI surface).
// These cover the app-logic guards the JSON schema can't express (reference parsing, message-name
// dispatch); the runtime's schema validation (required `variables`/`name`) is exercised by urban's
// own api runtime tests.
import { assertEquals } from "jsr:@std/assert@1";
import type { AppApi } from "@nanobpm/urban";
import postMessage from "./postMessage.ts";
import startConvergenceLoop from "./startConvergenceLoop.ts";
import startPlanFanout from "./startPlanFanout.ts";

// deno-lint-ignore no-explicit-any
const app = {} as any as AppApi;

// deno-lint-ignore no-explicit-any
function input(body: any) {
	return {
		// deno-lint-ignore no-explicit-any
		req: {
			method: "POST",
			path: "/",
			query: new URLSearchParams(),
			headers: new Headers(),
			text: async () => "",
		} as any,
		params: {},
		query: {},
		body,
	};
}

Deno.test("startConvergenceLoop → 400 on an unparseable PR reference", async () => {
	const res = await startConvergenceLoop(
		input({ variables: { pr: "not a pr" } }),
		app,
	);
	// deno-lint-ignore no-explicit-any
	const r = res as any;
	assertEquals(r.status, 400);
	assertEquals(typeof r.body.error, "string");
});

Deno.test("startPlanFanout → 400 on an unparseable issue reference", async () => {
	const res = await startPlanFanout(input({ variables: { issue: "" } }), app);
	// deno-lint-ignore no-explicit-any
	const r = res as any;
	assertEquals(r.status, 400);
	assertEquals(typeof r.body.error, "string");
});

Deno.test("postMessage → 400 when name is blank", async () => {
	const res = await postMessage(input({ name: "" }), app);
	// deno-lint-ignore no-explicit-any
	const r = res as any;
	assertEquals(r.status, 400);
	assertEquals(r.body.error, "name is required");
});

Deno.test("postMessage → 400 when escalation-answered lacks a correlationKey", async () => {
	const res = await postMessage(
		input({ name: "escalation-answered", variables: { answer: "yes" } }),
		app,
	);
	// deno-lint-ignore no-explicit-any
	const r = res as any;
	assertEquals(r.status, 400);
	assertEquals(r.body.error, "correlationKey is required");
});
