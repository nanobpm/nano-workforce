// The ACP permission → nano-workforce escalation bridge (issue #559, ADR 0056 — the advisory agentic
// app-tier plane). It does NOT touch BPMN, the agent job envelope, or the worker⇄engine protocol.
//
// When an ACP-driven agent emits a permission REQUEST tagged `policy: "escalate"` on the relay lane
// (a blocked `session/request_permission`), this bridge:
//   1. raises it as an answerable row in the unified Tasks inbox (a new `ACP_PERMISSION_ELEMENT` kind,
//      via the pure `buildUserTaskRow` derivation), carrying the request's title/reason as the question;
//   2. lets a human operator answer Allow/Deny through the ONE canonical completion door
//      (`completeEscalationAsHuman`), the exact seam every other escalation uses; then
//   3. flows the answer BACK DOWN the relay as a permission RESOLUTION frame on the CONTROL lane (a
//      permission answer is high-priority control), releasing the agent's blocked request.
//
// A `yolo`-policy request NEVER reaches this path (it auto-allows elsewhere), and the whole bridge is
// OPT-IN per hire — the default (`NANO_WORKFORCE_PERMISSION_ESCALATION` off) is yolo: no user task, no
// prompt, no bridge resolution.
//
// Derivation over duplication: the core is a set of PURE functions (raise the row / build the
// resolution frame), with the side-effecting relay `send` and the completion door kept as thin edges.
// Because the cockpit-render slice exposed a `RenderDerivedTranscriptOptions.onPermissionResolve` seam,
// this module ALSO exports an adapter that produces an `onPermissionResolve` handler backed by the SAME
// pure resolution builder, so the seam and the completion door converge on one bridge. Wiring the live
// in-browser Allow/Deny of `pages/cockpit/mount.js` to this bridge is a deferred follow-up (there is no
// in-repo cockpit boot site), OUT OF SCOPE here.
import type { Frame } from "@nanobpm/agentic/protocol";
import { RELAY_FAMILY } from "@nanobpm/agentic/relay";
import type { DataLayer, EngineClient } from "@nanobpm/urban";
import { type AgentCompleteResult, completeEscalationAsHuman } from "../agentCompletion.ts";
import { readEnvOr } from "../contracts.ts";
import { ACP_PERMISSION_ELEMENT, buildUserTaskRow, type UserTaskRow } from "../userTasks.ts";
import type { RenderDerivedTranscriptOptions } from "./cockpit/transcript-derive.ts";
import { jobStream } from "./correlation.ts";
import {
  type DerivedPermission,
  encodeTranscriptEvent,
  type PermissionOptionKind,
  type PermissionResolutionEvent,
} from "./transcript-events.ts";

/** The exact `onPermissionResolve` seam the cockpit-render slice exported — consumed VERBATIM (not
 *  re-declared) so a drift in the cockpit's prop shape is a compile error here, never a silent skew. */
export type OnPermissionResolve = NonNullable<RenderDerivedTranscriptOptions["onPermissionResolve"]>;

/** Read the per-hire opt-in master switch for the permission-escalation bridge. Default OFF (yolo).
 *  Governed by the one typed env schema (`NANO_WORKFORCE_PERMISSION_ESCALATION`, `app/contracts.ts`). */
export function permissionEscalationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = readEnvOr("NANO_WORKFORCE_PERMISSION_ESCALATION", "off", env).toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/** Pure: does a permission option kind ALLOW (true) or REJECT (false) the proposed action? The option
 *  `kind` is the single source of truth (`allow-*` vs `reject-*`), mirroring the cockpit seam's own
 *  allow/deny derivation so the two paths can never disagree on what a chosen option means. */
export function optionKindAllows(kind: PermissionOptionKind): boolean {
  return kind === "allow-once" || kind === "allow-always";
}

/** Pure: whether the chosen `optionId` allows the action, derived from the REQUEST's own options.
 *  Returns false for an unknown option (fail-closed — an unrecognised answer denies). */
export function permissionOptionAllows(permission: DerivedPermission, optionId: string): boolean {
  const option = permission.options.find((o) => o.optionId === optionId);
  return option !== undefined && optionKindAllows(option.kind);
}

/** Pure: fold a permission request's `title`/`reason` (falling back to its `toolName`) into the one
 *  human-readable `question` the Tasks inbox row shows. */
