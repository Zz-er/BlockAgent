/**
 * test/context_budget.test.ts — the context-budget primitive (skill-memory-wiki §9):
 *
 *   P0.1 install-side  — `render_ceiling_bytes` + the Σ ≤ R reserve gate in `install()`
 *                        (`AppRenderReserveError`, fail-closed, zero residue) + the default
 *                        charge for an undeclared App + the elastic-app exemption.
 *   P0.2 run-side      — the Renderer's per-block clip-to-ceiling (`ceiling_resolver`):
 *                        a block over its App's ceiling is clipped (§9.2 ②); the elastic
 *                        stream is clipped to `E_hard`; the construction is bounded (任意
 *                        state → 总渲染字节 ≤ B, §9.3) and byte-identical (INV #1).
 *
 * The recalled-fence exception (§9.4 #3) is gated separately in test/memory.test.ts
 * (the self-bound lives in the memory recalled builder); here we prove the GENERIC
 * Renderer clip is a uniform, fence-agnostic, deterministic byte cap.
 */

import { describe, expect, it } from 'vitest';

import { BlockTree } from '../src/core/block.js';
import { Renderer } from '../src/core/renderer.js';
import { AppRegistry, AppRenderReserveError } from '../src/app/registry.js';
import type { Block, BlockName } from '../src/core/types.js';
import type { AppManifest, BuilderManifest, BuildContext } from '../src/app/types.js';

// ---------------------------------------------------------------------------
// helpers (mirrors render_registry.test.ts)
// ---------------------------------------------------------------------------

function leaf(name: BlockName, text: string, children: Block[] = []): Block {
  return { id: name, name, children, content_text: text, content_blob: null };
}

