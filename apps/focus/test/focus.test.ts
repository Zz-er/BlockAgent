/**
 * test/focus.test.ts — the focus BlockApp (D5 P1.5a). Covers §3 (the carriers), the A1
 * staleness/degrade amendment, the A2 cold-start + completion-hint amendment, §7
 * multi-window per-focus keying, §6 restart-restore, and the anti-injection invoker gate
 * on `focus.set_goal`:
 *
 *   - `focus.record` is a DETERMINISTIC, clock-free fold: the same TurnRecord sequence
 *     yields the same FocusState; the cursor is monotonic; last_outcome_ptr tracks the
 *     latest turn; no Date.now / Math.random in the fold path;
 *   - WorkingStateBlock renders the active slice purely and DEGRADES (A1 iii) when the
 *     slice is not fresh; the staleness/priority cue (A1 ii) is present when fresh;
 *   - `focus.set_goal` is allowed for agent + user but DENIED for `app` (anti-injection,
 *     §3.4) — an injected/foreign source cannot set the agent's intent;
 *   - cold-start seeds wake_reason on a brand-new focus (§7), then the record overwrites
 *     it with the distilled value the same turn;
 *   - per-focus keying: two foci coexist in state; builders render only the ACTIVE slice;
 *   - restart restores the bounded state from the durable jsonl;
 *   - jsonl uses a temp dir so the repo's real `.block-agent` is never touched.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRegistry } from '@block-agent/core/app/registry.js';
import { BlockTree } from '@block-agent/core/core/block.js';
import { Operations } from '@block-agent/core/core/operations.js';
import type { AppContext, BuildContext } from '@block-agent/core/app/types.js';
import type { Block, InvokerContext, WakeEvent } from '@block-agent/core/core/types.js';

import {
  FocusApp,
  FocusStore,
  WORKING_STATE_BLOCK,
  RECENT_ACTION_BLOCK,
  GOAL_BLOCK,
  DEGRADED_WORKING_STATE,
  foldTurn,
  restoreState,
  focusIdOf,
  wakeReasonOf,
  emptySlice,
  type FocusState,
  type DistillerTurnRecord,
} from '../src/manifest.js';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'focus-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const AGENT: InvokerContext = { invoker: 'agent', identity: 'main' };
const USER: InvokerContext = { invoker: 'user', identity: 'human' };
const APP: InvokerContext = { invoker: 'app', identity: 'runtime' };

const MESSAGES_WAKE: WakeEvent = { kind: 'app_event', source: 'messages', reason: 'message_arrived', ref: 'm1' };
const TASK_WAKE: WakeEvent = { kind: 'app_event', source: 'task', reason: 'task_arrived', ref: 't1' };

/** A DistillerTurnRecord for direct foldTurn tests. */
function rec(turn_id: string, ended_by: string, wake: WakeEvent = MESSAGES_WAKE): DistillerTurnRecord {
  return { turn_id, ended_by, wake_event: wake };
}

/** The runtime's onTurn TurnRecord shape `focus.record` accepts (only the read fields matter). */
function turnRecordArg(turn_id: string, ended_by: string, wake: WakeEvent = MESSAGES_WAKE) {
  return { turn_record: { turn_id, ended_by, wake_event: wake } };
}

/** Wire a FocusApp through the REAL Operations + default PolicyEngine (the gate). */
function wire(store?: FocusStore) {
  const app = new FocusApp({ dir: join(dir, 'store'), ...(store ? { store } : {}) });
  const reg = new AppRegistry();
  reg.install(app.manifest());
  const root: Block = {
    id: 'root', name: 'root:root', children: [], content_text: null, content_blob: null,
  };
  const tree = new BlockTree(root);
  const ops = Operations.with_default_policy({ tree, registry: reg });
  return { app, reg, ops };
}

/** Read the App's live state through its installed AppContext. */
function liveState(reg: AppRegistry): FocusState {
  return reg.get_app_context('focus')?.state as FocusState;
}

/** A throwaway BuildContext; focus builders ignore it (state-only build, INV #16). */
function fakeBuildContext(): BuildContext {
  return {
    snapshot: {
      root: { id: 'r', name: 'root:root', children: [], content_text: null, content_blob: null },
      hash: 'h',
      get: () => null,
    },
    read: () => null,
    deterministic_clock: () => 0,
    deterministic_random: () => 0,
    content_addressed_id: (s) => s,
    config: {},
  };
}

