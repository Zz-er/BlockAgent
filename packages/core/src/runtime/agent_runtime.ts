/**
 * runtime/agent_runtime.ts — owned by impl-runtime
 *
 * AgentRuntime is the heartbeat that drives the whole agent (§8). It is idle
 * (burning no tokens) until a WakeEvent arrives, then runs one turn: render the
 * tree → send to the provider → extract → process the response under the
 * commands-only invariant → loop until there are no more commands and no new
 * events, then return to idle.
 *
 * Authoritative design: ai_com/block-agent-architecture-v3.1.md
 *   §4.2 LLM output handling · §4.3 thoughts-never-parsed · §8.1 state machine
 *   §9.4 invoker policy (PolicyEngine lives inside Operations, not here)
 *
 * Invariants this file holds:
 *   INV #9  commands-only — agent text that fails commands-only is invalid →
 *           write an error feedback block for the next turn.
 *   INV #13 thoughts never parsed as commands — promoted thinking text is opaque;
 *           commands come ONLY from structured tool_calls (the ThinkingAdapter
 *           already split them; this file must never re-scan thoughts/raw_text).
 *   §8.1    idle burns no tokens — no event ⇒ no LLM call.
 */

import type {
  AgentState,
  Block,
  BlockName,
  CacheTier,
  CommandEvent,
  CommandListener,
  ContentPart,
  InputDescriptor,
  InputListener,
  InvokerContext,
  Operations,
  Renderer,
  RenderedPrompt,
  RuntimeErrorEvent,
  ThinkingEvent,
  ToolCallEvent,
  TurnEndReason,
  TurnRecord,
  WakeEvent,
} from '../core/types.js';
import type {
  ModelProvider,
  ProviderChunk,
  ProviderResponse,
  SendOpts,
  ToolCall,
} from '../provider/types.js';
import type {
  BuilderManifest,
  BuilderRegistry,
  BuildContext,
  CommandResult,
} from '../app/types.js';
import { combineResults, validateAgainstSchema } from '../app/contracts.js';

/**
 * ThinkingListener — a UI subscriber on the runtime's thinking channel (§4.3).
 *
 * The runtime EMITS each promoted block of reasoning to every registered listener
 * (see `AgentRuntime.onThinking`) and does NOTHING else with it: thinking is never
 * written to the BlockTree and never rendered into the next prompt, so it does not
 * survive into the agent's context. Listeners are for a UI to display the agent's
 * reasoning live. INV #13 holds throughout — the text is opaque, never scanned for
 * commands; commands come ONLY from structured tool_calls.
 */
export type ThinkingListener = (event: ThinkingEvent) => void;

/**
 * ErrorListener — a UI/caller subscriber on the runtime's error channel. The runtime
 * emits a RuntimeErrorEvent when a turn fails unexpectedly (e.g. the provider call
 * errors) and then returns to idle. Symmetric to ThinkingListener; a throwing listener
 * is isolated so it never breaks the turn loop.
 */
export type ErrorListener = (event: RuntimeErrorEvent) => void;

/**
 * TurnListener — a subscriber on the runtime's per-turn telemetry channel. The runtime
 * emits one TurnRecord per turn (symmetric to ThinkingListener / ErrorListener):
 * the wake event, the render hashes/sizes, the recaptured token usage, and the end
 * reason. Fire-and-forget; a throwing listener is isolated so it never breaks the loop.
 */
export type TurnListener = (event: TurnRecord) => void;

/** A subscriber on the runtime's tool-call channel; see `AgentRuntime.onToolCall`. */
export type ToolCallListener = (event: ToolCallEvent) => void;

/** The agent-invokable command list advertised to the provider each turn (§4.2). */
export type ToolCatalog = NonNullable<SendOpts['tools']>;

/** Construction wiring for the runtime. */
export interface AgentRuntimeOptions {
  operations: Operations;
  renderer: Renderer;
  provider: ModelProvider;
  /**
   * The App/Builder registry handle (R-5 / F1). The runtime uses it to register its
   * own bookkeeping `system` builder (`registry.registerSystemBuilder`, B1) after
   * construction, and is the seam through which it will reach `get_app_context` for
   * the consume-refresh pass (P3). Held as the `BuilderRegistry` interface so the
   * runtime stays decoupled from the concrete `AppRegistry` (core never imports the
   * registry class — only its interfaces).
   */
  registry: BuilderRegistry;
  /** sub-agent recursion depth; 0 = main agent (§8.1). */
  spawn_depth?: number;
  /** Hard cap on turns within one wake, to bound a runaway tool-call loop. */
  max_turns_per_wake?: number;
  /**
   * Idle deadline (ms) for a provider send: if the stream yields NO chunk for this
   * long (a hung/half-open socket — stalled time-to-first-token or a mid-stream stall),
   * the send is ABORTED via SendOpts.signal. The abort surfaces as a normal send failure
   * (the catch in runTurn), so the agent self-heals and stays wake-responsive instead of
   * wedging FOREVER in `running` (and then silently dropping every later wake). The timer
   * RE-ARMS on every chunk, so a long-but-streaming generation is never cut off — it
   * bounds a STALL, not total generation time. A non-positive value DISABLES the timeout
   * (e.g. for a scripted/mock provider that completes synchronously).
   */
  send_timeout_ms?: number;
  /**
   * The agent-invokable commands to advertise to the provider as `SendOpts.tools`
   * each turn (native tool dispatch, §4.2 / §11.1). For a native-tool-dispatch model
   * (Anthropic / OpenAI / DeepSeek) this is the ONLY way it learns which commands
   * exist — without it the model can only emit plain text, which fails commands-only,
   * so it can never act. Resolved fresh each turn (a thunk) so a future dynamic
   * command set is picked up. Omit for scripted providers (mock) that ignore tools.
   * The caller is responsible for excluding user-only commands (PolicyEngine would
   * deny them anyway — no point advertising them to the agent).
   */
  tool_catalog?: () => ToolCatalog;
  /**
   * The actual tree ROOT the boot built (CM-4). B1 no longer writes its bookkeeping
   * blocks into the tree itself — the boot seeds their empty placeholders via
   * `registry.seedProjectionBlocks(has, apply, parent)` and the system builders then
   * project runtime state onto them each render. Those seeded placeholders MUST attach
   * under the live tree root, or they are orphaned and never render (the bookkeeping
   * silently disappears). `registry.seedProjectionBlocks` defaults its `parent` to
   * `core:root`, which is NOT the empty-tree root (`root:root`); so the boot must pass
   * THIS value (exposed via the `root` getter) as the seed parent. Defaults to the
   * empty-tree root `root:root` (matches core/block.ts boot + fixtures + index.ts).
   */
  root_name?: BlockName;
}

/** The block name the runtime writes commands-only rejection feedback to (§4.2). */
export const COMMANDS_ONLY_FEEDBACK_BLOCK: BlockName = 'runtime:commands_only_feedback';

/** The block name the runtime writes loop/stall-guard feedback to (§8.1 stall-guard). */
export const LOOP_FEEDBACK_BLOCK: BlockName = 'runtime:loop_feedback';

/** Default root block name (matches the empty-tree boot in core/block.ts). */
const DEFAULT_ROOT_NAME: BlockName = 'root:root';

/**
 * The exact feedback text written when an agent emits disallowed plain text (§4.2).
 * Kept app-agnostic on purpose: core must not name specific app commands (the
 * available commands are advertised to the model as tools, and which apps are
 * installed varies). Earlier wording referenced `thoughts.append` (the thoughts app
 * was removed in DR-27 — reasoning now flows to the UI thinking channel) and
 * `chat.reply` (not a v3.0 app); both were stale and removed.
 */
export const COMMANDS_ONLY_FEEDBACK_TEXT =
  '你的上一条响应包含未通过 commands-only 校验的纯文本。' +
  '所有 agent 输出必须是命令调用（tool call）。' +
  '请使用提供给你的命令工具来行动或回复用户，不要直接输出纯文本。';

const DEFAULT_MAX_TURNS_PER_WAKE = 16;

