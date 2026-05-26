/**
 * core/types.ts — CONTRACT FILE (owned by architect; import-only for everyone else)
 *
 * The foundational data model for block-agent v3.0: the Block tree, the single
 * mutation entry point (Operations / invoke_command), the security decision type
 * (PolicyEngine), and the runtime state machine vocabulary.
 *
 * Authoritative design: ai_com/block-agent-architecture-v3.1.md
 *   §3 Block · §4 commands-only · §8 AgentRuntime · §9 PolicyEngine · §10 Renderer · §16 invariants
 *
 * House style (v3.1.md §0.5): block-world nouns get the `Block` prefix
 * (Block / BlockTree / BlockName / BlockRef / BlockSnapshot / BlockView / BlockOp);
 * actors get role names with no prefix (Operations / PolicyEngine / Renderer).
 *
 * INVARIANTS this file encodes (see §16):
 *   #2  block metadata lives in BuilderRegistry/AppRegistry, never on the Block.
 *   #15 BlockName is always `<app_id>:<name>` namespaced (template literal type below).
 *
 * NOTE: the ACTOR interfaces (BlockTree / PolicyEngine / Operations / Renderer)
 * live at the BOTTOM of this file. They were added in wave 2 so the runtime can
 * wire against stable signatures (not concrete classes). The concrete classes
 * `implements` these. See those sections for the canonical constructor shapes.
 */

// ============================================================================
// §3 Block data model
// ============================================================================

/**
 * BlockName — every block is addressed by a namespaced schelling point.
 *
 * INVARIANT #15: the form is always `<app_id>:<name>`, e.g. `memory:summary`,
 * `chat:current_turn`, `tools:tool_result.7a3`. The `<app_id>` prefix makes the
 * owner App unambiguous (INVARIANT #3: at most one owner builder per name) and
 * lets a third-party App register `slack:thread.abc` without colliding with core.
 *
 * The template-literal type enforces the single colon at compile time. Helpers
 * to split/validate live in the implementation (core/block.ts), not here.
 */
export type BlockName = `${string}:${string}`;

/**
 * A name pattern used by builders to subscribe to inputs, e.g. `memory:*`.
 * Kept as a plain string because glob/wildcard matching is a runtime concern;
 * the contract only promises it is a string interpreted as a pattern.
 */
export type BlockNamePattern = string;

/**
 * RESERVED `runtime:` NAMESPACE — owned by the AgentRuntime itself.
 *
 * The runtime writes ONE block that no App owns: the commands-only rejection
 * feedback (§4.2). It must be a well-formed BlockName (`<app_id>:<name>`, INV
 * #15) with a single owner (INV #3), so it lives under the reserved `runtime`
 * app-id.
 *
 * Ownership (INV #3): the runtime registers ONE built-in system builder
 * (`owner: 'system'`, app_id `runtime`) that owns the whole `runtime:*` namespace
 * and declares `cache_tier: 'volatile'` (the block changes most turns → render at
 * the tail). The runtime writes it via `Operations.apply(ops, {invoker:'app'})`,
 * which still passes through PolicyEngine (no bypass). The name is a constant
 * here so every implementer references the SAME string (no drift).
 *
 * `runtime` (not `system`) is the chosen prefix: it names the actual writer and
 * avoids confusion with the `owner: 'system'` builder category.
 *
 * NOTE (thinking-channel decision, 2026-05-26): there is NO `runtime:thoughts_sink`
 * block. Promoted thinking text is NEVER written to the tree and never re-enters a
 * prompt; the runtime EMITS it on a UI-only thinking channel (`AgentRuntime.onThinking`
 * → `ThinkingEvent`). See ARCHITECTURE.md "thinking-channel" and `ThinkingEvent` below.
 */
export const RUNTIME_APP_ID = 'runtime' as const;
/** Block holding the commands-only validation-failure feedback for the next turn (§4.2). */
export const BLOCK_COMMANDS_ONLY_FEEDBACK: BlockName = 'runtime:commands_only_feedback';

/**
 * Blob — non-text content (image / audio / pdf / ...).
 *
 * Across an UNTRUSTED (out-of-process) boundary a blob is NOT inlined; it travels
 * as a content-addressed read-only handle `blob://<sha256>` and is dereferenced
 * through an O(1) in-memory check (INVARIANT #18/#19). In-process trusted code
 * holds the Blob directly. `data` therefore carries either inline bytes
 * (base64 / data-URI) or a `blob://<sha256>` handle.
 */
export interface Blob {
  /** base64, data-URI, or a `blob://<sha256>` content-addressed handle. */
  data: string;
  /** e.g. `image/png` · `audio/mp3` · `application/pdf`. */
  mime_type: string;
  filename?: string;
  size?: number;
}

