/**
 * test/render_registry.test.ts — unit tests for impl-render's two files:
 *   - core/renderer.ts  (byte-identical, builder-driven, tier-segmented render)
 *   - app/registry.ts   (install/bootstrap/collision/state-schema, registry views)
 *
 * These exercise the App FRAMEWORK directly (no standard app, ARCHITECTURE.md
 * scope). Fixture Apps here are one-off stubs, clearly labeled.
 */

import { describe, expect, it } from 'vitest';

import { BlockTree } from '../src/core/block.js';
import { Renderer } from '../src/core/renderer.js';
import {
  AppRegistry,
  AppDependencyCycleError,
  AppManifestError,
  AppStateViolation,
} from '../src/app/registry.js';
import type { Block, BlockName } from '../src/core/types.js';
import type {
  AppManifest,
  BuilderManifest,
  BuildContext,
  CommandManifest,
} from '../src/app/types.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function leaf(name: BlockName, text: string, children: Block[] = []): Block {
  return { id: name, name, children, content_text: text, content_blob: null };
}

function treeWith(...children: Block[]): BlockTree {
  // Root is a pure structural container (null content), matching makeEmptyTree;
  // only the children carry renderable content.
  const root: Block = {
    id: 'root',
    name: 'root:root',
    children,
    content_text: null,
    content_blob: null,
  };
  return new BlockTree(root);
}

/** A builder that re-emits its block's snapshot text verbatim, with a tier. */
function passthroughBuilder(
  name: BlockName,
  tier: BuilderManifest['cache_tier'],
): BuilderManifest {
  const app_id = name.slice(0, name.indexOf(':'));
  return {
    name: `${name}.builder`,
    version: '1.0.0',
    owner: 'system',
    app_id,
    inputs: [],
    outputs: [name],
    cache_tier: tier,
    async build(ctx: BuildContext): Promise<Block | null> {
      const src = ctx.read(name);
      return src ? { ...src, children: [] } : null;
    },
  };
}

/** Minimal manifest builder. */
function manifest(opts: {
  id: string;
  depends_on?: string[];
  builders?: BuilderManifest[];
  commands?: CommandManifest[];
  initial_state?: unknown;
  state_schema?: Record<string, unknown>;
}): AppManifest {
  return {
    id: opts.id,
    version: '1.0.0',
    depends_on: opts.depends_on ?? [],
    tree_namespace: `/${opts.id}`,
    initial_state: opts.initial_state ?? {},
    state_schema: opts.state_schema ?? {},
    builders: (opts.builders ?? []).map((b) => () => b),
    commands: (opts.commands ?? []).map((c) => () => c),
  };
}

// ===========================================================================
// Renderer — byte-identical, tier-segmented
// ===========================================================================