/** A minimal AppContext carrying a fixed state — all a builder reads (INV #16). */
function stateCtx(state: FocusState) {
  return {
    app_id: 'focus',
    state,
    set_state: () => undefined,
    list_commands: () => [],
    list_builders: () => [],
    list_blocks: () => [],
    invoke_command: async () => ({ ok: true }),
    read: async () => [],
    on: () => undefined,
    emit: () => undefined,
    spawn_system_agent: () => ({ id: 'x', stop: () => undefined }),
  } as unknown as AppContext<FocusState>;
}

/** Render a block via its registered builder against a fixed state. */
async function renderBlock(reg: AppRegistry, blockName: string, state: FocusState): Promise<Block | null> {
  const builder = reg.resolve_builder(blockName as never);
  if (builder === null) throw new Error(`no builder for ${blockName}`);
  return builder.build(fakeBuildContext(), stateCtx(state));
}

// ---------------------------------------------------------------------------
// focus.record — the deterministic distiller fold
// ---------------------------------------------------------------------------

describe('focus.record (deterministic distiller)', () => {
  it('same TurnRecord sequence → same FocusState (determinism, no clock/random)', () => {
    const empty: FocusState = { active_focus: '', foci: {}, config: { recent_limit: 8 } };
    const seq = [rec('1.0', 'tool_calls'), rec('1.1', 'tool_calls'), rec('1.2', 'reply')];
    const a = seq.reduce(foldTurn, empty);
    const b = seq.reduce(foldTurn, empty);
    expect(a).toEqual(b);
  });

  it('the fold never reads the clock or random', async () => {
    const now = vi.spyOn(Date, 'now');
    const rand = vi.spyOn(Math, 'random');
    const empty: FocusState = { active_focus: '', foci: {}, config: { recent_limit: 8 } };
    foldTurn(foldTurn(empty, rec('1.0', 'tool_calls')), rec('1.1', 'reply'));
    expect(now).not.toHaveBeenCalled();
    expect(rand).not.toHaveBeenCalled();
    now.mockRestore();
    rand.mockRestore();
  });

  it('cursor is monotonic and last_outcome_ptr tracks the latest turn', async () => {
    const { reg, ops } = wire();
    await ops.invoke_command('focus.record', turnRecordArg('1.0', 'tool_calls'), APP);
    await ops.invoke_command('focus.record', turnRecordArg('1.1', 'tool_calls'), APP);
    await ops.invoke_command('focus.record', turnRecordArg('1.2', 'reply'), APP);
    const slice = liveState(reg).foci['messages']!;
    expect(slice.cursor.step).toBe(3);
    expect(slice.last_outcome_ptr).toBe('1.2');
    expect(slice.distilled_as_of).toBe('1.2');
    expect(slice.fresh).toBe(true);
  });

  it('appends to the recent window + compacts past the limit (window+fold shape)', () => {
    let state: FocusState = { active_focus: '', foci: {}, config: { recent_limit: 2 } };
    for (let i = 0; i < 5; i += 1) state = foldTurn(state, rec(`1.${i}`, 'tool_calls'));
    const slice = state.foci['messages']!;
    // window bounded to 2; the older 3 folded into the summary.
    expect(slice.recent_actions.map((a) => a.turn_id)).toEqual(['1.3', '1.4']);
    expect(slice.actions_summary).toContain('folded');
    expect(slice.actions_summary).toContain('1.0');
  });

  it('record durably appends to the focus jsonl', async () => {
    const { app, ops } = wire();
    await ops.invoke_command('focus.record', turnRecordArg('1.0', 'reply'), APP);
    const rows = app.store.readAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ turn_id: '1.0', ended_by: 'reply', focus: 'messages' });
  });

  it('rejects a malformed turn_record (missing fields)', async () => {
    const { ops } = wire();
    const res = await ops.invoke_command('focus.record', { turn_record: { turn_id: 'x' } }, APP);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A2 — cold-start seed + completion hint
// ---------------------------------------------------------------------------

describe('cold-start + A2 completion hint', () => {
  it('cold-start seeds wake_reason on a brand-new focus, then record overwrites it', () => {
    const empty: FocusState = { active_focus: '', foci: {}, config: { recent_limit: 8 } };
    const next = foldTurn(empty, rec('1.0', 'tool_calls', TASK_WAKE));
    const slice = next.foci['task']!;
    // the distilled wake_reason is the human-readable projection of the wake event.
    expect(slice.wake_reason).toBe(wakeReasonOf(TASK_WAKE));
    expect(next.active_focus).toBe('task');
  });

  it('a reply-ended turn sets a "goal looks complete?" hint when a goal is set (A2)', () => {
    let state: FocusState = {
      active_focus: 'messages',
      foci: { messages: { ...emptySlice(), goal: 'ship the feature' } },
      config: { recent_limit: 8 },
    };
    state = foldTurn(state, rec('1.0', 'reply'));
    expect(state.foci['messages']!.cursor.note).toContain('goal looks complete?');
  });

  it('no completion hint when there is no goal yet', () => {
    const empty: FocusState = { active_focus: '', foci: {}, config: { recent_limit: 8 } };
    const next = foldTurn(empty, rec('1.0', 'reply'));
    expect(next.foci['messages']!.cursor.note).toBe('');
  });
});

// ---------------------------------------------------------------------------
// WorkingStateBlock — pure render + A1 degrade
// ---------------------------------------------------------------------------

describe('WorkingStateBlock (A1)', () => {
  it('renders the active slice with the staleness/priority cue when fresh (A1 ii)', async () => {
    const { reg } = wire();
    const state = foldTurn(
      { active_focus: '', foci: {}, config: { recent_limit: 8 } },
      rec('3.0', 'tool_calls'),
    );
    const block = await renderBlock(reg, WORKING_STATE_BLOCK, state);
    expect(block?.content_text).toContain('distilled as of turn 3.0');
    expect(block?.content_text).toContain('recent window is authoritative');
    expect(block?.content_text).not.toContain(DEGRADED_WORKING_STATE);
  });

  it('DEGRADES to "read recent window" when the active slice is not fresh (A1 iii)', async () => {
    const { reg } = wire();
    const state: FocusState = {
      active_focus: 'messages',
      foci: { messages: { ...emptySlice() /* fresh:false */ } },
      config: { recent_limit: 8 },
    };
    const block = await renderBlock(reg, WORKING_STATE_BLOCK, state);
    expect(block?.content_text).toContain(DEGRADED_WORKING_STATE);
  });

  it('is byte-identical for the same state (INV #1)', async () => {
    const { reg } = wire();
    const state = foldTurn(
      { active_focus: '', foci: {}, config: { recent_limit: 8 } },
      rec('1.0', 'tool_calls'),
    );
    const a = await renderBlock(reg, WORKING_STATE_BLOCK, state);
    const b = await renderBlock(reg, WORKING_STATE_BLOCK, state);
    expect(a?.content_text).toBe(b?.content_text);
  });

  it('renders nothing when there is no active focus yet', async () => {
    const { reg } = wire();
    const empty: FocusState = { active_focus: '', foci: {}, config: { recent_limit: 8 } };
    expect(await renderBlock(reg, WORKING_STATE_BLOCK, empty)).toBeNull();
  });

  it('the builder is slow_changing + owner system (INV #4)', () => {
    const { reg } = wire();
    const b = reg.resolve_builder(WORKING_STATE_BLOCK as never)!;
    expect(b.cache_tier).toBe('slow_changing');
    expect(b.owner).toBe('system');
  });

  it('the recent-action window builder is volatile (the correctness floor, §3.2)', () => {
    const { reg } = wire();
    const b = reg.resolve_builder(RECENT_ACTION_BLOCK as never)!;
    expect(b.cache_tier).toBe('volatile');
  });
});

// ---------------------------------------------------------------------------
// focus.set_goal — anti-injection invoker gate (§3.4)
// ---------------------------------------------------------------------------

describe('focus.set_goal (anti-injection gate)', () => {
  it('the agent may set the goal', async () => {
    const { reg, ops } = wire();
    const res = await ops.invoke_command('focus.set_goal', { text: 'ship it' }, AGENT);
    expect(res.ok).toBe(true);
    expect(liveState(reg).foci[liveState(reg).active_focus]!.goal).toBe('ship it');
  });

  it('the user may set the goal', async () => {
    const { ops } = wire();
    expect((await ops.invoke_command('focus.set_goal', { text: 'g' }, USER)).ok).toBe(true);
  });

  it('the app invoker is DENIED (injected/foreign cannot set intent)', async () => {
    const { ops } = wire();
    const res = await ops.invoke_command('focus.set_goal', { text: 'injected goal' }, APP);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
  });

  it('declares allowed_invokers [agent, user] (excludes app) on the manifest', () => {
    const { reg } = wire();
    expect(reg.resolve_command('focus.set_goal')?.allowed_invokers).toEqual(['agent', 'user']);
  });

  it('setting the goal clears a stale completion hint', async () => {
    const { reg, ops } = wire();
    // First a turn establishes the active `messages` focus, THEN the agent states a goal
    // on it, THEN a reply-ended turn raises the A2 hint; restating the goal clears it.
    await ops.invoke_command('focus.record', turnRecordArg('1.0', 'tool_calls'), APP);
    await ops.invoke_command('focus.set_goal', { text: 'g1' }, AGENT);
    await ops.invoke_command('focus.record', turnRecordArg('1.1', 'reply'), APP);
    expect(liveState(reg).foci['messages']!.cursor.note).toContain('goal looks complete?');
    await ops.invoke_command('focus.set_goal', { text: 'g2' }, AGENT);
    expect(liveState(reg).foci['messages']!.cursor.note).toBe('');
  });

  it('the goal block renders the active goal (③, separate writer)', async () => {
    const { reg } = wire();
    const state: FocusState = {
      active_focus: 'messages',
      foci: { messages: { ...emptySlice(), goal: 'the goal' } },
      config: { recent_limit: 8 },
    };
    const block = await renderBlock(reg, GOAL_BLOCK, state);
    expect(block?.content_text).toContain('the goal');
  });
});

// ---------------------------------------------------------------------------
// §7 multi-window per-focus keying
// ---------------------------------------------------------------------------

describe('per-focus keying (§7)', () => {
  it('two foci coexist; builders render ONLY the active slice', async () => {
    const { reg, ops } = wire();
    // a messages wake then a task wake → two foci, task is now active.
    await ops.invoke_command('focus.record', turnRecordArg('1.0', 'tool_calls', MESSAGES_WAKE), APP);
    await ops.invoke_command('focus.record', turnRecordArg('2.0', 'tool_calls', TASK_WAKE), APP);
    const state = liveState(reg);
    expect(Object.keys(state.foci).sort()).toEqual(['messages', 'task']);
    expect(state.active_focus).toBe('task');

    // the recent-action window renders only the ACTIVE (task) slice's actions.
    const block = await renderBlock(reg, RECENT_ACTION_BLOCK, state);
    expect(block?.content_text).toContain('2.0');
    expect(block?.content_text).not.toContain('1.0');
  });

  it('focusIdOf keys a window off the wake source, not the ref (a window spans messages)', () => {
    expect(focusIdOf({ kind: 'app_event', source: 'messages', ref: 'm1' })).toBe('messages');
    expect(focusIdOf({ kind: 'app_event', source: 'messages', ref: 'm2' })).toBe('messages');
  });
});

// ---------------------------------------------------------------------------
// §6 restart-restore
// ---------------------------------------------------------------------------

describe('restart-restore (§6)', () => {
  it('restoreState replays the durable jsonl back into a bounded fresh state', () => {
    const records = [
      { turn_id: '1.0', ended_by: 'tool_calls', focus: 'messages', wake: 'messages: message_arrived' },
      { turn_id: '1.1', ended_by: 'reply', focus: 'messages', wake: 'messages: message_arrived' },
    ];
    const state = restoreState(records, { recent_limit: 8 });
    expect(state.active_focus).toBe('messages');
    const slice = state.foci['messages']!;
    expect(slice.cursor.step).toBe(2);
    expect(slice.last_outcome_ptr).toBe('1.1');
    expect(slice.fresh).toBe(true);
  });

  it('a fresh FocusApp restores its state from the prior instance jsonl', async () => {
    const store = new FocusStore(join(dir, 'restore'));
    const first = wire(store);
    await first.ops.invoke_command('focus.record', turnRecordArg('1.0', 'tool_calls'), APP);
    await first.ops.invoke_command('focus.record', turnRecordArg('1.1', 'reply'), APP);

    // a brand-new app over the SAME dir reads the jsonl at construction.
    const second = new FocusApp({ dir: join(dir, 'restore') });
    const reg2 = new AppRegistry();
    reg2.install(second.manifest());
    const restored = reg2.get_app_context('focus')?.state as FocusState;
    expect(restored.active_focus).toBe('messages');
    expect(restored.foci['messages']!.cursor.step).toBe(2);
    expect(restored.foci['messages']!.last_outcome_ptr).toBe('1.1');
  });

  it('a missing jsonl restores empty (never throws at boot)', () => {
    const app = new FocusApp({ dir: join(dir, 'does-not-exist-yet') });
    const reg = new AppRegistry();
    expect(() => reg.install(app.manifest())).not.toThrow();
  });
});