function treeWith(...children: Block[]): BlockTree {
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
  tier: BuilderManifest['cache_tier'] = 'volatile',
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

function manifest(opts: {
  id: string;
  render_ceiling_bytes?: number;
  builders?: BuilderManifest[];
  /** Auto-generate this many passthrough render builders (`<id>:b0..b{n-1}`). The install
   *  reserve charge is PER-BLOCK (缺陷1), so a test app MUST carry render blocks to be
   *  charged; default 1 so a bare `manifest({id, render_ceiling_bytes})` charges 1×ceiling. */
  blocks?: number;
}): AppManifest {
  const blockCount = opts.builders !== undefined ? 0 : (opts.blocks ?? 1);
  const auto = Array.from({ length: blockCount }, (_, i) =>
    passthroughBuilder(`${opts.id}:b${i}` as BlockName),
  );
  const builders = opts.builders ?? auto;
  return {
    id: opts.id,
    version: '1.0.0',
    depends_on: [],
    tree_namespace: `/${opts.id}`,
    initial_state: {},
    state_schema: {},
    ...(opts.render_ceiling_bytes !== undefined
      ? { render_ceiling_bytes: opts.render_ceiling_bytes }
      : {}),
    builders: builders.map((b) => () => b),
    commands: [],
  };
}

/** Total UTF-8 bytes across a render's emitted text segments. */
function renderedBytes(segments: { rendered: string | unknown[] }[]): number {
  let n = 0;
  for (const s of segments) {
    if (typeof s.rendered === 'string') n += Buffer.byteLength(s.rendered, 'utf8');
  }
  return n;
}

// ===========================================================================
// P0.1 — install-side Σ ≤ R reserve gate
// ===========================================================================

describe('P0.1 render reserve Σ ≤ R (install gate)', () => {
  it('admits apps whose declared ceilings sum to ≤ R', () => {
    const reg = new AppRegistry();
    reg.render_reserve_bytes = 1000;
    reg.install(manifest({ id: 'a', render_ceiling_bytes: 400 }));
    reg.install(manifest({ id: 'b', render_ceiling_bytes: 600 })); // Σ = 1000 ≤ 1000 OK
    expect(reg.get('a')).not.toBeNull();
    expect(reg.get('b')).not.toBeNull();
  });

  it('REJECTS the install that would push Σ over R (fail-closed, zero residue)', () => {
    const reg = new AppRegistry();
    reg.render_reserve_bytes = 1000;
    reg.install(manifest({ id: 'a', render_ceiling_bytes: 700 }));
    expect(() => reg.install(manifest({ id: 'b', render_ceiling_bytes: 400 }))).toThrow(
      AppRenderReserveError,
    ); // 700 + 400 = 1100 > 1000
    // Zero residue: the rejected app left no registry/index footprint.
    expect(reg.get('b')).toBeNull();
    expect(reg.resolve_builder('b:x')).toBeNull();
    // ...and the already-installed app is untouched.
    expect(reg.get('a')).not.toBeNull();
  });

  it('charges the injected default to an app that declares NO ceiling (undeclared still counts)', () => {
    const reg = new AppRegistry();
    reg.render_reserve_bytes = 1000;
    reg.default_render_ceiling_bytes = 600;
    reg.install(manifest({ id: 'a' })); // charged 600 (default)
    expect(() => reg.install(manifest({ id: 'b' }))).toThrow(AppRenderReserveError); // 600+600>1000
  });

  it('EXEMPTS an elastic app from the Σ — its budget is E_hard, not a reservation', () => {
    const reg = new AppRegistry();
    reg.render_reserve_bytes = 1000;
    reg.default_render_ceiling_bytes = 5000;
    reg.elastic_app_ids = new Set(['base']);
    // base declares a huge ceiling but is exempt → does NOT consume the reserve.
    reg.install(manifest({ id: 'base', render_ceiling_bytes: 999_999 }));
    // a dashboard still fits R afterward (base contributed 0 to Σ).
    expect(() => reg.install(manifest({ id: 'a', render_ceiling_bytes: 900 }))).not.toThrow();
  });

  it('does NO reserve check when render_reserve_bytes is unset (opt-in, zero regression)', () => {
    const reg = new AppRegistry(); // no reserve injected
    expect(() => reg.install(manifest({ id: 'a', render_ceiling_bytes: 1 << 30 }))).not.toThrow();
  });

  it('the thrown error carries the offending charge, committed sum, and reserve', () => {
    const reg = new AppRegistry();
    reg.render_reserve_bytes = 1000;
    reg.install(manifest({ id: 'a', render_ceiling_bytes: 800 })); // 1 block × 800
    try {
      reg.install(manifest({ id: 'b', render_ceiling_bytes: 300 }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppRenderReserveError);
      const e = err as AppRenderReserveError;
      expect(e.app_ceiling).toBe(300);
      expect(e.committed).toBe(800);
      expect(e.reserve).toBe(1000);
    }
  });

  it('缺陷1: charges PER-BLOCK — an N-block app charges N × ceiling, not 1× (the §9.3 fix)', () => {
    const reg = new AppRegistry();
    reg.render_reserve_bytes = 1000;
    // A 4-block app at 200/block charges 800, NOT 200. A second 1-block app at 300 then
    // overflows (800 + 300 = 1100 > 1000) — proving the multi-block app consumed its full
    // 4× footprint, not a single ceiling.
    reg.install(manifest({ id: 'multi', render_ceiling_bytes: 200, blocks: 4 })); // charge = 800
    try {
      reg.install(manifest({ id: 'x', render_ceiling_bytes: 300 }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppRenderReserveError);
      expect((err as AppRenderReserveError).committed).toBe(800); // 4 × 200, not 200
    }
    // And the 4-block app ITSELF is rejected at install if its own N×ceiling already > R.
    const reg2 = new AppRegistry();
    reg2.render_reserve_bytes = 700;
    expect(() => reg2.install(manifest({ id: 'big', render_ceiling_bytes: 200, blocks: 4 }))).toThrow(
      AppRenderReserveError, // 4 × 200 = 800 > 700
    );
  });

  it('缺陷1: a zero-render-block (presence-only) app charges 0', () => {
    const reg = new AppRegistry();
    reg.render_reserve_bytes = 100;
    reg.default_render_ceiling_bytes = 5000;
    // No builders ⇒ 0 render blocks ⇒ charge 0 even with a huge default, so it always fits.
    expect(() => reg.install(manifest({ id: 'presence', builders: [] }))).not.toThrow();
  });
});

// ===========================================================================
// P0.2 — Renderer per-block clip-to-ceiling
// ===========================================================================

describe('P0.2 Renderer per-block clip-to-ceiling', () => {
  /** A renderer whose ceiling_resolver returns a fixed map (base → E_hard). */
  function rendererWithCeilings(
    reg: AppRegistry,
    ceilings: Record<string, number>,
  ): Renderer {
    return new Renderer(reg, {
      ceiling_resolver: (app_id) => ceilings[app_id],
    });
  }

  it('clips a block over its app ceiling (and appends the truncation marker)', async () => {
    const reg = new AppRegistry();
    reg.install(manifest({ id: 'a', builders: [passthroughBuilder('a:big')] }));
    const huge = 'x'.repeat(10_000);
    const r = await rendererWithCeilings(reg, { a: 100 }).render(
      treeWith(leaf('a:big', huge)).snapshot(),
    );
    const seg = r.segments[0]!.rendered as string;
    expect(Buffer.byteLength(seg, 'utf8')).toBeLessThanOrEqual(100);
    expect(seg).toContain('…[truncated]');
  });

  it('does NOT clip a block already within its ceiling (fast-path, byte-for-byte)', async () => {
    const reg = new AppRegistry();
    reg.install(manifest({ id: 'a', builders: [passthroughBuilder('a:small')] }));
    const r = await rendererWithCeilings(reg, { a: 1000 }).render(
      treeWith(leaf('a:small', 'tiny')).snapshot(),
    );
    expect(r.segments[0]!.rendered).toBe('tiny'); // no marker, no change
  });

  it('renders a block UNCLIPPED when its app has no ceiling (undefined) or no resolver', async () => {
    const reg = new AppRegistry();
    reg.install(manifest({ id: 'a', builders: [passthroughBuilder('a:big')] }));
    const huge = 'y'.repeat(5000);
    // app 'a' not in the ceiling map → undefined → render full
    const r1 = await rendererWithCeilings(reg, {}).render(treeWith(leaf('a:big', huge)).snapshot());
    expect(r1.segments[0]!.rendered).toBe(huge);
    // no resolver at all → legacy behavior (full render)
    const r2 = await new Renderer(reg).render(treeWith(leaf('a:big', huge)).snapshot());
    expect(r2.segments[0]!.rendered).toBe(huge);
  });

  it('RedTeam P0.2: clip keys on INSTALL-time identity, not the builder-returned name (no escape)', async () => {
    // A builder registered at the BUDGETED tree position `victim:panel` (ceiling 100) returns
    // a Block whose `name` is a DIFFERENT, unbudgeted id (`runtime:huge`). If the clip keyed
    // off the returned name it would resolve `runtime`→undefined→render 50000 bytes unclipped
    // (the escape RedTeam proved). Keying off the builder's install-time app_id (`victim`)
    // clips it to 100 regardless of the forged name.
    const reg = new AppRegistry();
    const flood = 'X'.repeat(50_000);
    const forging: BuilderManifest = {
      name: 'victim.panel.builder',
      version: '1.0.0',
      owner: 'system',
      app_id: 'victim',
      inputs: [],
      outputs: ['victim:panel'],
      cache_tier: 'volatile',
      async build(): Promise<Block> {
        // The builder LIES about its block name — returns a foreign, unbudgeted id.
        return { id: 'x', name: 'runtime:huge' as BlockName, children: [], content_text: flood, content_blob: null };
      },
    };
    reg.install({
      id: 'victim',
      version: '1.0.0',
      depends_on: [],
      tree_namespace: '/victim',
      initial_state: {},
      state_schema: {},
      builders: [() => forging],
      commands: [],
    });
    const r = await rendererWithCeilings(reg, { victim: 100, runtime: undefined as unknown as number }).render(
      treeWith(leaf('victim:panel', 'seed')).snapshot(),
    );
    const seg = r.segments[0]!.rendered as string;
    // Clipped to victim's ceiling (100), NOT rendered at 50000 — the escape is closed.
    expect(Buffer.byteLength(seg, 'utf8')).toBeLessThanOrEqual(100);
  });

  it('edge: an UNMANAGED block (no owner builder) is still clipped by its tree-position prefix', async () => {
    // No builder owns `victim:orphan` (nothing installed for it) → it.builder is null. The clip
    // must FALL BACK to the tree-position name `it.name` (= `victim:orphan`, the collect key) and
    // still clip — never skip because there's no builder. (This is also the only path where the
    // name IS authoritative: an unmanaged block's snapshot name is the registry/collect key.)
    const reg = new AppRegistry(); // nothing installed
    const huge = 'Q'.repeat(20_000);
    const r = await rendererWithCeilings(reg, { victim: 100 }).render(
      treeWith(leaf('victim:orphan', huge)).snapshot(),
    );
    expect(Buffer.byteLength(r.segments[0]!.rendered as string, 'utf8')).toBeLessThanOrEqual(100);
  });

  it('edge: a registerSystemBuilder builder (undefined app_id, no app) falls back to tree prefix (no skip)', async () => {
    // P0.4 ④ STAMPS every app builder's app_id to its install id, so an undefined app_id only
    // survives to render time via `registerSystemBuilder` — core's OWN bookkeeping builders,
    // which belong to no app and bypass instantiate/stamp. The clip must fall back to
    // `appIdOf(it.name)` (= the tree-position prefix `victim`) for these and STILL clip —
    // `it.builder?.app_id` being undefined MUST NOT mean "skip clip" (that would let a system
    // builder write an unbudgeted huge block). The builder forges its returned name to prove
    // the key is the tree-position `it.name`, not the builder's output `block.name`.
    const reg = new AppRegistry();
    const flood = 'Z'.repeat(40_000);
    reg.registerSystemBuilder({
      name: 'victim.sys.builder',
      version: '1.0.0',
      owner: 'system',
      // app_id omitted (undefined) — a core bookkeeping builder, no owning app.
      inputs: [],
      outputs: ['victim:sys'],
      cache_tier: 'volatile',
      async build(): Promise<Block> {
        return { id: 'x', name: 'elsewhere:huge' as BlockName, children: [], content_text: flood, content_blob: null };
      },
    });
    const r = await rendererWithCeilings(reg, { victim: 100 }).render(
      treeWith(leaf('victim:sys', 'seed')).snapshot(),
    );
    expect(Buffer.byteLength(r.segments[0]!.rendered as string, 'utf8')).toBeLessThanOrEqual(100);
  });

  it('clips the elastic stream to E_hard', async () => {
    const reg = new AppRegistry();
    reg.install(manifest({ id: 'base', builders: [passthroughBuilder('base:recent')] }));
    const flood = 'z'.repeat(50_000);
    const E_hard = 2048;
    const r = await rendererWithCeilings(reg, { base: E_hard }).render(
      treeWith(leaf('base:recent', flood)).snapshot(),
    );
    expect(Buffer.byteLength(r.segments[0]!.rendered as string, 'utf8')).toBeLessThanOrEqual(
      E_hard,
    );
  });

  it('总渲染字节 ≤ B for ANY state (the bounded construction, §9.3 — incl. transient)', async () => {
    // Three dashboards (each clipped to R/3) + the elastic base (clipped to E_hard).
    const reg = new AppRegistry();
    reg.install(manifest({ id: 'd1', builders: [passthroughBuilder('d1:x', 'stable')] }));
    reg.install(manifest({ id: 'd2', builders: [passthroughBuilder('d2:x', 'slow_changing')] }));
    reg.install(manifest({ id: 'd3', builders: [passthroughBuilder('d3:x', 'volatile')] }));
    reg.install(manifest({ id: 'base', builders: [passthroughBuilder('base:recent', 'volatile')] }));

    const R = 3000;
    const E_hard = 4000;
    const B = R + E_hard;
    const perDash = Math.floor(R / 3); // each dashboard's slice of the reserve
    const renderer = new Renderer(reg, {
      ceiling_resolver: (id) => (id === 'base' ? E_hard : perDash),
    });

    // Pathologically oversized state on EVERY block — the transient worst case.
    const flood = '漢'.repeat(40_000); // multibyte, far over every ceiling
    const r = await renderer.render(
      treeWith(
        leaf('d1:x', flood),
        leaf('d2:x', flood),
        leaf('d3:x', flood),
        leaf('base:recent', flood),
      ).snapshot(),
    );
    // Σ ≤ 3·perDash + E_hard ≤ R + E_hard = B (each block independently capped).
    expect(renderedBytes(r.segments)).toBeLessThanOrEqual(B);
  });

  it('缺陷1: ONE app rendering N blocks — total ≤ its install charge (N×ceiling) AND ≤ B', async () => {
    // The bug the per-block charge closes: an app with N blocks at one ceiling can render up to
    // N×ceiling, which the install Σ must have reserved. Here one app renders 4 blocks; we
    // install it through the REAL reserve gate (so the charge is exercised), then render every
    // block flooded and assert the app's rendered total ≤ its account charge and ≤ B.
    const perBlock = 1000;
    const blockCount = 4;
    const charge = perBlock * blockCount; // 4000 — what install reserves for this app
    const R = charge; // reserve exactly fits this one app
    const E_hard = 2000;
    const B = R + E_hard;

    const reg = new AppRegistry();
    reg.render_reserve_bytes = R;
    // 4-block app installs iff its N×ceiling ≤ R (it does, == R). A 5th block would overflow.
    reg.install(manifest({ id: 'multi', render_ceiling_bytes: perBlock, blocks: blockCount }));

    const renderer = new Renderer(reg, {
      ceiling_resolver: (id) => (id === 'multi' ? perBlock : id === 'base' ? E_hard : undefined),
    });
    const flood = '漢'.repeat(20_000); // every block ≫ perBlock
    const r = await renderer.render(
      treeWith(
        leaf('multi:b0', flood),
        leaf('multi:b1', flood),
        leaf('multi:b2', flood),
        leaf('multi:b3', flood),
      ).snapshot(),
    );
    // The app's 4 rendered blocks sum to ≤ its charge (each ≤ perBlock) — the install
    // reservation actually upper-bounds the multi-block render footprint.
    expect(renderedBytes(r.segments)).toBeLessThanOrEqual(charge);
    expect(renderedBytes(r.segments)).toBeLessThanOrEqual(B);
  });

  it('is byte-identical for the same (snapshot, ceiling) — clip is deterministic (INV #1)', async () => {
    const reg = new AppRegistry();
    reg.install(manifest({ id: 'a', builders: [passthroughBuilder('a:big')] }));
    const renderer = rendererWithCeilings(reg, { a: 128 });
    const tree = treeWith(leaf('a:big', 'q'.repeat(9999)));
    const r1 = await renderer.render(tree.snapshot());
    const r2 = await renderer.render(tree.snapshot());
    expect(r1.snapshot_hash).toBe(r2.snapshot_hash);
    expect(JSON.stringify(r1.segments)).toBe(JSON.stringify(r2.segments));
  });
});
