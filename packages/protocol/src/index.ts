/**
 * @block-agent/protocol — SessionProtocol v0 message catalog (TYPES ONLY).
 *
 * Design: ai_com/design/session-protocol-v0.md (D2). This module is the transport-
 * neutral wire contract: the envelope (§4.1) + the inbound/outbound discriminated
 * unions (§2), keyed by `kind`. It has ZERO runtime — it exports interfaces/unions and
 * RE-EXPORTS a few core types (TurnRecord / CacheTier / WakeEvent / RenderedPrompt /
 * AgentState) `type`-only so every consumer (the in-process + WS host in
 * @block-agent/server, and the browser web/ client) reads ONE source. The browser never
 * imports core; it imports these types only, which carry no runtime.
 *
 * House style: actors get role names, block-world nouns keep the `Block` prefix; this
 * file invents neither — it serializes existing core surfaces. Frame `kind` strings are
 * the protocol's own vocabulary (`submit`/`query`/`control`/`hello`/`thinking`/...).
 *
 * The barrel re-export below is the package's single public entry; `package.json`
 * `exports` maps `./*` → `./src/*`, so consumers `import type { ... } from
 * '@block-agent/protocol/index.js'`.
 */

// Core types we serialize 1:1 — re-exported so a consumer gets one definition. These are
// TYPE-only imports (verbatimModuleSyntax): no core VALUE crosses this boundary, so the
// package stays runtime-dependency-free and a browser bundle never pulls in a Node core
// module by importing the protocol.
import type {
  TurnRecord,
  CacheTier,
  WakeEvent,
  AgentState,
} from '@block-agent/core/core/types.js';

export type { TurnRecord, CacheTier, WakeEvent, AgentState };

// ============================================================================
// §4.1 Envelope + versioning
// ============================================================================

/** The v0 protocol version tag. Client/server reject across a major mismatch (§4.1). */
export const PROTOCOL_VERSION = '0' as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/**
 * Envelope — every frame (inbound and outbound) carries it (§4.1).
 *   - `v`          — protocol version tag (`"0"` for v0).
 *   - `seq?`       — optional per-direction monotonic sequence (ordering / replay).
 *   - `session_id?`— present ONLY when a transport multiplexes N agent instances
 *                    (supervisor envelope, §4.4); absent ⇒ single session (CLI case).
 *
 * Forward-compat rule (§4.1): ignore unknown fields, ignore unknown `kind`. A frame may
 * carry extra fields a v0 peer does not know; it tolerates them rather than rejecting.
 */
export interface Envelope {
  v: ProtocolVersion;
  seq?: number;
  session_id?: string;
}

// ============================================================================
// §2.6–2.8 + §4.2 Inbound frames (client → server)
// ============================================================================

/**
 * `submit` — user text (§2.6). The ONLY inbound frame that mutates state, and only via
 * the gated front door: the host stamps `{ invoker: 'user' }` host-side (§4.3) and routes
 * to `messages.ingest`. The wire frame NEVER carries an invoker — that is a property of
 * the authenticated session, assigned by the host (the anti-jailbreak rule, §4.3).
 */
export interface SubmitFrame extends Envelope {
  kind: 'submit';
  text: string;
}

/**
 * `query` — a read-only inspection request (§2.7). EVERY query is served by
 * `invoke_query` (the ops-dropping read twin) or a pure render — never `invoke_command`.
 * `request_id` is echoed in the response so the client can correlate.
 *
 * `target` selects the projection (§2.7):
 *   - `'context'`       → rendered prompt summary (`verbose:true` ⇒ full segment text).
 *   - `'attribution'`   → per-app reflection (`appsView`).
 *   - `'blocks'`        → per-block array (the D3 sidebar binding, opt-in §2.4).
 *   - `'block'`         → ONE block's full rendered body, lazily on card-expand (D3
 *                         §3.3/§4.2 body-on-expand). Needs `block_name`; returns
 *                         `{ name, content_hash, text }` so the client caches by hash.
 *   - `'app_preview'`   → single-app reflection (`installedApps` for one id; `app_id`).
 *   - `'turn_history'`  → the server-side ring of recent TurnRecords.
 *
 * `scope` is the D3 spelling of the context layer (`summary` | `attribution` | `blocks` |
 * `block`); it overlaps `target` for the context family and is accepted as an alias so a
 * client may send either. `verbose` requests full segment text on a `context` query.
 * `app_id` scopes an `app_preview`; `block_name` scopes a `block`.
 */
