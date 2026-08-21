// POST /app/api/actions/delivery-graph/dispatch → operationId `dispatchDeliveryGraph` (issue #386,
// ADR 0005 slice S5). The human-facing UI JSON-paste DISPATCH ingress: the Delivery Graphs page's
// "Dispatch" action posts the operator's pasted delivery-graph as a raw JSON STRING plus an explicit
// `approve` flag; this door parses it (`parseDeliveryGraphText`) and DELEGATES to the SAME gated,
// idempotent `startDeliveryGraph` handler the agent-facing / REST paths use. There is deliberately NO
// parallel dispatch path — this is a thin UI text adapter onto the ONE contract (S5's stated "UI
// JSON-paste" ingress that S5 named but did not build).
//
//   • APPROVAL. When the operator ticks `approve` (having reviewed the preview), the door derives the
//     graph's content digest via the SAME pure compiler `startDeliveryGraph` uses and presents it as
//     the `approvalToken`, so a side-effecting graph dispatches. Without `approve`, a side-effecting
//     graph is PARKED at approval by the start door (a 400 whose `awaiting-approval` run shows in the
//     in-flight grid) and a non-side-effecting graph dispatches straight away.
//   • The start door owns idempotency, the durable run row, and the at-most-once launch fence — this
//     adapter adds nothing to that; it only parses the paste and surfaces a human `error` banner.

import { compileDeliveryGraph } from "../app/deliveryGraphCompiler.ts";
import { parseDeliveryGraphText } from "../app/deliveryGraphText.ts";
import { deliveryGraphDigest } from "../app/deliveryRunner.ts";
import type { DeliveryGraphTextResult } from "../nano-generated/api-io.d.ts";
import { defineOperation } from "../nano-generated/operations.ts";
import startDeliveryGraph from "./startDeliveryGraph.ts";

export default defineOperation("dispatchDeliveryGraph", async (input, app) => {
  const body = input.body;
  const parsed = parseDeliveryGraphText(body);
  if (!parsed.ok) {
    app.log.warn("dispatch-delivery-graph rejected: parse", { message: parsed.error });
    return { status: 400, body: { ok: false, error: parsed.error } };
  }
  const approve = body?.approve === true;
  const idemRaw = typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  const idempotencyKey = idemRaw !== "" ? idemRaw : undefined;

  // When the operator approves, derive the graph's content digest (the approval token) via the SAME
  // pure compiler the start door uses, so a side-effecting graph they reviewed in the preview
  // dispatches. A compile failure here surfaces as a clean 400 rather than reaching the start door.
  let approvalToken: string | undefined;
  if (approve) {
    const compiled = compileDeliveryGraph(parsed.graph);
    if (!compiled.ok) {
      app.log.warn("dispatch-delivery-graph rejected: compile", { errors: compiled.errors.length });
      return {
        status: 400,
        body: {
          ok: false,
          error: `graph failed validation: ${compiled.errors.length} error(s)`,
          errors: compiled.errors,
        },
      };
    }
    approvalToken = deliveryGraphDigest(compiled.bpmn);
  }

  const startBody: Record<string, unknown> = { graph: parsed.graph };
  if (approvalToken !== undefined) startBody.approvalToken = approvalToken;
  if (idempotencyKey !== undefined) startBody.idempotencyKey = idempotencyKey;

  // Delegate to the ONE dispatch contract — the exact `startDeliveryGraph` handler, no re-implementation.
  // The parsed graph is `unknown` (the paste is runtime-validated inside the door), so the handler's
  // typed input signature is bridged here; nothing re-implements dispatch.
  // biome-ignore lint/plugin: bridging the runtime-validated paste onto the start door's typed input; the door owns validation.
  const delegate = startDeliveryGraph as (
    i: { req: unknown; params: unknown; query: unknown; body: unknown },
    a: typeof app,
  ) => Promise<{ status?: number; body?: Record<string, unknown> } | undefined>;
  const res = await delegate(
    { req: input.req, params: input.params, query: input.query, body: startBody },
    app,
  );
  const resBody: Record<string, unknown> = res?.body ?? {};
  const status = res?.status ?? 202;

  // Re-shape the start door's result onto this ingress contract by narrowing each field — no assertions.
  const outBody: DeliveryGraphTextResult = { ok: resBody.ok === true };
  if (typeof resBody.status === "string") outBody.status = resBody.status;
  if (typeof resBody.runKey === "string") outBody.runKey = resBody.runKey;
  if (typeof resBody.digest === "string") outBody.digest = resBody.digest;
  if (typeof resBody.sideEffecting === "boolean") outBody.sideEffecting = resBody.sideEffecting;
  if (typeof resBody.alreadyRunning === "boolean") outBody.alreadyRunning = resBody.alreadyRunning;
  if (typeof resBody.processInstanceKey === "string") outBody.processInstanceKey = resBody.processInstanceKey;
  if (typeof resBody.processDefinitionId === "string") outBody.processDefinitionId = resBody.processDefinitionId;
  if (typeof resBody.approvalToken === "string") outBody.approvalToken = resBody.approvalToken;
  if (typeof resBody.message === "string") outBody.message = resBody.message;

  // Surface a human error banner for the page on a refusal (parked-at-approval / validation).
  if (status >= 400 && typeof outBody.error !== "string") {
    if (typeof resBody.error === "string") outBody.error = resBody.error;
    else if (typeof resBody.message === "string") outBody.error = resBody.message;
    else if (Array.isArray(resBody.errors)) outBody.error = `graph failed validation: ${resBody.errors.length} error(s)`;
    else outBody.error = "dispatch was refused";
  }
  return { status, body: outBody };
});