/**
 * LOOP_FEEDBACK_TEXT — the exact feedback written when the stall-guard detects NO
 * PROGRESS (§8.1 stall-guard): a turn whose tool_calls were ALL exact repeats
 * (same name + same args) of commands already issued this wake. A weaker model can
 * otherwise loop the same tool_call until DEFAULT_MAX_TURNS_PER_WAKE (16) — burning
 * ~48 calls without ever replying. On the FIRST stall the runtime projects this text
 * so the agent sees it next turn and can self-correct (reply or do something
 * different); on the SECOND consecutive stall it breaks the wake. App-agnostic in
 * spirit but names `messages.reply` / `base:recent` as the canonical reply/recent
 * surfaces (mirroring agent_identity's operating constraints).
 */
export const LOOP_FEEDBACK_TEXT =
  '你这一轮重复了已经做过的动作（见 `base:recent`），没有产生新进展。' +
  '如果请求已完成，请调用回复命令（如 `messages.reply`）回复用户并结束这一轮；' +
  '否则换一个不同的动作。';

/**
 * Default idle deadline for a provider send (ms): abort if the stream goes this long
 * with no chunk. Generous enough for time-to-first-token on a reasoning model, short
 * enough to detect a hung socket before it wedges the runtime in `running` forever.
 * Re-armed per chunk, so it bounds STALLS between chunks, not total generation time.
 */
const DEFAULT_SEND_TIMEOUT_MS = 120_000;

/**
 * Abort reason for a provider send that stalled past the idle deadline. It surfaces as a
 * normal send failure in runTurn (emitError 'send' + a send_error TurnRecord + return to
 * idle), so the agent SELF-HEALS and stays wake-responsive rather than wedging forever.
 */
class ProviderSendTimeoutError extends Error {
  constructor(ms: number) {
    super(`provider send timed out after ${ms}ms with no stream activity`);
    this.name = 'ProviderSendTimeoutError';
  }
}

/**
 * Per-provider deadline for a consume-refresh pull (UH-2 §3.7). A slow/hung provider
 * (e.g. a cross-process sandboxed app whose pull degenerates to a sync RPC) must not
 * hijack the snapshot: each provider query is raced against this deadline, and a
 * timeout is treated exactly like any other provider failure — it fails the contract
 * entry, which the existing per-consumer layer-1 degrade catches (the consumer keeps
 * its previous state). 200ms matches the RPC channel's default deadline (rpc/channel).
 */
const CONSUME_PULL_DEADLINE_MS = 200;

/**
 * AgentRuntime — the §8.1 state machine + the §4.2 commands-only main loop.
 *
 * The agent itself never sees `state` directly (it is exposed to Apps via
 * AppContext, not to the LLM); this class owns the transitions.
 */
export class AgentRuntime {
  state: AgentState = { kind: 'idle' };
  spawn_depth: number;

  private readonly ops: Operations;
  private readonly renderer: Renderer;
  private readonly provider: ModelProvider;
  /** Registry handle (R-5): registerSystemBuilder for B1 + future get_app_context. */
  private readonly registry: BuilderRegistry;
  private readonly max_turns_per_wake: number;
  private readonly send_timeout_ms: number;
  private readonly root_name: BlockName;
  private readonly tool_catalog: (() => ToolCatalog) | undefined;

  /** UI subscribers on the thinking channel (§4.3). */
  private readonly thinking_listeners = new Set<ThinkingListener>();

  /** UI/caller subscribers on the error channel (failed turns). */
  private readonly error_listeners = new Set<ErrorListener>();

  /** Subscribers on the per-turn telemetry channel (one TurnRecord per turn). */
  private readonly turn_listeners = new Set<TurnListener>();

  /** UI subscribers on the tool-call channel (one event per agent command invoked). */
  private readonly tool_call_listeners = new Set<ToolCallListener>();

  /**
   * Subscribers on the command channel (actions §2.1): one CommandEvent per agent
   * command — WITH content (args + result/error). Unlike tool_call_listeners (name+ok
   * only), this feeds an out-of-core sink (the `actions` ledger) the action↔observation
   * pair. Fed ONLY from the agent lane (invokeCommand); never fires for invoker:'app'.
   */
  private readonly command_listeners = new Set<CommandListener>();

  /**
   * Subscribers on the input channel (actions §2.1): one InputDescriptor per external
   * input an app reports via `ctx.report_input`. Pure telemetry, like the others.
   */
  private readonly input_listeners = new Set<InputListener>();

  /** Monotonic wake counter; feeds the deterministic TurnRecord.turn_id (no clock). */
  private _wake_seq = 0;
  /** Turn index within the current wake; the second half of TurnRecord.turn_id. */
  private _turn_index = 0;
  /** The WakeEvent that opened the current wake loop (for TurnRecord.wake_event). */
  private current_wake_event: WakeEvent | null = null;

  /**
   * Dirty-latch for a wake that arrived WHILE the loop was already `running` (§8 seam 2).
   * A re-entrant wake is no longer DROPPED: it is parked here and fired once the loop
   * returns to idle, so an async push (e.g. an IM message landing mid-turn) is never lost.
   * COALESCED to a single pending wake on purpose — one latch is enough to guarantee the
   * agent re-renders and observes whatever the wake's source folded into the tree; we do
   * NOT queue every wake unboundedly (a burst of N IM pushes ⇒ one more loop, which sees
   * all N already-applied tree changes). The latch holds the MOST RECENT wake so the next
   * loop's TurnRecord.wake_event reflects the freshest trigger. Cleared when consumed.
   */
  private pending_wake: WakeEvent | null = null;

  /**
   * wake_seq — the monotonic wake counter (read-only). Exposed for an out-of-core liveness
   * poller (§8 seam 3): a supervisor reads `{state.kind, wake_seq, turn_index}` and treats
   * `running` with a FROZEN wake_seq over N polls as the unambiguous wedged-turn signal
   * (a live turn advances turn_index; a fresh wake bumps wake_seq). Telemetry only — never
   * enters the tree or the prompt.
   */
  get wake_seq(): number {
    return this._wake_seq;
  }

  /** turn_index — the current turn's index within the active wake (read-only; see wake_seq). */
  get turn_index(): number {
    return this._turn_index;
  }

  /**
   * Set when a turn produced commands-only-violating plain text (§4.2). The
   * commands-only feedback system builder PROJECTS this into the tree (B1): when
   * non-null the block renders the feedback text, when null it renders nothing.
   * No longer written to the tree directly (the old `upsertBookkeepingBlock` path) —
   * this state IS the source of truth and the builder is its only reader.
   */
  private pending_feedback: string | null = null;

  /**
   * Set when the stall-guard detected a no-progress turn (§8.1 stall-guard). The
   * loop-feedback system builder PROJECTS this into `runtime:loop_feedback`: non-null
   * → render the loop-feedback text, null → render nothing. Mirrors `pending_feedback`
   * exactly (B1: state is the source of truth; the builder is its only reader). It
   * persists across wakes until the next progressing turn clears it, so the nudge
   * the agent saw before a stall-break still projects on the next wake.
   */
  private pending_loop_feedback: string | null = null;

  /**
   * Per-wake set of command SIGNATURES issued so far this wake (§8.1 stall-guard).
   * A signature is `name + ' ' + stableStringify(args)` (sorted keys), so the SAME
   * command name with DIFFERENT args is a DIFFERENT signature = different work (never
   * flagged); only an EXACT (name+args) repeat counts. RESET at the start of each
   * wake — this is per-wake telemetry that never enters the rendered prompt (it only
   * drives `pending_loop_feedback`). A `Set` because membership is all we test.
   */
  private wake_signatures = new Set<string>();

  /**
   * Count of CONSECUTIVE no-progress turns this wake (§8.1 stall-guard). A turn that
   * issued tool_calls but ZERO new signatures is a stall → increment; any turn that
   * did NEW work (or replied/idled) resets it to 0. The wake loop breaks once this
   * reaches 2, bounding a runaway to ~3 turns instead of `max_turns_per_wake`. Reset
   * per wake alongside `wake_signatures`.
   */
  private stall_turns = 0;

