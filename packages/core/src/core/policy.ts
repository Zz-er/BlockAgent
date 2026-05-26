/**
 * core/policy.ts — PolicyEngine (owned by impl-core)
 *
 * The security core that lives INSIDE Operations (§9.1 defense-in-depth): every
 * `invoke_command` calls `check` before routing, so there is no path to the tree
 * that skips it. `check` is a pure, O(1) in-memory table lookup — NO IO, NO
 * network (INVARIANT #19). It decides allow / deny / pending from two inputs:
 * the normalized OperationCall and the InvokerContext (who is driving).
 *
 * Strictness is keyed off `invoker` (§9.4): user > agent in default trust, app is
 * system-level. The default per-invoker table below encodes:
 *   - capability ACL (granted set per invoker; agent is checked strictly),
 *   - credential subtree `*:credentials*` read-blob (only user/app see plaintext),
 *   - pinned blocks (agent may not modify; user/app may),
 *   - private blocks (agent only its own),
 *   - dangerous commands (agent → pending approval; user → interactive confirm
 *     modeled as allow-with-confirm; app → allow),
 *   - physical delete (a capability the agent never holds, INVARIANT #5).
 *
 * Authoritative design: ai_com/block-agent-architecture-v3.1.md §9.3 / §9.4 / §9.6.
 *
 * House style: PolicyEngine is an actor → role name, no `Block` prefix.
 */

import type { Capability } from '../app/types.js';
import type {
  InvokerContext,
  OperationCall,
  PolicyDecision,
  // The wave-2 actor interface. Aliased because the concrete class is also named
  // `PolicyEngine`; the class `implements` the alias.
  PolicyEngine as PolicyEngineContract,
} from './types.js';

// ============================================================================
// Reserved full-names for the low-level Operations primitives
// ============================================================================

/**
 * Operations routes its own low-level primitives (find/read/create/update/
 * delete/move) through `check` too, under reserved `core.*` full-names, so the
 * single chokepoint covers them as well. Command full-names use a DOT (§0.5), so
 * these never collide with an App command `<app_id>.<cmd>` unless an App literally
 * claims the id `core` (reserved).
 */
export const PRIMITIVE_COMMANDS = {
  find: 'core.find',
  read: 'core.read',
  create: 'core.create',
  update: 'core.update',
  delete: 'core.delete',
  move: 'core.move',
} as const;

export type PrimitiveCommand =
  (typeof PRIMITIVE_COMMANDS)[keyof typeof PRIMITIVE_COMMANDS];

// ============================================================================
// Capability vocabulary (referenced by §9.4; structural — matches app/types.ts)
// ============================================================================

/**
 * Well-known capability names the default table reasons about. Apps may declare
 * others on their commands; the engine treats any name it does not special-case
 * as a plain ACL token checked against the invoker's granted set.
 */
export const CAP = {
  block_write: 'block:write',
  block_delete_physical: 'block:delete_physical',
  block_modify_pinned: 'block:modify_pinned',
  cred_read_blob: 'cred:read_blob',
  net_http: 'net:http',
  dangerous: 'op:dangerous',
} as const;

// ============================================================================
// Inputs the engine needs beyond the bare OperationCall
// ============================================================================

/**
 * A capability lookup the engine consults to learn what a command DECLARES it
 * needs (from its CommandManifest). Operations wires this to
 * `CommandRegistry.resolve_command(full_name)?.capabilities`. Kept as an injected pure
 * function so PolicyEngine never imports the registry (preserves the core↔app
 * decoupling) and stays O(1) — the resolver is an in-memory map lookup.
 */
export type CapabilityResolver = (full_name: string) => readonly Capability[];

/**
 * An invoker-allowlist lookup the engine consults to learn WHICH invokers a
 * command permits (from its CommandManifest `allowed_invokers`). Operations wires
 * this to `CommandRegistry.resolve_command(full_name)?.allowed_invokers`. Returns
 * `null`/`undefined` when the command declares no restriction (all invokers
 * allowed — the default, preserves prior behavior). Injected as a pure O(1) lookup
 * so PolicyEngine never imports the registry/manifest (core↔app decoupling) and
 * does not break INV #19.
 */
export type AllowedInvokersResolver = (
  full_name: string,
) => readonly InvokerContext['invoker'][] | null | undefined;

