/**
 * test/context_pressure.test.ts — the byte-bounded window + fold-grace + context_pressure
 * via (P1#1, §E). App-local coverage through the REAL Operations + default PolicyEngine.
 *
 * Bearing tests (§H, base side):
 *   1. byte window — a flood over E settles Σtok ≤ 0.7·E (after the hard cap fires); a
 *      single pathological row > E is RETAINED in the window (the Renderer's physical clip,
 *      proven in core's context_budget.test.ts P0.2, caps it to E_hard, not this layer);
 *   2. fold-grace — crossing 0.7·E raises grace_pending WITHOUT scrolling the oldest row
 *      (it stays in state.recent + compacted_seq is unchanged); crossing 0.95·E forces the
 *      scroll-out + advances compacted_seq + clears grace_pending;
 *   3. pressure via — base.pressure returns Σtok / E (the contract scalar);
 *   4. seq never regresses — a post-overflow restart's nextSeq does not reuse a seq;
 *   5. INV #1 — same state renders base:recent byte-identically.
 *
 * `tok` semantics: the row's RENDERED UTF-8 byte length + 1 (the `\n` join), the same unit
 * the Renderer clips on — NOT a provider token estimate. The elastic budget E is injected at
 * construction (a small E here isolates byte eviction without pathologically large rows).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppRegistry } from '@block-agent/core/app/registry.js';
import { BlockTree } from '@block-agent/core/core/block.js';
import { Operations } from '@block-agent/core/core/operations.js';
import type { AppContext, BuildContext } from '@block-agent/core/app/types.js';
import type { Block, InvokerContext } from '@block-agent/core/core/types.js';

import { BaseApp, RECENT_BLOCK, type BaseState, type ActionRow } from '../src/manifest.js';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'base-pressure-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const APP: InvokerContext = { invoker: 'app', identity: 'runtime' };
const USER: InvokerContext = { invoker: 'user', identity: 'human' };

/** A small elastic budget E so byte eviction fires on modest rows (gap 0.25·E ≫ one row). */
const E = 2000;

/**
 * Wire a BaseApp with an injected elastic budget E through the REAL Operations + policy.
 * The count cap `window_size` is raised to its MAX (100) so the BYTE budget — not the count
 * 兜底 — is the binding eviction driver in these tests (the modest rows here would otherwise
 * hit the default count cap of 20 long before Σtok reaches the soft water).
 */
async function wire(elasticBudgetBytes = E) {
  const app = new BaseApp(dir, { elasticBudgetBytes });
  const reg = new AppRegistry();
  reg.install(app.manifest());
  const tree = new BlockTree();
  const ops = Operations.with_default_policy({ tree, registry: reg });
  await ops.invoke_command('base.set_config', { window_size: 100 }, USER);
  return { app, reg, ops };
}

function liveState(reg: AppRegistry): BaseState {
  return reg.get_app_context('base')?.state as BaseState;
}

/** Σtok over the live window (the byte weight the budget bounds). */
function sumTok(reg: AppRegistry): number {
  return liveState(reg).recent.reduce((acc, r) => acc + r.tok, 0);
}

/** A command-event arg (kind:'command' + ts), the shape the launch subscription passes. */
function commandArg(name: string, args: unknown, result?: unknown) {
  return {
    kind: 'command' as const,
    name,
    args,
    ok: true,
    invoker: 'agent' as const,
    ts: '14:30',
    ...(result !== undefined ? { result } : {}),
  };
}

/** Record one input row with a fixed-size preview (deterministic, ~modest tok). */
async function recordInput(ops: Operations, n: number): Promise<void> {
  await ops.invoke_command(
    'base.record',
    { kind: 'input', source: 'messages', sender: 'user', preview: `row-${n}-${'x'.repeat(20)}`, ts: '14:31' },
    APP,
  );
}

/** A throwaway BuildContext; the recent builder ignores it (state-only build, INV #16). */
function fakeBuildContext(): BuildContext {
  return {
    snapshot: { root: { id: 'r', name: 'root:root', children: [], content_text: null, content_blob: null }, hash: 'h', get: () => null },
    read: () => null,
    deterministic_clock: () => 0,
    deterministic_random: () => 0,
    content_addressed_id: (s: string) => s,
    config: {},
  } as unknown as BuildContext;
}

/** A minimal AppContext carrying a fixed state — all the builder reads (INV #16). */
function stateCtx(state: BaseState): AppContext<BaseState> {
  return { app_id: 'base', state } as unknown as AppContext<BaseState>;
}

