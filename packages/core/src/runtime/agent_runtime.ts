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
  BlockName,
  BlockOp,
  InvokerContext,
  Operations,
  Renderer,
  RuntimeErrorEvent,
  ThinkingEvent,
  WakeEvent,
} from '../core/types.js';
import type {
  ModelProvider,
  ProviderChunk,
  ProviderResponse,
  SendOpts,
  ToolCall,
} from '../provider/types.js';
import type { CommandResult } from '../app/types.js';

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

/** The agent-invokable command list advertised to the provider each turn (§4.2). */
export type ToolCatalog = NonNullable<SendOpts['tools']>;

/** Construction wiring for the runtime. */
export interface AgentRuntimeOptions {
  operations: Operations;
  renderer: Renderer;
  provider: ModelProvider;
  /** sub-agent recursion depth; 0 = main agent (§8.1). */
  spawn_depth?: number;
  /** Hard cap on turns within one wake, to bound a runaway tool-call loop. */
  max_turns_per_wake?: number;
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
   * Parent block under which the runtime attaches its own bookkeeping blocks
   * (commands-only feedback, command-error blocks) when they don't yet exist.
   * Defaults to the empty-tree root `root:root`.
   */
  root_name?: BlockName;
}

/** The block name the runtime writes commands-only rejection feedback to (§4.2). */
export const COMMANDS_ONLY_FEEDBACK_BLOCK: BlockName = 'runtime:commands_only_feedback';

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
  private readonly max_turns_per_wake: number;
  private readonly root_name: BlockName;
  private readonly tool_catalog: (() => ToolCatalog) | undefined;

  /** UI subscribers on the thinking channel (§4.3). */
  private readonly thinking_listeners = new Set<ThinkingListener>();

  /** UI/caller subscribers on the error channel (failed turns). */
  private readonly error_listeners = new Set<ErrorListener>();

  /** Set when a turn produced commands-only-violating plain text (§4.2). */
  private pending_feedback: string | null = null;

  constructor(opts: AgentRuntimeOptions) {
    this.ops = opts.operations;
    this.renderer = opts.renderer;
    this.provider = opts.provider;
    this.spawn_depth = opts.spawn_depth ?? 0;
    this.max_turns_per_wake = opts.max_turns_per_wake ?? DEFAULT_MAX_TURNS_PER_WAKE;
    this.root_name = opts.root_name ?? DEFAULT_ROOT_NAME;
    this.tool_catalog = opts.tool_catalog;
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
      // Already mid-loop (re-entrant wake, e.g. a system agent firing). Ignore;
      // the in-flight loop will observe tree changes on its next turn.
      return;
    }

    this.state = { kind: 'running', current_event: event };

    try {
      let turns = 0;
      // Loop: each turn renders the current tree and processes the response.
      // We stop when a turn neither invoked a command nor queued feedback —
      // i.e. the agent had nothing more to do.
      for (;;) {
        if (turns >= this.max_turns_per_wake) break;
        turns += 1;

        let progressed: boolean;
        try {
          progressed = await this.runTurn();
        } catch (err) {
          // Safety net for an unexpected turn failure OUTSIDE the send path (which
          // runTurn already catches and reports as phase 'send'). Surface it and end
          // the wake gracefully so a failed turn never crashes the process or wedges
          // the runtime in 'running'.
          this.emitError(err, 'turn');
          break;
        }

        // If the turn parked the runtime (approval pending), stop the loop here;
        // resumption happens via a later on_wake once the approval resolves.
        // (read via stateKind() so TS does not narrow away the mutation runTurn
        // performed — `this.state` was 'running' on entry but runTurn may park.)
        if (this.stateKind() === 'paused_for_approval') return;

        if (!progressed) break;
      }
    } finally {
      // Only return to idle if we did not park. (A park already set state and
      // returned above; this guard keeps a parked state intact.)
      if (this.stateKind() === 'running') {
        this.state = { kind: 'idle' };
      }
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
    // 1) Render the current snapshot into a prompt (§10). Byte-identical for a
    //    given (snapshot, tiers) — the runtime relies on Operations.snapshot()
    //    being a frozen COW capture (INV #1).
    const snapshot = this.ops.snapshot();
    const prompt = await this.renderer.render(snapshot);

    // 2) Send to the provider and accumulate the stream into one response. We
    //    advertise the agent-invokable command catalog as SendOpts.tools so a
    //    native-tool-dispatch model can actually emit tool_calls (commands); without
    //    it the model only ever produces plain text → commands-only rejection (§4.2).
    //    A provider/transport failure (endpoint 4xx/5xx, network drop, unparseable
    //    stream) is NOT a command refusal — it aborts the whole turn. We surface it on
    //    the error channel and end the turn (no progress) instead of throwing, so the
    //    caller who submitted a message gets a failure signal rather than silence.
    let response: ProviderResponse;
    try {
      response = await this.collect(this.provider.send(prompt, this.buildSendOpts()));
    } catch (err) {
      this.emitError(err, 'send');
      return false;
    }

    // 3) Extract via the provider's thinking adapter. This is the seam that
    //    enforces INV #13: tool_calls are commands; thoughts/raw_text are NOT.
    const { thoughts, tool_calls, raw_text } =
      this.provider.thinking_adapter.extract(response);

    let progressed = false;

    // 4a) thinking → UI thinking channel (§4.3). The text is OPAQUE: we EMIT it to
    //     subscribers and do nothing else — never write it to the tree, never feed
    //     it into the next prompt, never parse it for commands.
    this.emitThoughts(thoughts);

    // 4b) tool_use (commands) → invoke_command one by one (§4.2). PolicyEngine
    //     runs inside Operations.invoke_command; a `pending` decision parks the
    //     runtime (paused_for_approval) and aborts the rest of this turn.
    const parked = await this.handleToolCalls(tool_calls);
    if (tool_calls.length > 0) progressed = true;
    if (parked) return true; // parked → caller stops the loop; resumed via on_wake.

    // 4c) plain text (not in thinking, not a tool_use) → commands-only REJECTION
    //     (§4.2). Write the feedback block; the agent self-corrects next turn.
    if (this.hasDisallowedText(raw_text)) {
      await this.writeCommandsOnlyFeedback();
      progressed = true;
    }

    return progressed;
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
   * handleToolCalls — turn each structured tool_call into an invoke_command (§4.2).
   * Returns true if the runtime parked on a `pending` policy decision (the rest of
   * the calls are deferred until the approval resolves and on_wake re-enters).
   */
  private async handleToolCalls(tool_calls: ToolCall[]): Promise<boolean> {
    const invoker: InvokerContext = { invoker: 'agent' };
    for (const call of tool_calls) {
      const result = await this.invokeCommand(call, invoker);
      if (result === 'parked') return true;
    }
    return false;
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
  ): Promise<'done' | 'parked'> {
    try {
      const res = await this.ops.invoke_command(call.name, call.args, invoker);
      // A `pending` policy decision surfaces two ways across impls: the real
      // Operations returns ok:false carrying data.policy==='pending'+token (it
      // does not throw); a thrown tagged error is the other recognized form
      // (handled in catch). Detect the result-marker form here and park.
      const token = pendingTokenOf(res);
      if (token !== null) {
        this.state = { kind: 'paused_for_approval', gateway_token: token };
        return 'parked';
      }
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
      // Non-policy error: record it so the agent sees it next turn (§8.1).
      await this.recordCommandError(call, err);
      return 'done';
    }
  }

  /** True if the model emitted plain assistant text outside thinking/tool_use. */
  private hasDisallowedText(raw_text: string): boolean {
    return raw_text.trim().length > 0;
  }

  /**
   * writeCommandsOnlyFeedback — write/overwrite the feedback block (§4.2). Written
   * with invoker='app' via the system primitive because no App owns a command for
   * it. Becomes the agent's input next turn so it self-corrects.
   */
  private async writeCommandsOnlyFeedback(): Promise<void> {
    this.pending_feedback = COMMANDS_ONLY_FEEDBACK_TEXT;
    await this.upsertBookkeepingBlock(
      COMMANDS_ONLY_FEEDBACK_BLOCK,
      COMMANDS_ONLY_FEEDBACK_TEXT,
    );
  }

  /** Record a non-policy command failure as a tree block the agent can read. */
  private async recordCommandError(call: ToolCall, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const target = `runtime:command_error.${call.id}` as BlockName;
    await this.upsertBookkeepingBlock(target, `command ${call.name} failed: ${message}`);
  }

  /**
   * upsertBookkeepingBlock — set `text` on a runtime-owned block, creating it under
   * the root if absent and updating it in place otherwise. The block id is
   * content-addressed off its name so the choice stays deterministic (no random
   * UUID, INV #16). Applied with invoker='app' (§9.4).
   */
  private async upsertBookkeepingBlock(name: BlockName, text: string): Promise<void> {
    const op: BlockOp = this.ops.has(name)
      ? { kind: 'update', target: name, content_text: text }
      : {
          kind: 'create',
          parent: this.root_name,
          block: {
            id: `runtime-${name}`,
            name,
            children: [],
            content_text: text,
            content_blob: null,
          },
        };
    await this.applySystemOps([op]);
  }

  /**
   * applySystemOps — apply runtime-owned ops with invoker='app'. Both the feedback
   * block and command-error blocks are runtime bookkeeping, not agent-initiated
   * commands, so they go through `apply` (invoker='app', §9.4) rather than
   * invoke_command.
   */
  private async applySystemOps(ops: BlockOp[]): Promise<void> {
    const invoker: InvokerContext = { invoker: 'app' };
    await this.ops.apply(ops, invoker);
  }

  /**
   * buildSendOpts — assemble the per-turn SendOpts. Currently this is just the tool
   * catalog (the agent-invokable commands advertised so the model can call them). We
   * omit `tools` entirely when the catalog is absent/empty (rather than passing an
   * empty array), which `exactOptionalPropertyTypes` requires and which keeps the
   * request identical to the old no-tools behavior for scripted providers.
   */
  private buildSendOpts(): SendOpts {
    const tools = this.tool_catalog?.();
    return tools && tools.length > 0 ? { tools } : {};
  }

  /** Accumulate a provider stream into one ProviderResponse for the adapter. */
  private async collect(stream: AsyncIterable<ProviderChunk>): Promise<ProviderResponse> {
    let done: ProviderResponse | null = null;
    let input_tokens: number | undefined;
    let output_tokens: number | undefined;
    for await (const chunk of stream) {
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