/** Per-invoker grant table: which capability names this invoker is allowed to exercise. */
export interface InvokerPolicy {
  /** Capability names granted by default (an allowlist). */
  granted: ReadonlySet<string>;
  /** Capability names that exist but require out-of-band approval → `pending`. */
  needs_approval: ReadonlySet<string>;
  /** Capability names this invoker is flatly denied. */
  denied: ReadonlySet<string>;
}

/**
 * PolicyTable — the full default policy, one row per invoker. Pure data; the
 * engine reads it in O(1). Exported so a host can clone + tweak it without
 * touching engine logic.
 */
export interface PolicyTable {
  user: InvokerPolicy;
  agent: InvokerPolicy;
  app: InvokerPolicy;
}

// ----------------------------------------------------------------------------
// §9.4 default table
// ----------------------------------------------------------------------------

/**
 * The default per-invoker policy (§9.4). Encodes the trust ordering user > agent,
 * app = system-level.
 *
 *   user  — broad grants; dangerous + pinned modification allowed (the host layer
 *           is responsible for any interactive confirmation; from the engine's
 *           view it is an allow).
 *   agent — strict: ordinary block writes/reads OK, but dangerous ops and
 *           net:http go to approval; physical delete, pinned modification, and
 *           credential plaintext are flatly denied (INV #5 / §9.6).
 *   app   — system-level: everything granted, nothing gated.
 */
export function default_policy_table(): PolicyTable {
  return {
    user: {
      granted: new Set([
        CAP.block_write,
        CAP.block_delete_physical,
        CAP.block_modify_pinned,
        CAP.cred_read_blob,
        CAP.net_http,
        CAP.dangerous,
      ]),
      needs_approval: new Set<string>(),
      denied: new Set<string>(),
    },
    agent: {
      // net:http is granted but the host must scope it to an allowlist (§9.4 H2);
      // from the engine's pure table the token is simply granted — host-side host
      // allowlisting is a separate (also O(1)) concern, not the engine's table.
      granted: new Set([CAP.block_write, CAP.net_http]),
      needs_approval: new Set([CAP.dangerous]),
      denied: new Set([
        CAP.block_delete_physical,
        CAP.block_modify_pinned,
        CAP.cred_read_blob,
      ]),
    },
    app: {
      granted: new Set([
        CAP.block_write,
        CAP.block_delete_physical,
        CAP.block_modify_pinned,
        CAP.cred_read_blob,
        CAP.net_http,
        CAP.dangerous,
      ]),
      needs_approval: new Set<string>(),
      denied: new Set<string>(),
    },
  };
}

// ============================================================================
// PolicyEngine
// ============================================================================

export interface PolicyEngineOptions {
  /** Override the default §9.4 table (e.g. tighten the agent row). */
  table?: PolicyTable;
  /**
   * Resolve a command's declared capabilities. Defaults to "declares nothing",
   * which means only the structural checks (target-name based) apply.
   */
  capability_resolver?: CapabilityResolver;
  /**
   * Resolve a command's invoker allowlist (`allowed_invokers`). Defaults to
   * "no restriction" (every command allows all invokers), preserving prior
   * behavior. When a command declares a list, an invoker not in it is denied
   * BEFORE any capability check.
   */
  allowed_invokers_resolver?: AllowedInvokersResolver;
  /**
   * Decide if a live block name is pinned. Pure + O(1) (a Set lookup). Defaults
   * to "nothing is pinned". The owning layer (AppRegistry/Operations) supplies it.
   */
  is_pinned?: (name: string) => boolean;
  /**
   * Decide if a live block name is private, and to which identity it belongs.
   * Returns the owner identity, or null if the block is not private. Pure + O(1).
   */
  private_owner?: (name: string) => string | null;
  /**
   * Monotonic token source for `pending` decisions. Injected (not Date.now /
   * crypto) to keep the engine deterministic and IO-free. Defaults to an internal
   * counter.
   */
  approval_token?: (call: OperationCall, ctx: InvokerContext) => string;
}

/**
 * PolicyEngine — `check` is the unbypassable gate. It is intentionally a pure
 * function of (call, ctx, injected-lookups): no IO, no network, no clock, no
 * randomness (INVARIANT #19; determinism keeps the security decision auditable
 * and replayable).
 */
