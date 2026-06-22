/**
 * test/messages_history.test.ts — P1.5 agent-facing history navigation (messages.history).
 *
 * messages.history is the FIRST read surface the agent may invoke (allowed_invokers includes
 * 'agent'): it walks the durable jsonl log backward so the agent can reach messages that have
 * scrolled out of the visible `messages:recent` window. peek/list/count stay user/app-only
 * (DR-F) — they are redundant with the recent block; history is not. First-party content, so
 * no fence; bounded on the SERIALIZED result (what the base ledger weighs).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppRegistry } from '../src/app/registry.js';
import {
  MessagesApp,
  type HistoryMessage,
  type MessagesState,
} from '@block-agent/app-messages/manifest.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'msg-hist-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(base: string, cfg: Record<string, number>): void {
  const appDir = join(base, 'messages');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, 'config.json'), JSON.stringify(cfg));
}

function installApp(): { app: MessagesApp; registry: AppRegistry } {
  const app = new MessagesApp({ dir: join(dir, 'store'), configBase: dir });
  const registry = new AppRegistry();
  registry.install(app.manifest());
  return { app, registry };
}

/** Read a command's `allowed_invokers` off the manifest (the PolicyEngine gate config). */
function invokersOf(app: MessagesApp, name: string): readonly string[] | undefined {
  const m = app.manifest();
  const st: MessagesState = {
    recent: [],
    summary: '',
    config: { max_history_tokens: 4000, compression_threshold: 0.8, display_count: 10 },
  };
  const factory = m.commands.find((f) => f(st).name === name);
  if (factory === undefined) throw new Error(`no command ${name}`);
  return factory(st).allowed_invokers;
}

describe('messages.history (P1.5 agent-facing history navigation)', () => {
  it('opens history to the AGENT; peek/list/count stay user/app-only (DR-F)', () => {
    const { app } = installApp();
    expect(invokersOf(app, 'history')).toEqual(['user', 'agent', 'app']);
    expect(invokersOf(app, 'peek')).toEqual(['user', 'app']);
    expect(invokersOf(app, 'list')).toEqual(['user', 'app']);
    expect(invokersOf(app, 'count')).toEqual(['app', 'user']);
  });

  it('HEADLINE: reaches a message that has scrolled OUT of the recent window', async () => {
    // Tiny budget so older messages fold out of `recent` (but stay in durable jsonl).
    writeConfig(dir, { max_history_tokens: 10, compression_threshold: 0.1, display_count: 2 });
    const { app, registry } = installApp();
    for (let i = 1; i <= 8; i += 1) app.ingest({ id: `u${i}`, content: `m${i}` });

    // u1 is NOT in the recent projection any more.
    const peek = await registry.route('messages.peek', {}, { invoker: 'agent' });
    const recentIds = (peek.data as { recent: HistoryMessage[] }).recent.map((m) => m.id);
    expect(recentIds).not.toContain('u1');

    // …but messages.history reaches it (the whole point of P1.5).
    const res = await registry.route('messages.history', {}, { invoker: 'agent' });
    expect(res.ok).toBe(true);
    const data = res.data as {
      items: { idx: number; id: string; body: string }[];
      cursor: number;
      has_more: boolean;
    };
    expect(data.items[0]).toMatchObject({ idx: 0, id: 'u1', body: 'm1' });
    expect(data.items.at(-1)).toMatchObject({ id: 'u8' });
    expect(data.has_more).toBe(false); // all 8 fit in the default page
    expect(data.cursor).toBe(0);
  });

  it('pages backward deterministically via the cursor; has_more flips false at the start', async () => {
    const { app, registry } = installApp();
    for (let i = 1; i <= 8; i += 1) app.ingest({ id: `u${i}`, content: `m${i}` });

    const p1 = (await registry.route('messages.history', { limit: 3 }, { invoker: 'agent' })).data as {
      items: { idx: number; id: string }[];
      cursor: number;
      has_more: boolean;
    };
    expect(p1.items.map((m) => m.id)).toEqual(['u6', 'u7', 'u8']);
    expect(p1).toMatchObject({ cursor: 5, has_more: true });

    const p2 = (await registry.route('messages.history', { before: p1.cursor, limit: 3 }, { invoker: 'agent' }))
      .data as { items: { id: string }[]; cursor: number; has_more: boolean };
    expect(p2.items.map((m) => m.id)).toEqual(['u3', 'u4', 'u5']);
    expect(p2).toMatchObject({ cursor: 2, has_more: true });

    const p3 = (await registry.route('messages.history', { before: p2.cursor, limit: 3 }, { invoker: 'agent' }))
      .data as { items: { id: string }[]; has_more: boolean };
    expect(p3.items.map((m) => m.id)).toEqual(['u1', 'u2']);
    expect(p3.has_more).toBe(false);
  });

  it('filters by role (cursor still indexes the full durable log)', async () => {
    const { app, registry } = installApp();
    app.ingest({ id: 'u1', content: 'q1' });
    await registry.route('messages.reply', { content: 'a1' }, { invoker: 'agent' });
    app.ingest({ id: 'u2', content: 'q2' });

    const res = (await registry.route('messages.history', { role: 'user' }, { invoker: 'agent' })).data as {
      items: { role: string; id: string }[];
    };
    expect(res.items.every((m) => m.role === 'user')).toBe(true);
    expect(res.items.map((m) => m.id)).toEqual(['u1', 'u2']);
  });

  it('bounds output: clips a huge body and keeps the SERIALIZED result under cap', async () => {
    const { app, registry } = installApp();
    for (let i = 1; i <= 30; i += 1) app.ingest({ id: `u${i}`, content: 'X'.repeat(5_000) });

    const res = (await registry.route('messages.history', { limit: 50 }, { invoker: 'agent' })).data as {
      items: { body: string }[];
      count: number;
      has_more: boolean;
    };
    // Each body clipped (≤ 2000 bytes incl. marker); the SERIALIZED result fits the cap, so the
    // page was trimmed from the oldest end → fewer than 30 rows, and has_more is honest.
    for (const it of res.items) expect(Buffer.byteLength(it.body, 'utf8')).toBeLessThanOrEqual(2_000);
    expect(Buffer.byteLength(JSON.stringify(res.items), 'utf8')).toBeLessThanOrEqual(12_000);
    expect(res.has_more).toBe(true);
    expect(res.count).toBe(res.items.length);
  });
});