  constructor(opts: AgentRuntimeOptions) {
    this.ops = opts.operations;
    this.renderer = opts.renderer;
    this.provider = opts.provider;
    this.registry = opts.registry;
    this.spawn_depth = opts.spawn_depth ?? 0;
    this.max_turns_per_wake = opts.max_turns_per_wake ?? DEFAULT_MAX_TURNS_PER_WAKE;
    this.send_timeout_ms = opts.send_timeout_ms ?? DEFAULT_SEND_TIMEOUT_MS;
    this.root_name = opts.root_name ?? DEFAULT_ROOT_NAME;
    this.tool_catalog = opts.tool_catalog;

    // B1 (CM-5): register the runtime's commands-only feedback system builder AFTER all
    // state fields exist (it closes over `this.pending_feedback`). It belongs to no
    // installed App, so it goes through the registry's `registerSystemBuilder` seam (F3:
    // the registry stays the single owner of builder ownership). Once registered,
    // `seedProjectionBlocks` will seed its output name and the Renderer projects live
    // runtime state each turn — no runtime block is ever written to the tree directly.
    // (The command-error builder was removed: command failures now flow out the
    // `onCommand` channel to the `actions` ledger, not into a runtime block — actions §2.4.)
    this.registry.registerSystemBuilder(this.makeFeedbackBuilder());
    // Stall-guard (§8.1): the loop-feedback system builder projects
    // `pending_loop_feedback` into `runtime:loop_feedback`. Same shape/ownership as
    // the commands-only feedback builder — pure, volatile, owner='system'.
    this.registry.registerSystemBuilder(this.makeLoopFeedbackBuilder());
  }

  /**
   * The live tree root the runtime's bookkeeping placeholders must be seeded under
   * (CM-4). The boot reads this to pass as `seedProjectionBlocks`' `parent`, instead
   * of relying on that method's `core:root` default which does not match the
   * empty-tree root. Exposing it keeps the authoritative root in ONE place (the
   * runtime), so the seed parent can never silently drift from the real root.
   */
  get root(): BlockName {
    return this.root_name;
  }

  /**
   * onThinking — subscribe a UI to the thinking channel (§4.3). The returned thunk
   * unsubscribes. Each promoted block of reasoning is delivered as a ThinkingEvent;
   * the runtime never writes thinking to the tree or into the next prompt, so this
   * is the ONLY way a UI sees it. Listeners must not block (fire-and-forget); a
   * throwing listener is isolated so it never breaks the turn loop.
   */
  onThinking(listener: ThinkingListener): () => void {
    this.thinking_listeners.add(listener);
    return () => this.thinking_listeners.delete(listener);
  }

  /**
   * onError — subscribe to the runtime's error channel. Emits a RuntimeErrorEvent
   * whenever a turn fails unexpectedly (most commonly the provider call erroring); the
   * runtime then returns to idle rather than silently no-op'ing or crashing. The
   * returned thunk unsubscribes. Symmetric to onThinking. A throwing listener is
   * isolated (fire-and-forget) so it never breaks the turn loop.
   */
  onError(listener: ErrorListener): () => void {
    this.error_listeners.add(listener);
    return () => this.error_listeners.delete(listener);
  }

  /**
   * onTurn — subscribe to the per-turn telemetry channel. The returned thunk
   * unsubscribes. One TurnRecord is emitted per turn (symmetric to onThinking/onError),
   * carrying the wake event, the render hashes/sizes, the recaptured token usage, and
   * the end reason. The record is clock-free and never enters the tree or the next
   * prompt — it is the seam an out-of-core subscriber (e.g. a turn_log ledger, a budget
   * governor, a context inspector) reads, without any new tree churn.
   */
  onTurn(listener: TurnListener): () => void {
    this.turn_listeners.add(listener);
    return () => this.turn_listeners.delete(listener);
  }

  /**
   * onToolCall — subscribe to the tool-call channel: one ToolCallEvent per structured
   * tool_call the agent invokes this turn (the command name + whether it succeeded). A UI
   * groups these under the in-flight agent turn. Symmetric to onThinking; the returned
   * thunk unsubscribes. Telemetry only — never the command args, never the tree.
   */
  onToolCall(listener: ToolCallListener): () => void {
    this.tool_call_listeners.add(listener);
    return () => this.tool_call_listeners.delete(listener);
  }

  /**
   * onCommand — subscribe to the command channel: one CommandEvent per agent command run
   * this turn, WITH content (full args + result on success / error on failure). The seam an
   * out-of-core sink (the `actions` ledger) reads to record the action↔observation pair the
   * agent never otherwise sees. Symmetric to onToolCall; the returned thunk unsubscribes.
   *
   * Fires ONLY in the agent lane (invokeCommand) — user/app commands reach the tree via
   * Operations.invoke_command directly and never surface here, so `base.record`
   * (invoker:'app') produces zero CommandEvents (no recursion). INV #13: it feeds an
   * app-side sink, never the prompt.
   */
  onCommand(listener: CommandListener): () => void {
    this.command_listeners.add(listener);
    return () => this.command_listeners.delete(listener);
  }

  /**
   * onInput — subscribe to the input channel: one InputDescriptor per external input an app
   * reports via `ctx.report_input`. The boot connects this to `base.record(kind:'input')`.
   * Pure telemetry, symmetric to onToolCall; the returned thunk unsubscribes.
   */
  onInput(listener: InputListener): () => void {
    this.input_listeners.add(listener);
    return () => this.input_listeners.delete(listener);
  }

  /**
   * on_wake — the only entry that moves the runtime out of idle (§8.1).
   *
   * Drives turns until a turn produces no commands (the agent is done responding)
   * and no new event was generated. While running we keep looping because each
   * turn's commands mutate the tree, and the agent gets to see the result next
   * turn (e.g. a tool_result block, or the commands-only feedback block).
   */
  async on_wake(event: WakeEvent): Promise<void> {
    // idle is the only state from which a fresh wake starts a turn loop. If we are
    // parked (waiting_external / paused_for_approval) a wake is the resumption
    // signal for that park; we fall through into the loop either way, but never
    // start a second concurrent loop.
    if (this.state.kind === 'running') {
      // Already mid-loop. A re-entrant wake (e.g. an async IM push landing during a
      // turn) must NOT be dropped — that would let the agent miss the trigger and never
      // re-render (§8 seam 2). PARK it in the dirty-latch instead; the loop fires it on
      // return-to-idle below. Coalesced: the most-recent wake wins (one extra loop sees
      // every already-applied tree change), so a burst can never queue unboundedly.
      this.pending_wake = event;
      return;
    }

    this.state = { kind: 'running', current_event: event };
    this.current_wake_event = event;
    this._wake_seq += 1;
    this._turn_index = 0;
    // Stall-guard per-wake state (§8.1): a fresh signature set + zeroed stall counter.
    // Per-wake, NOT global — distinct work across separate wakes is never conflated.
    // (pending_loop_feedback is NOT reset here: it persists until the next progressing
    // turn clears it, so a stall-break still projects its nudge on the next wake.)
    this.wake_signatures = new Set<string>();
    this.stall_turns = 0;

    try {
      let turns = 0;
      // Loop: each turn renders the current tree and processes the response.
      // We stop when a turn neither invoked a command nor queued feedback —
      // i.e. the agent had nothing more to do.
      for (;;) {
        if (turns >= this.max_turns_per_wake) break;
        turns += 1;
        this._turn_index = turns;

        let progressed: boolean;
        try {
          progressed = await this.runTurn();
        } catch (err) {
          // Safety net for an unexpected turn failure OUTSIDE the send path (which
          // runTurn already catches and reports as phase 'send'). Surface it and end
          // the wake gracefully so a failed turn never crashes the process or wedges
          // the runtime in 'running'.
          this.emitError(err, 'turn');
          this.emitTurn(this.turnEnvelope('turn_error'));
          break;
        }

        // If the turn parked the runtime (approval pending), stop the loop here;
        // resumption happens via a later on_wake once the approval resolves.
        // (read via stateKind() so TS does not narrow away the mutation runTurn
        // performed — `this.state` was 'running' on entry but runTurn may park.)
        if (this.stateKind() === 'paused_for_approval') return;

        // Stall-guard (§8.1): a THIRD early-exit, alongside max_turns (:429) and
        // !progressed below. runTurn set `stall_turns` per turn (incremented on a
        // no-progress turn, reset on any new work / reply / idle). On the 1st stall it
        // already projected the loop-feedback nudge; on the 2nd CONSECUTIVE stall we
        // break the wake (the agent ignored the nudge), bounding a runaway to ~3 turns
        // instead of max_turns. The loop feedback persists and projects next wake.
        if (this.stall_turns >= 2) break;

        if (!progressed) break;
      }
    } finally {
      // Only return to idle if we did not park. (A park already set state and
      // returned above; this guard keeps a parked state intact.)
      if (this.stateKind() === 'running') {
        this.state = { kind: 'idle' };
      }
    }

    // RE-LATCH (§8 seam 2): a wake that arrived while we were `running` was parked, not
    // dropped. Now that we are back at idle, FIRE it so the agent observes the trigger it
    // would otherwise have missed. We consume the latch BEFORE re-entering (so a wake that
    // arrives during THIS re-run re-latches afresh, not into the value we are draining),
    // and only re-enter from a clean idle — a park above already returned, so this is
    // unreachable while parked. Recursion depth is bounded: each re-run can leave at most
    // one new pending wake (coalesced), and it only fires while idle, so this is a tail
    // drain of at most the wakes that genuinely overlapped running turns, not a busy loop.
    if (this.stateKind() === 'idle' && this.pending_wake !== null) {
      const next = this.pending_wake;
      this.pending_wake = null;
      await this.on_wake(next);
    }
  }

