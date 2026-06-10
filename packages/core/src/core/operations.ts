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
import { BlockTree, BlockTreeError, is_valid_block_name, owner_app_id } from './block.js';
import { current_chain_trust, run_in_chain, stricter_trust } from './taint.js';
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
      // Authoritative sandboxed-lane input (UH-2 §3.8): resolve the owning App's
      // declared trust so an untrusted App is gated by the tightened row even if a
      // caller forgets to stamp InvokerContext.trust (fail-closed).
      trust_resolver: (full_name) => deps.registry.trust_of(full_name),
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

    // (3) route to the owning App (already authorized). Wrap the route in the taint
    //     chain: the subtree's trust is the STRICTER of the inherited chain trust and
    //     THIS call's effective trust (sandbox-taint propagation, SS3). So a nested
    //     `ctx.invoke_command` inside the handler — even one targeting a TRUSTED app —
    //     inherits the sandboxed floor and cannot launder the taint (the hole this
    //     fixes). A top-level trusted call sets a `trusted` chain (no-op floor); a
    //     top-level sandboxed call (or any sandboxed ancestor) pins `sandboxed`.
    const chain_trust = stricter_trust(
      current_chain_trust(),
      this.policy.effective_trust_for(full_name, ctx),
    );
    let result: CommandResult;
    try {
      result = await run_in_chain(chain_trust, () => this.registry.route(full_name, args, ctx));
    } catch (err) {
      return { status: 'error', error: error_message(err) };
    }

    // A command may report its own failure; if so, do NOT apply its ops.
    if (!result.ok) return { status: 'ok', result };

    // (3.5) For a SANDBOXED command, RE-GATE the ops it actually RETURNED, per op
    //     (UH-2 §3.8). The check at (1) only authorized the command by its DECLARED
    //     capabilities (full_name → resolver). The ops a command returns are its real
    //     write, and for an untrusted app "declared" is not trustworthy: it can
    //     declare only `block:write` yet return a physical-delete / pinned-modify /
    //     credential op — the cap-set check at (1) never sees it. So for a sandboxed
    //     command we re-check every returned op under its own `core.*` primitive name,
    //     the same gate `apply()` uses, BEFORE touching the tree. This turns the
    //     "declared" gate into a "behavior" gate (closes the result.ops bypass).
    //
    //     Scope: ONLY when the owning command resolves to `sandboxed` (the stricter
    //     of registry trust and any caller stamp). A trusted app, the agent, and the
    //     user keep the EXACT prior path — no per-op re-check, no added cost or blast
    //     radius — because for them "declared = behavior" is a trusted assumption
    //     (the agent's own ops are already gated at (1)/(2) by its row).
    //
    //     Trust threading: the op names are reserved `core.*` primitives with NO
    //     owning app, so `trust_of('core.delete')` is undefined — a per-op check
    //     keyed off the op name alone would drop the sandboxed floor. We stamp the
    //     resolved `sandboxed` trust onto the per-op ctx so the sandboxed row +
    //     structural floor (physical/pinned/cred) apply to the ops exactly as if the
    //     command itself had declared them.
    //     Taint (SS3): the re-gate also fires when the CHAIN is sandboxed even if THIS
    //     command resolves trusted — a trusted intermediary executing inside a
    //     sandboxed chain must not emit destructive ops under full trust. We fold the
    //     inherited chain trust into the decision (stricter wins).
    const effective_with_chain = stricter_trust(
      current_chain_trust(),
      this.policy.effective_trust_for(full_name, ctx),
    );
    if (result.ops && result.ops.length > 0 && effective_with_chain === 'sandboxed') {
      // (3.5a) NAMESPACE-OWNERSHIP gate (cross-ns write isolation, task#12). The
      //     per-op capability re-check below catches the destructive trio
      //     (physical/pinned/cred), but an ordinary `block:write` op that targets a
      //     DIFFERENT app's namespace (`create victimapp:injected`, `update
      //     victimapp:data`) is granted to the sandboxed lane — yet it writes into
      //     another App's subtree. block.ts enforces single-owner-per-name (INV #3)
      //     but no "writer app_id == target namespace" ACL. This is a DIFFERENT axis
      //     from the capability ceiling (ceiling = which operation classes; this =
      //     which OBJECTS): an untrusted App may only write blocks IT OWNS. We resolve
      //     the writer authoritatively from the OWNING COMMAND's app_id (the part
      //     before the first `.` of `full_name`) — not from `ctx.identity`, which on a
      //     cross-App call is the CALLER, not the App whose command body produced these
      //     ops — and require every block name the op references (the object it writes
      //     PLUS the parent/destination it writes under) to live in that namespace.
      //     This also subsumes the `credentials_new`/`credentials2` naming seam: such a
      //     block is in the victim's namespace, so the cross-ns deny fires regardless of
      //     the `is_credential_name` pattern. Trusted user/app never reach this branch.
      const writer = command_app_id(full_name);
      for (const op of result.ops) {
        const foreign = foreign_namespace_target(op, writer);
        if (foreign !== null) {
          return {
            status: 'denied',
            reason:
              `sandboxed app '${writer}' may not write block '${foreign}' outside its own ` +
              `namespace '${writer}:' (cross-namespace write isolation)`,
          };
        }
      }

      // (3.5b) per-op capability/structural re-check (the destructive-trio gate).
      const op_ctx: InvokerContext = { ...ctx, trust: 'sandboxed' };
      for (const op of result.ops) {
        const decision = this.policy.check(
          { full_name: primitive_for(op), args: op_policy_args(op) },
          op_ctx,
        );
        if (decision.kind === 'deny') return { status: 'denied', reason: decision.reason };
        if (decision.kind === 'pending') return { status: 'pending', token: decision.token };
      }
    }

    // (4) apply the (now per-op authorized) ops to the tree as one logical change
    //     (rolls back on a bad op rather than leaving a half-applied tree).
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

  /**
   * invoke_query — a pure READ down the command path (R-3, C-API-9 / CM-1). Same
   * front half as `invoke_command` — `PolicyEngine.check` FIRST (unbypassable),
   * then resolve + route to the owning App — but it NEVER applies ops: it returns
   * only the command's `CommandResult.data` and DROPS any `ops` the command
   * produced. So a contract provider's `via` command can be pulled at render-time
   * (consume-refresh) with byte-identical rendering (INVARIANT #1) guaranteed by
   * MECHANISM, not convention: there is no `applyOps` call on this path at all.
   *
   * It is the query twin of `invoke_command`: deny/pending surface as `ok:false`
   * with the same `data.policy` marker so a caller holding only the contract type
   * can branch; a thrown command becomes an error result. The registry asserts a
   * `provides.via` command is `readonly` at assemble time; this is the runtime arm
   * that makes "readonly" true regardless of what the command's body returns.
   */
  async invoke_query(
    full_name: string,
    args: unknown,
    invoker_ctx: InvokerContext,
  ): Promise<CommandResult> {
    const call: OperationCall = { full_name, args };

    // (1) THE check — first, unbypassable (exactly as invoke_command).
    const decision = this.policy.check(call, invoker_ctx);
    if (decision.kind === 'deny')
      return { ok: false, error: decision.reason, data: { policy: 'deny', reason: decision.reason } };
    if (decision.kind === 'pending')
      return { ok: false, error: 'approval pending', data: { policy: 'pending', token: decision.token } };

    // (2) command must exist.
    if (this.registry.resolve_command(full_name) === null) {
      return { ok: false, error: `no such command: ${full_name}` };
    }

    // (3) route to the owning App (already authorized).
    let result: CommandResult;
    try {
      result = await this.registry.route(full_name, args, invoker_ctx);
    } catch (err) {
      return { ok: false, error: error_message(err) };
    }

    // (4) A query NEVER writes the tree: we return only `data` and deliberately
    //     drop any `ops` the command produced (the R-3 mechanism guarantee). A
    //     self-reported failure passes through unchanged (still no apply).
    if (!result.ok) return result;
    return { ok: true, data: result.data };
  }

  // ---- §4.2 system write primitive (owner-less blocks) --------------------

  /**
   * Apply raw BlockOps under an invoker tag, STILL through PolicyEngine (§9.1: no
   * bypass). This is the runtime's door for owner-less system writes — the
   * commands-only feedback block (§4.2) — and for projection-block seed/unseed
   * (launch.ts). It carries ops, not free text, so it is not a back door. Returns
   * the PolicyDecision; on `allow` the ops are applied (atomically), on deny/pending
   * nothing is written.
   *
   * FAIL-CLOSED DEFAULT (UH-2 §3.8, task#10). The ops here carry reserved `core.*`
   * primitive names that have NO owning app, so the PolicyEngine's `trust_resolver`
   * (`trust_of('core.delete')` → undefined) cannot recover a sandboxed floor from the
   * op name. That left `apply()` keyed on `invoker_ctx.trust` ALONE, whose absence
   * fell back to the full-trust `app` row — a fail-OPEN footgun: any caller that
   * reached `apply()` with `{invoker:'app'}` and no trust stamp (or a future refactor
   * that routed sandboxed work here) would get physical-delete / pinned-modify /
   * credential writes silently granted.
   *
   * We flip the default to fail-CLOSED: an `invoker:'app'` call that does NOT carry an
   * explicit `trust` is treated as `sandboxed` (the strict lane) for the per-op check.
   * Full trust is now an explicit OPT-IN: the trusted system callers (index.ts seed,
   * launch.ts seed/unseed) stamp `trust:'trusted'` and keep their full-power writes
   * (seed pinned/system blocks) unchanged. The security property no longer rests on
   * the unenforced assumption "no app can reach apply()" (task#13) — a forgotten stamp
   * on a NEW caller now fails closed by default instead of opening the floor. Only the
   * unstamped `app` lane is affected; user/agent and explicitly-stamped calls are
   * unchanged (zero regression for every existing stamped caller).
   */
  async apply(ops: BlockOp[], invoker_ctx: InvokerContext): Promise<PolicyDecision> {
    if (ops.length === 0) return { kind: 'allow' };

    // Fail-closed: an unstamped `app` call defaults to the strict `sandboxed` lane.
    // (`effective_trust` takes the STRICTER of resolved-app-trust and the stamp, so an
    // explicit `trust:'trusted'` here still resolves to trusted — full power — while an
    // absent stamp now resolves to sandboxed instead of the old fail-open trusted.)
    //
    // Taint (SS3, team-lead ④): also fold the CURRENT CHAIN trust in (stricter wins),
    // so an `apply()` reached from inside a sandboxed chain is gated under the
    // sandboxed floor EVEN IF this ctx was stamped `trusted` (a trusted intermediary
    // writing on behalf of a sandboxed ancestor cannot use full power). A top-level
    // trusted writer (no sandboxed ancestor) keeps full trust — zero regression.
    const chain_trust = current_chain_trust();
    const base: InvokerContext =
      invoker_ctx.invoker === 'app' && invoker_ctx.trust === undefined
        ? { ...invoker_ctx, trust: 'sandboxed' }
        : invoker_ctx;
    const ctx: InvokerContext =
      chain_trust === undefined
        ? base
        : { ...base, trust: stricter_trust(base.trust, chain_trust) };

    // Gate EVERY op under its own primitive full-name so the §9.4 structural and
    // capability checks (physical delete, pinned, private) each apply. The batch
    // is authorized only if every op is allowed; the first non-allow short-circuits
    // and nothing is written. A `pending` op parks the whole batch.
    for (const op of ops) {
      const decision = this.policy.check(
        { full_name: primitive_for(op), args: op_policy_args(op) },
        ctx,
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

/**
 * The owning App id of a command full-name (`<app_id>.<cmd>`, DOT-delimited per
 * §0.5). This is the AUTHORITATIVE writer for the cross-namespace gate: the ops a
 * command returns were produced by that App's command body, regardless of who
 * CALLED it (a cross-App call stamps the caller in `ctx.identity`, not the owner).
 * Command names use a dot; block names use a colon — they never collide.
 */
function command_app_id(full_name: string): string {
  const dot = full_name.indexOf('.');
  return dot < 0 ? full_name : full_name.slice(0, dot);
}

/**
 * If a write op references ANY block name outside `writer`'s namespace, return the
 * first such name; otherwise null. "References" = every name the op WRITES (the
 * object it creates/mutates) AND every name it writes UNDER (parent / new_parent),
 * because appending a child into another App's block, or moving a node under it, is
 * also a write into that App's subtree. The owner of a block name is the part before
 * its first colon (`owner_app_id`, INV #15); a malformed name has no owner and is
 * treated as foreign (fail-closed). Pure + O(1) per op.
 */
function foreign_namespace_target(op: BlockOp, writer: string): string | null {
  const names: string[] = [];
  switch (op.kind) {
    case 'create':
      names.push(op.parent, op.block.name);
      break;
    case 'append':
      names.push(op.target, op.child.name);
      break;
    case 'update':
      names.push(op.target);
      break;
    case 'delete':
      names.push(op.target);
      break;
    case 'move':
      names.push(op.target, op.new_parent);
      break;
    default: {
      const _never: never = op;
      return String(_never);
    }
  }
  for (const name of names) {
    if (!owns_namespace(name, writer)) return name;
  }
  return null;
}

/** True iff block `name`'s owner namespace (before the first colon) equals `writer`. */
function owns_namespace(name: string, writer: string): boolean {
  if (!is_valid_block_name(name)) return false; // malformed → not owned (fail-closed)
  return owner_app_id(name) === writer;
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
