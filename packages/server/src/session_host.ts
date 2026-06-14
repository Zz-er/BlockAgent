/**
 * server/session_host.ts — the transport-agnostic SessionProtocol v0 host.
 *
 * Design: ai_com/design/session-protocol-v0.md (D2) + multi-terminal-and-web-inspector.md
 * (D3) §3. A `SessionHost` wraps ONE `LaunchedAgent` (from `launch(config)`) and speaks
 * the protocol; the two transports (in-process, WebSocket) are thin adapters over it.
 *
 * It does exactly what cli_channel.ts + context_view.ts already do, re-expressed as
 * protocol handlers (D3 §2.2 "behavior-preserving re-labelling"):
 *   - inbound `submit`  → the cli_channel membrane: invoke_command('messages.ingest',
 *                         {content}, {invoker:'user'}) — the host stamps the invoker
 *                         HOST-SIDE, never from the wire (D2 §4.3). Then await turns
 *                         settled so the reply has been delivered.
 *   - inbound `query`   → invoke_query / render + the context_views helpers. READ-ONLY:
 *                         never invoke_command (D2 §2.7).
 *   - inbound `control` → gate the wakeHook (pause/resume/drain) — NOT PolicyEngine
 *                         (D2 §2.8).
 *   - outbound          → subscribe runtime.onThinking/onError/onTurn → thinking/error/
 *                         turn frames; answer context/context_diff on query; hello →
 *                         capabilities.
 *
 * Read-only & invariants: the whole outbound + query surface is served by invoke_query or
 * pure render with NO per-invoker param and NO clock injection, so INV #1 holds. The only
 * write path is `submit` → messages.ingest as invoker:'user'; the host never forges
 * 'agent'/'app' and never writes the tree directly (the trust membrane, D2 §6).
 */

import type { LaunchedAgent } from '@block-agent/cli/types.js';
import { awaitTurnsSettled } from '@block-agent/cli/launch.js';
import type {
  WakeEvent,
  TurnRecord,
  CacheTier,
  RuntimeErrorEvent,
  ThinkingEvent,
  InvokerContext,
  AgentState,
} from '@block-agent/core/core/types.js';
import {
  PROTOCOL_VERSION,
  V0_EMITS,
  V0_ACCEPTS,
  type InboundFrame,
  type OutboundFrame,
  type CapabilitiesFrame,
  type ContextFrame,
  type ContextDiffFrame,
  type ErrorFrame,
  type ThinkingFrame,
  type TurnFrame,
} from '@block-agent/protocol/index.js';

import {
  contextSummary,
  contextAttribution,
  contextAppPreview,
  contextBlocks,
  contextBlock,
} from './context_views.js';

/** A sink the host pushes outbound frames into (one per connected client/subscriber). */
export type OutboundSink = (frame: OutboundFrame) => void;

/**
 * The invoker the host stamps on a connection's side-effecting frames (`submit`/`control`).
 * It is a property of the AUTHENTICATED connection, NEVER read off a wire frame (D2 §4.3,
 * the anti-jailbreak rule). A trusted local/in-process connection is `{invoker:'user'}`;
 * a remote/embedded driver is stamped non-user (`{invoker:'app', identity:'ext:<src>'}`)
 * by the transport's auth membrane. Defaulted to `{invoker:'user'}` when a transport does
 * not supply one — sound ONLY because v0 binds loopback-only (the WS transport throws on a
 * non-loopback bind without an auth hook; see ws_transport.ts).
 */
const DEFAULT_INVOKER: InvokerContext = { invoker: 'user' };

/** How many recent TurnRecords the host keeps for `turn_history` + supervisor replay. */
const TURN_RING_CAP = 64;

/**
 * SessionHost — wraps one LaunchedAgent and serves SessionProtocol v0.
 *
 * Construct it, then: subscribe a transport's outbound sink via `subscribe(sink)`, and
 * feed inbound frames through `handle(frame, sink)`. The sink passed to `handle` receives
 * the per-request responses (context/capabilities); the subscribed sinks receive the
 * broadcast stream (thinking/error/turn). A transport typically registers ONE sink and
 * passes that same sink to `handle`.
 */