  /**
   * runTurn — one render→send→extract→process cycle.
   *
   * Returns true if the turn "progressed" (invoked ≥1 command or wrote feedback),
   * meaning another turn is warranted; false if the agent produced no commands and
   * no feedback (it is done).
   */
  private async runTurn(): Promise<boolean> {
    // 0) Consume-refresh (§3.5 / R-4): BEFORE the snapshot, pull each consumer App's
    //    declared contracts from their providers and fold the merged result into the
    //    consumer's state[as]. It runs OUTSIDE the builder sandbox and BEFORE the
    //    snapshot, so builders stay pure and rendering stays byte-identical (INV #1):
    //    the only state it touches is App state via set_state, and it never writes the
    //    tree (it pulls via Operations.invoke_query, which drops ops). The method holds
    //    the three-layer guardrail (R-4/CM-2) and never throws, so it cannot crash the
    //    turn even if a provider/validate/set_state misbehaves.
    await this.consumeRefresh();

    // 1) Render the current snapshot into a prompt (§10). Byte-identical for a
    //    given (snapshot, tiers) — the runtime relies on Operations.snapshot()
    //    being a frozen COW capture (INV #1).
    const snapshot = this.ops.snapshot();
    const prompt = await this.renderer.render(snapshot);
    // Telemetry copied straight off the render OUTPUT (no re-hash, no re-render) for
    // this turn's TurnRecord. Captured here so even a failed send still reports the
    // prompt it tried to send (INV #1 untouched — this reads render output).
    const telemetry = this.turnTelemetry(prompt);

    // 2) Send to the provider and accumulate the stream into one response. We
    //    advertise the agent-invokable command catalog as SendOpts.tools so a
    //    native-tool-dispatch model can actually emit tool_calls (commands); without
    //    it the model only ever produces plain text → commands-only rejection (§4.2).
    //    A provider/transport failure (endpoint 4xx/5xx, network drop, unparseable
    //    stream) is NOT a command refusal — it aborts the whole turn. We surface it on
    //    the error channel and end the turn (no progress) instead of throwing, so the
    //    caller who submitted a message gets a failure signal rather than silence.
    //    A hung/half-open stream (no bytes, no FIN) would otherwise block HERE forever,
    //    pinning the runtime in `running` and silently dropping every later wake. We arm
    //    an idle deadline that ABORTS the send (via SendOpts.signal) after send_timeout_ms
    //    of no chunk; the abort surfaces as a send failure below, so the agent self-heals.
    //    The timer re-arms on every chunk (collect's onChunk), so only a STALL aborts.
    let response: ProviderResponse;
    const sendAbort = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdle =
      this.send_timeout_ms > 0
        ? (): void => {
            if (idleTimer !== null) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
              sendAbort.abort(new ProviderSendTimeoutError(this.send_timeout_ms));
            }, this.send_timeout_ms);
          }
        : null;
    try {
      armIdle?.(); // covers time-to-first-token
      response = await this.collect(
        this.provider.send(prompt, this.buildSendOpts(sendAbort.signal)),
        armIdle,
      );
    } catch (err) {
      this.emitError(err, 'send');
      this.emitTurn({ ...this.turnEnvelope('send_error'), ...telemetry });
      return false;
    } finally {
      if (idleTimer !== null) clearTimeout(idleTimer);
    }

    // 3) Extract via the provider's thinking adapter. This is the seam that
    //    enforces INV #13: tool_calls are commands; thoughts/raw_text are NOT.
    const { thoughts, tool_calls, raw_text } =
      this.provider.thinking_adapter.extract(response);

    // Stall-guard signature tracking (§8.1): count how many of this turn's tool_calls
    // are NEW (a (name+args) signature not yet seen this wake), then record them all.
    // A turn that issued ONLY repeats (tool_calls.length > 0 && newCount === 0) made NO
    // progress. The SAME name with DIFFERENT args has a DIFFERENT signature → counts as
    // new → never false-flagged as a stall. Computed here (after extract, before
    // dispatch) so it sees the full call set even if dispatch parks midway.
    let newCount = 0;
    for (const call of tool_calls) {
      const sig = commandSignature(call.name, call.args);
      if (!this.wake_signatures.has(sig)) {
        newCount += 1;
        this.wake_signatures.add(sig);
      }
    }

    let progressed = false;

    // 4a) thinking → UI thinking channel (§4.3). The text is OPAQUE: we EMIT it to
    //     subscribers and do nothing else — never write it to the tree, never feed
    //     it into the next prompt, never parse it for commands.
    this.emitThoughts(thoughts);

    // 4b) tool_use (commands) → invoke_command one by one (§4.2). PolicyEngine
    //     runs inside Operations.invoke_command; a `pending` decision parks the
    //     runtime (paused_for_approval) and aborts the rest of this turn.
    // Recaptured token usage (computed in collect() at :809/:822-829, previously
    // dropped on the floor). Spread into the TurnRecord; absent when the provider
    // reported none (preserves exactOptionalPropertyTypes).
    const usage = response.usage ? { usage: response.usage } : {};

    const { parked, end_turn, yielded } = await this.handleToolCalls(tool_calls);
    if (tool_calls.length > 0) progressed = true;
    if (parked) {
      this.emitTurn({ ...this.turnEnvelope('parked'), ...telemetry, ...usage });
      return true; // parked → caller stops the loop; resumed via on_wake.
    }
    // The agent finished responding (a command set end_turn): stop the loop and return to
    // idle to await the next event, instead of running another turn and re-replying.
    // Multi-step tool use (no end_turn) keeps looping as before. ended_by distinguishes a
    // spoken reply ('reply') from a silent yield ('yield', e.g. base.end_turn). Neither is
    // a stall — reset the counter + clear any pending nudge (the wake ends here anyway).
    if (end_turn) {
      this.stall_turns = 0;
      this.pending_loop_feedback = null;
      this.emitTurn({ ...this.turnEnvelope(yielded ? 'yield' : 'reply'), ...telemetry, ...usage });
      return false;
    }

    // Stall-guard verdict (§8.1): this turn made NO progress iff it issued tool_calls
    // that were ALL exact repeats (newCount === 0). On the 1st stall, nudge (project the
    // loop-feedback so the agent self-corrects next turn) but keep going. On any turn
    // that did NEW work — or replied/idled (no tool_calls) — reset the counter. The wake
    // loop reads `stall_turns >= 2` after this returns and breaks (the 2nd consecutive
    // stall). Parked already returned above, so a parked turn is never a stall.
    if (tool_calls.length > 0 && newCount === 0) {
      this.stall_turns += 1;
      if (this.stall_turns === 1) this.pending_loop_feedback = LOOP_FEEDBACK_TEXT;
    } else {
      // Progress (new work) or a no-op turn → not stalling. Clear the nudge so a stale
      // loop-feedback block never lingers once the agent is making progress again.
      this.stall_turns = 0;
      this.pending_loop_feedback = null;
    }

    // 4c) plain text (not in thinking, not a tool_use) → commands-only REJECTION
    //     (§4.2). Write the feedback block; the agent self-corrects next turn.
    const disallowed = this.hasDisallowedText(raw_text);
    if (disallowed) {
      await this.writeCommandsOnlyFeedback();
      progressed = true;
    }

    // One TurnRecord per turn. ended_by reports the strongest signal: disallowed_text
    // (what drives the next turn) > tool_calls > idle. (parked/reply already returned.)
    const ended_by: TurnEndReason = disallowed
      ? 'disallowed_text'
      : tool_calls.length > 0
        ? 'tool_calls'
        : 'idle';
    this.emitTurn({ ...this.turnEnvelope(ended_by), ...telemetry, ...usage });
    return progressed;
  }

  /**
   * consumeRefresh — the render-time consume-refresh lifecycle point (§3.5, R-4).
   *
   * BEFORE each turn's snapshot, for every installed consumer App C (those that
   * declare `consumes`), pull each declared contract from its providers and fold the
   * merged result into C's `state[as]`. Mechanically:
   *   for each C in registry.consumers():
   *     for each {contract, as} in C.consumes:
   *       def       = registry.resolve_contract(contract)        // output_schema/combine
   *       providers = registry.providers_of(contract)            // [{app_id, via}]
   *       datas     = providers.map(p => ops.invoke_query(`${p.app_id}.${p.via}`, {},
   *                                       {invoker:'app', identity:C.app_id}).data)  // CM-9
   *                   each `data` validated against def.output_schema (R-2)
   *       collect[as] = combineResults(datas, def.combine)        // sum / list / first
   *     registry.get_app_context(C).set_state(s => ({...s, ...collect}))
   *
   * THREE-LAYER GUARDRAIL (R-4 / CM-2 — the red-team BLOCKER's resolution). The pull
   * crosses an App boundary, validates untrusted data, and writes App state whose
   * `set_state` UNLOADS the App on a schema breach; none of that may corrupt a
   * consumer's state or crash the turn:
   *   1. PER-ENTRY try/catch — each `{contract, as}` is computed in isolation
   *      (invoke_query / validate / combineResults each may fail or throw); the first
   *      failure marks the WHOLE consumer degraded and stops computing its entries.
   *   2. PER-CONSUMER ATOMIC (all-or-nothing) — `collect` is assembled fully BEFORE any
   *      write; if any entry failed, the consumer is left at its PREVIOUS state (no
   *      set_state at all), never half-new/half-old (CM-2 — no mixed snapshot).
   *   3. ONE set_state per consumer, itself guarded — a merged value that breaches the
   *      `as` field's state_schema throws AppStateViolation (which would unload the
   *      App); we catch it so a bad merge degrades that consumer instead of unloading it.
   *   4. THE WHOLE METHOD is wrapped in try/catch — nothing bubbles out of
   *      consumeRefresh, so a refresh fault can never crash the turn (it runs before
   *      the snapshot; an uncaught throw here would abort `runTurn`).
   *
   * Seam-optional (additive): the registry's consume-refresh accessors and
   * Operations.invoke_query are OPTIONAL on their interfaces, so a contract-less wiring
   * (e.g. a test double, or a boot with no consumers) makes this a clean no-op. It
   * touches NO tree (invoke_query drops ops) and NO builder, so INV #1 / the builder
   * sandbox are intact.
   */
  private async consumeRefresh(): Promise<void> {
    try {
      const consumers = this.registry.consumers?.();
      if (!consumers || consumers.length === 0) return; // no consumers ⇒ no-op

      // Refresh all consumers IN PARALLEL (§3.7). Each consumer writes its OWN cell and
      // is fully isolated (its own try/catch below), so concurrency is safe — and we
      // still `await` the whole batch so EVERY set_state lands BEFORE the snapshot (the
      // "before snapshot" guarantee R-4; a non-awaited batch would render stale state).
      // `Promise.all` over a `.catch`-guarded map means one consumer's failure neither
      // aborts the batch nor escapes here. No cross-consumer ordering dependency exists
      // (distinct cells), so parallelizing does not affect determinism.
      await Promise.all(
        consumers.map((consumer) =>
          this.refreshOneConsumer(consumer).catch(() => {
            /* isolate a single consumer's failure */
          }),
        ),
      );
    } catch {
      // Layer 4: NOTHING bubbles out of consume-refresh. It runs before the snapshot,
      // so an uncaught throw here would abort the whole turn — which is exactly the
      // crash R-4 forbids. Swallow it; the turn proceeds with last-good consumer state.
    }
  }

  /**
   * refreshOneConsumer — compute + commit the consume-refresh for ONE consumer App,
   * with the per-entry (layer 1) and per-consumer-atomic (layer 2) + guarded-set_state
   * (layer 3) guardrails. Split out of `consumeRefresh` so the control flow of "abandon
   * this consumer on the first failed entry" is a single early-`return` rather than
   * nested flags. Synchronous wrt. its own structure but `await`s each provider pull.
   */
  private async refreshOneConsumer(consumer: {
    app_id: string;
    consumes: { contract: string; as: string }[];
  }): Promise<void> {
    const ctx = this.registry.get_app_context?.(consumer.app_id);
    if (!ctx) return; // App gone / no context seam ⇒ skip (no-op for this consumer)

    // Assemble the full set of merged values BEFORE writing anything (layer 2).
    const collect: Record<string, unknown> = {};
    for (const { contract, as } of consumer.consumes) {
      let merged: unknown;
      try {
        merged = await this.pullContract(contract, consumer.app_id);
      } catch {
        // Layer 1: this entry failed (resolve / pull / validate / combine). The whole
        // consumer degrades to its previous state — abandon WITHOUT any set_state.
        return;
      }
      collect[as] = merged;
    }

    // Layer 3: ONE set_state for the whole consumer, guarded. A merged value that
    // breaches the `as` field's state_schema throws AppStateViolation (which would
    // UNLOAD the App); we catch it so the consumer simply keeps its previous state.
    try {
      ctx.set_state((s) => ({ ...(s as Record<string, unknown>), ...collect }));
    } catch {
      /* schema breach (or any set_state fault) ⇒ keep previous state, do not unload */
    }
  }

  /**
   * pullContract — resolve ONE contract to its merged value for a consumer (§3.5).
   * Resolves the ContractDef (for `output_schema` + `combine`), enumerates providers,
   * pulls each via the READ-ONLY `Operations.invoke_query` under `invoker:'app'` tagged
   * with the consumer's identity (CM-9), validates each provider's `data` against the
   * contract's `output_schema` (R-2), then folds the validated outputs with
   * `combineResults`. THROWS on any failure (unresolved contract, a failed/denied
   * query, a schema-invalid datum, an empty `first`/`sum` misuse) — the caller's
   * per-entry try/catch (layer 1) turns that into a graceful consumer degrade.
   */
  private async pullContract(contract: string, consumer_app_id: string): Promise<unknown> {
    const def = this.registry.resolve_contract?.(contract);
    if (!def) throw new Error(`consume-refresh: contract '${contract}' is not registered`);

    const providers = this.registry.providers_of?.(contract) ?? [];
    const invoker: InvokerContext = { invoker: 'app', identity: consumer_app_id };

    // invoke_query is OPTIONAL on the Operations interface; absence ⇒ no pull path.
    if (!this.ops.invoke_query) {
      throw new Error('consume-refresh: Operations.invoke_query is unavailable');
    }
    const invoke_query = this.ops.invoke_query.bind(this.ops);

    // Pull every provider IN PARALLEL with a per-provider deadline (§3.7): a slow/hung
    // provider can no longer serialize the wait or hijack the snapshot. A timeout, a
    // failed query, or a schema-invalid datum each REJECT this provider's promise →
    // `Promise.all` rejects → the caller's layer-1 catch degrades the WHOLE consumer to
    // its previous state (preserving the per-consumer-atomic R-4 guarantee for timeouts
    // exactly as for data errors — no half-new partial combine).
    //
    // DETERMINISM (§3.7 / INV #1): `Promise.all` resolves to results in INPUT order, and
    // `providers` is in `deriveContractTable`'s manifest-stable order, so `datas` folds
    // through `combineResults` (position-based) byte-identically regardless of which
    // pull returned first. We MUST NOT collect by arrival order (no `Promise.race` /
    // push-on-resolve) — that would break byte-determinism.
    //
    // PULL-FROM-CACHE (UH-2 §3.6) — IRON RULE: the consume/render path NEVER forks or RPCs
    // into a child process. `pull_cached_contract` returns the per-provider verdict:
    //   - 'route'   → IN-PROCESS provider: the normal read-only `invoke_query` (synchronous
    //                 against the live cell, no RPC — zero regression). This is the ONLY
    //                 mode that ever touches `invoke_query`/`route`.
    //   - 'cell'    → CHILD-PROCESS provider with a present declared cache slot: use that
    //                 SYNCHRONOUSLY-read core-side value (the child pushed it via set_state
    //                 while active for its own reasons; no fork/activate/RPC here, INV #1).
    //   - 'degrade' → CHILD-PROCESS provider with no usable cached value (undeclared, or the
    //                 child never activated so the slot is still undefined): we THROW — never
    //                 route a child (that would be a forbidden sync cross-process RPC). The
    //                 throw degrades the WHOLE consumer to last-good (per-consumer-atomic,
    //                 SS4d). A sandboxed provider reporting stale/default until it first
    //                 activates (for its own reasons) and pushes is acceptable (§3.6).
    // Absent seam (contract-less double) ⇒ treated as 'route' (prior behavior).
    const pullCached = this.registry.pull_cached_contract?.bind(this.registry);
    const datas = await Promise.all(
      providers.map(async (provider) => {
        const full_name = `${provider.app_id}.${provider.via}`;
        const verdict = pullCached?.(provider.app_id, contract) ?? { mode: 'route' as const };
        let res: CommandResult;
        if (verdict.mode === 'cell') {
          res = { ok: true, data: verdict.value }; // §3.6 sync cell read, no RPC/activate
        } else if (verdict.mode === 'degrade') {
          // Child provider with no usable cache → degrade the consumer (last-good). NEVER
          // route a child on the render path (no sync fork/RPC — the iron rule).
          throw new Error(
            `consume-refresh: child-process provider '${full_name}' has no cached value ` +
              `for '${contract}' (not yet pushed) — degrading consumer to last-good (§3.6)`,
          );
        } else {
          // 'route': in-process provider — the normal synchronous read-only query (no RPC),
          // still wrapped in the §3.7 per-provider deadline as defense-in-depth.
          res = await withTimeout(
            invoke_query(full_name, {}, invoker),
            CONSUME_PULL_DEADLINE_MS,
            `consume-refresh: query '${full_name}' exceeded ${CONSUME_PULL_DEADLINE_MS}ms`,
          );
        }
        if (!res.ok) {
          throw new Error(
            `consume-refresh: query '${full_name}' failed: ${res.error ?? 'unknown error'}`,
          );
        }
        // Validate against the contract output_schema the SAME way a queried value is (R-2)
        // — a stale/garbage cell value cannot bypass the contract.
        const check = validateAgainstSchema(res.data, def.output_schema);
        if (!check.ok) {
          throw new Error(
            `consume-refresh: '${full_name}' data violates contract '${contract}': ${check.error}`,
          );
        }
        return res.data;
      }),
    );

    // combineResults throws on misuse (non-number sum, empty first); that surfaces as
    // this contract entry failing → the consumer degrades (layer 1).
    return combineResults(datas, def.combine);
  }

  /**
   * emitThoughts — publish promoted thinking text to the UI channel (§4.3).
   *
   * SECURITY: the text is opaque. It is emitted to subscribers and NOTHING else —
   * never written to the BlockTree, never rendered into the next prompt, never fed
   * to any command parser. The ThinkingAdapter already separated it from
   * `tool_calls`; this method must not undo that separation (INV #13). It also does
   * not affect turn progress: thinking alone never keeps the loop spinning.
   */
  private emitThoughts(thoughts: string[]): void {
    if (thoughts.length === 0 || this.thinking_listeners.size === 0) return;
    for (const text of thoughts) {
      const event: ThinkingEvent = { text, spawn_depth: this.spawn_depth };
      for (const listener of this.thinking_listeners) {
        try {
          listener(event);
        } catch {
          // A faulty UI subscriber never breaks the turn loop (fire-and-forget).
        }
      }
    }
  }

  /**
   * emitToolCall — publish one invoked tool_call (name + ok) to the tool-call channel.
   * Fire-and-forget + listener-isolated like emitThoughts; never carries the args (INV #13
   * spirit: telemetry, not content). No-op when nobody is subscribed.
   */
  private emitToolCall(name: string, ok: boolean): void {
    if (this.tool_call_listeners.size === 0) return;
    const event: ToolCallEvent = { name, ok, spawn_depth: this.spawn_depth };
    for (const listener of this.tool_call_listeners) {
      try {
        listener(event);
      } catch {
        // A faulty UI subscriber never breaks the turn loop (fire-and-forget).
      }
    }
  }

  /**
   * emitCommand — publish one agent CommandEvent (name + args + result/error) to the command
   * channel (actions §2.1). Fire-and-forget + listener-isolated like emitToolCall; carries
   * the command CONTENT (unlike emitToolCall) for an out-of-core ledger sink — INV #13 holds
   * because it never writes the tree and is never re-scanned for commands. No-op when nobody
   * is subscribed. Called ONLY from the agent lane (invokeCommand, success :950 / failure
   * :964) — NEVER from operations.ts (the universal chokepoint would loop on every
   * invoker:'app' base.record).
   */
  private emitCommand(event: CommandEvent): void {
    if (this.command_listeners.size === 0) return;
    for (const listener of this.command_listeners) {
      try {
        listener(event);
      } catch {
        // A faulty subscriber never breaks the turn loop (fire-and-forget).
      }
    }
  }

  /**
   * emitInput — publish one external-input InputDescriptor to the input channel (actions
   * §2.1). PUBLIC (unlike the other emit*): it is driven from OUTSIDE the turn loop — the
   * boot wires `registry.inputHook = (d) => runtime.emitInput(d)`, so an app's
   * `ctx.report_input` reaches the channel. Fire-and-forget + listener-isolated; pure
   * telemetry (never the tree, never the prompt). No-op when nobody is subscribed.
   */
  emitInput(d: InputDescriptor): void {
    if (this.input_listeners.size === 0) return;
    for (const listener of this.input_listeners) {
      try {
        listener(d);
      } catch {
        // A faulty subscriber never breaks the turn loop (fire-and-forget).
      }
    }
  }

  /**
   * emitError — publish a failed-turn event to the error channel. Like emitThoughts
   * it is fire-and-forget: each listener is isolated in try/catch so a faulty
   * subscriber never breaks the (already failing) turn. Normalizes the thrown value
   * to a message but also forwards the original `error` for callers that want more.
   */
  private emitError(err: unknown, phase: RuntimeErrorEvent['phase']): void {
    if (this.error_listeners.size === 0) return;
    const event: RuntimeErrorEvent = {
      message: err instanceof Error ? err.message : String(err),
      error: err,
      phase,
      spawn_depth: this.spawn_depth,
    };
    for (const listener of this.error_listeners) {
      try {
        listener(event);
      } catch {
        // A faulty error subscriber never breaks the turn loop (fire-and-forget).
      }
    }
  }

  /**
   * emitTurn — publish one TurnRecord per turn to the turn channel. Fire-and-forget +
   * error-isolated, exactly like emitThoughts/emitError: a faulty subscriber never
   * breaks the turn loop. The record is NEVER written to the tree and NEVER rendered
   * into the next prompt (telemetry, not context).
   */
  private emitTurn(record: TurnRecord): void {
    if (this.turn_listeners.size === 0) return;
    for (const listener of this.turn_listeners) {
      try {
        listener(record);
      } catch {
        // A faulty turn subscriber never breaks the turn loop (fire-and-forget).
      }
    }
  }

  /**
   * turnEnvelope — the deterministic, CLOCK-FREE fields of a TurnRecord (INV #16):
   * a monotonic turn_id (`${wake_seq}.${turn_index}`), the spawn depth, the wake event
   * that opened this loop, and the end reason. No wall-clock — a ts (if any) is stamped
   * by an out-of-core subscriber, keeping core's surface deterministic.
   */
  private turnEnvelope(ended_by: TurnEndReason): {
    turn_id: string;
    spawn_depth: number;
    wake_event: WakeEvent;
    ended_by: TurnEndReason;
  } {
    return {
      turn_id: `${this._wake_seq}.${this._turn_index}`,
      spawn_depth: this.spawn_depth,
      wake_event: this.current_wake_event ?? UNKNOWN_WAKE,
      ended_by,
    };
  }

  /**
   * turnTelemetry — copy the render-derived fields for a TurnRecord straight off the
   * RenderedPrompt (no re-hash, no re-render). segment_hashes is a Map keyed by tier;
   * we narrow it to a per-tier record. per_tier_bytes is the byte length of each
   * emitted segment's payload. Pure: a read of render OUTPUT, so INV #1 is untouched.
   */
  private turnTelemetry(prompt: RenderedPrompt): {
    snapshot_hash: string;
    segment_hashes: Partial<Record<CacheTier, string>>;
    per_tier_bytes: Partial<Record<CacheTier, number>>;
  } {
    const segment_hashes: Partial<Record<CacheTier, string>> = {};
    for (const [tier, hash] of prompt.segment_hashes) {
      segment_hashes[tier as CacheTier] = hash;
    }
    const per_tier_bytes: Partial<Record<CacheTier, number>> = {};
    for (const seg of prompt.segments) {
      per_tier_bytes[seg.tier] = segmentBytes(seg.rendered);
    }
    return { snapshot_hash: prompt.snapshot_hash, segment_hashes, per_tier_bytes };
  }

  /**
   * handleToolCalls — turn each structured tool_call into an invoke_command (§4.2).
   *   - `parked`: the runtime parked on a `pending` policy decision (the rest of the
   *     calls are deferred until the approval resolves and on_wake re-enters).
   *   - `end_turn`: a command signaled the agent finished responding (e.g.
   *     messages.reply) → the turn loop should stop after this turn.
   */
  private async handleToolCalls(
    tool_calls: ToolCall[],
  ): Promise<{ parked: boolean; end_turn: boolean; yielded: boolean }> {
    const invoker: InvokerContext = { invoker: 'agent' };
    let end_turn = false;
    let yielded = false;
    for (const call of tool_calls) {
      const result = await this.invokeCommand(call, invoker);
      if (result === 'parked') return { parked: true, end_turn, yielded };
      if (result === 'end_turn') end_turn = true;
      // A silent yield (base.end_turn) also ends the turn, but reports as 'yield'.
      if (result === 'yield') {
        end_turn = true;
        yielded = true;
      }
    }
    return { parked: false, end_turn, yielded };
  }

  /**
   * invokeCommand — run one command through Operations (PolicyEngine inside).
   *
   * A thrown PolicyDecision-pending is surfaced by Operations as a thrown error or
   * an unhandled rejection in some impls; the seam contract is that a `pending`
   * decision is observable. We treat it via the runtime's own park: Operations is
   * expected to reject with a tagged error carrying the approval token. Until the
   * exact signal is confirmed with the architect, we recognize a `pending`-tagged
   * rejection and park; any other error is written into the tree as a result the
   * agent can see next turn (§8.1 error handling).
   */
  private async invokeCommand(
    call: ToolCall,
    invoker: InvokerContext,
  ): Promise<'done' | 'parked' | 'end_turn' | 'yield'> {
    try {
      const res = await this.ops.invoke_command(call.name, call.args, invoker);
      // A `pending` policy decision surfaces two ways across impls: the real
      // Operations returns ok:false carrying data.policy==='pending'+token (it
      // does not throw); a thrown tagged error is the other recognized form
      // (handled in catch). Detect the result-marker form here and park.
      const token = pendingTokenOf(res);
      if (token !== null) {
        this.state = { kind: 'paused_for_approval', gateway_token: token };
        return 'parked'; // deferred until approval — emit when it actually runs on resume.
      }
      // A successful command may signal it COMPLETED the agent's response (CommandResult
      // .end_turn, §8.1): the runtime then stops the turn loop instead of looping and
      // re-replying. Two flavors (end_turn_kind):
      //   - reply (default): the command IS the reply — it surfaces as the `reply` event
      //     (the chat bubble), so we do NOT also emit it as a tool_call or re-ledger it
      //     (double-show; and onReply fires inside the command, stranding the UI panel).
      //   - yield (base.end_turn): a SILENT end with no outward message. Nothing else
      //     surfaces it, so we DO record it in the command ledger (base:recent) for a
      //     visible trace, then end the turn as 'yield'.
      if (res.ok && res.end_turn === true) {
        if (res.end_turn_kind === 'yield') {
          this.emitCommand({
            name: call.name,
            args: call.args,
            ok: true,
            ...(res.data !== undefined ? { result: res.data, ...refOf(res.data) } : {}),
            invoker: 'agent',
            spawn_depth: this.spawn_depth,
          });
          return 'yield';
        }
        return 'end_turn';
      }
      // Any OTHER executed command (memory.write, task.add, a denied command…) → surface it
      // to the tool-call channel for a UI to group under the turn (name + ok, never args).
      this.emitToolCall(call.name, res.ok);
      // SUCCESS site (actions §2.1): publish the full action↔observation pair to the command
      // channel for the `actions` ledger — args + result (CommandResult.data), no error. This
      // is the signal the agent never otherwise sees (its own success). end_turn/parked
      // already returned above, so they never reach here. `invoker` is always 'agent' (the
      // agent lane); a denied command (res.ok:false, no throw) emits too, with no result.
      this.emitCommand({
        name: call.name,
        args: call.args,
        ok: res.ok,
        ...(res.ok ? { result: res.data, ...refOf(res.data) } : {}),
        ...(res.ok ? {} : { error: res.error }),
        invoker: 'agent',
        spawn_depth: this.spawn_depth,
      });
      // Otherwise a deny/failed command is not fatal: Operations already recorded
      // the refusal as the CommandResult; the owning App's block (or the result's
      // own error surfaced to the agent next turn) reflects it. Nothing to do here
      // beyond noting we progressed.
      return 'done';
    } catch (err) {
      const token = approvalTokenOf(err);
      if (token !== null) {
        this.state = { kind: 'paused_for_approval', gateway_token: token };
        return 'parked';
      }
      // FAILURE site (actions §2.1): surface the failed call to the UI channel (ok:false), then
      // publish it to the command channel (ok:false + error, no result) so the `actions` ledger
      // records the failure — replacing the removed `runtime:command_error` block (§2.4). Only
      // `err` is in scope here; normalize it the way recordCommandError did.
      this.emitToolCall(call.name, false);
      this.emitCommand({
        name: call.name,
        args: call.args,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        invoker: 'agent',
        spawn_depth: this.spawn_depth,
      });
      return 'done';
    }
  }

  /** True if the model emitted plain assistant text outside thinking/tool_use. */
  private hasDisallowedText(raw_text: string): boolean {
    return raw_text.trim().length > 0;
  }

  /**
   * writeCommandsOnlyFeedback — record a commands-only violation (§4.2). B1: this no
   * longer writes the tree — it just sets `pending_feedback` runtime state. The
   * feedback system builder projects that state into `runtime:commands_only_feedback`
   * on the NEXT render, so the agent sees it and self-corrects. `async` is kept (the
   * call site `await`s it and a future variant may do async work); the body is sync.
   */
  private async writeCommandsOnlyFeedback(): Promise<void> {
    this.pending_feedback = COMMANDS_ONLY_FEEDBACK_TEXT;
  }

  // --------------------------------------------------------------------------
  // B1 — bookkeeping system builders (state → block projection, no tree writes)
  // --------------------------------------------------------------------------

  /**
   * makeFeedbackBuilder — the `runtime:commands_only_feedback` system builder (B1).
   * It is a CLOSURE over this runtime: each render it reads `this.pending_feedback`
   * and projects the feedback text when a violation is pending, or returns `null`
   * (render nothing) on a clean turn. owner='system' (INV #4 — never 'agent'), no
   * `app_id` (it reads runtime state via the closure, not an AppContext), volatile
   * tier so it never poisons the stable cache prefix. Deterministic: identical
   * `pending_feedback` → byte-identical block (INV #1 / #16).
   */
  private makeFeedbackBuilder(): BuilderManifest {
    return {
      name: 'runtime.commands_only_feedback',
      version: '1.0.0',
      owner: 'system',
      inputs: [],
      outputs: [COMMANDS_ONLY_FEEDBACK_BLOCK],
      cache_tier: 'volatile',
      build: async (ctx: BuildContext): Promise<Block | null> =>
        this.pending_feedback === null
          ? null
          : projectionBlock(ctx, COMMANDS_ONLY_FEEDBACK_BLOCK, this.pending_feedback),
    };
  }

  /**
   * makeLoopFeedbackBuilder — the `runtime:loop_feedback` system builder (§8.1
   * stall-guard). A closure over this runtime that mirrors makeFeedbackBuilder
   * EXACTLY: each render it reads `this.pending_loop_feedback` and projects the
   * loop-feedback text when a stall was detected, or returns `null` (render nothing)
   * otherwise. owner='system' (INV #4 — never 'agent'), no `app_id`, volatile tier so
   * it never poisons the stable cache prefix. PURE: identical `pending_loop_feedback`
   * → byte-identical block (INV #1 / #16); no clock/random/env.
   */
  private makeLoopFeedbackBuilder(): BuilderManifest {
    return {
      name: 'runtime.loop_feedback',
      version: '1.0.0',
      owner: 'system',
      inputs: [],
      outputs: [LOOP_FEEDBACK_BLOCK],
      cache_tier: 'volatile',
      build: async (ctx: BuildContext): Promise<Block | null> =>
        this.pending_loop_feedback === null
          ? null
          : projectionBlock(ctx, LOOP_FEEDBACK_BLOCK, this.pending_loop_feedback),
    };
  }

  /**
   * buildSendOpts — assemble the per-turn SendOpts. Currently this is just the tool
   * catalog (the agent-invokable commands advertised so the model can call them). We
   * omit `tools` entirely when the catalog is absent/empty (rather than passing an
   * empty array), which `exactOptionalPropertyTypes` requires and which keeps the
   * request identical to the old no-tools behavior for scripted providers.
   */
  private buildSendOpts(signal?: AbortSignal): SendOpts {
    const tools = this.tool_catalog?.();
    const opts: SendOpts = {};
    if (tools && tools.length > 0) opts.tools = tools;
    if (signal) opts.signal = signal;
    return opts;
  }

  /**
   * Accumulate a provider stream into one ProviderResponse for the adapter. `onChunk`
   * (the runtime's idle-timeout re-arm, §send-timeout) fires on EVERY chunk, so the send
   * deadline bounds a STALL between chunks, never a long-but-streaming generation.
   */
  private async collect(
    stream: AsyncIterable<ProviderChunk>,
    onChunk?: (() => void) | null,
  ): Promise<ProviderResponse> {
    let done: ProviderResponse | null = null;
    let input_tokens: number | undefined;
    let output_tokens: number | undefined;
    for await (const chunk of stream) {
      onChunk?.();
      switch (chunk.kind) {
        case 'done':
          done = chunk.response;
          break;
        case 'usage':
          input_tokens = chunk.input_tokens;
          output_tokens = chunk.output_tokens;
          break;
        // text / thinking / tool_call deltas are reflected in the final `done`
        // response by the provider; the adapter parses `done.raw`. We do not
        // re-derive commands from streamed text here (INV #13).
        case 'text':
        case 'thinking':
        case 'tool_call':
          break;
      }
    }
    if (done) {
      // Prefer the terminal response; fold in any usage chunk if absent.
      if (!done.usage) {
        const usage = buildUsage(input_tokens, output_tokens);
        if (usage) return { raw: done.raw, usage };
      }
      return done;
    }
    // Provider closed the stream without a `done` chunk: synthesize an empty one
    // so the adapter sees a well-formed (empty) response rather than crashing.
    const usage = buildUsage(input_tokens, output_tokens);
    return usage ? { raw: null, usage } : { raw: null };
  }

  /** Discriminant of the current state, read so TS cannot narrow it spuriously. */
  private stateKind(): AgentState['kind'] {
    return this.state.kind;
  }
}