export function permissionQuestion(permission: DerivedPermission): string {
  const parts: string[] = [];
  if (permission.title) parts.push(permission.title);
  if (permission.reason) parts.push(permission.reason);
  if (parts.length === 0 && permission.toolName) parts.push(`Permission requested for ${permission.toolName}`);
  return parts.join(" — ");
}

/** The denormalised context a bridged permission request needs to raise its Tasks-inbox row. */
export interface PermissionUserTaskContext {
  /** The completable key the raised row carries (the operator answers this key through the door). */
  readonly userTaskKey: string;
  /** The subject the row is keyed on (the hire / job / session the permission belongs to). */
  readonly subjectKey: string;
  readonly subjectTitle?: string | null;
  readonly subjectUrl?: string | null;
  readonly processKey?: string | null;
}

/** Pure: the Tasks-inbox row an escalate-policy permission REQUEST raises, or `null` when the bridge is
 *  disabled (opt-out default) or the policy is `yolo` (auto-allow — no user task, no prompt). The row is
 *  the `ACP_PERMISSION_ELEMENT` kind, carrying the request's title/reason as its `question`, so a bridged
 *  permission surfaces in the SAME inbox as every other escalation. */
export function permissionUserTaskRow(
  permission: DerivedPermission,
  ctx: PermissionUserTaskContext,
  opts: { enabled: boolean },
  at?: string,
): UserTaskRow | null {
  if (!opts.enabled) return null;
  if (permission.policy !== "escalate") return null;
  return buildUserTaskRow(
    {
      userTaskKey: ctx.userTaskKey,
      elementId: ACP_PERMISSION_ELEMENT,
      subjectType: "agent",
      subjectKey: ctx.subjectKey,
      subjectTitle: ctx.subjectTitle,
      subjectUrl: ctx.subjectUrl,
      question: permissionQuestion(permission),
      processKey: ctx.processKey,
    },
    at,
  );
}

/** The chosen answer to a permission request: the option id and whether it allows the action. */
export interface PermissionDecision {
  readonly callId: string;
  readonly optionId: string;
  readonly allowed: boolean;
  /** Provenance of the decision — an operator answer (default) or an auto policy. */
  readonly by?: "operator" | "auto";
}

/** A produced permission RESOLUTION: the typed event, its encoded wire chunk, and the control-lane
 *  relay frame that carries it back down to the blocked agent. */
export interface PermissionResolution {
  readonly event: PermissionResolutionEvent;
  readonly chunk: string;
  readonly frame: Frame;
}

/** Pure: the typed RESOLUTION event that releases a blocked `session/request_permission`. The `offset`
 *  is a placeholder — `encodeTranscriptEvent` strips it (the hub assigns the authoritative offset). */
export function buildPermissionResolutionEvent(decision: PermissionDecision): PermissionResolutionEvent {
  return {
    kind: "permission",
    phase: "resolution",
    offset: 0,
    callId: decision.callId,
    optionId: decision.optionId,
    allowed: decision.allowed,
    ...(decision.by !== undefined ? { by: decision.by } : {}),
  };
}

/** Options for the wire framing of a resolution — the producer generation and per-stream sequence the
 *  edge assigns. Both default to `0` so two independent callers with the same decision + stream produce
 *  byte-identical frames (the convergence the completion door and the `onPermissionResolve` seam rely on). */
export interface ResolutionFrameOptions {
  readonly seq?: number;
  readonly incarnation?: number;
}

/** Pure: encode a permission RESOLUTION into the CONTROL-lane relay frame that carries it back down to
 *  the blocked agent. The chunk speaks the one envelope grammar (`encodeTranscriptEvent`); the frame
 *  rides the control lane because a permission answer is high-priority control. This is the single
 *  builder BOTH the completion-door path and the `onPermissionResolve` adapter converge on. */
export function buildPermissionResolutionFrame(
  stream: string,
  decision: PermissionDecision,
  opts: ResolutionFrameOptions = {},
): PermissionResolution {
  const event = buildPermissionResolutionEvent(decision);
  const chunk = encodeTranscriptEvent(event);
  const frame: Frame = {
    lane: "control",
    family: RELAY_FAMILY,
    seq: opts.seq ?? 0,
    payload: { op: "produce", stream, incarnation: opts.incarnation ?? 0, chunk },
  };
  return { event, chunk, frame };
}

/** The thin side-effecting edge: emit a resolution frame down the relay to the blocked agent. */
export type RelayResolutionSend = (frame: Frame) => void;

