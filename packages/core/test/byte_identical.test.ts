/**
 * byte-identical rendering (INV #1 / §10.3) — owned by impl-runtime.
 *
 * Rendering the same (snapshot, registry) twice MUST produce identical bytes:
 * identical segment payloads AND identical hashes. This is what lets the
 * provider's prompt cache hit. We assert it against BOTH the real Renderer
 * (core/renderer.ts) and the test renderer, over a small fixed tree.
 */

import { describe, expect, it } from 'vitest';

import { BlockTree } from '../src/core/block.js';
import { Renderer } from '../src/core/renderer.js';
import type { Block, RenderedPrompt } from '../src/core/types.js';
import { TestBuilderRegistry, TestRenderer } from './fixtures.js';

/** A small fixed tree spanning all three tiers. */
function seededTree(): BlockTree {
  const root: Block = {
    id: 'root',
    name: 'root:root',
    children: [
      { id: 'id', name: 'identity:role', children: [], content_text: 'You are a demo agent.', content_blob: null },
      { id: 'sum', name: 'memory:summary', children: [], content_text: 'summary so far', content_blob: null },
      { id: 'now', name: 'thoughts:turn_1', children: [], content_text: 'latest thought', content_blob: null },
    ],
    content_text: null,
    content_blob: null,
  };
  return new BlockTree(root);
}

function tiers(): TestBuilderRegistry {
  const b = new TestBuilderRegistry();
  b.declareTier('identity:role', 'stable');
  b.declareTier('memory:summary', 'slow_changing');
  b.declareTier('thoughts:turn_1', 'volatile');
  return b;
}

/** Compare two RenderedPrompts for byte-level equality (payloads + hashes). */
function expectIdentical(a: RenderedPrompt, b: RenderedPrompt): void {
  expect(b.snapshot_hash).toBe(a.snapshot_hash);
  expect(b.segments).toEqual(a.segments);
  expect([...b.segment_hashes.entries()]).toEqual([...a.segment_hashes.entries()]);
}

describe('byte-identical rendering', () => {
  it('TestRenderer renders the same snapshot identically twice', async () => {
    const tree = seededTree();
    const renderer = new TestRenderer(tiers());
    const snap = tree.snapshot();

    const first = await renderer.render(snap);
    const second = await renderer.render(snap);
    expectIdentical(first, second);

    // Also identical when re-snapshotting an unchanged tree.
    const third = await renderer.render(tree.snapshot());
    expectIdentical(first, third);
  });

  it('real Renderer renders the same snapshot identically twice', async () => {
    const tree = seededTree();
    const renderer = new Renderer(buildersView(tiers()));
    const snap = tree.snapshot();

    const first = await renderer.render(snap);
    const second = await renderer.render(snap);
    expectIdentical(first, second);
  });

  it('TestRenderer orders tiers stable → slow_changing → volatile', async () => {
    const tree = seededTree();
    const out = await new TestRenderer(tiers()).render(tree.snapshot());
    expect(out.segments.map((s) => s.tier)).toEqual(['stable', 'slow_changing', 'volatile']);
  });

  it('a content change yields a different snapshot_hash (cache invalidation)', async () => {
    const tree = seededTree();
    const renderer = new TestRenderer(tiers());
    const before = await renderer.render(tree.snapshot());

    tree.applyOp({ kind: 'update', target: 'thoughts:turn_1', content_text: 'a new thought' });
    const after = await renderer.render(tree.snapshot());

    expect(after.snapshot_hash).not.toBe(before.snapshot_hash);
  });
});

/**
 * Adapt a TestBuilderRegistry to the wave-2 BuilderRegistry the real Renderer
 * consumes (resolve_builder / tier_of / list_builders). The test registry only
 * declares tiers; the real Renderer renders unmanaged blocks straight from the
 * snapshot when resolve_builder returns null, which is exactly what we want.
 */
function buildersView(b: TestBuilderRegistry) {
  return {
    resolve_builder: () => null,
    tier_of: (name: import('../src/core/types.js').BlockName) => b.tier_of(name),
    list_builders: () => [],
    // wave-2 BuilderRegistry adds registerSystemBuilder (R-5 / B1). This view does
    // not exercise system builders, so it is an inert stub.
    registerSystemBuilder: () => undefined,
  };
}
