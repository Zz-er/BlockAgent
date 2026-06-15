/**
 * stall-guard (§8.1) — owned by impl-runtime.
 *
 * A weaker model can loop: it keeps issuing tool_calls that never end the turn and
 * never replies, so the wake loop runs to max_turns_per_wake (16) — ~48 tool calls.
 * The stall-guard detects NO PROGRESS (a turn whose tool_calls are ALL exact repeats
 * of commands already issued THIS wake) and stops early:
 *   - 1st stall  → project the loop-feedback nudge (the agent self-corrects next turn).
 *   - 2nd stall  → break the wake (bounds a runaway to ~3 turns).
 *
 * The crux distinction: SAME command name + DIFFERENT args = DIFFERENT work (a new
 * signature) and is NEVER flagged. Only an EXACT (name+args) repeat counts.
 */

import { describe, expect, it } from 'vitest';

import { PolicyEngine } from '../src/core/policy.js';
import { MockProvider } from '../src/provider/mock.js';
import {
  AgentRuntime,
  LOOP_FEEDBACK_BLOCK,
  LOOP_FEEDBACK_TEXT,
} from '../src/runtime/agent_runtime.js';
import type { BlockOp, BlockName } from '../src/core/types.js';
import type { CommandManifest } from '../src/app/types.js';
import {
  TestBuilderRegistry,
  TestCommandRegistry,
  TestOperations,
  TestRenderer,
  makeEmptyTree,
  makeEndTurnApp,
} from './fixtures.js';

const WAKE = {
  kind: 'app_event',
  source: 'messages',
  reason: 'message_arrived',
  ref: 'm1',
} as const;

/**
 * A fixture command `work.do({...})` that NEVER ends the turn and writes a per-args
 * block, so the wake loop would otherwise keep running. It always succeeds — the
 * stall-guard must fire purely on REPEATED (name+args), not on a failure. Each distinct
 * args set writes a distinct block name so "different args = different work" is visible.
 */
function makeWorkApp(registry: TestCommandRegistry): void {
  const manifest: CommandManifest = {
    name: 'do',
    description: 'A demo command that never ends the turn (stall-guard fixture).',
    capabilities: [{ name: 'block:write' }],
    invoke: async () => ({ ok: true }),
  };
  registry.register('work.do', manifest, async (args) => {
    const key = JSON.stringify(args);
    const op: BlockOp = {
      kind: 'create',
      parent: 'root:root',
      block: {
        id: `work-${key}`,
        name: `work:${key}` as BlockName,
        children: [],
        content_text: key,
        content_blob: null,
      },
    };
    return { ok: true, ops: [op], data: { did: key } };
  });
}

function wire(provider: MockProvider, opts?: { withEndTurn?: boolean }) {
  const tree = makeEmptyTree();
  const registry = new TestCommandRegistry();
  makeWorkApp(registry);
  if (opts?.withEndTurn) makeEndTurnApp(registry);
  const policy = new PolicyEngine({ capability_resolver: registry.capabilityResolver() });
  const ops = new TestOperations(tree, policy, registry);
  const builders = new TestBuilderRegistry();
  const renderer = new TestRenderer(builders);
  const runtime = new AgentRuntime({
    operations: ops,
    renderer,
    provider,
    registry: builders,
  });
  return { tree, ops, runtime, builders, renderer };
}

/** Seed the bookkeeping projection placeholders + render → the text the agent sees. */
async function seedAndRenderText(
  ops: TestOperations,
  runtime: AgentRuntime,
  builders: TestBuilderRegistry,
  renderer: TestRenderer,
): Promise<string> {
  for (const builder of builders.list_builders()) {
    for (const name of builder.outputs) {
      if (ops.has(name)) continue;
      await ops.apply(
        [
          {
            kind: 'create',
            parent: runtime.root,
            block: { id: `seed-${name}`, name, children: [], content_text: null, content_blob: null },
          },
        ],
        { invoker: 'app', trust: 'trusted' },
      );
    }
  }
  const prompt = await renderer.render(ops.snapshot());
  return prompt.segments.map((s) => (typeof s.rendered === 'string' ? s.rendered : '')).join('\n');
}

/** A turn that re-issues the EXACT same (name+args) command. */
const REPEAT = { tool_calls: [{ id: 't', name: 'work.do', args: { x: 1 } }] } as const;

