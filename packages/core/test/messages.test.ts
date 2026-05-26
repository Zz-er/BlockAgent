/**
 * test/messages.test.ts — the messages BlockApp, conversation-history model
 * (impl-messages owned). Covers the §6.3 / §8.2 / §12.2 rewrite:
 *
 *   - history accrues across ingest/reply (durable jsonl + recent projection);
 *   - the token budget threshold triggers incremental compaction (placeholder
 *     summary folds the older messages, the recent `display_count` stay verbatim);
 *   - `messages:summary` is slow_changing, `messages:recent` is volatile, both
 *     owner=system, pure/deterministic (byte-identical builds);
 *   - the AGENT can read message BODIES from `messages:recent`;
 *   - config seeds from a config.json file and retunes via `set_config`, which is
 *     USER-ONLY (the agent is DENIED at the PolicyEngine invoker gate);
 *   - jsonl stays the FULL durable log (compaction never shrinks it) + §12.2 rules.
 *
 * Each test gets a fresh temp dir so jsonl/config files never bleed across tests.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppRegistry } from '../src/app/registry.js';
import { BlockTree } from '../src/core/block.js';
import { Operations } from '../src/core/operations.js';
import {
  JsonlStore,
  MessagesApp,
  RECENT_BLOCK,
  SUMMARY_BLOCK,
  type HistoryMessage,
  type MessagesAppOptions,
  type MessagesState,
  type ReplyEvent,
} from '../src/apps/messages.js';
import type { Block, BlockName, InvokerContext, WakeEvent } from '../src/core/types.js';
import type { AppContext, BuildContext, BuilderManifest } from '../src/app/types.js';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'msg-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A throwaway BuildContext; the messages builders ignore it (state-only build). */
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