/**
 * withTimeout — race a promise against a deadline (UH-2 §3.7). Resolves/rejects with
 * the wrapped promise if it settles within `ms`; otherwise REJECTS with a timeout error.
 * The timer is cleared on settle so a slow-but-eventually-resolving pull leaves no
 * dangling handle. Pure wrt the runtime closure (only `node:`-global setTimeout). Used
 * to bound each consume-refresh provider pull so one hung provider can't hijack the turn.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * commandSignature — the stall-guard's identity for one issued command (§8.1):
 * `name + ' ' + stableStringify(args)`. Two calls share a signature iff they have the
 * SAME command name AND structurally-equal args (key order ignored), so the same
 * command with DIFFERENT args is a DIFFERENT signature = different work — only an EXACT
 * repeat is flagged as no-progress. Pure (no clock/random/IO).
 */
function commandSignature(name: string, args: unknown): string {
  return `${name} ${stableStringify(args)}`;
}

/**
 * stableStringify — JSON serialization with object keys sorted recursively, so
 * `{a:1,b:2}` and `{b:2,a:1}` serialize identically. Non-object args (primitive,
 * array, null) serialize via plain `JSON.stringify` (arrays preserve order — element
 * order IS meaningful). Arrays nested anywhere keep their order; only object KEYS are
 * sorted. Pure and total for JSON-shaped command args. Used only by commandSignature.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/**
 * projectionBlock — the Block a runtime bookkeeping builder renders for `name`.
 * The id is content-addressed off the name (deterministic, no random UUID — INV #16)
 * via the BuildContext's own substitute, so two builds with the same name yield a
 * byte-identical block. A leaf node (no children); `content_text` carries the
 * projected state. This is the ONLY thing the builders emit — the runtime never
 * writes these blocks to the tree itself (B1).
 */