/** The bridge's edge dependencies: the relay `send`, plus how a permission `callId` maps to the relay
 *  stream its resolution travels back down and the frame's per-stream `seq`/`incarnation`. */
export interface PermissionBridgeDeps {
  /** Emit the RESOLUTION frame down the relay (control lane). */
  readonly send: RelayResolutionSend;
  /** Resolve the relay stream a permission `callId` is answered on. Defaults to `job:<callId>` (the
   *  request's `callId` is the blocked job's key); a bridge with richer correlation supplies its own. */
  readonly streamForCallId?: (callId: string) => string;
  /** The frame `seq` for a resolution on a `callId`'s stream (default 0). */
  readonly seq?: (callId: string) => number;
  /** The producer generation stamped on the resolution frame (default 0). */
  readonly incarnation?: number;
}

function resolveStream(deps: PermissionBridgeDeps, callId: string): string {
  return deps.streamForCallId?.(callId) ?? jobStream(callId);
}

function sendResolution(deps: PermissionBridgeDeps, stream: string, decision: PermissionDecision): PermissionResolution {
  const resolution = buildPermissionResolutionFrame(stream, decision, {
    seq: deps.seq?.(decision.callId),
    incarnation: deps.incarnation,
  });
  deps.send(resolution.frame);
  return resolution;
}

/**
 * The exported adapter behind the cockpit slice's `RenderDerivedTranscriptOptions.onPermissionResolve`
 * seam. Given the bridge's relay-send dependency, returns a handler matching the seam signature verbatim
 * that emits the SAME control-lane RESOLUTION frame the completion-door path emits (both route through
 * `buildPermissionResolutionFrame`). Provided so a future cockpit boot site can plug it in — this module
 * does NOT wire it into a live boot (there is no in-repo cockpit boot site; that is a deferred follow-up).
 */
export function createOnPermissionResolve(deps: PermissionBridgeDeps): OnPermissionResolve {
  return (resolution) => {
    sendResolution(deps, resolveStream(deps, resolution.callId), {
      callId: resolution.callId,
      optionId: resolution.optionId,
      allowed: resolution.allowed,
      by: "operator",
    });
  };
}

/** What an operator supplies to answer a bridged permission escalation through the completion door. */
export interface PermissionEscalationAnswer {
  /** The request being answered (its `callId`/`options` are the source of truth for the resolution). */
  readonly permission: DerivedPermission;
  /** The completable key of the raised Tasks-inbox row. */
  readonly userTaskKey: string;
  /** The relay stream the resolution travels back down. Defaults to the deps' `streamForCallId`. */
  readonly stream?: string;
  /** The option the operator chose (Allow/Deny). `allowed` is derived from the request's option kind. */
  readonly optionId: string;
  /** The operator's audit handle. */
  readonly operatorId: string;
}

/** The result of answering a bridged permission escalation: the completion-door result plus (on
 *  success) the RESOLUTION that was sent down the relay. */
export interface PermissionEscalationResult {
  readonly completion: AgentCompleteResult;
  readonly resolution?: PermissionResolution;
}

/**
 * Answer a bridged permission escalation AS A HUMAN operator through the ONE canonical completion door
 * (`completeEscalationAsHuman`), then flow the answer back down the relay as a control-lane RESOLUTION
 * frame that releases the agent's blocked `session/request_permission`. The completion and the relay
 * `send` are the thin edges; the resolution itself is the pure `buildPermissionResolutionFrame`, so this
 * converges with the `onPermissionResolve` adapter on one bridge. When the completion door refuses the
 * task (a 404-style no-op or a failed engine completion) NO resolution is sent — the block is only
 * released when the operator's answer actually took.
 */
export async function completePermissionEscalationAsHuman(
  data: DataLayer,
  engine: EngineClient,
  deps: PermissionBridgeDeps,
  answer: PermissionEscalationAnswer,
): Promise<PermissionEscalationResult> {
  const allowed = permissionOptionAllows(answer.permission, answer.optionId);
  const completion = await completeEscalationAsHuman(data, engine, {
    userTaskKey: answer.userTaskKey,
    variables: { optionId: answer.optionId, allowed },
    operatorId: answer.operatorId,
  });
  if (!completion.ok) return { completion };
  const stream = answer.stream ?? resolveStream(deps, answer.permission.callId);
  const resolution = sendResolution(deps, stream, {
    callId: answer.permission.callId,
    optionId: answer.optionId,
    allowed,
    by: "operator",
  });
  return { completion, resolution };
}