/** A minimal AppContext carrying a fixed state — all the builders read (INV #16). */
function stateCtx(state: MessagesState): AppContext<MessagesState> {
  return {
    app_id: 'messages',
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

/**
 * Install a MessagesApp into a registry, capturing every WakeEvent the registry's
 * wakeHook receives. Storage dir + config base default to the test's temp dir.
 */
function installApp(opts: MessagesAppOptions = {}): {
  app: MessagesApp;
  registry: AppRegistry;
  wakes: WakeEvent[];
} {
  const app = new MessagesApp({ dir: join(dir, 'store'), configBase: dir, ...opts });
  const registry = new AppRegistry();
  const wakes: WakeEvent[] = [];
  registry.wakeHook = (e) => wakes.push(e);
  registry.install(app.manifest()); // fires on_install synchronously, captures ctx.
  return { app, registry, wakes };
}

/** Resolve a messages builder by its output block name. */
function builderFor(registry: AppRegistry, block: BlockName): BuilderManifest {
  const b = registry.resolve_builder(block);
  if (b === null) throw new Error(`no builder for ${block}`);
  return b;
}

// ---------------------------------------------------------------------------
// ingest → durable history + recent projection + wake (§8.2)
// ---------------------------------------------------------------------------

describe('MessagesApp.ingest (§8.2 wake seam + history)', () => {
  it('appends to the durable history, projects into recent, and wakes the runtime', async () => {
    const { app, registry, wakes } = installApp();

    const event = app.ingest({ id: 'u1', content: 'hello', from: 'alice' });

    expect(event).toEqual({ kind: 'sync_message_arrived', msg_id: 'u1' });
    expect(wakes).toEqual([{ kind: 'sync_message_arrived', msg_id: 'u1' }]);

    // Durable history holds the full message.
    expect(app.store.readHistory()).toEqual([{ role: 'user', id: 'u1', content: 'hello' }]);

    // It is visible in the recent projection (peek reads bodies).
    const peek = await registry.route('messages.peek', {}, { invoker: 'agent' });
    expect(peek.ok).toBe(true);
    expect((peek.data as { recent: HistoryMessage[] }).recent).toEqual([
      { role: 'user', id: 'u1', content: 'hello' },
    ]);
  });

  it('throws if ingest is called before install (no AppContext)', () => {
    const app = new MessagesApp({ dir: join(dir, 'store'), configBase: dir });
    expect(() => app.ingest({ id: 'x', content: 'nope' })).toThrow(/before install/);
  });

  it('a wake to an un-wired runtime is inert (no throw)', () => {
    const app = new MessagesApp({ dir: join(dir, 'store'), configBase: dir });
    const registry = new AppRegistry();
    registry.install(app.manifest());
    expect(() => app.ingest({ id: 'u1', content: 'hi' })).not.toThrow();
    expect(app.store.readHistory()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// commands: ingest / reply / peek / ack
// ---------------------------------------------------------------------------

describe('messages commands (history model)', () => {
  it('ingest command appends a user message and reports the wake', async () => {
    const { app, registry } = installApp();
    const res = await registry.route('messages.ingest', { content: 'hey' }, { invoker: 'user' });
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ woke: 'sync_message_arrived' });
    expect(app.store.readHistory()).toHaveLength(1);
  });

  it('reply records an agent message to history + outbox and into recent', async () => {
    const { app, registry } = installApp();
    const res = await registry.route(
      'messages.reply',
      { reply_to: 'u1', content: 'hi back' },
      { invoker: 'agent' },
    );
    expect(res.ok).toBe(true);
    expect((res.data as { reply_id: string }).reply_id).toMatch(/^agent_/);

    // Durable: history + outbox both carry it.
    expect(app.store.readHistory().at(-1)).toMatchObject({ role: 'agent', content: 'hi back' });
    const out = app.store.outboxReplies.readAll();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ reply_to: 'u1', content: 'hi back' });

    // Projection: the agent turn shows in recent.
    const peek = await registry.route('messages.peek', {}, { invoker: 'agent' });
    expect((peek.data as { recent: HistoryMessage[] }).recent.at(-1)).toMatchObject({
      role: 'agent',
      content: 'hi back',
    });
  });

  it('reply rejects non-string content', async () => {
    const { registry } = installApp();
    expect((await registry.route('messages.reply', {}, { invoker: 'agent' })).ok).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// onReply push channel (reply=Option B, cli-design §6) — symmetric to onThinking
// ----------------------------------------------------------------------------

describe('MessagesApp.onReply (reply push channel)', () => {
  it('emits a ReplyEvent to subscribers when reply runs, carrying id + content + reply_to', async () => {
    const { app, registry } = installApp();
    const seen: ReplyEvent[] = [];
    app.onReply((e) => seen.push(e));

    const res = await registry.route(
      'messages.reply',
      { reply_to: 'u1', content: 'hi back' },
      { invoker: 'agent' },
    );
    expect(res.ok).toBe(true);

    expect(seen).toHaveLength(1);
    const reply_id = (res.data as { reply_id: string }).reply_id;
    expect(seen[0]).toEqual({ id: reply_id, content: 'hi back', reply_to: 'u1' });
  });

  it('omits reply_to from the event when the reply had none (exactOptionalPropertyTypes)', async () => {
    const { app, registry } = installApp();
    const seen: ReplyEvent[] = [];
    app.onReply((e) => seen.push(e));

    await registry.route('messages.reply', { content: 'no parent' }, { invoker: 'agent' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty('reply_to');
    expect(seen[0]).toMatchObject({ content: 'no parent' });
  });

  it('the unsubscribe thunk stops further delivery', async () => {
    const { app, registry } = installApp();
    const seen: ReplyEvent[] = [];
    const off = app.onReply((e) => seen.push(e));

    await registry.route('messages.reply', { content: 'first' }, { invoker: 'agent' });
    off();
    await registry.route('messages.reply', { content: 'second' }, { invoker: 'agent' });

    expect(seen.map((e) => e.content)).toEqual(['first']);
  });

  it('the event fires only AFTER the reply is durably recorded (history + outbox)', async () => {
    const { app, registry } = installApp();
    let historyLenAtEmit = -1;
    let outboxLenAtEmit = -1;
    app.onReply(() => {
      historyLenAtEmit = app.store.readHistory().length;
      outboxLenAtEmit = app.store.outboxReplies.readAll().length;
    });

    await registry.route('messages.reply', { content: 'durable first' }, { invoker: 'agent' });
    // At emit time the reply is already in both durable logs.
    expect(historyLenAtEmit).toBe(1);
    expect(outboxLenAtEmit).toBe(1);
  });

  it('a throwing listener is isolated and does not break the reply command', async () => {
    const { app, registry } = installApp();
    const seen: ReplyEvent[] = [];
    app.onReply(() => {
      throw new Error('boom');
    });
    app.onReply((e) => seen.push(e)); // a later listener still runs

    const res = await registry.route('messages.reply', { content: 'still ok' }, { invoker: 'agent' });
    expect(res.ok).toBe(true); // command path unaffected by a faulty subscriber
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ content: 'still ok' });
  });

  it('ack removes a message from the recent projection but NOT from the durable log', async () => {
    const { app, registry } = installApp();
    app.ingest({ id: 'u1', content: 'first' });
    app.ingest({ id: 'u2', content: 'second' });

    const ok = await registry.route('messages.ack', { id: 'u1' }, { invoker: 'agent' });
    expect(ok.ok).toBe(true);

    const peek = await registry.route('messages.peek', {}, { invoker: 'agent' });
    const ids = (peek.data as { recent: HistoryMessage[] }).recent.map((m) => m.id);
    expect(ids).toEqual(['u2']); // u1 left the projection

    // ...but the durable history still has both (compaction/ack never shrink it).
    expect(app.store.readHistory().map((m) => m.id)).toEqual(['u1', 'u2']);
  });

  it('ack rejects a missing / unknown id', async () => {
    const { registry } = installApp();
    expect((await registry.route('messages.ack', {}, { invoker: 'agent' })).ok).toBe(false);
    expect(
      (await registry.route('messages.ack', { id: 'nope' }, { invoker: 'agent' })).ok,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compaction: token threshold folds older messages into the summary
// ---------------------------------------------------------------------------

describe('automatic incremental compaction', () => {
  /**
   * 1 token per character, so an EMPTY summary costs 0 and the math is exact:
   * each `m{i}` body is 2 chars → 2 tokens. (A constant `() => 1` estimator would
   * wrongly charge the empty summary a token; length-based avoids that.)
   */
  const charTokens: MessagesAppOptions['estimate_tokens'] = (t) => t.length;

  it('folds messages older than display_count once the threshold is reached', async () => {
    // budget 20, threshold 0.5 → trigger at 10 tokens; display_count 2.
    writeConfig(dir, { max_history_tokens: 20, compression_threshold: 0.5, display_count: 2 });
    const { app, registry } = installApp({ estimate_tokens: charTokens });

    // 4 ingests: projection tokens 0 + 4×2 = 8, < 10 → no compaction yet.
    for (let i = 1; i <= 4; i += 1) app.ingest({ id: `u${i}`, content: `m${i}` });
    let peek = await registry.route('messages.peek', { count: 100 }, { invoker: 'agent' });
    expect((peek.data as { recent: HistoryMessage[] }).recent).toHaveLength(4);
    expect((peek.data as { summary: string }).summary).toBe('');

    // 5th ingest: 10 tokens ≥ trigger → fold all but the last 2 (u1..u3 folded).
    app.ingest({ id: 'u5', content: 'm5' });
    peek = await registry.route('messages.peek', { count: 100 }, { invoker: 'agent' });
    const recentIds = (peek.data as { recent: HistoryMessage[] }).recent.map((m) => m.id);
    expect(recentIds).toEqual(['u4', 'u5']); // most-recent display_count kept verbatim
    const summary = (peek.data as { summary: string }).summary;
    expect(summary).toContain('3 earlier messages folded'); // placeholder summary
    expect(summary).toContain('m1'); // the folded bodies are traced in the placeholder

    // The durable log keeps ALL five (compaction does not shrink it).
    expect(app.store.readHistory().map((m) => m.id)).toEqual(['u1', 'u2', 'u3', 'u4', 'u5']);
  });

  it('renders the folded summary into messages:summary (slow_changing)', async () => {
    writeConfig(dir, { max_history_tokens: 20, compression_threshold: 0.5, display_count: 2 });
    const { app, registry } = installApp({ estimate_tokens: charTokens });
    for (let i = 1; i <= 5; i += 1) app.ingest({ id: `u${i}`, content: `m${i}` });

    // Pull the LIVE state via peek, then render the summary builder against it.
    const state = await liveState(registry);
    const summaryBuilder = builderFor(registry, SUMMARY_BLOCK);
    const block = await summaryBuilder.build(fakeBuildContext(), stateCtx(state));
    expect(block).not.toBeNull();
    expect(block!.name).toBe(SUMMARY_BLOCK);
    expect(block!.content_text).toContain('Conversation summary');
    expect(block!.content_text).toContain('folded');
  });
});

// ---------------------------------------------------------------------------
// builders: tiers, owner, agent reads bodies, byte-identical
// ---------------------------------------------------------------------------

describe('messages builders', () => {
  it('messages:summary is slow_changing, messages:recent is volatile, both owner=system', () => {
    const { registry } = installApp();
    const summary = builderFor(registry, SUMMARY_BLOCK);
    const recent = builderFor(registry, RECENT_BLOCK);

    expect(summary.cache_tier).toBe('slow_changing');
    expect(summary.owner).toBe('system'); // INV #4
    expect(recent.cache_tier).toBe('volatile');
    expect(recent.owner).toBe('system');
    expect(registry.tier_of(SUMMARY_BLOCK)).toBe('slow_changing');
    expect(registry.tier_of(RECENT_BLOCK)).toBe('volatile');
  });

  it('the agent reads message BODIES from messages:recent', async () => {
    const { app, registry } = installApp();
    app.ingest({ id: 'u1', content: 'remember the milk' });
    app.ingest({ id: 'u2', content: 'and the eggs' });

    const state = await liveState(registry);
    const recent = builderFor(registry, RECENT_BLOCK);
    const block = await recent.build(fakeBuildContext(), stateCtx(state));
    expect(block!.content_text).toContain('remember the milk'); // VERBATIM body
    expect(block!.content_text).toContain('and the eggs');
    expect(block!.content_text).toContain('[user]');
  });

  it('messages:recent shows only the most-recent display_count, byte-identical', async () => {
    const state: MessagesState = {
      recent: [
        { role: 'user', id: 'u1', content: 'a' },
        { role: 'agent', id: 'a1', content: 'b' },
        { role: 'user', id: 'u2', content: 'c' },
      ],
      summary: '',
      config: { max_history_tokens: 4000, compression_threshold: 0.8, display_count: 2 },
    };
    const recent = builderFor(installApp().registry, RECENT_BLOCK);
    const b1 = await recent.build(fakeBuildContext(), stateCtx(state));
    const b2 = await recent.build(fakeBuildContext(), stateCtx(state));
    // Only the last 2 messages (display_count) are shown.
    expect(b1!.content_text).not.toContain('[user] a');
    expect(b1!.content_text).toContain('[agent] b');
    expect(b1!.content_text).toContain('[user] c');
    // Same state → byte-identical (INV #1 / #16).
    expect(b2!.content_text).toBe(b1!.content_text);
  });

  it('summary builder renders nothing when there is no summary yet', async () => {
    const { registry } = installApp();
    const state = await liveState(registry);
    const summary = builderFor(registry, SUMMARY_BLOCK);
    expect(await summary.build(fakeBuildContext(), stateCtx(state))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// config: file seed + user-only set_config (agent DENIED at the policy gate)
// ---------------------------------------------------------------------------

describe('messages config (file seed + user-only set_config)', () => {
  const AGENT: InvokerContext = { invoker: 'agent', identity: 'main' };
  const USER: InvokerContext = { invoker: 'user', identity: 'human' };

  /** Wire the App through the REAL Operations + default PolicyEngine (the gate). */
  function wire(opts: MessagesAppOptions = {}) {
    const app = new MessagesApp({ dir: join(dir, 'store'), configBase: dir, ...opts });
    const reg = new AppRegistry();
    reg.install(app.manifest());
    const root: Block = {
      id: 'root', name: 'root:root', children: [], content_text: null, content_blob: null,
    };
    const tree = new BlockTree(root);
    const ops = Operations.with_default_policy({ tree, registry: reg });
    return { app, reg, ops };
  }

  it('seeds config from config.json over the compiled defaults', () => {
    writeConfig(dir, { display_count: 3, max_history_tokens: 999 });
    const { reg } = wire();
    const state = reg.get('messages')!.initial_state as MessagesState;
    expect(state.config.display_count).toBe(3);
    expect(state.config.max_history_tokens).toBe(999);
    // A key absent from the file keeps the compiled default.
    expect(state.config.compression_threshold).toBe(0.8);
  });

  it('DENIES the agent (anti self-modification: cannot retune its own budget)', async () => {
    const { reg, ops } = wire();
    const res = await ops.invoke_command('messages.set_config', { display_count: 1 }, AGENT);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
    // The config is unchanged (handler never ran): default display_count stays 10.
    expect((reg.get('messages')!.initial_state as MessagesState).config.display_count).toBe(10);
  });

  it('ALLOWS the user and clamps the patch', async () => {
    const { ops } = wire();
    const res = await ops.invoke_command(
      'messages.set_config',
      { compression_threshold: 5, display_count: 0 }, // out of range → clamped
      USER,
    );
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({
      updated: expect.arrayContaining(['compression_threshold', 'display_count']),
    });
  });

  it('rejects an empty/invalid patch from the user', async () => {
    const { ops } = wire();
    const res = await ops.invoke_command('messages.set_config', { nonsense: 1 }, USER);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no valid field/);
  });

  it('declares set_config as user-only on the manifest', () => {
    const { reg } = wire();
    const cmd = reg.resolve_command('messages.set_config');
    expect(cmd?.allowed_invokers).toEqual(['user']);
  });
});

// ---------------------------------------------------------------------------
// §12.2 jsonl write rules (unchanged) + full durable log
// ---------------------------------------------------------------------------

describe('JsonlStore (§12.2 write rules)', () => {
  it('appends one complete line per record, serially under a lock', () => {
    const store = new JsonlStore(join(dir, 'x.jsonl'));
    store.append({ id: 'a' });
    store.append({ id: 'b' });
    expect(readFileSync(join(dir, 'x.jsonl'), 'utf8')).toBe('{"id":"a"}\n{"id":"b"}\n');
    expect(store.readAll()).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('rejects a line over the 64KB limit instead of writing a torn record', () => {
    const store = new JsonlStore(join(dir, 'big.jsonl'));
    expect(() => store.append({ id: 'big', content: 'x'.repeat(70 * 1024) })).toThrow(
      /exceeds the 65536B\/line limit/,
    );
    expect(store.readAll()).toEqual([]);
  });

  it('truncates a crash-torn incomplete trailing line on startup', () => {
    const file = join(dir, 'torn.jsonl');
    writeFileSync(file, '{"id":"a"}\n{"id":"b"}\n{"id":"c", "partial');
    const store = new JsonlStore(file);
    expect(store.readAll()).toEqual([{ id: 'a' }, { id: 'b' }]);
    store.append({ id: 'd' });
    expect(store.readAll()).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'd' }]);
  });

  it('drops a file that is a single torn line with no newline at all', () => {
    const file = join(dir, 'alltorn.jsonl');
    writeFileSync(file, '{"id":"a", "partial');
    expect(new JsonlStore(file).readAll()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** Write a messages config.json under the configBase the tests pass in. */
function writeConfig(base: string, cfg: Record<string, number>): void {
  const appDir = join(base, 'messages');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, 'config.json'), JSON.stringify(cfg));
}

/**
 * Read the App's LIVE state through `peek` + a config probe, reconstructing a
 * MessagesState the builders can render. The registry doesn't expose the ctx
 * publicly, and the builders read state-only, so this rebuilds exactly what they see.
 */
async function liveState(registry: AppRegistry): Promise<MessagesState> {
  const peek = await registry.route('messages.peek', { count: 1_000_000 }, { invoker: 'agent' });
  const data = peek.data as { recent: HistoryMessage[]; summary: string };
  const config = (registry.get('messages')!.initial_state as MessagesState).config;
  return { recent: data.recent, summary: data.summary, config };
}
