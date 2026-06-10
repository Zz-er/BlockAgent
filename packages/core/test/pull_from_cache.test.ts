/**
 * test/pull_from_cache.test.ts — UH-2 SS4e (§3.6): pull-from-cache for a CHILD-PROCESS
 * contract provider.
 *
 * §3.6 (A-minimal): a child-process provider PUSHES its contract scalar to the CONVENTION
 * cell slot `state.__contracts__[<contract>]` (while active for its own reasons); consume-
 * refresh reads it SYNCHRONOUSLY from the provider's core-side cell — it does NOT fork/
 * activate/RPC the child. The read is local + deterministic (INV #1: the value was framed
 * back via set_state before the snapshot freezes), and "being consumed" no longer pulls a
 * child process alive. IRON RULE: the consume path NEVER forks/RPCs into a child — a child
 * with no pushed value DEGRADES to last-good (per-consumer-atomic, SS4d), it is NEVER routed
 * (no sync cross-process RPC on the render path). No manifest declaration — convention only.
 *
 * SCOPE (Atlas, team-lead-confirmed): no child-process provider exists today (built-ins are
 * trusted/in-process, already synchronous), so this tests the MECHANISM with a FIXTURE
 * child-process host — built-in apps are untouched (in-process providers always miss
 * pull_cached_contract and keep the exact prior route path, zero regression).
 *
 * Raven SS4e: INV #1 (the cell read is the pre-freeze authoritative value) + the child is
 * NOT activated/RPC'd on the cached path (route_command never called).
 */

import { describe, expect, it } from 'vitest';

import { BlockTree } from '../src/core/block.js';
import { Operations } from '../src/core/operations.js';
import { Renderer } from '../src/core/renderer.js';
import { AppRegistry, CONTRACT_CACHE_SLOT } from '../src/app/registry.js';
import { AgentRuntime } from '../src/runtime/agent_runtime.js';
import { MockProvider } from '../src/provider/mock.js';
import type { ContractDef } from '../src/app/contracts.js';
import type { AppHost } from '../src/app/app_host.js';
import type { AppContext, AppManifest, CommandManifest, CommandResult } from '../src/app/types.js';
import type { Block, BlockName, InvokerContext, WakeEvent } from '../src/core/types.js';

const WAKE = { kind: 'app_event', source: 'test', reason: 'tick', ref: 'r1' } as const;

// A scalar-number count contract, fan-in summed (like message_count).
const COUNT_SUM: ContractDef = {
  name: 'cache_count',
  version: '1',
  input_schema: {},
  output_schema: { type: 'number' },
  cardinality: 'many',
  combine: 'sum',
};

// ---------------------------------------------------------------------------
// A FAKE child-process host: kind='child-process', records route_command calls so a
// test can assert the cached path NEVER drives the child. It does not fork anything.
// ---------------------------------------------------------------------------

interface FakeChildHost extends AppHost {
  readonly route_calls: string[];
}

function makeFakeChildFactory(): {
  factory: (app_id: string, manifest: unknown, parts: { ctx: AppContext; run_uninstall: () => void; run_command: (c: string, a: unknown, i: InvokerContext) => Promise<CommandResult> }) => AppHost;
  hosts: Map<string, FakeChildHost>;
} {
  const hosts = new Map<string, FakeChildHost>();
  const factory = (
    app_id: string,
    _manifest: unknown,
    parts: { ctx: AppContext; run_uninstall: () => void; run_command: (c: string, a: unknown, i: InvokerContext) => Promise<CommandResult> },
  ): AppHost => {
    const route_calls: string[] = [];
    const host: FakeChildHost = {
      app_id,
      kind: 'child-process',
      active: false, // inactive child → consume must read the cell, not activate
      route_calls,
      // If consume-refresh ever drives the child for a CACHED contract, this records it →
      // the test asserts it stays empty. (It still works as the M3 fallback for undeclared.)
      async route_command(command, args, invoker) {
        route_calls.push(command);
        return parts.run_command(command, args, invoker);
      },
      async activate() {
        return parts.ctx;
      },
      current_context() {
        return null; // inactive child → null → pull-from-cell (§3.6)
      },
      async dispose() {
        parts.run_uninstall();
      },
    };
    hosts.set(app_id, host);
    return host;
  };
  return { factory, hosts };
}

