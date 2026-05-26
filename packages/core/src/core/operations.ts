/**
 * core/operations.ts — Operations (owned by impl-core)
 *
 * THE single mutation door (§2 ② / §4). Every change to the BlockTree — whether
 * an App command, a runtime system write, or a low-level primitive — flows
 * through here, and the FIRST thing that happens is `PolicyEngine.check`. That
 * ordering is the whole security model: the check sits INSIDE the chokepoint, so
 * a caller that reached Operations still cannot skip it (§9.1 defense-in-depth,
 * INVARIANT §9.6 "无旁路").
 *
 * invoke_command(full_name, args, ctx):
 *   1. policy.check(call, ctx)               ← before anything else, no bypass
 *   2. deny → error result · pending → parked result (runtime → paused_for_approval)
 *   3. CommandRegistry.route(...)            ← run the (now authorized) command
 *   4. apply each returned BlockOp to the tree
 *   5. return the command's CommandResult
 *
 * DECOUPLING (ARCHITECTURE §dep-rule 1/2): Operations depends ONLY on the
 * `CommandRegistry` INTERFACE from app/types.ts — never on app/registry.ts or any
 * concrete App. AppRegistry implements that interface and is injected. core never
 * imports app impls; this is the seam that breaks the core↔app cycle.
 *
 * House style: Operations is an actor → role name, no `Block` prefix.
 */

import type {
  Capability,
  CommandRegistry,
  CommandResult,
} from '../app/types.js';
import type {
  Block,
  BlockName,
  BlockNamePattern,
  BlockOp,
  BlockSnapshot,
  BlockView,
  InvokerContext,
  OperationCall,
  PolicyDecision,
  // The wave-2 actor interface. Aliased because the concrete class is also named
  // `Operations`; the class `implements` the alias.
  Operations as OperationsContract,
} from './types.js';
import { BlockTree, BlockTreeError, is_valid_block_name } from './block.js';
import { PolicyEngine, PRIMITIVE_COMMANDS } from './policy.js';

// ============================================================================
// Outcome types (impl-core extensions, not in the contract interface)
// ============================================================================

/**
 * InvokeOutcome — the FULL result of `invoke_command_detailed`, carrying the
 * policy decision alongside the command result. `invoke_command` (the contract
 * method) returns a contract-shaped `CommandResult`; the detailed form is for the
 * runtime, which must distinguish `pending` (→ park in `paused_for_approval`)
 * from a plain failure.
 */
export type InvokeOutcome =
  | { status: 'ok'; result: CommandResult }
  | { status: 'denied'; reason: string }
  | { status: 'pending'; token: string }
  | { status: 'error'; error: string };

/** Result of a policy-gated read primitive (find_checked/read_checked/view). */
export interface PrimitiveReadResult {
  decision: PolicyDecision;
  /** Present only when the decision was `allow`. */
  block?: Readonly<Block> | null;
}

// ============================================================================
// Operations
// ============================================================================

export class Operations implements OperationsContract {
  private readonly tree: BlockTree;
  private readonly registry: CommandRegistry;
  private readonly policy: PolicyEngine;

  /**
   * Canonical constructor (per the wave-2 contract):
   *   `new Operations(tree, policy, commands)`
   *
   * `policy` is constructed by the host. To keep the §9.4 capability ACL aware of
   * what each command declares, the host should build the PolicyEngine with a
   * `capability_resolver` wired to the registry — `Operations.with_default_policy`
   * does exactly that for the common case.
   */
  constructor(tree: BlockTree, policy: PolicyEngine, commands: CommandRegistry) {
    this.tree = tree;
    this.policy = policy;
    this.registry = commands;
  }

  /**
   * Convenience factory: build Operations with a default PolicyEngine whose
   * capability resolver reads command manifests via the registry (O(1) map lookup,
   * IO-free — INVARIANT #19). Equivalent to the old options-bag constructor. Use
   * this from index.ts / runtime boot when you don't need a custom policy table.
   */
  static with_default_policy(deps: { tree: BlockTree; registry: CommandRegistry }): Operations {
    const policy = new PolicyEngine({
      capability_resolver: (full_name) => declared_capabilities(deps.registry, full_name),
      allowed_invokers_resolver: (full_name) => declared_allowed_invokers(deps.registry, full_name),
    });
    return new Operations(deps.tree, policy, deps.registry);
  }