describe('Renderer', () => {
  it('renders the same snapshot byte-identically (INV #1)', async () => {
    const reg = new AppRegistry();
    reg.install(
      manifest({
        id: 'a',
        builders: [
          passthroughBuilder('a:stable', 'stable'),
          passthroughBuilder('a:vol', 'volatile'),
        ],
      }),
    );
    const tree = treeWith(leaf('a:stable', 'STABLE'), leaf('a:vol', 'VOL'));
    const renderer = new Renderer(reg);

    const r1 = await renderer.render(tree.snapshot());
    const r2 = await renderer.render(tree.snapshot());

    expect(r1.snapshot_hash).toBe(r2.snapshot_hash);
    expect(JSON.stringify(r1.segments)).toBe(JSON.stringify(r2.segments));
    expect([...r1.segment_hashes]).toEqual([...r2.segment_hashes]);
  });

  it('orders segments stable -> slow_changing -> volatile, with cache boundaries', async () => {
    const reg = new AppRegistry();
    reg.install(
      manifest({
        id: 'a',
        builders: [
          passthroughBuilder('a:v', 'volatile'),
          passthroughBuilder('a:s', 'stable'),
          passthroughBuilder('a:m', 'slow_changing'),
        ],
      }),
    );
    const tree = treeWith(leaf('a:v', 'V'), leaf('a:s', 'S'), leaf('a:m', 'M'));
    const r = await new Renderer(reg).render(tree.snapshot());

    expect(r.segments.map((s) => s.tier)).toEqual(['stable', 'slow_changing', 'volatile']);
    expect(r.segments.every((s) => s.cache_boundary)).toBe(true);
    expect(r.segments[0]!.rendered).toBe('S');
    expect(r.segments[2]!.rendered).toBe('V');
  });

  it('sorts blocks within a tier by name (no source-order leak)', async () => {
    const reg = new AppRegistry();
    reg.install(
      manifest({
        id: 'a',
        builders: [
          passthroughBuilder('a:zzz', 'stable'),
          passthroughBuilder('a:aaa', 'stable'),
        ],
      }),
    );
    // Insert zzz BEFORE aaa: output must still be aaa\nzzz.
    const tree = treeWith(leaf('a:zzz', 'Z'), leaf('a:aaa', 'A'));
    const r = await new Renderer(reg).render(tree.snapshot());
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.rendered).toBe('A\nZ');
  });

  it('treats an unmanaged block (no owner builder) as volatile', async () => {
    const reg = new AppRegistry(); // nothing installed
    const tree = treeWith(leaf('x:orphan', 'ORPHAN'));
    const r = await new Renderer(reg).render(tree.snapshot());
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.tier).toBe('volatile');
    expect(r.segments[0]!.rendered).toBe('ORPHAN');
  });

  it('drops a block whose builder returns null', async () => {
    const reg = new AppRegistry();
    const nullBuilder: BuilderManifest = {
      ...passthroughBuilder('a:gone', 'volatile'),
      async build() {
        return null;
      },
    };
    reg.install(manifest({ id: 'a', builders: [nullBuilder] }));
    const tree = treeWith(leaf('a:gone', 'SHOULD_NOT_APPEAR'));
    const r = await new Renderer(reg).render(tree.snapshot());
    expect(r.segments).toHaveLength(0);
  });

  it('emits ContentPart[] when a tier carries a blob', async () => {
    const reg = new AppRegistry();
    reg.install(manifest({ id: 'a', builders: [passthroughBuilder('a:img', 'volatile')] }));
    const imgBlock: Block = {
      id: 'a:img',
      name: 'a:img',
      children: [],
      content_text: 'caption',
      content_blob: { data: 'blob://abc', mime_type: 'image/png' },
    };
    const tree = treeWith(imgBlock);
    const r = await new Renderer(reg).render(tree.snapshot());
    const parts = r.segments[0]!.rendered;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts).toEqual([
      { type: 'text', value: 'caption' },
      { type: 'image', value: 'blob://abc', mime_type: 'image/png' },
    ]);
  });

  it('changes the snapshot_hash when content changes', async () => {
    const reg = new AppRegistry();
    reg.install(manifest({ id: 'a', builders: [passthroughBuilder('a:s', 'stable')] }));
    const renderer = new Renderer(reg);
    const h1 = (await renderer.render(treeWith(leaf('a:s', 'one')).snapshot())).snapshot_hash;
    const h2 = (await renderer.render(treeWith(leaf('a:s', 'two')).snapshot())).snapshot_hash;
    expect(h1).not.toBe(h2);
  });

  it('gives builders deterministic substitutes (no wall-clock leak)', async () => {
    const reg = new AppRegistry();
    let clockA = 0;
    let clockB = -1;
    const probe: BuilderManifest = {
      ...passthroughBuilder('a:probe', 'stable'),
      async build(ctx) {
        // deterministic_clock is stable per snapshot; deterministic_random pure.
        clockA = ctx.deterministic_clock();
        clockB = ctx.deterministic_clock();
        const rnd = ctx.deterministic_random('seed');
        const id = ctx.content_addressed_id('hello');
        return leaf('a:probe', `${rnd === ctx.deterministic_random('seed')}:${id.slice(0, 8)}`);
      },
    };
    reg.install(manifest({ id: 'a', builders: [probe] }));
    const r = await new Renderer(reg).render(treeWith(leaf('a:probe', '')).snapshot());
    expect(clockA).toBe(clockB); // same snapshot => same logical clock
    expect(r.segments[0]!.rendered).toMatch(/^true:[0-9a-f]{8}$/); // random is pure
  });
});

// ===========================================================================
// AppRegistry — install / bootstrap / collision / schema / views
// ===========================================================================