export type QueryTarget =
  | 'context'
  | 'attribution'
  | 'blocks'
  | 'block'
  | 'app_preview'
  | 'turn_history';

export type ContextScope = 'summary' | 'attribution' | 'blocks' | 'block';

export interface QueryFrame extends Envelope {
  kind: 'query';
  request_id: string;
  target: QueryTarget;
  /** D3 alias for the context-family layer; overlaps `target` (§2.4 scopes). */
  scope?: ContextScope;
  /** `context`: request full segment text (≈ `dumpFull`) rather than the cheap summary. */
  verbose?: boolean;
  /** `app_preview`: which app id to reflect. */
  app_id?: string;
  /** `block`: which block name to fetch the full rendered body for (D3 body-on-expand). */
  block_name?: string;
}

/**
 * `control` — timing/lifecycle control of the WAKE seam, NOT a policy decision (§2.8):
 *   - `'pause'`  → park incoming wakes (the `launch.ts` drain/park window).
 *   - `'resume'` → clear the gate and replay parked wakes in order.
 *   - `'drain'`  → await turns settled, then report idle (let in-flight turns finish).
 *
 * It gates the wakeHook, never PolicyEngine — pause defers WHEN a turn runs, never WHETHER
 * a command is authorized (the load-bearing §2.8 argument). The host stamps the invoker
 * for control as it does for submit (§4.3); the wire frame carries only the op.
 */
export type ControlOp = 'pause' | 'resume' | 'drain';

export interface ControlFrame extends Envelope {
  kind: 'control';
  op: ControlOp;
}

/**
 * `hello` — the client half of the handshake (§4.2). The client names itself and the
 * outbound message kinds it `understands`; it NEVER names its own invoker tier (`hello`
 * negotiates message KINDS, not permissions — the host assigns the tier from the
 * authenticated principal, §4.2/§4.3). `v` mismatch on the major version ⇒ the server
 * refuses past the handshake.
 */
export interface HelloFrame extends Envelope {
  kind: 'hello';
  client: string;
  /** The outbound kinds the client can render; the server pushes only these (§4.2). */
  understands: OutboundKind[];
}

// ── Supervisor inbound (§4.4, opt-in `supervisor` capability) ──────────────

/**
 * `session_list` (req) — enumerate the supervisor's agent instances (§4.4). A naive
 * single-session client never negotiates this and so never sends it.
 */
export interface SessionListFrame extends Envelope {
  kind: 'session_list';
  request_id: string;
}

/**
 * `attach` (req) — subscribe this transport to one instance's channels (§4.4).
 * `replay` (default 0) replays the last N buffered outbound frames before streaming new.
 */
export interface AttachFrame extends Envelope {
  kind: 'attach';
  request_id: string;
  session_id: string;
  replay?: number;
}

/** `detach` (req) — unsubscribe from a session; the instance keeps running (§4.4). */
export interface DetachFrame extends Envelope {
  kind: 'detach';
  session_id: string;
}

/**
 * InboundFrame — the discriminated union of everything a client may send, keyed by
 * `kind`. `submit` and `control` are the only side-effecting members (both through the
 * existing gated seams); `query`/`hello` and the supervisor requests are read-only.
 */
export type InboundFrame =
  | SubmitFrame
  | QueryFrame
  | ControlFrame
  | HelloFrame
  | SessionListFrame
  | AttachFrame
  | DetachFrame;

/** The set of inbound `kind` discriminants (for `accepts` negotiation + validation). */
export type InboundKind = InboundFrame['kind'];

// ============================================================================
// §2.1–2.5 + §4.2 Outbound frames (server → client) — all read-only projections
// ============================================================================

/**
 * `thinking` — one promoted block of LLM reasoning (§2.1), the `ThinkingEvent` 1:1. The
 * text is OPAQUE (INV #13): a UI-only display stream, never written to the tree, never
 * re-parsed for commands.
 */
export interface ThinkingFrame extends Envelope {
  kind: 'thinking';
  text: string;
  spawn_depth: number;
}

/**
 * `error` — a turn that failed unexpectedly (§2.2), the `RuntimeErrorEvent` MINUS its raw
 * `error` field (that carries the original thrown value and is NOT wire-safe). Only the
 * normalized message + phase + depth cross the wire.
 */
