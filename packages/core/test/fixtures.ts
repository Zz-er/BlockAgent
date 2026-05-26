/**
 * test/fixtures.ts — test stubs (impl-runtime)
 *
 * Everything here is a ONE-OFF TEST FIXTURE, not a standard App and not production
 * code. v3.0 ships the App FRAMEWORK with NO predefined standard app
 * (ARCHITECTURE.md "What v3.0 builds"); the loop is proven end-to-end with the
 * fixtures below, which are deliberately minimal and clearly labeled.
 *
 * What's here:
 *   - makeEmptyTree(): a bare empty BlockTree root (`root:root`).
 *   - TestOperations: a contract-conformant `Operations` (core/types.ts) built on
 *     the REAL BlockTree + REAL PolicyEngine + a tiny CommandRegistry. It is the
 *     Operations the AgentRuntime drives in tests; the real core/operations.ts
 *     (impl-core) is interchangeable with it.
 *   - TestRenderer: a contract-conformant `Renderer` (core/types.ts) that segments
 *     a snapshot by cache_tier (via a BuilderRegistry) into a RenderedPrompt.
 *   - makeEchoApp / makeReplyApp: one-off fixture Apps (echo/reply) exercising the
 *     command path — explicitly demo stubs, not standard apps.
 */

import { BlockTree } from '../src/core/block.js';
import {
  PolicyEngine,
  PRIMITIVE_COMMANDS,
  type AllowedInvokersResolver,
  type CapabilityResolver,
} from '../src/core/policy.js';
import type {
  Block,
  BlockName,
  BlockOp,
  BlockSnapshot,
  CacheTier,
  InvokerContext,
  Operations,
  OperationCall,
  PolicyDecision,
  Renderer,
  RenderedPrompt,
} from '../src/core/types.js';
import type {
  BuilderManifest,
  BuilderRegistry,
  Capability,
  CommandManifest,
  CommandRegistry,
  CommandResult,
} from '../src/app/types.js';

// ============================================================================
// Empty tree boot
// ============================================================================

/** A bare empty-tree root, matching the boot example in core/block.ts. */
export function makeEmptyTree(): BlockTree {
  const root: Block = {
    id: 'root',
    name: 'root:root',
    children: [],
    content_text: null,
    content_blob: null,
  };
  return new BlockTree(root);
}

// ============================================================================
// A tiny in-memory CommandRegistry (the core↔app decoupling seam)
// ============================================================================

/**
 * TestCommandRegistry — maps `<app_id>.<command>` → CommandManifest and routes to
 * a per-command handler. Stands in for AppRegistry's CommandRegistry impl in tests
 * that don't need the full registry. Each registered command supplies its own
 * minimal AppContext-less handler (fixtures don't exercise App state).
 */
export class TestCommandRegistry implements CommandRegistry {
  private readonly commands = new Map<string, CommandManifest>();
  private readonly handlers = new Map<
    string,
    (args: unknown, invoker: InvokerContext) => Promise<CommandResult>
  >();

  register(
    full_name: string,
    manifest: CommandManifest,
    handler: (args: unknown, invoker: InvokerContext) => Promise<CommandResult>,
  ): void {
    this.commands.set(full_name, manifest);
    this.handlers.set(full_name, handler);
  }

  resolve_command(full_name: string): CommandManifest | null {
    return this.commands.get(full_name) ?? null;
  }

  async route(
    full_name: string,
    args: unknown,
    invoker: InvokerContext,
  ): Promise<CommandResult> {
    const handler = this.handlers.get(full_name);
    if (!handler) return { ok: false, error: `unknown command '${full_name}'` };
    return handler(args, invoker);
  }

  /** A CapabilityResolver wired to this registry, for the PolicyEngine. */
  capabilityResolver(): CapabilityResolver {
    return (full_name) => this.commands.get(full_name)?.capabilities ?? [];
  }

  /** An AllowedInvokersResolver wired to this registry, for the PolicyEngine. */
  allowedInvokersResolver(): AllowedInvokersResolver {
    return (full_name) => this.commands.get(full_name)?.allowed_invokers ?? null;
  }
}

// ============================================================================
// TestOperations — the single mutation door (Operations) over the real tree
// ============================================================================

