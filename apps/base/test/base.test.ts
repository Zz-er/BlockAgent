/**
 * test/base.test.ts — the base BlockApp (ai_com/design/actions-app-architecture.md).
 *
 * App-local coverage (§9 / §10.9). The cross-process no-recursion test and the full
 * end-to-end (launch wiring + messages report_input) are INTEGRATION and live in core —
 * flagged to the lead. Here we exercise the app's own contract through the REAL
 * Operations + default PolicyEngine (so the invoker gates are real, not mocked):
 *
 *   - record → render round-trip per command_detail / input_detail level;
 *   - failure → actions (the success-counterpart of the removed runtime:command_error):
 *     ok:false rows render at every level, error never lost;
 *   - input does NOT duplicate messages (default input_detail=2 → preview only, no body);
 *   - bounded window + overflow scroll-out advances compacted_seq, jsonl keeps everything;
 *   - byte-identical render (INV #1: same state → same bytes);
 *   - restart-from-jsonl seq seed (a post-overflow restart never reuses a seq);
 *   - the invoker gates: record is app-only, set_config is user-only, show is user/app;
 *   - the builder never reads the clock/random (INV #16);
 *   - jsonl uses a temp dir so the repo's real `.block-agent` is never touched.
 */

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRegistry } from '@block-agent/core/app/registry.js';
import { BlockTree } from '@block-agent/core/core/block.js';
import { Operations } from '@block-agent/core/core/operations.js';
import type { AppContext, BuildContext } from '@block-agent/core/app/types.js';
import type { Block, InvokerContext } from '@block-agent/core/core/types.js';

import {
  BaseApp,
  ActionLogStore,
  RECENT_BLOCK,
  DEFAULT_CONFIG,
  type BaseState,
  type BaseConfig,
  type ActionRow,
  type ActionLogRecord,
} from '../src/manifest.js';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'actions-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const AGENT: InvokerContext = { invoker: 'agent', identity: 'main' };
const USER: InvokerContext = { invoker: 'user', identity: 'human' };
const APP: InvokerContext = { invoker: 'app', identity: 'runtime' };

/** The jsonl ledger path the app uses under a temp base dir. */
function logPath(): string {
  return join(dir, 'base', 'log.jsonl');
}

/** Wire an BaseApp through the REAL Operations + default PolicyEngine (the gates). */
function wire(config?: Partial<BaseConfig>) {
  const app = new BaseApp(dir);
  const reg = new AppRegistry();
  reg.install(app.manifest());
  const root: Block = {
    id: 'root', name: 'root:root', children: [], content_text: null, content_blob: null,
  };
  const tree = new BlockTree(root);
  const ops = Operations.with_default_policy({ tree, registry: reg });
  // If the test wants non-default config, set it via the user-only command (real path).
  return { app, reg, ops, config };
}

/** The live state through the installed AppContext. */
function liveState(reg: AppRegistry): BaseState {
  return reg.get_app_context('base')?.state as BaseState;
}

/** A command event arg (kind:'command' + ts), the shape the launch subscription passes. */
function commandArg(
  name: string,
  args: unknown,
  ok: boolean,
  extra: { result?: unknown; error?: string; ref?: string; ts?: string } = {},
) {
  return {
    kind: 'command' as const,
    name,
    args,
    ok,
    invoker: 'agent' as const,
    spawn_depth: 0,
    ts: extra.ts ?? '14:30',
    ...(extra.result !== undefined ? { result: extra.result } : {}),
    ...(extra.error !== undefined ? { error: extra.error } : {}),
    ...(extra.ref !== undefined ? { ref: extra.ref } : {}),
  };
}

/** An input descriptor arg (kind:'input'), the shape the launch subscription passes. */
function inputArg(
  source: string,
  preview: string,
  extra: { sender?: string; content?: string; ts?: string; [k: string]: unknown } = {},
) {
  const { sender, content, ts, ...rest } = extra;
  return {
    kind: 'input' as const,
    source,
    preview,
    ts: ts ?? '14:31',
    ...(sender !== undefined ? { sender } : {}),
    ...(content !== undefined ? { content } : {}),
    ...rest,
  };
}