export interface ErrorFrame extends Envelope {
  kind: 'error';
  message: string;
  phase: 'send' | 'turn';
  spawn_depth: number;
}

/**
 * `turn` — the D1 `TurnRecord` 1:1 PLUS a boundary-stamped `ts` (§2.3). Core's TurnRecord
 * is clock-free (INV #1/#16); the wall-clock `ts` is added here at the protocol boundary,
 * never by core. Intersecting `TurnRecord` keeps every record field exact (snapshot_hash,
 * segment_hashes, per_tier_bytes, usage, ended_by, ...) with no drift from core.
 */
export type TurnFrame = Envelope &
  TurnRecord & {
    kind: 'turn';
    /** ISO-8601 wall-clock, stamped at the protocol boundary (NOT by core). */
    ts: string;
  };

/**
 * One rendered segment in a `context` summary (§2.4a). Mirrors the CLI's `SegmentSummary`
 * (`cli/types.ts`) — the slash-command UI consumes the same shape, just over the wire.
 */
export interface SegmentSummary {
  tier: CacheTier;
  bytes: number;
  cache_boundary: boolean;
  preview: string;
  /** Full segment text — present ONLY on a `verbose:true` context query. */
  text?: string;
}

/**
 * One per-app reflection row in a `context` attribution layer (§2.4b). Mirrors the CLI's
 * `AppSummary` join: id/version, owned block NAMES, and each command's `user_only` flag
 * (PolicyEngine still enforces it; this is annotation only).
 */
export interface AppAttribution {
  id: string;
  version: string;
  blocks: string[];
  commands: Array<{ full_name: string; user_only: boolean }>;
}

/** One available (not-yet-installed) app in the attribution layer (§2.4b). */
export interface AvailableApp {
  id: string;
  summary: string;
  default_enabled: boolean;
  requires?: string;
}

/**
 * One per-block row in a `context` blocks layer (§2.4 / §6.1) — the row-level join of
 * `summarize` + `appsView`, pivoted one row per block. This is the D3 sidebar-card
 * binding (weight bar + grow/shrink diff + per-block changed flag). Cheap host-side
 * derivation: `registry.resolve_builder` + `utf8Bytes` + `firstLinePreview` + the
 * already-computed per-segment hash.
 */
export interface BlockAttribution {
  name: string;
  app_id: string | null;
  owner: 'system' | 'plugin' | 'tool' | null;
  tier: CacheTier | null;
  bytes: number;
  content_hash: string;
  preview: string;
}

/**
 * One block's full rendered body (the `block` scope, D3 §3.3/§4.2 body-on-expand). Fetched
 * lazily when a sidebar card expands. `content_hash` is the SAME hash the `blocks` layer
 * reported for this name, so the client caches the body by hash and skips the fetch when an
 * unchanged hash recurs. `text` is the block's content text — no metadata (INV #2). `text`
 * is null when the named block has no rendered body in the current snapshot (absent/empty).
 */
export interface BlockBody {
  name: string;
  content_hash: string;
  text: string | null;
}

/**
 * `context` — a read-only context projection, sent ONLY in response to a `query` (§2.4),
 * never pushed. It carries whichever layer the query asked for; the layers are additive
 * and a single response may carry one of them. `request_id` echoes the query.
 *
 *   - `snapshot_hash` + `segments` + `segment_hashes` — the rendered-prompt summary (a).
 *   - `attribution` — the per-app reflection layer (b).
 *   - `blocks` — the per-block array (the opt-in D3 layer).
 *   - `block` — ONE block's full body (the lazy body-on-expand layer).
 *   - `app_preview` — a single-app reflection (`app_preview` target).
 */
export interface ContextFrame extends Envelope {
  kind: 'context';
  /** Echoes the `query.request_id` that asked for this projection. */
  request_id: string;
  /** Which layer this response carries (mirrors the query target/scope). */
  scope: ContextScope | 'app_preview';
  /** (a) rendered-prompt summary — present on the `context` scope. */
  snapshot_hash?: string;
  segments?: SegmentSummary[];
  segment_hashes?: Partial<Record<CacheTier, string>>;
  /** (b) per-app attribution — present on the `attribution` scope. */
  attribution?: {
    installed: AppAttribution[];
    available: AvailableApp[];
  };
  /** per-block layer — present on the `blocks` scope. */
  blocks?: BlockAttribution[];
  /** one block's full body — present on the `block` scope (lazy body-on-expand). */
  block?: BlockBody | null;
  /** single-app reflection — present on the `app_preview` scope. */
  app_preview?: AppAttribution | null;
}