/**
 * TestOperations — a contract-conformant `Operations` over the real BlockTree.
 * Runs PolicyEngine.check INSIDE invoke_command (§9.1, no bypass), then routes via
 * the CommandRegistry and applies the returned BlockOps. On deny/pending it returns
 * `ok:false` with the `data.policy` marker — exactly as the real core/operations.ts
 * does (the runtime reads that marker to park; it does NOT throw). `apply`
 * (invoker='app') is the runtime's bookkeeping-block primitive; it too passes
 * through the policy check under the reserved `core.*` names.
 */
export class TestOperations implements Operations {
  /** Records every (full_name, decision) for test assertions. */
  readonly decisions: Array<{ full_name: string; kind: string }> = [];

  constructor(
    private readonly tree: BlockTree,
    private readonly policy: PolicyEngine,
    private readonly registry: TestCommandRegistry,
  ) {}

  async invoke_command(
    full_name: string,
    args: unknown,
    invoker: InvokerContext,
  ): Promise<CommandResult> {
    const call: OperationCall = { full_name, args };
    const decision = this.policy.check(call, invoker);
    this.decisions.push({ full_name, kind: decision.kind });

    if (decision.kind === 'deny') {
      return { ok: false, error: decision.reason, data: { policy: 'deny', reason: decision.reason } };
    }
    if (decision.kind === 'pending') {
      return { ok: false, error: 'approval pending', data: { policy: 'pending', token: decision.token } };
    }

    const result = await this.registry.route(full_name, args, invoker);
    if (result.ok && result.ops) {
      for (const op of result.ops) this.tree.applyOp(op);
    }
    return result;
  }

  async apply(ops: BlockOp[], invoker: InvokerContext): Promise<PolicyDecision> {
    // Each runtime-owned op passes through the policy check under a reserved
    // primitive name, then applies. invoker='app' is system-level (granted).
    // `append` inserts a child, so it maps to the same write primitive as create.
    for (const op of ops) {
      const full_name =
        op.kind === 'append' ? PRIMITIVE_COMMANDS.create : PRIMITIVE_COMMANDS[op.kind];
      const decision = this.policy.check({ full_name, args: op }, invoker);
      this.decisions.push({ full_name, kind: decision.kind });
      if (decision.kind !== 'allow') return decision;
      this.tree.applyOp(op);
    }
    return { kind: 'allow' };
  }

  has(name: BlockName): boolean {
    return this.tree.has(name);
  }

  snapshot(): BlockSnapshot {
    return this.tree.snapshot();
  }
}

// ============================================================================
// TestBuilderRegistry + TestRenderer — deterministic tier-segmented rendering
// ============================================================================

/** Minimal BuilderRegistry mapping a block name → its declared cache_tier. */
export class TestBuilderRegistry implements BuilderRegistry {
  private readonly tiers = new Map<BlockName, CacheTier>();
  private readonly builders: BuilderManifest[] = [];

  declareTier(name: BlockName, tier: CacheTier): void {
    this.tiers.set(name, tier);
  }

  resolve_builder(_block_name: BlockName): BuilderManifest | null {
    return null; // fixtures don't run builders; tiers are declared directly.
  }

  tier_of(block_name: BlockName): CacheTier | null {
    return this.tiers.get(block_name) ?? null;
  }

  list_builders(): BuilderManifest[] {
    return this.builders;
  }
}

const TIER_ORDER: readonly CacheTier[] = ['stable', 'slow_changing', 'volatile'];

/**
 * TestRenderer — flattens a snapshot into a tier-segmented RenderedPrompt (§10),
 * U-shape-ordered by tier. Deterministic: it walks the snapshot in tree order,
 * groups each block's text under its tier (default 'volatile' if undeclared), and
 * emits one segment per non-empty tier with a cache_boundary. Same snapshot →
 * byte-identical output (INV #1), because BlockTree.snapshot is itself stable and
 * this code uses no clock/random.
 */
export class TestRenderer implements Renderer {
  constructor(private readonly builders: TestBuilderRegistry) {}