describe('AppRegistry', () => {
  it('installs an App and resolves its builder owner O(1)', () => {
    const reg = new AppRegistry();
    const res = reg.install(
      manifest({ id: 'mem', builders: [passthroughBuilder('mem:summary', 'slow_changing')] }),
    );
    expect(res.installed_id).toBe('mem');
    expect(res.warnings).toEqual([]);
    expect(reg.resolve_builder('mem:summary')?.outputs).toEqual(['mem:summary']);
    expect(reg.tier_of('mem:summary')).toBe('slow_changing');
    expect(reg.resolve_builder('mem:absent')).toBeNull();
    expect(reg.tier_of('mem:absent')).toBeNull();
  });

  it('auto-renames on a namespace collision and warns (§5.3 #4)', () => {
    const reg = new AppRegistry();
    reg.install(manifest({ id: 'chat' }));
    const r2 = reg.install(manifest({ id: 'chat' }));
    const r3 = reg.install(manifest({ id: 'chat' }));
    expect(r2.installed_id).toBe('chat_2');
    expect(r3.installed_id).toBe('chat_3');
    expect(r2.warnings[0]).toMatch(/auto-renamed to 'chat_2'/);
    expect(reg.list().map((m) => m.id)).toEqual(['chat', 'chat', 'chat']); // manifests unchanged
  });

  it("reserves the 'core' id for the runtime (auto-renames an App that asks for it)", () => {
    const reg = new AppRegistry();
    const r = reg.install(manifest({ id: 'core' }));
    expect(r.installed_id).toBe('core_2'); // never plain 'core'
    expect(r.warnings[0]).toMatch(/reserved for the runtime core/);
    expect(reg.get('core')).toBeNull(); // 'core' stays unoccupied
    expect(reg.get('core_2')).not.toBeNull();
  });

  it("reserves the 'runtime' id for the runtime's system blocks (auto-renames an App that asks for it)", () => {
    const reg = new AppRegistry();
    const r = reg.install(manifest({ id: 'runtime' }));
    expect(r.installed_id).toBe('runtime_2'); // never plain 'runtime' (would shadow runtime:* system blocks)
    expect(r.warnings[0]).toMatch(/reserved for the runtime core/);
    expect(reg.get('runtime')).toBeNull(); // 'runtime' stays unoccupied
    expect(reg.get('runtime_2')).not.toBeNull();
  });

  it('resolves a command and routes it (CommandRegistry seam)', async () => {
    const reg = new AppRegistry();
    const cmd: CommandManifest = {
      name: 'say',
      description: 'demo',
      capabilities: [{ name: 'block:write' }],
      invoke: async (args) => ({ ok: true, data: { got: args } }),
    };
    reg.install(manifest({ id: 'reply', commands: [cmd] }));
    expect(reg.resolve_command('reply.say')?.capabilities).toEqual([{ name: 'block:write' }]);
    expect(reg.resolve_command('reply.absent')).toBeNull();
    const result = await reg.route('reply.say', { text: 'hi' }, { invoker: 'agent' });
    expect(result).toEqual({ ok: true, data: { got: { text: 'hi' } } });
  });

  it('returns an error result for an unknown command route', async () => {
    const reg = new AppRegistry();
    expect(await reg.route('nope.x', {}, { invoker: 'agent' })).toEqual({
      ok: false,
      error: "unknown App 'nope' for command 'nope.x'",
    });
  });

  describe('bootstrap (topo-sort by depends_on)', () => {
    it('installs in dependency order', () => {
      const reg = new AppRegistry();
      // chat depends on memory + messages; declare out of order.
      const results = reg.bootstrap([
        manifest({ id: 'chat', depends_on: ['memory', 'messages'] }),
        manifest({ id: 'memory' }),
        manifest({ id: 'messages', depends_on: ['memory'] }),
      ]);
      const order = results.map((r) => r.installed_id);
      expect(order.indexOf('memory')).toBeLessThan(order.indexOf('messages'));
      expect(order.indexOf('messages')).toBeLessThan(order.indexOf('chat'));
    });

    it('is deterministic across identical inputs', () => {
      const make = () => [
        manifest({ id: 'c', depends_on: ['a', 'b'] }),
        manifest({ id: 'b', depends_on: ['a'] }),
        manifest({ id: 'a' }),
        manifest({ id: 'd', depends_on: ['a'] }),
      ];
      const o1 = new AppRegistry().bootstrap(make()).map((r) => r.installed_id);
      const o2 = new AppRegistry().bootstrap(make()).map((r) => r.installed_id);
      expect(o1).toEqual(o2);
    });

    it('throws on a dependency cycle', () => {
      const reg = new AppRegistry();
      expect(() =>
        reg.bootstrap([
          manifest({ id: 'x', depends_on: ['y'] }),
          manifest({ id: 'y', depends_on: ['x'] }),
        ]),
      ).toThrow(AppDependencyCycleError);
    });

    it('throws on a missing dependency', () => {
      const reg = new AppRegistry();
      expect(() => reg.bootstrap([manifest({ id: 'x', depends_on: ['ghost'] })])).toThrow(
        AppManifestError,
      );
    });
  });

  describe('state schema validation (INV #14 / DR-25)', () => {
    const schema = { required: ['count'] };

    it('accepts a JSON-serializable transition', async () => {
      const { reg } = installWithCtx('s', { count: 0 }, schema);
      const ctx = await grabCtx(reg, 's');
      ctx.set_state(() => ({ count: 5 }));
      expect((ctx.state as { count: number }).count).toBe(5);
    });

    it('rejects a function in state -> AppStateViolation', async () => {
      const { reg } = installWithCtx('s', { count: 0 }, schema);
      const ctx = await grabCtx(reg, 's');
      expect(() => ctx.set_state(() => ({ count: 1, fn: () => 1 }))).toThrow(AppStateViolation);
    });

    it('rejects a class instance (Block ref) in state', async () => {
      const { reg } = installWithCtx('s', { count: 0 }, schema);
      const ctx = await grabCtx(reg, 's');
      const blockish = leaf('x:y', 'z');
      Object.setPrototypeOf(blockish, { tainted: true }); // non-plain prototype
      expect(() => ctx.set_state(() => ({ count: 1, b: blockish }))).toThrow(AppStateViolation);
    });

    it('rejects a missing required key', async () => {
      const { reg } = installWithCtx('s', { count: 0 }, schema);
      const ctx = await grabCtx(reg, 's');
      expect(() => ctx.set_state(() => ({ other: 1 }))).toThrow(AppStateViolation);
    });

    it('leaves state untouched when a transition is rejected', async () => {
      const { reg } = installWithCtx('s', { count: 0 }, schema);
      const ctx = await grabCtx(reg, 's');
      expect(() => ctx.set_state(() => ({ count: 1, fn: () => 1 }))).toThrow();
      expect((ctx.state as { count: number }).count).toBe(0); // unchanged
    });

    it('rejects an illegal initial_state at install', () => {
      const reg = new AppRegistry();
      expect(() =>
        reg.install(
          manifest({ id: 'bad', initial_state: { fn: () => 1 }, state_schema: {} }),
        ),
      ).toThrow(AppStateViolation);
    });
  });

  it("rejects a builder with owner='agent' at runtime (INV #4)", () => {
    const reg = new AppRegistry();
    const illegal: BuilderManifest = {
      ...passthroughBuilder('a:x', 'stable'),
      owner: 'agent' as unknown as BuilderManifest['owner'],
    };
    expect(() => reg.install(manifest({ id: 'a', builders: [illegal] }))).toThrow(
      AppManifestError,
    );
  });

  it('uninstall removes the App and its builder ownership', () => {
    const reg = new AppRegistry();
    reg.install(manifest({ id: 'a', builders: [passthroughBuilder('a:s', 'stable')] }));
    expect(reg.resolve_builder('a:s')).not.toBeNull();
    reg.uninstall('a');
    expect(reg.get('a')).toBeNull();
    expect(reg.resolve_builder('a:s')).toBeNull();
  });

  it('delivers emitted events to subscribers (fire-and-forget, INV #22)', async () => {
    const reg = new AppRegistry();
    installWithCtx('pub', {}, {}, reg);
    installWithCtx('sub', {}, {}, reg);
    const ctxSub = await grabCtx(reg, 'sub');
    const seen: unknown[] = [];
    ctxSub.on('ping', (e) => seen.push(e.payload));
    // a throwing subscriber must not break delivery to others
    ctxSub.on('ping', () => {
      throw new Error('boom');
    });
    (await grabCtx(reg, 'pub')).emit('ping', { n: 1 });
    expect(seen).toEqual([{ n: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// Reach the AppContext of an installed App for white-box tests.
//
// The registry hands AppContext only to commands/builders/hooks — never out a
// public accessor (by design). To unit-test set_state / on / emit we install
// each App with a probe command `__probe.capture` whose invoke captures the ctx
// it receives, then route the probe to retrieve that exact ctx instance.
// ---------------------------------------------------------------------------

const PROBE = '__probe_capture';

/** Install an App carrying a ctx-capturing probe command. */
function installWithCtx(
  id: string,
  initial_state: unknown,
  state_schema: Record<string, unknown>,
  reg: AppRegistry = new AppRegistry(),
): { reg: AppRegistry } {
  const probe: CommandManifest = {
    name: PROBE,
    description: 'test-only ctx capture probe',
    invoke: async (_args, ctx) => ({ ok: true, data: ctx }),
  };
  reg.install(manifest({ id, initial_state, state_schema, commands: [probe] }));
  return { reg };
}

/** Route the probe to fetch the live AppContext of an installed App. */
async function grabCtx(reg: AppRegistry, app_id: string) {
  const res = await reg.route(`${app_id}.${PROBE}`, {}, { invoker: 'app', identity: 'test' });
  if (!res.ok || res.data === undefined)
    throw new Error(`failed to capture ctx for '${app_id}'`);
  return res.data as import('../src/app/types.js').AppContext;
}