/** Render `base:recent` via its registered builder against the given state. */
async function renderRecentBlock(reg: AppRegistry, state: BaseState): Promise<Block | null> {
  const builder = reg.resolve_builder(RECENT_BLOCK as never);
  if (builder === null) throw new Error('no builder for base:recent');
  return builder.build(fakeBuildContext(), stateCtx(state));
}

// ---------------------------------------------------------------------------
// 1. byte window
// ---------------------------------------------------------------------------

describe('byte-bounded window', () => {
  it('a flood over E stays under the hard cap; the hard cap settles Σtok ≤ 0.7·E', async () => {
    const { reg, ops } = await wire();
    const soft = 0.7 * E;
    const hard = 0.95 * E;

    let evicted = false; // did the hard cap ever fire?
    let firedPostEvictionTotal = -1;
    let prevCompacted = liveState(reg).compacted_seq;

    // Feed far more rows than fit in E (each ~40 bytes; 200 rows ≫ E=2000).
    for (let i = 0; i < 200; i += 1) {
      await recordInput(ops, i);
      const st = liveState(reg);
      const total = sumTok(reg);
      // TRANSIENT BOUND (§9.3): after EVERY record the window is below the hard cap — the
      // moment a record would reach 0.95·E it evicts in the same step. This is what keeps the
      // rendered stream under E (the Renderer's E_hard clip is the further physical floor).
      expect(total).toBeLessThan(hard);
      // Capture Σtok at the first record whose eviction advanced compacted_seq: that is the
      // "硬帽后回落" moment, where the window has been pulled down to the soft water.
      if (!evicted && st.compacted_seq > prevCompacted) {
        evicted = true;
        firedPostEvictionTotal = total;
      }
      prevCompacted = st.compacted_seq;
    }

    // The hard cap actually fired (byte eviction, not just the count兜底), and at that moment
    // Σtok had fallen to ≤ 0.7·E (the soft water it evicts down to).
    expect(evicted).toBe(true);
    expect(firedPostEvictionTotal).toBeGreaterThanOrEqual(0);
    expect(firedPostEvictionTotal).toBeLessThanOrEqual(soft);

    // Steady-state window: non-empty, every row carries a tok, and (count兜底 never bound) the
    // length is well under the 100-row cap — the BYTE budget is the driver.
    const st = liveState(reg);
    expect(st.recent.length).toBeGreaterThan(0);
    expect(st.recent.length).toBeLessThan(100);
    expect(st.recent.every((r) => typeof r.tok === 'number' && r.tok > 0)).toBe(true);
  });

  it('a single pathological row > E is retained in the window (length 1)', async () => {
    const { reg, ops } = await wire();
    // Warm the window with a few small rows, then a command whose result body renders > E.
    for (let i = 0; i < 3; i += 1) await recordInput(ops, i);
    const huge = 'Z'.repeat(E * 2); // result_text at command_detail=3 is untruncated → tok > E
    await ops.invoke_command('base.record', commandArg('base.read_file', { path: 'big' }, huge), APP);

    const st = liveState(reg);
    // The newest huge row was never evicted (we never drop the just-pushed row): the prior
    // small rows scrolled out under it, leaving exactly the one row > E in the window.
    expect(st.recent.length).toBe(1);
    const only = st.recent[0]!;
    expect(only.kind).toBe('command');
    expect(only.tok).toBeGreaterThan(E);
    // The Renderer's per-block physical clip to E_hard (core P0.2) bounds the transient — not
    // this layer; here we only assert the window does NOT drop the latest observation.
  });
});

// ---------------------------------------------------------------------------
// 2. fold-grace
// ---------------------------------------------------------------------------