function projectionBlock(ctx: BuildContext, name: BlockName, text: string): Block {
  return {
    id: ctx.content_addressed_id(name),
    name,
    children: [],
    content_text: text,
    content_blob: null,
  };
}

/**
 * buildUsage — assemble a usage object that omits absent fields entirely (rather
 * than setting them to `undefined`), which `exactOptionalPropertyTypes` requires.
 * Returns undefined when neither token count is known.
 */
function buildUsage(
  input_tokens: number | undefined,
  output_tokens: number | undefined,
): ProviderResponse['usage'] | undefined {
  if (input_tokens === undefined && output_tokens === undefined) return undefined;
  const usage: { input_tokens?: number; output_tokens?: number } = {};
  if (input_tokens !== undefined) usage.input_tokens = input_tokens;
  if (output_tokens !== undefined) usage.output_tokens = output_tokens;
  return usage;
}

/**
 * segmentBytes — byte length of a rendered segment's payload (string or ContentPart[]),
 * for TurnRecord.per_tier_bytes. ContentPart.value is always a string (text or a blob
 * handle/data-URI, core/types.ts), so this is a pure utf8 byte count — no IO, no clock.
 */
function segmentBytes(rendered: string | ContentPart[]): number {
  if (typeof rendered === 'string') return Buffer.byteLength(rendered, 'utf8');
  let total = 0;
  for (const part of rendered) total += Buffer.byteLength(part.value, 'utf8');
  return total;
}