export class PolicyEngine implements PolicyEngineContract {
  private readonly table: PolicyTable;
  private readonly resolve_caps: CapabilityResolver;
  private readonly resolve_allowed_invokers: AllowedInvokersResolver;
  private readonly is_pinned: (name: string) => boolean;
  private readonly private_owner: (name: string) => string | null;
  private readonly mint_token: (call: OperationCall, ctx: InvokerContext) => string;
  private token_seq = 0;

  /**
   * Canonical form is `new PolicyEngine(policyTable?)` (per the contract): pass a
   * §9.4 table override, or nothing for the default. The richer
   * `PolicyEngineOptions` form is also accepted so a host can inject the
   * capability resolver / pinned / private lookups (Operations uses this). We
   * detect which was passed by the presence of `InvokerPolicy`-shaped rows.
   */
  constructor(arg: PolicyTable | PolicyEngineOptions = {}) {
    const opts: PolicyEngineOptions = is_policy_table(arg) ? { table: arg } : arg;
    this.table = opts.table ?? default_policy_table();
    this.resolve_caps = opts.capability_resolver ?? (() => []);
    this.resolve_allowed_invokers = opts.allowed_invokers_resolver ?? (() => null);
    this.is_pinned = opts.is_pinned ?? (() => false);
    this.private_owner = opts.private_owner ?? (() => null);
    this.mint_token =
      opts.approval_token ?? ((_call, ctx) => `approval:${ctx.invoker}:${++this.token_seq}`);
  }

  /**
   * The single decision point. Returns the FIRST non-allow outcome it finds, in a
   * fixed precedence (deny before pending), so the result is deterministic.
   *
   * Precedence:
   *   0. invoker not in command's allowed_invokers → deny (the "who" gate)
   *   1. flatly-denied capability         → deny
   *   2. structural deny (pinned/private/credential/physical for this invoker) → deny
   *   3. capability needing approval        → pending
   *   4. ungranted (but not denied) capability → deny
   *   5. otherwise                          → allow
   */
  check(call: OperationCall, ctx: InvokerContext): PolicyDecision {
    const policy = this.row(ctx.invoker);

    // (0) invoker-allowlist gate ("who, not what"). A command may restrict which
    //     invokers run it (e.g. agent_identity.set is user-only). Absent list ⇒ no
    //     restriction. This runs FIRST so a forbidden invoker is denied regardless
    //     of capabilities. O(1): a small injected array membership test (INV #19).
    const allowed = this.resolve_allowed_invokers(call.full_name);
    if (allowed && !allowed.includes(ctx.invoker)) {
      return deny(
        `invoker '${ctx.invoker}' is not permitted to run '${call.full_name}' ` +
          `(allowed: ${allowed.join(', ')})`,
      );
    }

    // The effective set of capability names this call exercises = the command's
    // declared caps PLUS any implied by the primitive/target structure.
    const required = this.required_capabilities(call);

    // (1) any flatly-denied capability → deny immediately.
    for (const cap of required) {
      if (policy.denied.has(cap)) {
        return deny(`invoker '${ctx.invoker}' is denied capability '${cap}' for ${call.full_name}`);
      }
    }

    // (2) structural checks tied to the target block (pinned / private / cred).
    const structural = this.structural_decision(call, ctx);
    if (structural.kind !== 'allow') return structural;

    // (3) any capability needing approval → pending (park the runtime, §8.1).
    for (const cap of required) {
      if (policy.needs_approval.has(cap)) {
        return { kind: 'pending', token: this.mint_token(call, ctx) };
      }
    }

    // (4) a required capability that is neither granted nor approval-gated → deny.
    for (const cap of required) {
      if (!policy.granted.has(cap)) {
        return deny(
          `invoker '${ctx.invoker}' lacks capability '${cap}' for ${call.full_name}`,
        );
      }
    }

    // (5) clear.
    return { kind: 'allow' };
  }

  // ---- internals (all O(1) / pure) ----------------------------------------

  private row(invoker: InvokerContext['invoker']): InvokerPolicy {
    // The union is closed; this is exhaustive.
    return this.table[invoker];
  }