describe('fold-grace (record-driven)', () => {
  it('crossing the soft water raises grace_pending WITHOUT scrolling the oldest row', async () => {
    const { reg, ops } = await wire();
    const soft = 0.7 * E;
    const hard = 0.95 * E;

    let crossedSoft = -1;
    for (let i = 0; i < 1000; i += 1) {
      await recordInput(ops, i);
      const total = sumTok(reg);
      if (total >= soft) {
        crossedSoft = i;
        break;
      }
    }
    expect(crossedSoft).toBeGreaterThanOrEqual(0);

    const st = liveState(reg);
    const total = sumTok(reg);
    // The first crossing lands in the grace band [soft, hard) (rows ≪ the 0.25·E gap).
    expect(total).toBeGreaterThanOrEqual(soft);
    expect(total).toBeLessThan(hard);
    // grace is latched, and NOTHING scrolled: seq 0 is still present, compacted_seq untouched.
    expect(st.grace_pending).toBe(true);
    expect(st.recent[0]!.seq).toBe(0);
    expect(st.compacted_seq).toBe(-1); // initial high-water, never advanced (no scroll-out)
  });

  it('crossing the hard cap forces scroll-out, advances compacted_seq, clears grace', async () => {
    const { reg, ops } = await wire();
    const hard = 0.95 * E;

    // Keep feeding until the hard cap fires (Σ would reach ≥ hard, triggering eviction).
    for (let i = 0; i < 1000; i += 1) {
      await recordInput(ops, i);
      if (liveState(reg).compacted_seq >= 0) break; // first eviction advanced the high-water
    }

    const st = liveState(reg);
    // A scroll-out happened: compacted_seq advanced past the initial -1, the oldest seq 0 is
    // gone, the window settled ≤ soft, and grace cleared (the hard branch evicts, not defers).
    expect(st.compacted_seq).toBeGreaterThanOrEqual(0);
    expect(st.recent.some((r) => r.seq === 0)).toBe(false);
    expect(sumTok(reg)).toBeLessThanOrEqual(0.7 * E);
    expect(sumTok(reg)).toBeLessThan(hard);
    expect(st.grace_pending).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. pressure via (the context_pressure contract scalar)
// ---------------------------------------------------------------------------

describe('base.pressure (context_pressure via)', () => {
  it('returns Σtok / E as a scalar number', async () => {
    const { reg, ops } = await wire();
    for (let i = 0; i < 10; i += 1) await recordInput(ops, i);
    const expected = sumTok(reg) / E;

    const res = await ops.invoke_command('base.pressure', {}, APP);
    expect(res.ok).toBe(true);
    expect(typeof res.data).toBe('number');
    expect(res.data as number).toBeCloseTo(expected, 10);
  });

  it('an empty window reports zero pressure', async () => {
    const { ops } = await wire();
    const res = await ops.invoke_command('base.pressure', {}, APP);
    expect(res.ok).toBe(true);
    expect(res.data).toBe(0);
  });

  it('is NOT agent-callable (app/user only — never in the agent tool catalog)', async () => {
    const { ops } = await wire();
    const asAgent = await ops.invoke_command('base.pressure', {}, { invoker: 'agent', identity: 'main' });
    expect(asAgent.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. seq never regresses (post-overflow restart)
// ---------------------------------------------------------------------------

describe('seq high-water survives byte overflow + restart', () => {
  it('a restart after overflow does not reuse a scrolled-out seq', async () => {
    const { reg, ops } = await wire();
    const N = 100;
    for (let i = 0; i < N; i += 1) await recordInput(ops, i);
    // Many rows scrolled out of the byte window, but every record is still in the jsonl.
    expect(liveState(reg).compacted_seq).toBeGreaterThanOrEqual(0);
    expect(liveState(reg).recent.length).toBeLessThan(N); // byte budget evicted the old rows

    // Restart: a fresh BaseApp on the same dir seeds nextSeq from the jsonl TAIL (not the
    // rolled window), so the next seq is N — it never reuses a scrolled-out seq.
    const restarted = new BaseApp(dir, { elasticBudgetBytes: E });
    expect(restarted.store.nextSeq()).toBe(N);
  });
});

// ---------------------------------------------------------------------------
// 5. INV #1 — byte-identical render of base:recent
// ---------------------------------------------------------------------------

describe('INV #1 — byte-identical render', () => {
  it('the same state renders base:recent byte-identically twice', async () => {
    const { reg, ops } = await wire();
    for (let i = 0; i < 12; i += 1) await recordInput(ops, i);
    const st = liveState(reg);
    const a = await renderRecentBlock(reg, st);
    const b = await renderRecentBlock(reg, st);
    expect(a).not.toBeNull();
    expect(a!.content_text).toBe(b!.content_text);
    // The tok bookkeeping field is NEVER rendered (it is record-time accounting only).
    expect(a!.content_text).not.toContain('tok');
  });

  it('tok does not leak into the rendered row text (accounting only)', async () => {
    const { reg, ops } = await wire();
    await recordInput(ops, 0);
    const st = liveState(reg);
    const row: ActionRow = st.recent[0]!;
    expect(typeof row.tok).toBe('number');
    const block = await renderRecentBlock(reg, st);
    expect(block!.content_text).toContain('[0] input ← user @14:31');
  });
});