  async render(snapshot: BlockSnapshot): Promise<RenderedPrompt> {
    const byTier = new Map<CacheTier, string[]>();
    for (const tier of TIER_ORDER) byTier.set(tier, []);

    walkSnapshot(snapshot.root, (b) => {
      if (b.content_text === null) return;
      const tier = this.builders.tier_of(b.name) ?? 'volatile';
      byTier.get(tier)!.push(`${b.name}\n${b.content_text}`);
    });

    const segments: RenderedPrompt['segments'] = [];
    const segment_hashes = new Map<string, string>();
    for (const tier of TIER_ORDER) {
      const lines = byTier.get(tier)!;
      if (lines.length === 0) continue;
      const rendered = lines.join('\n');
      segments.push({ tier, rendered, cache_boundary: true });
      segment_hashes.set(tier, fnv1a(rendered));
    }

    return { segments, snapshot_hash: snapshot.hash, segment_hashes };
  }
}

// ============================================================================
// One-off fixture Apps (DEMO STUBS — not standard apps)
// ============================================================================

const NO_CAPS: Capability[] = [];

/**
 * makeReplyApp — a fixture "reply" command (`reply.say`) that writes the reply text
 * into a block `reply:last`. Demo stub only. The handler creates-or-updates the
 * block via returned ops. Requires `block:write` (granted to agent by default).
 */
export function makeReplyApp(registry: TestCommandRegistry): void {
  const manifest: CommandManifest = {
    name: 'say',
    description: 'Write a reply into reply:last (demo fixture).',
    capabilities: [{ name: 'block:write' }],
    invoke: async () => ({ ok: true }), // unused: TestCommandRegistry routes to handler
  };
  registry.register('reply.say', manifest, async (args) => {
    const text = readText(args);
    const op: BlockOp = {
      kind: 'create',
      parent: 'root:root',
      block: {
        id: 'reply-last',
        name: 'reply:last',
        children: [],
        content_text: text,
        content_blob: null,
      },
    };
    return { ok: true, ops: [op], data: { echoed: text } };
  });
}

/**
 * makeDangerousApp — a fixture command (`danger.run`) declaring the `op:dangerous`
 * capability, so the agent invoker resolves to `pending` (approval) per §9.4.
 */
export function makeDangerousApp(registry: TestCommandRegistry): void {
  const manifest: CommandManifest = {
    name: 'run',
    description: 'A dangerous demo command (forces approval for the agent).',
    capabilities: [{ name: 'op:dangerous' }],
    invoke: async () => ({ ok: true }),
  };
  registry.register('danger.run', manifest, async () => ({ ok: true }));
}

/**
 * makeUserOnlyApp — a fixture command (`identity.set`) declaring
 * `allowed_invokers: ['user']`, so PolicyEngine denies invoker=agent and
 * invoker=app outright (the "who, not what" gate). Mirrors the real
 * `agent_identity.set` shape: the agent must not rewrite its own identity.
 */
export function makeUserOnlyApp(registry: TestCommandRegistry): void {
  const manifest: CommandManifest = {
    name: 'set',
    description: 'Set identity (user/UI only; agent forbidden).',
    capabilities: [{ name: 'block:write' }],
    allowed_invokers: ['user'],
    invoke: async () => ({ ok: true }),
  };
  registry.register('identity.set', manifest, async () => ({ ok: true }));
}

/** A command declaring no capabilities, for the basic allow path. */
export function makeNoopApp(registry: TestCommandRegistry): void {
  const manifest: CommandManifest = {
    name: 'noop',
    description: 'No-op demo command (no capabilities).',
    capabilities: NO_CAPS,
    invoke: async () => ({ ok: true }),
  };
  registry.register('noop.noop', manifest, async () => ({ ok: true }));
}

// ============================================================================
// helpers
// ============================================================================

function readText(args: unknown): string {
  if (typeof args === 'object' && args !== null && 'text' in args) {
    const t = (args as { text: unknown }).text;
    if (typeof t === 'string') return t;
  }
  return '';
}

function walkSnapshot(
  node: Readonly<Block>,
  visit: (b: Readonly<Block>) => void,
): void {
  visit(node);
  for (const child of node.children) walkSnapshot(child, visit);
}

/** Stable FNV-1a hex used only for per-segment hashes in the test renderer. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