/**
 * A reference to a block by stable id, used by the `associated` DAG escape hatch
 * and by BlockOp targets. Prefer addressing by BlockName where a stable name exists.
 */
export interface BlockRef {
  id: string;
  name?: BlockName;
}

/**
 * Block — the ONE data structure in the system. A block is passive data:
 * a piece of content (text OR blob) plus ordered children, nested into a tree.
 *
 * Everything the LLM sees each turn is rendered from this tree.
 *
 * INVARIANT #2 (no metadata pollution): the block deliberately has NO
 * `type` / `metadata` / `state` / `owner` / `cache_tier` fields. All of that
 * is provided by BuilderRegistry / AppRegistry, keyed by `name`.
 */
export interface Block {
  /** Stable UUID. Identity that survives content edits. */
  id: string;
  /** Namespaced schelling point; binds the block to its owner App/builder. */
  name: BlockName;
  /** Ordered child blocks (the tree). */
  children: Block[];
  content_text: string | null;
  content_blob: Blob | null;

  /**
   * Optional DAG escape hatch (§3 / DR-8). The tree is strict by default
   * (one parent per block); `associated` declares a rare cross-link, used only
   * when a builder declares `associated_required`. Omitted in the common case
   * to keep the tree pure and cacheable.
   */
  associated?: BlockRef[];
}

// ----------------------------------------------------------------------------
// §3 Optional branded types (builders may opt in via their manifest).
// These narrow a Block at the type level without adding runtime fields.
// ----------------------------------------------------------------------------

export type ValidatedBlock<N extends BlockName> = Block & {
  readonly name: N;
  readonly __validated: unique symbol;
};
export type PublicBlock = Block & { readonly __visibility: 'public' };
export type PrivateBlock = Block & { readonly __visibility: 'private' };
export type PinnedBlock = Block & { readonly __pinned: true };

// ============================================================================
// §8.5 / §10 Snapshots and views — determinism + zero-copy sharing
// ============================================================================

/**
 * cache_tier — how often a block changes, which decides where it renders and
 * how the provider's prompt cache treats it (§10.2).
 *   stable        — almost never changes → rendered first (e.g. `identity:*`)
 *   slow_changing — changes occasionally → middle (e.g. `memory:summary`)
 *   volatile      — changes most turns → last (e.g. `thoughts:*`, `tools:tool_result.*`)
 *
 * Declared per block by its owner builder in BuilderManifest; the Renderer reads
 * it through the BuilderRegistry. A block's tier may be dynamically demoted to
 * `volatile` (projection only, with hysteresis) — see §10.2.
 */
export type CacheTier = 'stable' | 'slow_changing' | 'volatile';

/**
 * BlockSnapshot — a frozen, copy-on-write read-only capture of the tree taken
 * before rendering (§8.5). Rendering reads a snapshot so that concurrent writes
 * land in the NEXT snapshot; this is what guarantees byte-identical rendering
 * (INVARIANT #1). Treat it as deeply immutable.
 */
export interface BlockSnapshot {
  /** Deeply-frozen root of the captured tree. */
  readonly root: Readonly<Block>;
  /** Stable content hash of the whole snapshot (feeds RenderedPrompt.snapshot_hash). */
  readonly hash: string;
  /** Look up a block within this snapshot by name; null if absent. */
  get(name: BlockName): Readonly<Block> | null;
}

/**
 * BlockView — a read-only zero-copy view of a block subtree shared between two
 * TRUSTED in-process Apps (INVARIANT #18). It does NOT cross a BlockSnapshot
 * boundary and is NOT transferable: if either end is untrusted the runtime falls
 * back to a deep copy (by-value). Used by AppContext.read between trusted Apps.
 */
export interface BlockView {
  readonly block: Readonly<Block>;
  /** Marker forbidding the view from being persisted or passed onward. */
  readonly __view: unique symbol;
}

// ============================================================================
// §4 / §9 BlockOp + invocation + policy
// ============================================================================

/**
 * BlockOp — one tree mutation. Discriminated union by `kind`. These are the
 * primitive edits an App's command produces; Operations applies them to the
 * tree only after PolicyEngine has allowed the originating command.
 *
 * INVARIANT #5: delete defaults to archival (agent invoker); physical removal
 * is a separate capability gated by PolicyEngine — represented here as the
 * `physical` flag on the delete op (the policy layer decides whether to honor it).
 */
export type BlockOp =
  | { kind: 'create'; parent: BlockName; block: Block; index?: number }
  | { kind: 'update'; target: BlockName; content_text?: string | null; content_blob?: Blob | null }
  | { kind: 'delete'; target: BlockName; physical?: boolean }
  | { kind: 'move'; target: BlockName; new_parent: BlockName; index?: number }
  | { kind: 'append'; target: BlockName; child: Block };

