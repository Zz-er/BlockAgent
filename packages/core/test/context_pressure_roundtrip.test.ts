/**
 * test/context_pressure_roundtrip.test.ts — the base→memory context_pressure round-trip
 * (P1#1, §H3 integration). The REAL path: real BaseApp (provider) + real MemoryApp
 * (consumer) + real AgentRuntime.consumeRefresh + real Operations + real Renderer.
 *
 * Proves the whole vertical end-to-end: `base.record` stamps byte-weighted rows → the
 * byte-bounded window's Σtok crosses the soft water → `base.pressure` (the context_pressure
 * via) reports the ratio → consume-refresh folds it into `memory.state.context_pressure` →
 * `memory:pressure` renders the distillation nudge. Identity-free: memory never names base.
 *
 * The unit seams are interface-optional, so only this real wiring exercises the fold (the
 * "green but the real loop is broken" class consume_refresh.test.ts guards, applied here to
 * the new contract). A small injected E lets a handful of rows cross the soft water.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BlockTree } from '../src/core/block.js';
import { Operations } from '../src/core/operations.js';
import { Renderer } from '../src/core/renderer.js';
import { AppRegistry } from '../src/app/registry.js';
import { AgentRuntime } from '../src/runtime/agent_runtime.js';
import { MockProvider } from '../src/provider/mock.js';
import { CONTEXT_PRESSURE } from '../src/app/contracts.js';
import type { InvokerContext } from '../src/core/types.js';

import { BaseApp } from '@block-agent/app-base/manifest.js';
import { MemoryApp } from '@block-agent/app-memory/manifest.js';

const WAKE = { kind: 'app_event', source: 'test', reason: 'tick', ref: 'r1' } as const;
const APP: InvokerContext = { invoker: 'app', identity: 'runtime' };

/** A small elastic budget E so a handful of rows cross the soft water (0.7·E). */
const E = 400;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ctx-pressure-rt-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Real Registry + Operations + Renderer + Runtime, base (provider) + memory (consumer). */
function wire() {
  const reg = new AppRegistry();
  reg.registerContract(CONTEXT_PRESSURE);
  reg.install(new BaseApp(join(dir, 'base'), { elasticBudgetBytes: E }).manifest());
  reg.install(new MemoryApp({ dir: join(dir, 'memory') }).manifest());

  const tree = new BlockTree();
  const ops = Operations.with_default_policy({ tree, registry: reg });
  reg.commandRouter = (fn, a, inv) => ops.invoke_command(fn, a, inv);
  const renderer = new Renderer(reg, { app_context_provider: (id) => reg.get_app_context(id) });
  const runtime = new AgentRuntime({
    operations: ops,
    renderer,
    provider: new MockProvider([{}]), // one empty turn → exactly one consumeRefresh
    registry: reg,
  });
  return { reg, ops, renderer, runtime };
}

/** Record one input row into base (the byte-weighted ledger). */
async function recordInput(ops: Operations, n: number): Promise<void> {
  await ops.invoke_command(
    'base.record',
    { kind: 'input', source: 'messages', sender: 'user', preview: `row-${n}-${'x'.repeat(20)}`, ts: '14:31' },
    APP,
  );
}

/** base.pressure (the via) read directly through Operations. */
async function basePressure(ops: Operations): Promise<number> {
  const r = await ops.invoke_command('base.pressure', {}, APP);
  return r.data as number;
}

/** memory.state.context_pressure through the live context. */
function memoryPressure(reg: AppRegistry): number {
  return (reg.get_app_context('memory')?.state as { context_pressure: number }).context_pressure;
}

/** Seed projection placeholders + render the whole prompt, flattened. */
async function seedAndRenderText(reg: AppRegistry, ops: Operations, renderer: Renderer): Promise<string> {
  await reg.seedProjectionBlocks(
    (name) => ops.has(name),
    (sOps) => ops.apply(sOps, { invoker: 'app', trust: 'trusted' }),
  );
  const r = await renderer.render(ops.snapshot());
  return r.segments.map((s) => (typeof s.rendered === 'string' ? s.rendered : '')).join('\n');
}

describe('context_pressure round-trip (base provider → consume-refresh → memory nudge)', () => {
  it('folds base.pressure into memory.context_pressure and renders the nudge (≥ 0.7)', async () => {
    const { reg, ops, renderer, runtime } = wire();

    // Feed rows until base reports pressure in the grace band [0.7, 0.95) — enough to nudge
    // but not so much it evicts (which would drop the ratio back below the soft water).
    for (let i = 0; i < 50; i += 1) {
      await recordInput(ops, i);
      if ((await basePressure(ops)) >= 0.72) break;
    }
    const provided = await basePressure(ops);
    expect(provided).toBeGreaterThanOrEqual(0.7);
    expect(provided).toBeLessThan(0.95);

    // One turn runs exactly one consumeRefresh BEFORE the snapshot, folding the provider's
    // scalar into the consumer's state[as] via combine:'first'.
    await runtime.on_wake(WAKE);

    expect(memoryPressure(reg)).toBeCloseTo(provided, 10);

    // ...and the nudge block is now visible to the agent in the rendered prompt.
    const text = await seedAndRenderText(reg, ops, renderer);
    expect(text).toContain('上下文压力');
    expect(text).toContain('memory.remember');
    expect(runtime.state.kind).toBe('idle');
  });

  it('no pressure (< 0.7) leaves memory.context_pressure low and renders NO nudge', async () => {
    const { reg, ops, renderer, runtime } = wire();

    // A single small row keeps pressure well under the soft water.
    await recordInput(ops, 0);
    const provided = await basePressure(ops);
    expect(provided).toBeLessThan(0.7);

    await runtime.on_wake(WAKE);

    expect(memoryPressure(reg)).toBeCloseTo(provided, 10);
    const text = await seedAndRenderText(reg, ops, renderer);
    expect(text).not.toContain('上下文压力');
  });

  it('a provider-less boot keeps the memory seed (0) and renders no nudge (graceful)', async () => {
    // memory installed, base NOT — the consume has no provider. combine:'first' over an empty
    // list throws, which consume-refresh downgrades, keeping memory's seed (0). No nudge.
    const reg = new AppRegistry();
    reg.registerContract(CONTEXT_PRESSURE);
    reg.install(new MemoryApp({ dir: join(dir, 'memory') }).manifest());
    const tree = new BlockTree();
    const ops = Operations.with_default_policy({ tree, registry: reg });
    reg.commandRouter = (fn, a, inv) => ops.invoke_command(fn, a, inv);
    const renderer = new Renderer(reg, { app_context_provider: (id) => reg.get_app_context(id) });
    const runtime = new AgentRuntime({ operations: ops, renderer, provider: new MockProvider([{}]), registry: reg });

    await runtime.on_wake(WAKE); // must not throw despite the no-provider combine

    expect(memoryPressure(reg)).toBe(0);
    const text = await seedAndRenderText(reg, ops, renderer);
    expect(text).not.toContain('上下文压力');
    expect(runtime.state.kind).toBe('idle');
  });
});