  /** The live tree (trusted in-process callers; e.g. the Renderer takes a snapshot). */
  get block_tree(): BlockTree {
    return this.tree;
  }

  // ---- §4.1 the command door ----------------------------------------------

  /**
   * Invoke a command end-to-end (contract-shaped result). Policy is checked
   * FIRST; on deny/pending no command runs and no op touches the tree. On allow
   * the command runs and its ops are applied to the tree.
   *
   * deny/pending/error surface as `ok:false` with a machine-readable marker in
   * `data.policy` so a caller holding only the contract type can still branch.
   * Use `invoke_command_detailed` for the typed outcome.
   */
  async invoke_command(
    full_name: string,
    args: unknown,
    invoker_ctx: InvokerContext,
  ): Promise<CommandResult> {
    const outcome = await this.invoke_command_detailed(full_name, args, invoker_ctx);
    switch (outcome.status) {
      case 'ok':
        return outcome.result;
      case 'denied':
        return { ok: false, error: outcome.reason, data: { policy: 'deny', reason: outcome.reason } };
      case 'pending':
        return { ok: false, error: 'approval pending', data: { policy: 'pending', token: outcome.token } };
      case 'error':
        return { ok: false, error: outcome.error };
      default: {
        const _never: never = outcome;
        return { ok: false, error: `unknown outcome ${JSON.stringify(_never)}` };
      }
    }
  }

  /** As `invoke_command`, but returns the typed `InvokeOutcome` (for the runtime). */
  async invoke_command_detailed(
    full_name: string,
    args: unknown,
    ctx: InvokerContext,
  ): Promise<InvokeOutcome> {
    const call: OperationCall = { full_name, args };

    // (1) THE check — first, unbypassable.
    const decision = this.policy.check(call, ctx);
    if (decision.kind === 'deny') return { status: 'denied', reason: decision.reason };
    if (decision.kind === 'pending') return { status: 'pending', token: decision.token };

    // (2) command must exist.
    if (this.registry.resolve_command(full_name) === null) {
      return { status: 'error', error: `no such command: ${full_name}` };
    }

    // (3) route to the owning App (already authorized).
    let result: CommandResult;
    try {
      result = await this.registry.route(full_name, args, ctx);
    } catch (err) {
      return { status: 'error', error: error_message(err) };
    }

    // A command may report its own failure; if so, do NOT apply its ops.
    if (!result.ok) return { status: 'ok', result };

    // (4) apply the authorized ops to the tree as one logical change (rolls back
    //     on a bad op rather than leaving a half-applied tree).
    if (result.ops && result.ops.length > 0) {
      try {
        this.tree.applyOps(result.ops);
      } catch (err) {
        return {
          status: 'error',
          error: err instanceof BlockTreeError ? err.message : error_message(err),
        };
      }
    }

    return { status: 'ok', result };
  }

  // ---- §4.2 system write primitive (owner-less blocks) --------------------

  /**
   * Apply raw BlockOps under an invoker tag, STILL through PolicyEngine (§9.1: no
   * bypass). This is the runtime's door for owner-less system writes — the
   * commands-only feedback block (§4.2) — typically with
   * `invoker:'app'` (which the §9.4 table does not gate on capability, but the
   * chokepoint stays uniform). It carries ops, not free text, so it is not a back
   * door. Returns the PolicyDecision; on `allow` the ops are applied (atomically),
   * on deny/pending nothing is written.
   */
  async apply(ops: BlockOp[], invoker_ctx: InvokerContext): Promise<PolicyDecision> {
    if (ops.length === 0) return { kind: 'allow' };

    // Gate EVERY op under its own primitive full-name so the §9.4 structural and
    // capability checks (physical delete, pinned, private) each apply. The batch
    // is authorized only if every op is allowed; the first non-allow short-circuits
    // and nothing is written. A `pending` op parks the whole batch.
    for (const op of ops) {
      const decision = this.policy.check(
        { full_name: primitive_for(op), args: op_policy_args(op) },
        invoker_ctx,
      );
      if (decision.kind !== 'allow') return decision;
    }

    this.tree.applyOps(ops);
    return { kind: 'allow' };
  }