/** A throwaway BuildContext; the actions builder ignores it (state-only build, INV #16). */
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
    content_addressed_id: (s: string) => s,
    config: {},
  } as unknown as BuildContext;
}

/** A minimal AppContext carrying a fixed state — all the builder reads (INV #16). */
function stateCtx(state: BaseState): AppContext<BaseState> {
  return {
    app_id: 'base',
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
  } as unknown as AppContext<BaseState>;
}

/** Render `base:recent` via its registered builder against the live state. */
async function renderRecentBlock(reg: AppRegistry, state: BaseState): Promise<Block | null> {
  const builder = reg.resolve_builder(RECENT_BLOCK as never);
  if (builder === null) throw new Error('no builder for base:recent');
  return builder.build(fakeBuildContext(), stateCtx(state));
}

/** Read every jsonl record off disk (the full audit log). */
function readLog(): ActionLogRecord[] {
  return new ActionLogStore(logPath()).readAll();
}

// ---------------------------------------------------------------------------
// record → render round-trip (per detail level)
// ---------------------------------------------------------------------------

describe('record → render round-trip', () => {
  it('a command + an input interleave in the window, sorted by seq', async () => {
    const { reg, ops } = wire();
    await ops.invoke_command(
      'base.record',
      inputArg('messages', '帮我记一下 A', { sender: 'user', ts: '14:30' }),
      APP,
    );
    await ops.invoke_command(
      'base.record',
      commandArg('memory.remember', { content: 'API 地址' }, true, {
        result: { id: 'note#7' },
        ref: 'memory:note#7',
      }),
      APP,
    );
    const state = liveState(reg);
    expect(state.recent.map((r) => r.seq)).toEqual([0, 1]);
    expect(state.recent[0]!.kind).toBe('input');
    expect(state.recent[1]!.kind).toBe('command');

    const block = await renderRecentBlock(reg, state);
    expect(block).not.toBeNull();
    const text = block!.content_text!;
    expect(text).toContain('# Recent actions');
    expect(text).toContain('[0] input ← user @14:30');
    expect(text).toContain('[1] memory.remember');
    expect(text).toContain('→ ok');
  });

  it('command_detail=3 (default) preserves the result body; level 1 drops it', async () => {
    const { reg, ops } = wire();
    await ops.invoke_command(
      'base.record',
      commandArg('read_file', { path: '/etc/hosts' }, true, { result: 'the file body here' }),
      APP,
    );
    const state = liveState(reg);
    // default command_detail=3 → the row carries the result body (tool result preserved, F2).
    const row = state.recent[0] as Extract<ActionRow, { kind: 'command' }>;
    expect(DEFAULT_CONFIG.command_detail).toBe(3);
    expect(row.result_text).toBeDefined();
    expect(row.result_text).toContain('the file body here');

    const l3 = await renderRecentBlock(reg, state);
    expect(l3!.content_text).toContain('the file body here');

    // Detail is baked into each row at record time (rows are immutable once recorded,
    // like the jsonl). Dropping command_detail to 1 (user-only) applies to NEW rows: a
    // command recorded after the retune drops the successful result body but keeps the
    // verb→ok signal. (The already-recorded L3 row keeps its body until it scrolls out.)
    await ops.invoke_command('base.set_config', { command_detail: 1 }, USER);
    await ops.invoke_command(
      'base.record',
      commandArg('grep', { pattern: 'x' }, true, { result: 'a secret match body' }),
      APP,
    );
    const after = liveState(reg);
    const l1Row = after.recent[after.recent.length - 1] as Extract<ActionRow, { kind: 'command' }>;
    expect(l1Row.result_text).toBeUndefined();
    expect(l1Row.args_text).toBeUndefined();
    const l1 = await renderRecentBlock(reg, after);
    expect(l1!.content_text).toContain('grep → ok');
    expect(l1!.content_text).not.toContain('a secret match body');
  });
});

// ---------------------------------------------------------------------------
// failure → actions (replacing runtime:command_error)
// ---------------------------------------------------------------------------