/**
 * A child-process (sandboxed) provider. `pushed:true` pre-populates the CONVENTION cache
 * slot `state.__contracts__[<contract>]` (simulating the child having computed + pushed the
 * scalar while active for its own reasons); `pushed:false` leaves the slot absent (child
 * never activated). No manifest declaration — the slot is a convention (A-minimal). The
 * `via` command exists for the provides-table assertion but is NEVER reached on the cached
 * path (consume reads the cell, not the command).
 */
function cachingChildProvider(opts: { id: string; value: number; pushed: boolean }): AppManifest {
  const count: CommandManifest = {
    name: 'count',
    description: 'via command (NOT reached on the cached path — consume reads the cell)',
    readonly: true,
    allowed_invokers: ['app'],
    result_schema: { type: 'number' },
    capabilities: [],
    async invoke(_args: unknown, ctx: AppContext): Promise<CommandResult> {
      const slot = (ctx.state as Record<string, unknown>)[CONTRACT_CACHE_SLOT] as
        | Record<string, number>
        | undefined;
      return { ok: true, data: slot?.[COUNT_SUM.name] ?? 0 };
    },
  };
  return {
    id: opts.id,
    version: '1.0.0',
    depends_on: [],
    provides: [{ contract: COUNT_SUM.name, via: 'count' }],
    tree_namespace: `/${opts.id}`,
    // pushed → the convention slot holds the scalar; not pushed → no slot (degrade).
    initial_state: opts.pushed ? { [CONTRACT_CACHE_SLOT]: { [COUNT_SUM.name]: opts.value } } : {},
    state_schema: { type: 'object' },
    trust: 'sandboxed', // → child-process carrier
    builders: [],
    commands: [() => count],
  };
}

// An in-process consumer that folds the count into state.total.
function consumer(opts: { id: string; seed: number }): AppManifest {
  return {
    id: opts.id,
    version: '1.0.0',
    depends_on: [],
    consumes: [{ contract: COUNT_SUM.name, as: 'total' }],
    tree_namespace: `/${opts.id}`,
    initial_state: { total: opts.seed },
    state_schema: { type: 'object', required: ['total'], properties: { total: { type: 'number' } } },
    builders: [],
    commands: [],
  };
}

function emptyTree(): BlockTree {
  const root: Block = { id: 'root', name: 'core:root', children: [], content_text: null, content_blob: null };
  return new BlockTree(root);
}

// ---------------------------------------------------------------------------
// Registry-level: pull_cached_contract hit/miss matrix
// ---------------------------------------------------------------------------