/**
 * UNKNOWN_WAKE — defensive fallback for TurnRecord.wake_event if a record were ever
 * emitted outside a wake (on_wake always sets current_wake_event before the loop, so
 * this is unreachable in practice; it keeps the record's wake_event non-null).
 */
const UNKNOWN_WAKE: WakeEvent = { kind: 'app_event', source: 'unknown' };

/**
 * approvalTokenOf — recognize a PolicyEngine `pending` signal surfaced as a thrown
 * error. The seam contract (pending architect confirmation) is that Operations
 * tags such an error so the runtime can park on it. We look for a `policy_pending`
 * marker carrying the approval token; anything else returns null (not a park).
 */
function approvalTokenOf(err: unknown): string | null {
  if (err && typeof err === 'object') {
    const e = err as { policy_pending?: unknown; token?: unknown };
    if (e.policy_pending === true && typeof e.token === 'string') {
      return e.token;
    }
  }
  return null;
}

/**
 * pendingTokenOf — recognize a PolicyEngine `pending` decision surfaced through a
 * (non-throwing) CommandResult. The real Operations returns
 * `{ ok:false, error:'approval pending', data:{ policy:'pending', token } }`; we
 * read that marker so the runtime parks regardless of which impl is wired in.
 */
function pendingTokenOf(res: CommandResult): string | null {
  if (res.ok) return null;
  const data = res.data;
  if (data && typeof data === 'object') {
    const d = data as { policy?: unknown; token?: unknown };
    if (d.policy === 'pending' && typeof d.token === 'string') return d.token;
  }
  return null;
}

/**
 * refOf — best-effort dig of a target id out of a CommandResult.data for the CommandEvent
 * `ref` (actions §2.1). Nothing in CommandResult is a STRUCTURED target id, so this is a
 * pure heuristic: a top-level string `id` / `ref` / `block` on a plain-object data. Absent
 * (no object, no recognized key) → `{}`, so the row degrades to `verb → ok` (still the
 * "I did this, it worked" signal). Returned as a spreadable partial so the call site stays
 * one expression and never sets `ref: undefined` (exactOptionalPropertyTypes-clean).
 */
function refOf(data: unknown): { ref?: string } {
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    for (const key of ['ref', 'id', 'block'] as const) {
      const v = d[key];
      if (typeof v === 'string' && v.length > 0) return { ref: v };
    }
  }
  return {};
}