describe('failure → actions (the removed command_error counterpart)', () => {
  it('a failed command renders error at every detail level', async () => {
    for (const detail of [1, 2, 3] as const) {
      const { reg, ops } = wire();
      if (detail !== 3) await ops.invoke_command('base.set_config', { command_detail: detail }, USER);
      await ops.invoke_command(
        'base.record',
        commandArg('task.add', { title: 'x' }, false, { error: 'backend 404' }),
        APP,
      );
      const block = await renderRecentBlock(reg, liveState(reg));
      // The verb is always present; the failure outcome (with the error) renders at
      // every level — the failure signal is never lost when command_detail drops.
      expect(block!.content_text, `detail=${detail}`).toContain('task.add');
      expect(block!.content_text, `detail=${detail}`).toContain('→ err (backend 404)');
    }
  });
});

// ---------------------------------------------------------------------------
// input does not duplicate messages (default level 2 → preview only)
// ---------------------------------------------------------------------------

describe('input does not duplicate messages', () => {
  it('default input_detail=2 renders the preview, not the full body', async () => {
    const { reg, ops } = wire();
    expect(DEFAULT_CONFIG.input_detail).toBe(2);
    await ops.invoke_command(
      'base.record',
      inputArg('messages', 'short preview', { sender: 'user', content: 'THE FULL BODY lives in messages:recent' }),
      APP,
    );
    const block = await renderRecentBlock(reg, liveState(reg));
    expect(block!.content_text).toContain('"short preview"');
    expect(block!.content_text).not.toContain('THE FULL BODY');
    // The full body is still in the jsonl audit (no loss, just no prompt dup).
    expect(readLog()[0]!.content).toBe('THE FULL BODY lives in messages:recent');
  });

  it('input_detail=3 renders the full content', async () => {
    const { reg, ops } = wire();
    await ops.invoke_command('base.set_config', { input_detail: 3 }, USER);
    await ops.invoke_command(
      'base.record',
      inputArg('messages', 'preview', { sender: 'user', content: 'THE FULL BODY' }),
      APP,
    );
    const block = await renderRecentBlock(reg, liveState(reg));
    expect(block!.content_text).toContain('THE FULL BODY');
  });
});

// ---------------------------------------------------------------------------
// bounded window + overflow scroll-out
// ---------------------------------------------------------------------------