describe('stall-guard: identical (name+args) repeats', () => {
  it('1st stall nudges (loop_feedback set), 2nd stall breaks the wake (loop bounded)', async () => {
    // Script far more turns than the guard should ever let run. Turn 1 does NEW work
    // (records the signature). Turns 2,3,4,... repeat it exactly → turn 2 = 1st stall
    // (nudge), turn 3 = 2nd stall (break). With NO guard, this would run to
    // max_turns_per_wake (16). We assert it stops at 3 and far below 16.
    const provider = new MockProvider(
      Array.from({ length: 16 }, () => ({
        tool_calls: [{ id: 't', name: 'work.do', args: { x: 1 } }],
      })),
    );
    const { ops, runtime, builders, renderer } = wire(provider);

    await runtime.on_wake(WAKE);

    // turn1 new work, turn2 1st stall (nudge), turn3 2nd stall → break. 3 turns total.
    expect(provider.turns_consumed).toBe(3);
    expect(provider.turns_consumed).toBeLessThan(16);
    expect(runtime.state.kind).toBe('idle');

    // The loop-feedback nudge is projected (it persisted after the break).
    const text = await seedAndRenderText(ops, runtime, builders, renderer);
    expect(text).toContain(LOOP_FEEDBACK_BLOCK);
    expect(text).toContain(LOOP_FEEDBACK_TEXT);
  });

  it('the 1st stall sets the nudge but does NOT break (gives a chance to self-correct)', async () => {
    // Only turn 1 (new) + turn 2 (1st stall) are scripted; an empty 3rd turn would end
    // the loop normally. If the 1st stall broke prematurely, turn-3 (the empty turn that
    // ends progress) would never run. We assert the loop ran into turn 3 (NOT broken at 2)
    // AND that the empty turn ended it (no break needed), proving the 1st stall is a nudge.
    const provider = new MockProvider([
      { tool_calls: [{ id: 't1', name: 'work.do', args: { x: 1 } }] }, // new work
      { tool_calls: [{ id: 't2', name: 'work.do', args: { x: 1 } }] }, // 1st stall (nudge)
      {}, // empty: a different turn that would reset + end the loop
    ]);
    const { runtime } = wire(provider);

    await runtime.on_wake(WAKE);

    expect(provider.turns_consumed).toBe(3); // ran past the 1st stall; ended on the empty turn
    expect(runtime.state.kind).toBe('idle');
  });
});

describe('stall-guard: same command name with DIFFERENT args is NOT a stall', () => {
  it('runs normally (every turn does new work) — the guard never trips', async () => {
    // Each turn calls the SAME command name but with DIFFERENT args → a new signature
    // every turn = real progress. The guard must NOT fire: the loop runs every scripted
    // turn and ends only on the trailing empty turn. This is the crux of the design.
    const provider = new MockProvider([
      { tool_calls: [{ id: 'a', name: 'work.do', args: { x: 1 } }] },
      { tool_calls: [{ id: 'b', name: 'work.do', args: { x: 2 } }] },
      { tool_calls: [{ id: 'c', name: 'work.do', args: { x: 3 } }] },
      { tool_calls: [{ id: 'd', name: 'work.do', args: { x: 4 } }] },
      {}, // empty → ends the loop (no commands, no feedback)
    ]);
    const { ops, runtime, builders, renderer } = wire(provider);

    await runtime.on_wake(WAKE);

    // All 5 turns ran (4 distinct-work turns + the empty terminator) — far past where a
    // stall would have broken (3). No premature break.
    expect(provider.turns_consumed).toBe(5);
    expect(runtime.state.kind).toBe('idle');

    // No loop-feedback was ever projected (no stall happened).
    const text = await seedAndRenderText(ops, runtime, builders, renderer);
    expect(text).not.toContain(LOOP_FEEDBACK_TEXT);
    expect(text).not.toContain(LOOP_FEEDBACK_BLOCK);
  });

  it('reordered keys in args count as the SAME signature (stable, sorted-key stringify)', async () => {
    // {a:1,b:2} and {b:2,a:1} are structurally equal → same signature → a stall on the
    // repeat, proving the key-order-independence of the signature. Turn1 new, turn2/3 are
    // the SAME command with REORDERED keys → 1st stall, 2nd stall → break at 3.
    const provider = new MockProvider([
      { tool_calls: [{ id: '1', name: 'work.do', args: { a: 1, b: 2 } }] },
      { tool_calls: [{ id: '2', name: 'work.do', args: { b: 2, a: 1 } }] },
      { tool_calls: [{ id: '3', name: 'work.do', args: { b: 2, a: 1 } }] },
      { tool_calls: [{ id: '4', name: 'work.do', args: { a: 1, b: 2 } }] },
    ]);
    const { runtime } = wire(provider);

    await runtime.on_wake(WAKE);

    expect(provider.turns_consumed).toBe(3); // reordered keys are the same work → stalls
    expect(runtime.state.kind).toBe('idle');
  });
});