/**
 * InvokerContext — who is driving this operation (§9.3). Stamped by a
 * ChannelAdapter at the trust boundary (`identity` set after authentication).
 * PolicyEngine keys its strictness off `invoker`: user > agent in default trust.
 */
export interface InvokerContext {
  invoker: 'user' | 'agent' | 'app';
  /** Authenticated identity, set by the entry-membrane ChannelAdapter. */
  identity?: string;
}

/**
 * OperationCall — the normalized form of a command invocation as seen by the
 * PolicyEngine. `full_name` is `<app_id>.<command>` (note: command routing uses
 * a DOT separator; block NAMES use a colon — they are different namespaces).
 */
export interface OperationCall {
  full_name: string;
  args: unknown;
}

/**
 * PolicyDecision — the result of PolicyEngine.check (§9.3). `pending` hands off
 * to an out-of-band ApprovalService and parks the runtime (§8.1
 * `paused_for_approval`); the prompt is never polluted by the approval flow.
 */
export type PolicyDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'pending'; token: string };

// ============================================================================
// §10 Renderer output
// ============================================================================

/** A multi-modal content fragment for providers that accept structured parts. */
export interface ContentPart {
  type: 'text' | 'image' | 'audio';
  /** Text for `type:'text'`, otherwise a blob handle / data-URI. */
  value: string;
  mime_type?: string;
}

/**
 * RenderedPrompt — the flattened, tier-segmented prompt handed to a Provider
 * (§10.1). `cache_boundary` marks where a provider may insert a cache breakpoint.
 *
 * INVARIANT #1: rendering the same (snapshot, tiers) twice MUST be byte-identical
 * — hence the hashes, which let tests and the cache assert stability.
 */
export interface RenderedPrompt {
  segments: Array<{
    tier: CacheTier;
    rendered: string | ContentPart[];
    cache_boundary: boolean;
  }>;
  snapshot_hash: string;
  /** Per-segment content hashes, keyed by a stable segment id (e.g. the tier). */
  segment_hashes: Map<string, string>;
}

// ============================================================================
// §8.1 AgentRuntime state machine vocabulary
// ============================================================================

/**
 * AgentState — the runtime is idle (burning no tokens) until a WakeEvent arrives.
 * `waiting_external` parks on a long off-tree builder; `paused_for_approval` parks
 * on a PolicyEngine `pending` decision.
 */
export type AgentState =
  | { kind: 'idle' }
  | { kind: 'running'; current_event: WakeEvent }
  | { kind: 'waiting_external'; builder_id: string }
  | { kind: 'paused_for_approval'; gateway_token: string };

/**
 * WakeEvent — the only things that move the runtime out of idle (§8.1). Delivered
 * by the messages App (sync/async), tasks App, a scheduler, a completed off-tree
 * builder, or a returning sub-agent.
 */
export type WakeEvent =
  | { kind: 'sync_message_arrived'; msg_id: string }
  | { kind: 'async_message_arrived'; msg_id: string }
  | { kind: 'task_arrived'; task_id: string }
  | { kind: 'scheduled_tick'; cron_id: string }
  | { kind: 'builder_completed'; builder_id: string; output_block_id: string }
  | { kind: 'sub_agent_returned'; sub_id: string };

/**
 * ThinkingEvent — one promoted block of LLM reasoning, emitted on the runtime's
 * UI-only thinking channel (§4.3, thinking-channel decision 2026-05-26).
 *
 * This is the ONLY thing the runtime does with extracted `thoughts`: it emits
 * them for a UI to subscribe to (`AgentRuntime.onThinking`). Thinking text is
 * NEVER written to the BlockTree and NEVER rendered into the next prompt — it does
 * not survive into the agent's context. INV #13 still holds: the text is opaque,
 * never scanned for commands; commands come ONLY from structured tool_calls.
 *
 * `spawn_depth` lets a UI attribute thoughts to the main agent (0) vs a sub-agent.
 */
export interface ThinkingEvent {
  text: string;
  spawn_depth: number;
}

// ============================================================================
// ACTOR INTERFACES (wave 2 — added so runtime/index wire against stable shapes)
//
// These are TYPE-ONLY contracts. The concrete classes (core/block.ts,
// core/policy.ts, core/operations.ts, core/renderer.ts) `implements` them.
//
// DECOUPLING NOTE: the import below pulls INTERFACES from app/types.ts
// (CommandRegistry / BuilderRegistry / CommandResult). This is type-only and
// does NOT violate the "core never imports a concrete app / app/registry.ts"
// rule — the dependency-rules in ARCHITECTURE.md explicitly allow core to depend
// on the *interfaces* in app/types.ts. No runtime import, no cycle.
// ============================================================================
import type { CommandRegistry, BuilderRegistry, CommandResult } from '../app/types.js';

