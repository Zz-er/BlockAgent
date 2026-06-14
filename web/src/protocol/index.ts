// ============================================================================
// Protocol surface for web/ — re-export the canonical types + UI-only helpers
// ============================================================================
//
// The wire contract is owned by Backend's `@block-agent/protocol` (D2,
// ai_com/design/session-protocol-v0.md). The browser imports it TYPE-only — no
// runtime, no core — so it never pulls a Node module into the bundle. This module
// is the single import point the rest of web/ uses (`../protocol`), re-exporting
// the canonical frame types and adding two tiny client-side conveniences the wire
// catalog doesn't owe us: a render-order constant and a receive-side type guard.

export type {
  // envelope + version
  Envelope,
  ProtocolVersion,
  // shared core types (re-exported by the protocol package, type-only)
  CacheTier,
  TurnRecord,
  WakeEvent,
  AgentState,
  // inbound
  InboundFrame,
  InboundKind,
  SubmitFrame,
  QueryFrame,
  QueryTarget,
  ContextScope,
  ControlFrame,
  ControlOp,
  HelloFrame,
  // outbound
  OutboundFrame,
  OutboundKind,
  ThinkingFrame,
  ReplyFrame,
  ErrorFrame,
  TurnFrame,
  ContextFrame,
  ContextDiffFrame,
  CapabilitiesFrame,
  SegmentSummary,
  AppAttribution,
  AvailableApp,
  BlockAttribution,
  BlockBody,
} from '@block-agent/protocol/index.js';

// Runtime VALUES from the protocol package (the negotiation surfaces + version).
// These are real exports with no transitive runtime cost (plain string consts).
export { PROTOCOL_VERSION, V0_EMITS, V0_ACCEPTS } from '@block-agent/protocol/index.js';

import type { CacheTier, OutboundFrame } from '@block-agent/protocol/index.js';

/**
 * Fixed sidebar render order (stable → slow_changing → volatile), mirroring the
 * Renderer's TIER_ORDER. stable first = the prompt-cache prefix on top, so prefix
 * churn is visually obvious (§4.2). UI-only; not part of the wire catalog.
 */
export const TIER_ORDER: readonly CacheTier[] = ['stable', 'slow_changing', 'volatile'];

/**
 * Receive-side guard: is this a known outbound frame? Unknown kinds are ignored,
 * not fatal (forward-compat, §4.1). Kept here (not in the protocol package) because
 * it's a client transport concern, not part of the type catalog.
 */
export function isOutboundFrame(value: unknown): value is OutboundFrame {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === 'thinking' ||
    kind === 'reply' ||
    kind === 'error' ||
    kind === 'turn' ||
    kind === 'context' ||
    kind === 'context_diff' ||
    kind === 'capabilities' ||
    kind === 'session_list_result' ||
    kind === 'attach_result'
  );
}
