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

/** The block name the runtime projects recent command failures into (§8.1). */
export const COMMAND_ERROR_BLOCK: BlockName = 'runtime:command_error';

/** Default root block name (matches the empty-tree boot in core/block.ts). */
const DEFAULT_ROOT_NAME: BlockName = 'root:root';

/**
 * Upper bound on the command-error ring the runtime keeps (CM-6, INV #16). Older
 * failures fall off the front so `recent_errors` never grows unbounded; the
 * `runtime:command_error` projection renders them oldest→newest deterministically.
 */
const MAX_RECENT_COMMAND_ERRORS = 8;

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
  /** Registry handle (R-5): registerSystemBuilder for B1 + future get_app_context. */
  private readonly registry: BuilderRegistry;
  private readonly max_turns_per_wake: number;
  private readonly root_name: BlockName;
  private readonly tool_catalog: (() => ToolCatalog) | undefined;

  /** UI subscribers on the thinking channel (§4.3). */
  private readonly thinking_listeners = new Set<ThinkingListener>();

  /** UI/caller subscribers on the error channel (failed turns). */
  private readonly error_listeners = new Set<ErrorListener>();

  /**
   * Set when a turn produced commands-only-violating plain text (§4.2). The
   * commands-only feedback system builder PROJECTS this into the tree (B1): when
   * non-null the block renders the feedback text, when null it renders nothing.
   * No longer written to the tree directly (the old `upsertBookkeepingBlock` path) —
   * this state IS the source of truth and the builder is its only reader.
   */
  private pending_feedback: string | null = null;

  /**
   * Recent non-policy command failures, oldest→newest, bounded to
   * `MAX_RECENT_COMMAND_ERRORS` (CM-6). The command-error system builder (B1)
   * projects these into a SINGLE `runtime:command_error` block; like
   * `pending_feedback` they are state, never written to the tree directly. `id` is
   * the failing tool_call id (kept for de-dup/debuggability); `text` is the rendered
   * line. Replaces the old per-id `runtime:command_error.<id>` tree blocks.
   */
  private readonly recent_errors: { id: string; text: string }[] = [];

  constructor(opts: AgentRuntimeOptions) {
    this.ops = opts.operations;
    this.renderer = opts.renderer;
    this.provider = opts.provider;
    this.registry = opts.registry;
    this.spawn_depth = opts.spawn_depth ?? 0;
    this.max_turns_per_wake = opts.max_turns_per_wake ?? DEFAULT_MAX_TURNS_PER_WAKE;
    this.root_name = opts.root_name ?? DEFAULT_ROOT_NAME;
    this.tool_catalog = opts.tool_catalog;

    // B1 (CM-5): register the runtime's two bookkeeping system builders AFTER all
    // state fields exist (the builders close over `this.pending_feedback` /
    // `this.recent_errors`). They belong to no installed App, so they go through the
    // registry's `registerSystemBuilder` seam (F3: the registry stays the single
    // owner of builder ownership). Once registered, `seedProjectionBlocks` will seed
    // their output names and the Renderer projects live runtime state each turn —
    // no runtime block is ever written to the tree directly.
    this.registry.registerSystemBuilder(this.makeFeedbackBuilder());
    this.registry.registerSystemBuilder(this.makeCommandErrorBuilder());
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
    const { parked, end_turn } = await this.handleToolCalls(tool_calls);
    if (tool_calls.length > 0) progressed = true;
    if (parked) return true; // parked → caller stops the loop; resumed via on_wake.
    // The agent finished responding (a command set end_turn, e.g. messages.reply): stop
    // the loop and return to idle to await the next event, instead of running another
    // turn and re-replying. Multi-step tool use (no end_turn) keeps looping as before.
    if (end_turn) return false;

    // 4c) plain text (not in thinking, not a tool_use) → commands-only REJECTION
    //     (§4.2). Write the feedback block; the agent self-corrects next turn.
    if (this.hasDisallowedText(raw_text)) {
      await this.writeCommandsOnlyFeedback();
      progressed = true;
    }

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

      for (const consumer of consumers) {
        // One bad consumer must never affect the others (defense in depth; the
        // per-consumer body below is already guarded, this is the outer net). The
        // `await` is REQUIRED: refreshOneConsumer awaits each provider pull, so without
        // it consume-refresh would return before set_state ran and the snapshot would
        // render STALE state (the refresh completing after the render) — defeating the
        // "before snapshot" guarantee. Awaiting also lets this try/catch catch its
        // rejection (a non-awaited async throw would escape it).
        try {
          await this.refreshOneConsumer(consumer);
        } catch {
          /* isolate a single consumer's failure */
        }
      }
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

    const datas: unknown[] = [];
    for (const provider of providers) {
      const full_name = `${provider.app_id}.${provider.via}`;
      // invoke_query is OPTIONAL on the Operations interface; absence ⇒ no pull path.
      if (!this.ops.invoke_query) {
        throw new Error('consume-refresh: Operations.invoke_query is unavailable');
      }
      const res = await this.ops.invoke_query(full_name, {}, invoker);
      if (!res.ok) {
        throw new Error(
          `consume-refresh: query '${full_name}' failed: ${res.error ?? 'unknown error'}`,
        );
      }
      const check = validateAgainstSchema(res.data, def.output_schema);
      if (!check.ok) {
        throw new Error(
          `consume-refresh: '${full_name}' data violates contract '${contract}': ${check.error}`,
        );
      }
      datas.push(res.data);
    }

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
   *   - `parked`: the runtime parked on a `pending` policy decision (the rest of the
   *     calls are deferred until the approval resolves and on_wake re-enters).
   *   - `end_turn`: a command signaled the agent finished responding (e.g.
   *     messages.reply) → the turn loop should stop after this turn.
   */
  private async handleToolCalls(
    tool_calls: ToolCall[],
  ): Promise<{ parked: boolean; end_turn: boolean }> {
    const invoker: InvokerContext = { invoker: 'agent' };
    let end_turn = false;
    for (const call of tool_calls) {
      const result = await this.invokeCommand(call, invoker);
      if (result === 'parked') return { parked: true, end_turn };
      if (result === 'end_turn') end_turn = true;
    }
    return { parked: false, end_turn };
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
  ): Promise<'done' | 'parked' | 'end_turn'> {
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
      // A successful command may signal it COMPLETED the agent's response (e.g.
      // messages.reply): the runtime then stops the turn loop instead of looping and
      // re-replying (CommandResult.end_turn, §8.1).
      if (res.ok && res.end_turn === true) return 'end_turn';
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
   * writeCommandsOnlyFeedback — record a commands-only violation (§4.2). B1: this no
   * longer writes the tree — it just sets `pending_feedback` runtime state. The
   * feedback system builder projects that state into `runtime:commands_only_feedback`
   * on the NEXT render, so the agent sees it and self-corrects. `async` is kept (the
   * call site `await`s it and a future variant may do async work); the body is sync.
   */
  private async writeCommandsOnlyFeedback(): Promise<void> {
    this.pending_feedback = COMMANDS_ONLY_FEEDBACK_TEXT;
  }

  /**
   * recordCommandError — record a non-policy command failure (§8.1). B1: pushes a
   * line onto the bounded `recent_errors` ring (oldest evicted past
   * `MAX_RECENT_COMMAND_ERRORS`, CM-6) instead of writing a per-id tree block. The
   * command-error system builder projects the ring into the single
   * `runtime:command_error` block next render, so the agent reads its recent failures.
   */
  private async recordCommandError(call: ToolCall, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    this.recent_errors.push({
      id: call.id,
      text: `command ${call.name} failed: ${message}`,
    });
    // Bound the ring: drop the oldest entries so it never grows without limit.
    while (this.recent_errors.length > MAX_RECENT_COMMAND_ERRORS) {
      this.recent_errors.shift();
    }
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
   * makeCommandErrorBuilder — the `runtime:command_error` system builder (B1). A
   * closure over this runtime: each render it projects the bounded `recent_errors`
   * ring (oldest→newest, CM-6 ordering) into ONE block, or returns `null` when there
   * are no errors. Same discipline as the feedback builder (system owner, volatile,
   * deterministic). Replaces the old per-id `runtime:command_error.<id>` blocks.
   */
  private makeCommandErrorBuilder(): BuilderManifest {
    return {
      name: 'runtime.command_error',
      version: '1.0.0',
      owner: 'system',
      inputs: [],
      outputs: [COMMAND_ERROR_BLOCK],
      cache_tier: 'volatile',
      build: async (ctx: BuildContext): Promise<Block | null> => {
        if (this.recent_errors.length === 0) return null;
        const text = this.recent_errors.map((e) => e.text).join('\n');
        return projectionBlock(ctx, COMMAND_ERROR_BLOCK, text);
      },
    };
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