/**
 * BlockTree — the live, mutable tree (single-writer). Holds the root Block,
 * applies BlockOps, and produces frozen BlockSnapshots for rendering (§8.5).
 *
 * Canonical constructor (not expressible in a TS interface):
 *   `new BlockTree()` — starts EMPTY (§2: empty-tree boot; Apps fill it on install).
 *   An optional `new BlockTree(initialRoot?: Block)` overload is allowed for
 *   sub-agent ephemeral subtrees (§8.4); the demo boot uses the no-arg form.
 */
export interface BlockTree {
  /** Apply one tree mutation. The single mutation primitive other ops build on. */
  applyOp(op: BlockOp): void;
  /** Apply several ops as one logical change. */
  applyOps(ops: BlockOp[]): void;
  /** Look up a block by name in the live tree; null if absent. */
  get(name: BlockName): Block | null;
  /** Whether a live block with this name currently exists (O(1) index lookup). */
  has(name: BlockName): boolean;
  /** Freeze a copy-on-write read-only snapshot for byte-identical rendering. */
  snapshot(): BlockSnapshot;
  /** A trusted zero-copy read-only view of a subtree (in-process only, INV #18). */
  view(name: BlockName): BlockView | null;
}

/**
 * PolicyEngine — the unbypassable security check INSIDE Operations (§9.1).
 * `check` is called by `Operations.invoke_command` before any routing/mutation.
 *
 * INVARIANT #19: check is O(1) in-memory; NO IO / network.
 *
 * Canonical constructor: `new PolicyEngine(policyTable?)` — defaults to the
 * per-invoker policy table in §9.4 when no override is given.
 */
export interface PolicyEngine {
  check(call: OperationCall, ctx: InvokerContext): PolicyDecision;
}

/**
 * Operations — THE single mutation entry point (§4.1, §9.1). Every change to the
 * tree goes through here, and `invoke_command` calls `PolicyEngine.check` before
 * routing the command via the `CommandRegistry` and applying the returned ops.
 *
 * Canonical constructor:
 *   `new Operations(tree: BlockTree, policy: PolicyEngine, commands: CommandRegistry)`
 *
 * `apply` is the system primitive the runtime uses to write blocks that NO app
 * owns — specifically the commands-only feedback block (§4.2). It is
 * invoker-tagged (`invoker:'app'`) and STILL passes through
 * PolicyEngine so the chokepoint stays uniform (no bypass, §9.1). It is not a
 * back door: it carries ops, not free text, and policy decides per invoker.
 *
 * SCOPE (wave 2): this interface is the CROSS-MODULE surface — exactly what the
 * runtime/index wire against. The concrete `Operations` class ALSO exposes
 * policy-aware low-level primitives (`find`/`read`/`view`/`create`/`update`/
 * `delete`/`move`, each running PolicyEngine.check and returning a PolicyDecision)
 * under reserved `core.*` command names; those are impl-core-internal + test
 * surface, deliberately NOT in this contract so the contract stays the minimal
 * thing other modules depend on. The concrete class is a superset of this.
 */
export interface Operations {
  /** §4.1: the command door. Resolves → PolicyEngine.check → route → apply ops. */
  invoke_command(
    full_name: string,
    args: unknown,
    invoker_ctx: InvokerContext,
  ): Promise<CommandResult>;

  /**
   * Apply raw BlockOps under an invoker tag (still policy-checked). Used by the
   * runtime for owner-less system writes (the commands-only feedback block)
   * and by command results internally. Returns the resulting decision so callers
   * can surface deny/pending. Throws nothing for deny — reports it in the result.
   * (Callers that ignore the decision — e.g. the runtime's fire-and-forget
   * bookkeeping writes — are fine; the return is there when you need it.)
   */
  apply(ops: BlockOp[], invoker_ctx: InvokerContext): Promise<PolicyDecision>;

  /**
   * Whether a live block with this name currently exists. The runtime uses it to
   * decide create-vs-update when writing its own owner-less bookkeeping blocks
   * (commands-only feedback, command-error blocks). Read-only, O(1); delegates to
   * the underlying BlockTree.has.
   */
  has(name: BlockName): boolean;

  /** Freeze a snapshot for rendering (delegates to the underlying BlockTree). */
  snapshot(): BlockSnapshot;
}

/**
 * Renderer — flattens a BlockSnapshot into a byte-identical RenderedPrompt,
 * looking up each block's cache_tier via the BuilderRegistry and segmenting into
 * the three tiers (§10).
 *
 * INVARIANT #1: render(sameSnapshot) twice → byte-identical output.
 *
 * Canonical constructor: `new Renderer(builders: BuilderRegistry)` — the registry
 * is injected ONCE at construction (a stable dependency), NOT passed per render.
 */
export interface Renderer {
  render(snapshot: BlockSnapshot): Promise<RenderedPrompt>;
}