  /**
   * Collect the capability names this call exercises:
   *   - whatever the CommandManifest declares (resolver), plus
   *   - structural implications of the primitive itself (physical delete, write).
   */
  private required_capabilities(call: OperationCall): Set<string> {
    const caps = new Set<string>();
    for (const c of this.resolve_caps(call.full_name)) caps.add(c.name);

    switch (call.full_name) {
      case PRIMITIVE_COMMANDS.create:
      case PRIMITIVE_COMMANDS.update:
      case PRIMITIVE_COMMANDS.move:
        caps.add(CAP.block_write);
        break;
      case PRIMITIVE_COMMANDS.delete: {
        caps.add(CAP.block_write);
        if (is_physical_delete(call.args)) caps.add(CAP.block_delete_physical);
        break;
      }
      // find / read are read-only primitives: no write capability implied.
      default:
        break;
    }
    return caps;
  }

  /**
   * Structural, target-aware checks (§9.4). These look at the block NAME(s) the
   * call touches — supplied in `call.args` for the primitives — and apply the
   * pinned / private / credential rules. All lookups are O(1).
   */
  private structural_decision(
    call: OperationCall,
    ctx: InvokerContext,
  ): PolicyDecision {
    const target = target_name(call.args);

    // Credential subtree: `*:credentials*`. Reading plaintext (read-blob) is
    // user/app only; the agent may resolve an alias (plain read) but never the
    // blob. We approximate "read-blob" as the read primitive against a credential
    // name carrying a `read_blob: true` arg.
    if (target && is_credential_name(target)) {
      if (ctx.invoker === 'agent' && wants_read_blob(call)) {
        return deny(`agent may not read credential plaintext ('${target}')`);
      }
    }

    // Pinned blocks: agent may not modify (§9.4 / §9.6). user/app may.
    if (target && ctx.invoker === 'agent' && is_mutating(call.full_name) && this.is_pinned(target)) {
      return deny(`agent may not modify pinned block '${target}'`);
    }

    // Private blocks: agent may only touch its own private subtree.
    if (target && ctx.invoker === 'agent') {
      const owner = this.private_owner(target);
      if (owner !== null && owner !== ctx.identity) {
        return deny(`agent '${ctx.identity ?? '<anon>'}' may not access private block '${target}' owned by '${owner}'`);
      }
    }

    return { kind: 'allow' };
  }
}

// ============================================================================
// Pure predicates over OperationCall.args (no IO; defensive on unknown shapes)
// ============================================================================

function deny(reason: string): PolicyDecision {
  return { kind: 'deny', reason };
}

/**
 * Discriminate a positional `PolicyTable` from the `PolicyEngineOptions` bag in
 * the constructor: a table has the three invoker rows, each an `InvokerPolicy`
 * with a `granted` Set. The options bag never has a `user.granted` shape.
 */
function is_policy_table(arg: PolicyTable | PolicyEngineOptions): arg is PolicyTable {
  const maybe = arg as Partial<PolicyTable>;
  return (
    !!maybe.user &&
    !!maybe.agent &&
    !!maybe.app &&
    maybe.user.granted instanceof Set
  );
}

/** True for primitives (and any command) that mutate the tree. */
function is_mutating(full_name: string): boolean {
  return (
    full_name === PRIMITIVE_COMMANDS.create ||
    full_name === PRIMITIVE_COMMANDS.update ||
    full_name === PRIMITIVE_COMMANDS.delete ||
    full_name === PRIMITIVE_COMMANDS.move
  );
}

/** Pull a `target`/`name`/`parent` block-name string out of an args object, if any. */
function target_name(args: unknown): string | null {
  if (!is_record(args)) return null;
  for (const key of ['target', 'name', 'parent', 'new_parent'] as const) {
    const v = args[key];
    if (typeof v === 'string') return v;
  }
  return null;
}

function is_physical_delete(args: unknown): boolean {
  return is_record(args) && args['physical'] === true;
}

function wants_read_blob(call: OperationCall): boolean {
  return is_record(call.args) && call.args['read_blob'] === true;
}

/** Credential subtree convention: any block under `<app>:credentials...` (§9.4). */
function is_credential_name(name: string): boolean {
  const colon = name.indexOf(':');
  if (colon < 0) return false;
  const local = name.slice(colon + 1);
  return local === 'credentials' || local.startsWith('credentials/') || local.startsWith('credentials.');
}

function is_record(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