  // ---- §4 read-only primitives (contract: ungated convenience reads) ------

  /**
   * Find live blocks whose name matches a pattern (e.g. `memory:*`). Read-only
   * convenience over the current tree; NOT policy-gated (a plain read of the
   * trusted in-process tree). For a policy-gated read (private/credential checks),
   * use `find_checked` / `read_checked`.
   */
  find(pattern: BlockNamePattern): Block[] {
    const re = pattern_to_regexp(pattern);
    const out: Block[] = [];
    const root = this.tree.get_root();
    collect(root, (b) => {
      if (re.test(b.name)) out.push(b);
    });
    return out;
  }

  /** Read a live block by exact name; null if absent. Read-only convenience. */
  read(name: BlockName): Block | null {
    return this.tree.get(name);
  }

  /**
   * Whether a live block with this name currently exists (O(1), delegates to
   * BlockTree.has). The runtime uses it to decide create-vs-update for its own
   * owner-less bookkeeping blocks (commands-only feedback / command-error blocks).
   */
  has(name: BlockName): boolean {
    return this.tree.has(name);
  }

  /** Freeze a snapshot for rendering (delegates to BlockTree). */
  snapshot(): BlockSnapshot {
    return this.tree.snapshot();
  }

  // ---- policy-gated reads (impl-core extensions) --------------------------
  //
  // These pass `policy.check` under reserved `core.*` full-names so private /
  // credential rules apply (§9.4). Use when the invoker is the agent and the read
  // must honor those rules; the bare `find`/`read` above are trusted convenience.

  /** Policy-gated lookup of a single block by name (private-block rules apply). */
  find_checked(name: BlockName, ctx: InvokerContext): PrimitiveReadResult {
    const decision = this.policy.check(
      { full_name: PRIMITIVE_COMMANDS.find, args: { name } },
      ctx,
    );
    if (decision.kind !== 'allow') return { decision };
    return { decision, block: this.tree.get(name) };
  }

  /**
   * Policy-gated content read. `read_blob:true` requests credential plaintext,
   * which the agent is denied (§9.4). Returns the live block on allow.
   */
  read_checked(name: BlockName, ctx: InvokerContext, opts: { read_blob?: boolean } = {}): PrimitiveReadResult {
    const decision = this.policy.check(
      {
        full_name: PRIMITIVE_COMMANDS.read,
        args: opts.read_blob ? { name, read_blob: true } : { name },
      },
      ctx,
    );
    if (decision.kind !== 'allow') return { decision };
    return { decision, block: this.tree.get(name) };
  }

  /** A zero-copy trusted BlockView (INVARIANT #18); read-policy applies. */
  view(name: BlockName, ctx: InvokerContext): { decision: PolicyDecision; view?: BlockView | null } {
    const decision = this.policy.check(
      { full_name: PRIMITIVE_COMMANDS.read, args: { name } },
      ctx,
    );
    if (decision.kind !== 'allow') return { decision };
    return { decision, view: this.tree.view(name) };
  }

  // ---- policy-gated mutation primitives (impl-core extensions) ------------

  /** Create a block under `parent` (mutating; needs block:write). */
  create(parent: BlockName, block: Block, ctx: InvokerContext, index?: number): PolicyDecision {
    return this.apply_primitive(
      PRIMITIVE_COMMANDS.create,
      { parent, name: block.name, ...(index !== undefined ? { index } : {}) },
      ctx,
      index !== undefined
        ? { kind: 'create', parent, block, index }
        : { kind: 'create', parent, block },
    );
  }

  /** Update a block's content (mutating; needs block:write; pinned-gated for agent). */
  update(
    target: BlockName,
    patch: { content_text?: string | null; content_blob?: Block['content_blob'] },
    ctx: InvokerContext,
  ): PolicyDecision {
    return this.apply_primitive(PRIMITIVE_COMMANDS.update, { target }, ctx, {
      kind: 'update',
      target,
      ...('content_text' in patch ? { content_text: patch.content_text } : {}),
      ...('content_blob' in patch ? { content_blob: patch.content_blob } : {}),
    });
  }