describe('bounded window + overflow scroll-out', () => {
  it('window caps at window_size; older rows scroll out; compacted_seq advances; jsonl keeps all', async () => {
    const { reg, ops } = wire();
    await ops.invoke_command('base.set_config', { window_size: 3 }, USER);
    for (let i = 0; i < 6; i += 1) {
      await ops.invoke_command('base.record', commandArg(`cmd.${i}`, { i }, true), APP);
    }
    const state = liveState(reg);
    // bounded to 3: only the last 3 seqs (3,4,5) remain in the window.
    expect(state.recent.map((r) => r.seq)).toEqual([3, 4, 5]);
    // the highest scrolled-out seq is 2.
    expect(state.compacted_seq).toBe(2);
    // the jsonl retains everything (INV #5): all 6 records.
    const log = readLog();
    expect(log.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('window_size=0 renders nothing but still logs + advances compacted_seq', async () => {
    const { reg, ops } = wire();
    await ops.invoke_command('base.set_config', { window_size: 0 }, USER);
    await ops.invoke_command('base.record', commandArg('x.y', {}, true), APP);
    const state = liveState(reg);
    expect(state.recent).toEqual([]);
    expect(state.compacted_seq).toBe(0);
    const block = await renderRecentBlock(reg, state);
    expect(block).toBeNull(); // empty window → null (renders nothing)
    expect(readLog()).toHaveLength(1); // but the audit log kept it
  });
});

// ---------------------------------------------------------------------------
// byte-identical render (INV #1)
// ---------------------------------------------------------------------------

describe('byte-identical render (INV #1 / #16)', () => {
  it('same state → byte-identical bytes; the builder reads no clock/random', async () => {
    const { reg, ops } = wire();
    await ops.invoke_command('base.record', inputArg('messages', 'hi', { sender: 'user' }), APP);
    await ops.invoke_command(
      'base.record',
      commandArg('task.add', { title: 't' }, true, { ref: 'task#7' }),
      APP,
    );
    const state = liveState(reg);

    const now = vi.spyOn(Date, 'now');
    const rand = vi.spyOn(Math, 'random');
    const a = await renderRecentBlock(reg, state);
    const b = await renderRecentBlock(reg, state);
    expect(a!.content_text).toBe(b!.content_text);
    expect(now).not.toHaveBeenCalled();
    expect(rand).not.toHaveBeenCalled();
    now.mockRestore();
    rand.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// restart-from-jsonl seq seed
// ---------------------------------------------------------------------------

describe('restart-from-jsonl seq seed (messages precedent)', () => {
  it('a fresh app resumes the seq high-water from the jsonl tail (post-overflow safe)', async () => {
    // First boot: write 4 records, scrolling some out of a window of 2.
    {
      const { reg, ops } = wire();
      await ops.invoke_command('base.set_config', { window_size: 2 }, USER);
      for (let i = 0; i < 4; i += 1) {
        await ops.invoke_command('base.record', commandArg(`a.${i}`, { i }, true), APP);
      }
      expect(liveState(reg).recent.map((r) => r.seq)).toEqual([2, 3]);
    }
    // Second boot (same base dir): the next seq must be 4 (max jsonl seq + 1), NOT a
    // reuse of a seq that rolled out of the window.
    {
      const { reg, ops } = wire();
      await ops.invoke_command('base.record', commandArg('a.new', {}, true), APP);
      const state = liveState(reg);
      expect(state.recent[state.recent.length - 1]!.seq).toBe(4);
    }
    // The jsonl now holds seqs 0..4 with no duplicate.
    expect(readLog().map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it('the window boots EMPTY (a live projection, not a restart-restore)', async () => {
    {
      const { ops } = wire();
      await ops.invoke_command('base.record', commandArg('a.0', {}, true), APP);
    }
    const { reg } = wire();
    expect(liveState(reg).recent).toEqual([]); // empty until new records arrive
  });
});

// ---------------------------------------------------------------------------
// invoker gates (the anti-self-mod / anti-forge surface, §5)
// ---------------------------------------------------------------------------

describe('invoker gates', () => {
  it('record is app-only: agent + user are denied', async () => {
    const { ops } = wire();
    const asAgent = await ops.invoke_command('base.record', commandArg('x.y', {}, true), AGENT);
    const asUser = await ops.invoke_command('base.record', commandArg('x.y', {}, true), USER);
    expect(asAgent.ok).toBe(false);
    expect(asUser.ok).toBe(false);
    const asApp = await ops.invoke_command('base.record', commandArg('x.y', {}, true), APP);
    expect(asApp.ok).toBe(true);
  });

  it('set_config is user-only: agent + app are denied (anti-self-mod)', async () => {
    const { ops } = wire();
    const asAgent = await ops.invoke_command('base.set_config', { window_size: 5 }, AGENT);
    const asApp = await ops.invoke_command('base.set_config', { window_size: 5 }, APP);
    expect(asAgent.ok).toBe(false);
    expect(asApp.ok).toBe(false);
    const asUser = await ops.invoke_command('base.set_config', { window_size: 5 }, USER);
    expect(asUser.ok).toBe(true);
  });

  it('set_config clamps out-of-range knobs (window_size, detail)', async () => {
    const { reg, ops } = wire();
    await ops.invoke_command(
      'base.set_config',
      { window_size: 9999, command_detail: 7, input_detail: 0 },
      USER,
    );
    const cfg = liveState(reg).config;
    expect(cfg.window_size).toBe(100); // clamped to MAX_WINDOW
    expect(cfg.command_detail).toBe(3); // invalid detail → default
    expect(cfg.input_detail).toBe(2); // invalid detail → default
  });
});

// ---------------------------------------------------------------------------
// show — full-record retrieval by seq
// ---------------------------------------------------------------------------

describe('base.show', () => {
  it('pulls the full persisted record by seq (user + app, NOT the agent)', async () => {
    const { ops } = wire();
    await ops.invoke_command(
      'base.record',
      commandArg('task.add', { title: 'big payload' }, true, { result: { id: 't_7' } }),
      APP,
    );
    const asUser = await ops.invoke_command('base.show', { seq: 0 }, USER);
    expect(asUser.ok).toBe(true);
    const record = (asUser.data as { record: ActionLogRecord }).record;
    expect(record.name).toBe('task.add');
    expect(record.args).toEqual({ title: 'big payload' });

    // The agent is not in show's allowed_invokers.
    const asAgent = await ops.invoke_command('base.show', { seq: 0 }, AGENT);
    expect(asAgent.ok).toBe(false);
  });

  it('a missing seq returns ok:false', async () => {
    const { ops } = wire();
    const res = await ops.invoke_command('base.show', { seq: 999 }, USER);
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// end_turn — the bare YIELD (end the wake without a message)
// ---------------------------------------------------------------------------

describe('base.end_turn (the yield primitive)', () => {
  it('agent ends the turn silently: ok + end_turn, no data payload', async () => {
    const { ops } = wire();
    const res = await ops.invoke_command('base.end_turn', {}, AGENT);
    expect(res.ok).toBe(true);
    // The signal the runtime's invokeOne stops the wake on (decoupled from reply).
    expect((res as { end_turn?: boolean }).end_turn).toBe(true);
    // A pure yield: nothing to show, no result.
    expect((res as { data?: unknown }).data).toBeUndefined();
  });

  it('user may also yield (manual stop); the app lane is denied', async () => {
    const { ops } = wire();
    const asUser = await ops.invoke_command('base.end_turn', {}, USER);
    expect(asUser.ok).toBe(true);
    expect((asUser as { end_turn?: boolean }).end_turn).toBe(true);
    // allowed_invokers is ['agent','user'] — the ledger ('app') lane cannot forge a yield.
    const asApp = await ops.invoke_command('base.end_turn', {}, APP);
    expect(asApp.ok).toBe(false);
  });

  it('is readonly: it does not push a row into the recent window', async () => {
    const { reg, ops } = wire();
    const before = liveState(reg).recent.length;
    await ops.invoke_command('base.end_turn', {}, AGENT);
    expect(liveState(reg).recent.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// jsonl store mechanics (clone of ToolHistoryStore — 64KB guard, tail-truncate)
// ---------------------------------------------------------------------------

describe('ActionLogStore mechanics', () => {
  it('rejects an over-64KB line (throw, not tear)', () => {
    const store = new ActionLogStore(join(dir, 'big.jsonl'));
    const huge = 'x'.repeat(70 * 1024);
    expect(() => store.append({ seq: 0, kind: 'command', name: 'x', ts: '', args: huge })).toThrow(
      /exceeds the/,
    );
  });

  it('nextSeq seeds from the jsonl tail max + 1', () => {
    const path = join(dir, 'seq.jsonl');
    const store = new ActionLogStore(path);
    store.append({ seq: 0, kind: 'command', name: 'a', ts: '' });
    store.append({ seq: 5, kind: 'command', name: 'b', ts: '' });
    expect(new ActionLogStore(path).nextSeq()).toBe(6);
    // A fresh/empty file → seq 0.
    expect(new ActionLogStore(join(dir, 'empty.jsonl')).nextSeq()).toBe(0);
    expect(existsSync(path)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// the input extras ride along to the jsonl, but are never rendered
// ---------------------------------------------------------------------------

describe('input app-arbitrary extras', () => {
  it('extra fields land in the jsonl audit only, never in the rendered row', async () => {
    const { reg, ops } = wire();
    await ops.invoke_command('base.set_config', { input_detail: 3 }, USER);
    await ops.invoke_command(
      'base.record',
      inputArg('im_proxy', 'hi', { sender: 'a2', content: 'body', conv_id: 'c1', mentions: ['x'] }),
      APP,
    );
    const log = readLog()[0]!;
    expect(log['conv_id']).toBe('c1');
    expect(log['mentions']).toEqual(['x']);
    // The rendered row never surfaces the extras (content-agnostic, public fields only).
    const block = await renderRecentBlock(reg, liveState(reg));
    expect(block!.content_text).not.toContain('conv_id');
    expect(block!.content_text).not.toContain('c1');
  });
});