describe('AppRegistry.pull_cached_contract — §3.6 verdict matrix (route / cell / degrade)', () => {
  it("'cell' for a child-process provider that declares + has a value (sync core-side read)", () => {
    const reg = new AppRegistry();
    reg.child_host_factory = makeFakeChildFactory().factory;
    reg.registerContract(COUNT_SUM);
    reg.install(cachingChildProvider({ id: 'prov', value: 7, pushed: true }));
    expect(reg.pull_cached_contract('prov', COUNT_SUM.name)).toEqual({ mode: 'cell', value: 7 });
  });

  it("'degrade' for a child-process provider WITHOUT a declaration (NEVER route a child)", () => {
    const reg = new AppRegistry();
    reg.child_host_factory = makeFakeChildFactory().factory;
    reg.registerContract(COUNT_SUM);
    reg.install(cachingChildProvider({ id: 'prov', value: 7, pushed: false }));
    expect(reg.pull_cached_contract('prov', COUNT_SUM.name)).toEqual({ mode: 'degrade' });
  });

  it("'degrade' for a child whose convention slot is still empty (child never pushed)", () => {
    const reg = new AppRegistry();
    reg.child_host_factory = makeFakeChildFactory().factory;
    reg.registerContract(COUNT_SUM);
    // A child provider whose convention slot is absent (initial_state {}) → never pushed.
    reg.install(cachingChildProvider({ id: 'prov', value: 0, pushed: false }));
    expect(reg.pull_cached_contract('prov', COUNT_SUM.name)).toEqual({ mode: 'degrade' });
  });

  it("'route' for an IN-PROCESS provider even if it has a __contracts__ slot (kind check, zero regression)", () => {
    const reg = new AppRegistry();
    reg.registerContract(COUNT_SUM);
    reg.install({
      id: 'inproc',
      version: '1.0.0',
      depends_on: [],
      provides: [{ contract: COUNT_SUM.name, via: 'count' }],
      tree_namespace: '/inproc',
      // Even with the convention slot populated, an in-process provider is 'route' (the
      // kind check short-circuits): in-process never diverts to the cell path.
      initial_state: { [CONTRACT_CACHE_SLOT]: { [COUNT_SUM.name]: 3 } },
      state_schema: { type: 'object' },
      builders: [],
      commands: [
        () => ({
          name: 'count',
          description: 'x',
          readonly: true,
          allowed_invokers: ['app'],
          result_schema: { type: 'number' },
          capabilities: [],
          async invoke(): Promise<CommandResult> {
            return { ok: true, data: 3 };
          },
        }),
      ],
    });
    expect(reg.pull_cached_contract('inproc', COUNT_SUM.name)).toEqual({ mode: 'route' });
  });

  it("'route' for an unknown app (the normal path errors there); 'degrade' for a child's undeclared contract", () => {
    const reg = new AppRegistry();
    reg.child_host_factory = makeFakeChildFactory().factory;
    reg.registerContract(COUNT_SUM);
    reg.install(cachingChildProvider({ id: 'prov', value: 7, pushed: true }));
    expect(reg.pull_cached_contract('nope', COUNT_SUM.name)).toEqual({ mode: 'route' });
    // The same child provider, queried for a DIFFERENT contract it doesn't cache → degrade
    // (still a child → never route).
    expect(reg.pull_cached_contract('prov', 'other_contract')).toEqual({ mode: 'degrade' });
  });

  it("'cell' reflects the LATEST value after write_app_cell (the child framed an update back)", () => {
    const reg = new AppRegistry();
    reg.child_host_factory = makeFakeChildFactory().factory;
    reg.registerContract(COUNT_SUM);
    reg.install(cachingChildProvider({ id: 'prov', value: 1, pushed: true }));
    // The child framed an updated push back to the convention slot via set_state.
    reg.write_app_cell('prov', { [CONTRACT_CACHE_SLOT]: { [COUNT_SUM.name]: 9 } });
    expect(reg.pull_cached_contract('prov', COUNT_SUM.name)).toEqual({ mode: 'cell', value: 9 });
  });
});

// ---------------------------------------------------------------------------
// consume-refresh integration: cached path is used and does NOT drive the child
// ---------------------------------------------------------------------------

function wire(manifests: AppManifest[], factory: ReturnType<typeof makeFakeChildFactory>['factory']) {
  const reg = new AppRegistry();
  reg.child_host_factory = factory;
  reg.registerContract(COUNT_SUM);
  for (const m of manifests) reg.install(m);
  const tree = emptyTree();
  const ops = Operations.with_default_policy({ tree, registry: reg });
  reg.commandRouter = (fn, a, inv) => ops.invoke_command(fn, a, inv);
  const renderer = new Renderer(reg, { app_context_provider: (id) => reg.get_app_context(id) });
  const runtime = new AgentRuntime({
    operations: ops,
    renderer,
    provider: new MockProvider([{}]),
    registry: reg,
    root_name: 'core:root' as BlockName,
  });
  return { reg, ops, runtime };
}