describe('stall-guard: clean exits are never stalls', () => {
  it('a turn that ends via reply (end_turn) is unaffected', async () => {
    // The reply ends the turn on turn 1; the scripted 2nd turn never runs. The guard must
    // not interfere with the normal end_turn exit.
    const provider = new MockProvider([
      { tool_calls: [{ id: 'r', name: 'done.reply', args: {} }] },
      { tool_calls: [{ id: 'r2', name: 'done.reply', args: {} }] },
    ]);
    const { ops, runtime, builders, renderer } = wire(provider, { withEndTurn: true });

    await runtime.on_wake(WAKE);

    expect(provider.turns_consumed).toBe(1); // ended on reply, no second turn
    expect(runtime.state.kind).toBe('idle');
    // No loop-feedback projected.
    const text = await seedAndRenderText(ops, runtime, builders, renderer);
    expect(text).not.toContain(LOOP_FEEDBACK_TEXT);
  });

  it('a repeated reply across wakes does not accumulate a stall (per-wake reset)', async () => {
    // Wake 1 and wake 2 both reply with the identical (name+args). Because the signature
    // set resets per wake AND end_turn resets the stall counter, neither wake stalls.
    const provider = new MockProvider([
      { tool_calls: [{ id: 'r', name: 'done.reply', args: {} }] },
      { tool_calls: [{ id: 'r', name: 'done.reply', args: {} }] },
    ]);
    const { runtime } = wire(provider, { withEndTurn: true });

    await runtime.on_wake(WAKE);
    await runtime.on_wake(WAKE);

    expect(provider.turns_consumed).toBe(2); // one reply per wake, no stall break
    expect(runtime.state.kind).toBe('idle');
  });
});

describe('stall-guard: loop_feedback projection (B1, INV #1)', () => {
  it('the loop-feedback builder owns runtime:loop_feedback, volatile, registered at construction', () => {
    const { builders } = wire(new MockProvider([{}]));
    expect(builders.resolve_builder(LOOP_FEEDBACK_BLOCK)?.name).toBe('runtime.loop_feedback');
    expect(builders.tier_of(LOOP_FEEDBACK_BLOCK)).toBe('volatile');
  });

  it('projects nothing on a clean (no-stall) wake — builder returns null', async () => {
    const provider = new MockProvider([{}]); // no commands, no stall
    const { ops, runtime, builders, renderer } = wire(provider);

    await runtime.on_wake(WAKE);

    const text = await seedAndRenderText(ops, runtime, builders, renderer);
    expect(text).not.toContain(LOOP_FEEDBACK_TEXT);
    expect(text).not.toContain(LOOP_FEEDBACK_BLOCK);
  });

  it('renders byte-identical for the same snapshot once a stall is pending (INV #1)', async () => {
    // Drive a stall so pending_loop_feedback is set, then render the SAME snapshot twice:
    // the projection must be byte-identical (the builder is pure).
    const provider = new MockProvider(
      Array.from({ length: 16 }, () => ({
        tool_calls: [{ id: 't', name: 'work.do', args: { x: 1 } }],
      })),
    );
    const { ops, runtime, builders, renderer } = wire(provider);

    await runtime.on_wake(WAKE);
    // Seed the placeholders once, then render the resulting snapshot twice.
    await seedAndRenderText(ops, runtime, builders, renderer);
    const snap = ops.snapshot();
    const a = await renderer.render(snap);
    const b = await renderer.render(snap);
    expect(b.snapshot_hash).toBe(a.snapshot_hash);
    expect(JSON.stringify(b.segments)).toBe(JSON.stringify(a.segments));
    // And the loop-feedback text is actually present (the stall really fired).
    const flat = a.segments.map((s) => (typeof s.rendered === 'string' ? s.rendered : '')).join('\n');
    expect(flat).toContain(LOOP_FEEDBACK_TEXT);
  });

  it('the runtime never writes runtime:loop_feedback to the tree (only projected)', async () => {
    const provider = new MockProvider(
      Array.from({ length: 16 }, () => ({
        tool_calls: [{ id: 't', name: 'work.do', args: { x: 1 } }],
      })),
    );
    const { tree, runtime } = wire(provider);

    await runtime.on_wake(WAKE);

    // No bookkeeping node was written to the tree by the runtime (B1 — state is SoT).
    expect(tree.get(LOOP_FEEDBACK_BLOCK)).toBeNull();
  });
});
