/**
 * test/pressure_nudge.test.ts — the context-pressure distillation nudge (P1#1, memory side).
 *
 * `memory` CONSUMES the `context_pressure` contract (base provides it) into
 * `state.context_pressure`; `PressureNudgeBuilder` renders the `memory:pressure` block as the
 * ratio approaches 1, nudging the agent to distil durable facts via `memory.remember` before
 * the oldest action rows scroll out of base's byte-bounded window.
 *
 * Bearing tests (§H3, memory side):
 *   - the nudge block APPEARS at/above the soft water (≥ 0.7) and shows the rounded percent;
 *   - it DISAPPEARS below the threshold (null block ⇒ no prompt cost when there is no pressure);
 *   - PURE / byte-identical render (INV #1 / #16) — same ratio → same bytes;
 *   - the consumed `context_pressure` is in the state schema (set_state accepts the fold).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppRegistry } from '@block-agent/core/app/registry.js';
import type { AppContext, BuildContext } from '@block-agent/core/app/types.js';
import type { BlockName, BlockSnapshot } from '@block-agent/core/core/types.js';

import { MemoryApp, PRESSURE_BLOCK, type MemoryState } from '../src/manifest.js';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memory-pressure-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A deterministic throwaway BuildContext (builders read app_ctx only, INV #16). */
function stubBuildContext(): BuildContext {
  const snapshot = {
    root: { id: 'r', name: 'root:root' as BlockName, children: [], content_text: null, content_blob: null },
    hash: 'stub',
    get: () => null,
  } as unknown as BlockSnapshot;
  return {
    snapshot,
    read: () => null,
    deterministic_clock: () => 0,
    deterministic_random: () => 0,
    content_addressed_id: (c: string) => `id:${c}`,
    config: {},
  } as unknown as BuildContext;
}

/** A MemoryState with the given pressure ratio (all other windows empty). */
function stateWithPressure(context_pressure: number): MemoryState {
  return {
    notes: [],
    user: [],
    pinned: [],
    recalled: [],
    index: [],
    config: { notes_char_limit: 2200, user_char_limit: 1375, recall_limit: 8, archivist_enabled: false },
    context_pressure,
  };
}

/** A minimal AppContext carrying a fixed state. */
function stubAppContext(state: MemoryState): AppContext<MemoryState> {
  return { app_id: 'memory', state } as unknown as AppContext<MemoryState>;
}

/** Build `memory:pressure` against the given pressure ratio. */
async function renderNudge(reg: AppRegistry, pressure: number) {
  const builder = reg.resolve_builder(PRESSURE_BLOCK);
  if (builder === null) throw new Error('no builder for memory:pressure');
  return builder.build(stubBuildContext(), stubAppContext(stateWithPressure(pressure)));
}

function wire() {
  const reg = new AppRegistry();
  reg.install(new MemoryApp({ dir }).manifest());
  return reg;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('PressureNudgeBuilder (memory:pressure)', () => {
  it('renders the nudge at/above the soft water (≥ 0.7), with the rounded percent', async () => {
    const reg = wire();
    const block = await renderNudge(reg, 0.83);
    expect(block).not.toBeNull();
    expect(block!.name).toBe(PRESSURE_BLOCK);
    expect(block!.content_text).toContain('上下文压力 83%');
    expect(block!.content_text).toContain('memory.remember');
  });

  it('renders exactly AT the threshold (0.7)', async () => {
    const reg = wire();
    const block = await renderNudge(reg, 0.7);
    expect(block).not.toBeNull();
    expect(block!.content_text).toContain('上下文压力 70%');
  });

  it('disappears below the threshold (null block ⇒ no prompt cost)', async () => {
    const reg = wire();
    expect(await renderNudge(reg, 0.69)).toBeNull();
    expect(await renderNudge(reg, 0)).toBeNull();
  });

  it('renders a ratio > 1 (a pathological row pushed pressure over the budget)', async () => {
    const reg = wire();
    const block = await renderNudge(reg, 1.4);
    expect(block).not.toBeNull();
    expect(block!.content_text).toContain('上下文压力 140%');
  });

  it('is byte-identical for the same ratio (INV #1 / #16)', async () => {
    const reg = wire();
    const a = await renderNudge(reg, 0.9);
    const b = await renderNudge(reg, 0.9);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('consumed context_pressure is in the state schema', () => {
  it('the memory manifest seeds context_pressure = 0 and declares the consume', () => {
    const manifest = new MemoryApp({ dir }).manifest();
    expect((manifest.initial_state as MemoryState).context_pressure).toBe(0);
    expect(manifest.consumes).toEqual([{ contract: 'context_pressure', as: 'context_pressure' }]);
  });
});