  /**
   * Delete a block. Default is ARCHIVE (INVARIANT #5); `physical:true` requests
   * hard removal, a capability the agent never holds — PolicyEngine decides, the
   * tree just executes what survives the check.
   */
  delete(target: BlockName, ctx: InvokerContext, physical = false): PolicyDecision {
    return this.apply_primitive(
      PRIMITIVE_COMMANDS.delete,
      { target, physical },
      ctx,
      physical ? { kind: 'delete', target, physical: true } : { kind: 'delete', target },
    );
  }

  /** Move a block to a new parent (mutating; needs block:write). */
  move(target: BlockName, new_parent: BlockName, ctx: InvokerContext, index?: number): PolicyDecision {
    return this.apply_primitive(
      PRIMITIVE_COMMANDS.move,
      { target, new_parent, ...(index !== undefined ? { index } : {}) },
      ctx,
      index !== undefined
        ? { kind: 'move', target, new_parent, index }
        : { kind: 'move', target, new_parent },
    );
  }

  // ---- shared primitive path ----------------------------------------------

  private apply_primitive(
    full_name: string,
    policy_args: Record<string, unknown>,
    ctx: InvokerContext,
    op: BlockOp,
  ): PolicyDecision {
    const decision = this.policy.check({ full_name, args: policy_args }, ctx);
    if (decision.kind !== 'allow') return decision;
    this.tree.applyOp(op);
    return decision;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Read a command's declared capabilities via the registry; empty if unknown. */
function declared_capabilities(registry: CommandRegistry, full_name: string): readonly Capability[] {
  const manifest = registry.resolve_command(full_name);
  return manifest?.capabilities ?? [];
}

/**
 * Read a command's declared invoker allowlist via the registry; `null` (no
 * restriction) if the command is unknown or declares none. Mirrors
 * `declared_capabilities` so the "who" gate is wired the same way as the "what".
 */
function declared_allowed_invokers(
  registry: CommandRegistry,
  full_name: string,
): readonly InvokerContext['invoker'][] | null {
  return registry.resolve_command(full_name)?.allowed_invokers ?? null;
}

/** The reserved `core.*` primitive full-name that matches a BlockOp's kind. */
function primitive_for(op: BlockOp): string {
  switch (op.kind) {
    case 'create':
    case 'append':
      return PRIMITIVE_COMMANDS.create;
    case 'update':
      return PRIMITIVE_COMMANDS.update;
    case 'delete':
      return PRIMITIVE_COMMANDS.delete;
    case 'move':
      return PRIMITIVE_COMMANDS.move;
    default: {
      const _never: never = op;
      return String(_never);
    }
  }
}

/**
 * The policy args for a single op so the §9.4 structural checks (pinned/private)
 * see a target and a physical delete escalates the capability.
 */
function op_policy_args(op: BlockOp): Record<string, unknown> {
  switch (op.kind) {
    case 'create':
      return { parent: op.parent, name: op.block.name };
    case 'append':
      return { target: op.target, name: op.child.name };
    case 'update':
      return { target: op.target };
    case 'delete':
      return op.physical === true ? { target: op.target, physical: true } : { target: op.target };
    case 'move':
      return { target: op.target, new_parent: op.new_parent };
    default: {
      const _never: never = op;
      return { _never };
    }
  }
}

/** Convert a BlockNamePattern (glob with `*`) to an anchored RegExp. */
function pattern_to_regexp(pattern: BlockNamePattern): RegExp {
  // Escape regex metacharacters except `*`, then turn `*` into `.*`.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/** Depth-first collect over the live tree. */
function collect(node: Block, visit: (b: Block) => void): void {
  const stack: Block[] = [node];
  while (stack.length > 0) {
    const b = stack.pop();
    if (!b) break;
    visit(b);
    for (const child of b.children) stack.push(child);
  }
}

/** Re-export for hosts validating names before building ops. */
export { is_valid_block_name };

function error_message(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
