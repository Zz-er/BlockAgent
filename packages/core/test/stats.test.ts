/**
 * test/stats.test.ts — the stats BlockApp (impl-apps owned). Covers §4.4:
 *
 *   - the `consumes` shape (message_count → msg_count, task_count → task_count) — the App
 *     binds on contract NAMES only, never a provider app-id (identity-free, §3.2);
 *   - the `stats:summary` builder: volatile, owner=system, pure, and RETURNS NULL when
 *     `show_block === false` (the §4.4 default-silent rule) — so the block only renders
 *     after a user explicitly turns it on;
 *   - it derives its counts from state (filled by consume-refresh), rendering them;
 *   - `set_config({show_block})` is USER-ONLY (agent denied at the policy gate); the App
 *     exposes NO write command to the agent;
 *   - seeding via config.json defaults show_block off.
 *
 * The end-to-end consume-refresh round-trip (a live provider count flowing into
 * stats.state) is the architect's e2e gate (§5 trace); here we unit-test the App's own
 * shape + the null-shrink + the invoker gate, with a fixed state for the builder.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppRegistry } from '../src/app/registry.js';
import { BlockTree } from '../src/core/block.js';
import { Operations } from '../src/core/operations.js';
import { StatsApp, STATS_SUMMARY_BLOCK, type StatsState } from '@block-agent/app-stats/manifest.js';
import type { Block, InvokerContext } from '../src/core/types.js';
import type { AppContext, BuildContext, BuilderManifest } from '../src/app/types.js';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stats-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const AGENT: InvokerContext = { invoker: 'agent', identity: 'main' };
const USER: InvokerContext = { invoker: 'user', identity: 'human' };

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

function stateCtx(state: StatsState): AppContext<StatsState> {
  return {
    app_id: 'stats',
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
  };
}

function installApp(): { registry: AppRegistry } {
  const app = new StatsApp({ configBase: dir });
  const registry = new AppRegistry();
  registry.install(app.manifest());
  return { registry };
}

function wire() {
  const app = new StatsApp({ configBase: dir });
  const reg = new AppRegistry();
  reg.install(app.manifest());
  const root: Block = {
    id: 'root', name: 'root:root', children: [], content_text: null, content_blob: null,
  };
  const tree = new BlockTree(root);
  const ops = Operations.with_default_policy({ tree, registry: reg });
  return { reg, ops };
}

function summaryBuilder(registry: AppRegistry): BuilderManifest {
  const b = registry.resolve_builder(STATS_SUMMARY_BLOCK);
  if (b === null) throw new Error('no builder for stats:summary');
  return b;
}

function makeState(over: Partial<StatsState> = {}): StatsState {
  return { msg_count: 0, task_count: 0, config: { show_block: false }, ...over };
}

// ---------------------------------------------------------------------------
// consumes shape (identity-free) + provides nothing
// ---------------------------------------------------------------------------

describe('stats manifest shape', () => {
  it('consumes message_count→msg_count and task_count→task_count (no provider app-id)', () => {
    const { registry } = installApp();
    const m = registry.get('stats')!;
    expect(m.consumes).toEqual([
      { contract: 'message_count', as: 'msg_count' },
      { contract: 'task_count', as: 'task_count' },
    ]);
    // identity-free: it binds on contract NAMES, never a provider app-id (no
    // `depends_on` coupling to a concrete provider App).
    expect(m.depends_on).toEqual([]);
    // it provides nothing.
    expect(m.provides).toBeUndefined();
  });

  it('seeds initial counts to 0 (renders 0 before any provider, contract-less boot)', () => {
    const { registry } = installApp();
    const s = registry.get('stats')!.initial_state as StatsState;
    expect(s.msg_count).toBe(0);
    expect(s.task_count).toBe(0);
    expect(s.config.show_block).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// builder: stats:summary — volatile, owner=system, default-silent null-shrink
// ---------------------------------------------------------------------------

describe('stats:summary builder', () => {
  it('is volatile and owner=system (INV #4)', () => {
    const { registry } = installApp();
    const b = summaryBuilder(registry);
    expect(b.cache_tier).toBe('volatile');
    expect(b.owner).toBe('system');
    expect(registry.tier_of(STATS_SUMMARY_BLOCK)).toBe('volatile');
  });

  it('returns NULL when show_block is false (§4.4 default-silent)', async () => {
    const b = summaryBuilder(installApp().registry);
    const block = await b.build(fakeBuildContext(), stateCtx(makeState({ msg_count: 5, task_count: 3 })));
    expect(block).toBeNull();
  });

  it('renders the count summary when show_block is true, byte-identical', async () => {
    const b = summaryBuilder(installApp().registry);
    const state = makeState({ msg_count: 2, task_count: 1, config: { show_block: true } });
    const b1 = await b.build(fakeBuildContext(), stateCtx(state));
    const b2 = await b.build(fakeBuildContext(), stateCtx(state));
    expect(b1!.name).toBe(STATS_SUMMARY_BLOCK);
    expect(b1!.content_text).toContain('1 待办');
    expect(b1!.content_text).toContain('2 条消息');
    expect(b2!.content_text).toBe(b1!.content_text); // INV #1/#16
  });
});

// ---------------------------------------------------------------------------
// set_config — user-only, no agent write command
// ---------------------------------------------------------------------------

describe('stats.set_config (user-only)', () => {
  it('is the App\'s only command and is user-only on the manifest', () => {
    const { registry } = installApp();
    const m = registry.get('stats')!;
    expect(m.commands).toHaveLength(1);
    expect(registry.resolve_command('stats.set_config')?.allowed_invokers).toEqual(['user']);
  });

  it('DENIES the agent (cannot toggle its own stats block)', async () => {
    const { ops } = wire();
    const res = await ops.invoke_command('stats.set_config', { show_block: true }, AGENT);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
  });

  it('ALLOWS the user to toggle show_block', async () => {
    const { ops } = wire();
    const res = await ops.invoke_command('stats.set_config', { show_block: true }, USER);
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ updated: ['show_block'] });
  });

  it('rejects an empty/invalid patch', async () => {
    const { ops } = wire();
    const res = await ops.invoke_command('stats.set_config', { nonsense: 1 }, USER);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no valid field/);
  });
});

// ---------------------------------------------------------------------------
// config file seed
// ---------------------------------------------------------------------------

describe('stats config file seed', () => {
  it('reads show_block from config.json (still off by default if absent)', () => {
    const appDir = join(dir, 'stats');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'config.json'), JSON.stringify({ show_block: true }));
    const app = new StatsApp({ configBase: dir });
    const reg = new AppRegistry();
    reg.install(app.manifest());
    expect((reg.get('stats')!.initial_state as StatsState).config.show_block).toBe(true);
  });
});