/**
 * `context_diff` — a compact per-turn delta (§2.5), DERIVED server-side from two adjacent
 * `turn` frames' `segment_hashes` (zero re-render). Opt-in: a client watching `turn` can
 * compute it itself; the server offers it as a convenience for thin clients.
 */
export interface ContextDiffFrame extends Envelope {
  kind: 'context_diff';
  from_snapshot_hash: string;
  to_snapshot_hash: string;
  changed_tiers: CacheTier[];
  changed_apps: string[];
}

/**
 * `capabilities` — the server half of the handshake (§4.2). Declares which message kinds
 * it `emits` / `accepts`, the negotiated optional `features` (server-derived context_diff,
 * supervisor), and the per-session static `model` label (delivered ONCE here, never
 * per-turn — it never changes within a session, keeping TurnRecord clean).
 */
export interface CapabilitiesFrame extends Envelope {
  kind: 'capabilities';
  emits: OutboundKind[];
  accepts: InboundKind[];
  features: {
    context_diff_push: boolean;
    supervisor: boolean;
  };
  /** "<provider/model label>", e.g. the LaunchedAgent.provider_id. */
  model: string;
}

// ── Supervisor outbound (§4.4) ─────────────────────────────────────────────

/** One instance row in a `session_list` response (§4.4). */
export interface SessionInfo {
  session_id: string;
  status: AgentState['kind'];
  provider_id: string;
  model: string;
  enabled_apps: string[];
}

/** `session_list` (resp) — the supervisor's instance map (§4.4). */
export interface SessionListResultFrame extends Envelope {
  kind: 'session_list_result';
  request_id: string;
  sessions: SessionInfo[];
}

/** `attach` (resp) — ack + how many buffered frames were replayed (§4.4). */
export interface AttachResultFrame extends Envelope {
  kind: 'attach_result';
  request_id: string;
  session_id: string;
  ok: boolean;
  replayed: number;
}

/**
 * `reply` — one agent reply, pushed when `messages.reply` durably records it (the
 * MessagesApp.onReply channel — the SAME seam the CLI uses to display replies, cli-design
 * §6). This is the assistant's conversational turn; thin clients render it in the chat
 * stream. Distinct from `turn` (per-turn telemetry) and `thinking` (opaque UI-only stream).
 * Carries the just-assigned reply id, the content, and the optional `reply_to`.
 */
export interface ReplyFrame extends Envelope {
  kind: 'reply';
  id: string;
  content: string;
  reply_to?: string;
}

/**
 * OutboundFrame — the discriminated union of everything the server may send, keyed by
 * `kind`. Every member is a read-only projection: emitting one never mutates the tree or
 * runtime state.
 */
export type OutboundFrame =
  | ThinkingFrame
  | ReplyFrame
  | ErrorFrame
  | TurnFrame
  | ContextFrame
  | ContextDiffFrame
  | CapabilitiesFrame
  | SessionListResultFrame
  | AttachResultFrame;

/** The set of outbound `kind` discriminants (for `emits`/`understands` negotiation). */
export type OutboundKind = OutboundFrame['kind'];

// ============================================================================
// Wire helpers — frame kind sets (the canonical v0 negotiation surfaces)
// ============================================================================

/**
 * The kinds a v0 host emits / accepts. These back the `capabilities` handshake and the
 * receive-side validation (an unknown inbound kind is answered with a benign `error`, not
 * a closed connection — §4.1). Listed explicitly (not derived) so the negotiation surface
 * is a stable, readable constant rather than an inferred type with no runtime presence.
 */
export const V0_EMITS: readonly OutboundKind[] = [
  'thinking',
  'reply',
  'error',
  'turn',
  'context',
  'context_diff',
  'capabilities',
  'session_list_result',
  'attach_result',
];

export const V0_ACCEPTS: readonly InboundKind[] = [
  'submit',
  'query',
  'control',
  'hello',
  'session_list',
  'attach',
  'detach',
];