function totalOf(reg: AppRegistry, id: string): unknown {
  return (reg.get_app_context(id)?.state as { total?: unknown } | undefined)?.total;
}

describe('consume-refresh pull-from-cache (child-process provider, §3.6)', () => {
  it('folds the cached count into the consumer WITHOUT driving the child (no route_command)', async () => {
    const { factory, hosts } = makeFakeChildFactory();
    const { reg, runtime } = wire(
      [cachingChildProvider({ id: 'prov', value: 7, pushed: true }), consumer({ id: 'cons', seed: 0 })],
      factory,
    );

    await runtime.on_wake(WAKE as WakeEvent);

    expect(totalOf(reg, 'cons')).toBe(7); // pulled from the cell
    // The child was NEVER driven for the contract pull (no fork/RPC) — the §3.6 win.
    expect(hosts.get('prov')!.route_calls).toEqual([]);
  });

  it('is deterministic: same cell → same folded value across turns (INV #1)', async () => {
    const { factory } = makeFakeChildFactory();
    const { reg, runtime } = wire(
      [cachingChildProvider({ id: 'prov', value: 5, pushed: true }), consumer({ id: 'cons', seed: 0 })],
      factory,
    );
    await runtime.on_wake(WAKE as WakeEvent);
    const first = totalOf(reg, 'cons');
    await runtime.on_wake(WAKE as WakeEvent);
    expect(totalOf(reg, 'cons')).toBe(first);
    expect(first).toBe(5);
  });

  it('an UNDECLARED child provider DEGRADES the consumer to last-good — child NEVER driven (iron rule)', async () => {
    // The corrected §3.6 rule: NO sync RPC into a child on the render path. An undeclared
    // child provider cannot be pulled synchronously → the consumer degrades to its seed
    // (last-good) this turn, and crucially the child is NOT forked/RPC'd (route_command
    // stays empty). This is the team-lead iron rule (consume path = zero cross-process).
    const { factory, hosts } = makeFakeChildFactory();
    const { reg, runtime } = wire(
      [cachingChildProvider({ id: 'prov', value: 4, pushed: false }), consumer({ id: 'cons', seed: 99 })],
      factory,
    );
    await runtime.on_wake(WAKE as WakeEvent);
    expect(totalOf(reg, 'cons')).toBe(99); // degraded to seed (last-good), NOT 4
    expect(hosts.get('prov')!.route_calls).toEqual([]); // child NOT driven — no sync RPC/fork
  });

  it('push→cell→consume round-trip: a later child push (write_app_cell) is read next turn', async () => {
    // End-to-end of the push/read decouple: turn 1 the child has not pushed (degrade to
    // seed); then the child (active for its own reasons) frames a push to the convention
    // slot via write_app_cell; turn 2 consume reads the pushed value synchronously — still
    // no route_command (no fork/RPC), proving the read side never drives the child.
    const { factory, hosts } = makeFakeChildFactory();
    const { reg, runtime } = wire(
      [cachingChildProvider({ id: 'prov', value: 0, pushed: false }), consumer({ id: 'cons', seed: 42 })],
      factory,
    );

    await runtime.on_wake(WAKE as WakeEvent);
    expect(totalOf(reg, 'cons')).toBe(42); // turn 1: not pushed → last-good (seed)

    // The child pushed its computed scalar to the convention slot (set_state framed back).
    reg.write_app_cell('prov', { [CONTRACT_CACHE_SLOT]: { [COUNT_SUM.name]: 8 } });

    await runtime.on_wake(WAKE as WakeEvent);
    expect(totalOf(reg, 'cons')).toBe(8); // turn 2: pushed value read from the cell
    expect(hosts.get('prov')!.route_calls).toEqual([]); // never drove the child (no RPC/fork)
  });
});