export class SessionHost {
  private readonly sinks = new Set<OutboundSink>();

  /** Recent turns (newest last), for `turn_history` + supervisor replay. */
  private readonly turnRing: TurnFrame[] = [];

  /** The previous turn's per-tier hashes, to derive context_diff (D2 §2.5). */
  private prevSegmentHashes: Partial<Record<CacheTier, string>> | null = null;
  private prevSnapshotHash: string | null = null;

  // ── Control gate over the wakeHook (D2 §2.8) ──────────────────────────────
  // We interpose on registry.wakeHook: the launcher installed its serialized-tail hook;
  // we capture it and replace it with a gated wrapper. While paused, incoming wakes are
  // PARKED (not dropped, not run) and replayed through the captured hook on resume — the
  // exact drain/park pattern launch.ts uses for hot-uninstall, applied at the protocol
  // seam. This gates SCHEDULING only; it never touches PolicyEngine (authorization stays
  // 100% in the engine — pause defers WHEN a turn runs, never WHETHER a command is allowed).
  private paused = false;
  private readonly parkedWakes: WakeEvent[] = [];
  private readonly innerWakeHook: ((event: WakeEvent) => void) | undefined;

  private readonly unsubscribers: Array<() => void> = [];

  constructor(private readonly agent: LaunchedAgent) {
    // Capture the launcher's wake hook and interpose the pause gate. If no hook was set
    // (unusual), the gate degrades to a no-op forward.
    //
    // D4 CAVEATS (single-host assumption — verified correct for v0, flag before multi-attach):
    //  1. `close()` restores `registry.wakeHook = innerWakeHook`. With ONE host that is
    //     exact. If D4 stacks a 2nd SessionHost on one agent (§4.4 multi-attach), an
    //     out-of-order close would restore a STALE hook — the chain would need a stack of
    //     wrappers, not a single captured ref. The Set-backed onThinking/onError/onTurn
    //     channels fan out fine to N observers; this wakeHook capture does NOT — it is a
    //     single-writer seam, so the gate is a singleton, not a fan-out.
    //  2. Relatedly, `control` pause is a SINGLETON gate on a shared seam: "two drivers
    //     pause one agent — whose wins, does one detach un-pause it?" is a real D4 policy
    //     question, not answered here. v0 has one driver per host, so it does not arise.
    //  (Overlapping pause + hot-uninstall double-parks: my queue, then the launcher's on
    //   resume — outcome is correct, just two hops. Benign.)
    this.innerWakeHook = agent.registry.wakeHook;
    agent.registry.wakeHook = (event: WakeEvent) => {
      if (this.paused) {
        this.parkedWakes.push(event);
        return;
      }
      this.innerWakeHook?.(event);
    };

    // Bridge the runtime's three channels to the outbound broadcast stream. Stamp `ts` on
    // the turn frame HERE, at the protocol boundary — core's TurnRecord is clock-free
    // (INV #1/#16). Each subscriber is fan-out; a throwing sink never breaks the loop.
    this.unsubscribers.push(
      agent.runtime.onThinking((e: ThinkingEvent) => this.broadcast(this.toThinkingFrame(e))),
      agent.runtime.onError((e: RuntimeErrorEvent) => this.broadcast(this.toErrorFrame(e))),
      agent.runtime.onTurn((record: TurnRecord) => this.onTurnRecord(record)),
    );
  }

  // ── Subscription (transport registers its outbound sink) ──────────────────

  /** Register an outbound sink (the transport's "send to client"). Returns unsubscribe. */
  subscribe(sink: OutboundSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  /** Fan one outbound frame to every subscribed sink, isolating a throwing sink. */
  private broadcast(frame: OutboundFrame): void {
    for (const sink of this.sinks) {
      try {
        sink(frame);
      } catch {
        // A misbehaving transport must never break the runtime's emit loop.
      }
    }
  }

  // ── Inbound dispatch ──────────────────────────────────────────────────────

  /**
   * handle — dispatch ONE inbound frame. `reply` receives the per-request response
   * (capabilities/context); broadcast frames (thinking/error/turn) go to subscribed sinks.
   * Unknown / unimplemented kinds get a benign `error` frame, never a thrown/closed
   * connection (the forward-compat rule, D2 §4.1). `submit`/`control` are the only
   * side-effecting members and both go through the existing gated seams.
   *
   * `invoker` is the AUTHENTICATED connection's stamp (D2 §4.3) — supplied by the
   * transport, NEVER read off `frame`. Absent ⇒ `DEFAULT_INVOKER` (`'user'`), which a
   * transport may only rely on for a trusted local/loopback connection. The host stamps
   * THIS onto the side-effecting `submit`; it never trusts a wire-supplied invoker.
   */
  async handle(frame: InboundFrame, reply: OutboundSink, invoker: InvokerContext = DEFAULT_INVOKER): Promise<void> {
    switch (frame.kind) {
      case 'hello':
        reply(this.capabilities());
        return;
      case 'submit':
        await this.onSubmit(frame.text, invoker);
        return;
      case 'query':
        reply(await this.onQuery(frame));
        return;
      case 'control':
        await this.onControl(frame.op);
        return;
      case 'session_list':
      case 'attach':
      case 'detach':
        // Supervisor scope is not negotiated by this single-session host (capabilities
        // advertises supervisor:false). Answer benignly rather than dropping the link.
        reply(this.benignError(`unsupported in single-session host: ${frame.kind}`));
        return;
      default: {
        // Unknown kind (forward-compat): a benign diagnostic, connection stays open.
        const unknown = frame as { kind?: unknown };
        reply(this.benignError(`unknown inbound kind: ${String(unknown.kind)}`));
        return;
      }
    }
  }

  /**
   * onSubmit — the §2.6 front door. Stamp the AUTHENTICATED connection's invoker HOST-SIDE
   * (never from the wire, D2 §4.3), route to messages.ingest through the chokepoint, then
   * await turns settled so the reply has been delivered to subscribers (symmetric to
   * cli_channel.submit). The host is the trust membrane: the `invoker` it passes is the one
   * the TRANSPORT authenticated (loopback/in-process → 'user'; a remote auth membrane →
   * non-user) — the host never forges a tier and never reads one off the frame, never writes
   * the tree directly. PolicyEngine inside Operations is the only authority.
   */
  private async onSubmit(text: string, invoker: InvokerContext): Promise<void> {
    await this.agent.operations.invoke_command(
      'messages.ingest',
      { content: text },
      invoker,
    );
    await awaitTurnsSettled(this.agent.runtime);
  }

  /**
   * onQuery — serve a read-only inspection (§2.7). EVERY branch is render / registry
   * reflection / invoke_query — never invoke_command. The `scope` alias overrides `target`
   * for the context family when present. `turn_history` reads the server-side ring.
   */
  private async onQuery(frame: Extract<InboundFrame, { kind: 'query' }>): Promise<OutboundFrame> {
    const { request_id, verbose } = frame;
    // D3 spells the context layer as `scope`; D2 spells it as `target`. Honor scope first.
    const target = frame.scope ?? frame.target;
    switch (target) {
      case 'context':
      case 'summary':
        return contextSummary(this.agent, request_id, verbose === true);
      case 'attribution':
        return contextAttribution(this.agent, request_id);
      case 'blocks':
        return contextBlocks(this.agent, request_id);
      case 'block':
        return contextBlock(this.agent, request_id, frame.block_name);
      case 'app_preview':
        return contextAppPreview(this.agent, request_id, frame.app_id);
      case 'turn_history':
        // The ring is itself the answer; we return the newest turn as a convenience and
        // rely on the broadcast stream for the rest. A dedicated turn_history frame is a
        // v0.1 affordance; here we surface the latest turn (or a benign empty context).
        return this.turnRing.length > 0
          ? this.turnRing[this.turnRing.length - 1]!
          : this.emptyContext(request_id);
      default:
        return this.benignError(`unknown query target: ${String(target)}`);
    }
  }

  /**
   * onControl — gate the WAKE seam (§2.8), NOT PolicyEngine.
   *   - pause  → set the gate; subsequent wakes park.
   *   - resume → clear the gate; replay parked wakes in order through the captured hook.
   *   - drain  → await turns settled (let in-flight turns finish; start no new ones here).
   */
  private async onControl(op: 'pause' | 'resume' | 'drain'): Promise<void> {
    switch (op) {
      case 'pause':
        this.paused = true;
        return;
      case 'resume': {
        this.paused = false;
        const replay = this.parkedWakes.splice(0, this.parkedWakes.length);
        for (const event of replay) this.innerWakeHook?.(event);
        return;
      }
      case 'drain':
        await awaitTurnsSettled(this.agent.runtime);
        return;
    }
  }

  // ── Outbound frame builders ───────────────────────────────────────────────

  /**
   * onTurnRecord — fold one TurnRecord into the broadcast stream + the ring + the diff
   * derivation. Stamps the wall-clock `ts` at the boundary (core stays clock-free). Then,
   * if the previous turn's hashes are known, derive + broadcast a `context_diff` (D2 §2.5)
   * as a convenience for thin clients (opt-in clients ignore it; D3 §3.3).
   */
  private onTurnRecord(record: TurnRecord): void {
    const frame: TurnFrame = { ...record, kind: 'turn', v: PROTOCOL_VERSION, ts: new Date().toISOString() };
    this.pushRing(frame);
    this.broadcast(frame);

    const diff = this.deriveDiff(record);
    if (diff !== null) this.broadcast(diff);

    this.prevSegmentHashes = record.segment_hashes ?? {};
    this.prevSnapshotHash = record.snapshot_hash ?? null;
  }

  private pushRing(frame: TurnFrame): void {
    this.turnRing.push(frame);
    if (this.turnRing.length > TURN_RING_CAP) this.turnRing.shift();
  }

  /**
   * deriveDiff — the §2.5 server-side derivation: compare the previous turn's
   * `segment_hashes` to this turn's; the changed tiers are those whose hash entry differs
   * (including absent↔present transitions — a stable tier appearing/vanishing is a real
   * change, D3 §4.5). Zero re-render. Returns null on the first turn (no prior to diff).
   */
  private deriveDiff(record: TurnRecord): ContextDiffFrame | null {
    if (this.prevSnapshotHash === null || record.snapshot_hash === undefined) return null;
    const prev = this.prevSegmentHashes ?? {};
    const next = record.segment_hashes ?? {};
    const tiers: CacheTier[] = ['stable', 'slow_changing', 'volatile'];
    const changed_tiers = tiers.filter((t) => prev[t] !== next[t]);
    // changed_apps: best-effort attribution is left to the `context` attribution layer; a
    // tier-level diff is the lightweight per-turn signal (D3 §4.4). v0 reports tiers only.
    return {
      kind: 'context_diff',
      v: PROTOCOL_VERSION,
      from_snapshot_hash: this.prevSnapshotHash,
      to_snapshot_hash: record.snapshot_hash,
      changed_tiers,
      changed_apps: [],
    };
  }

  private toThinkingFrame(e: ThinkingEvent): ThinkingFrame {
    return { kind: 'thinking', v: PROTOCOL_VERSION, text: e.text, spawn_depth: e.spawn_depth };
  }

  /** §2.2: drop the raw `error` field (not wire-safe); serialize only the normalized message. */
  private toErrorFrame(e: RuntimeErrorEvent): ErrorFrame {
    return {
      kind: 'error',
      v: PROTOCOL_VERSION,
      message: e.message,
      phase: e.phase,
      spawn_depth: e.spawn_depth,
    };
  }

  /**
   * capabilities — the §4.2 handshake reply. Declares the kinds this host emits/accepts,
   * the negotiated optional features, and the per-session static `model` label (delivered
   * ONCE here, never per-turn). `supervisor:false` — this is a single-session host.
   */
  capabilities(): CapabilitiesFrame {
    return {
      kind: 'capabilities',
      v: PROTOCOL_VERSION,
      emits: [...V0_EMITS],
      accepts: [...V0_ACCEPTS],
      features: { context_diff_push: true, supervisor: false },
      model: this.agent.provider_id,
    };
  }

  private emptyContext(request_id: string): ContextFrame {
    return { kind: 'context', v: PROTOCOL_VERSION, request_id, scope: 'summary', segments: [] };
  }

  private benignError(message: string): ErrorFrame {
    // A protocol-level diagnostic for an unknown/unsupported inbound (§4.1): phase 'turn',
    // depth 0. Not a runtime error — the connection stays open.
    return { kind: 'error', v: PROTOCOL_VERSION, message, phase: 'turn', spawn_depth: 0 };
  }

  /**
   * close — detach the host's runtime subscriptions and restore the original wakeHook.
   * Replays any still-parked wakes so a paused-then-closed host never strands a turn. The
   * underlying LaunchedAgent is NOT torn down (the caller owns its lifecycle).
   */
  close(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.sinks.clear();
    // Restore the launcher's hook and flush anything parked. Guard the assignment so an
    // `exactOptionalPropertyTypes` build never assigns `undefined` to the optional field;
    // if the launcher set no hook, leave the optional unset.
    if (this.innerWakeHook !== undefined) {
      this.agent.registry.wakeHook = this.innerWakeHook;
    }
    this.paused = false;
    const replay = this.parkedWakes.splice(0, this.parkedWakes.length);
    for (const event of replay) this.innerWakeHook?.(event);
  }

  /** The wrapped agent (read-only access for a transport that needs provider_id, etc.). */
  get launched(): LaunchedAgent {
    return this.agent;
  }

  /**
   * health — the poll-able liveness/progress snapshot (D6 §8 seam 3). Returns the runtime's
   * `{state, wake_seq, turn_index}` for a supervisor to poll: a live turn advances
   * `turn_index`, a fresh wake bumps `wake_seq`, so `running` with a FROZEN `wake_seq` over
   * N polls is the unambiguous wedged-turn signal that push-only (onTurn) telemetry cannot
   * give (a wedged turn and an idle agent are both silent). Pure read of the runtime's
   * read-only getters — zero side effects, never renders, never enters the tree (INV #1).
   * This is the trust membrane's READ twin: it exposes no tree content, only liveness.
   *
   * WEDGE DETECTION IS `running`-ONLY (important for the platform poller). `state.kind` has
   * four values; a frozen `wake_seq` only means "wedged" when `state === 'running'`. The two
   * park states — `waiting_external` (a long off-tree builder) and `paused_for_approval` (a
   * PolicyEngine `pending` gate) — are LEGITIMATE long-lived states in which `wake_seq` stays
   * frozen by design; treating a frozen counter there as a wedge would false-positive on a
   * healthy agent waiting on an external dependency or an operator approval. So the platform
   * MUST gate its frozen-wake_seq alarm on `state === 'running'` (idle is trivially fine too).
   */
  health(): HealthSnapshot {
    return {
      state: this.agent.runtime.state.kind,
      wake_seq: this.agent.runtime.wake_seq,
      turn_index: this.agent.runtime.turn_index,
    };
  }
}

/**
 * HealthSnapshot — the poll response shape (D6 §8 seam 3). `state` is the runtime state
 * discriminant (idle/running/waiting_external/paused_for_approval); `wake_seq` + `turn_index`
 * are the monotonic progress counters. Liveness only — no tree content, no per-invoker data.
 */
export interface HealthSnapshot {
  state: AgentState['kind'];
  wake_seq: number;
  turn_index: number;
}
