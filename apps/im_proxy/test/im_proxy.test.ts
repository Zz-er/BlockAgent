/**
 * test/im_proxy.test.ts — unit tests for the im_proxy package.
 *
 * Test strategy (im-proxy.md §verify):
 *   - Inject a FAKE ImClient (no network, no ws) via ImProxyApp opts.
 *   - Assert: render blocks (conversations + chat), ingest→wake (push→coalesce→ingest→
 *     wake), send forwarding, per-conv consumed_seq backfill (no loss across two seq
 *     spaces), and the identity fence — a peer `from` NEVER lands in identity, only in the
 *     sanitized `from_label` content. INV #1: same state → same bytes.
 *
 * No real network. No ws SDK loaded (dependency isolation — the client is faked).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppContext, AppManifest, BuilderManifest, CommandManifest, JsonSchema } from '@block-agent/core/app/types.js';
import type { BlockSnapshot, BlockName, WakeEvent } from '@block-agent/core/core/types.js';
// The REAL validator consume-refresh uses to check the folded value against the `as`
// field's slice of state_schema (contracts.ts) — proves `state.directory` survives.
import { validateAgainstSchema } from '@block-agent/core/app/contracts.js';
import type { ImClientApi } from '../src/im_client.js';
import type {
  ImConversationsResponse,
  ImGroupCreateResponse,
  ImGroupMemberResponse,
  ImGroupSetOwnerResponse,
  ImHistoryResponse,
  ImPushFrame,
  ImSendResponse,
  WireMessage,
} from '../src/wire.js';
import {
  ImProxyApp,
  type ImProxyState,
  CHAT_BLOCK,
  CONVERSATIONS_BLOCK,
  labelFor,
  sanitizeId,
} from '../src/manifest.js';
// The REAL ImClient (loads the `ws` SDK) — used ONLY by the WS-graceful-degrade regression at
// the end, which needs a real socket to exercise the 'error' path the fake client can't reach.
import { ImClient } from '../src/im_client.js';

// ============================================================================
// FakeImClient — in-memory, scriptable; records calls; no network
// ============================================================================

class FakeImClient implements ImClientApi {
  readonly sendCalls: { conv: string; body: string; client_msg_id: string; mentions?: string[] }[] = [];
  readonly historyCalls: { conv: string; since: number; limit?: number }[] = [];
  conversations: ImConversationsResponse['conversations'] = [];
  /** Scripted per-conv backfill: conv id → messages returned by history(conv, since). */
  historyByConv = new Map<string, WireMessage[]>();
  private frameSink: ((f: ImPushFrame) => void) | null = null;
  private seq = 100;

  async listConversations(): Promise<ImConversationsResponse> {
    return { conversations: this.conversations.map((c) => ({ ...c, members: [...c.members] })) };
  }

  async history(conv: string, since: number, limit?: number): Promise<ImHistoryResponse> {
    this.historyCalls.push({ conv, since, ...(limit !== undefined ? { limit } : {}) });
    const all = this.historyByConv.get(conv) ?? [];
    const messages = all.filter((m) => m.seq > since);
    const latest_seq = all.reduce((mx, m) => Math.max(mx, m.seq), since);
    return { messages, latest_seq };
  }

  async send(req: { conv: string; body: string; client_msg_id: string; mentions?: string[] }): Promise<ImSendResponse> {
    this.sendCalls.push(req);
    this.seq += 1;
    return { id: `srv_${this.seq}`, seq: this.seq, ts: 0 };
  }

  async createGroup(req: { title: string; members: string[] }): Promise<ImGroupCreateResponse> {
    return { conv: { id: 'g_new', kind: 'group', title: req.title, members: req.members } };
  }
  async addMember(req: { conv: string; principal_id: string }): Promise<ImGroupMemberResponse> {
    return { conv: { id: req.conv, kind: 'group', members: [req.principal_id] } };
  }
  async removeMember(req: { conv: string; principal_id: string }): Promise<ImGroupMemberResponse> {
    return { conv: { id: req.conv, kind: 'group', members: [] } };
  }
  async setOwner(req: { conv: string; owner_id: string }): Promise<ImGroupSetOwnerResponse> {
    return { conv: { id: req.conv, kind: 'group', owner_id: req.owner_id, members: [] } };
  }

  subscribe(onFrame: (frame: ImPushFrame) => void): () => void {
    this.frameSink = onFrame;
    return () => {
      this.frameSink = null;
    };
  }
  close(): void {
    this.frameSink = null;
  }

  /** Test helper: push a frame as if the WS service emitted it. */
  pushFrame(frame: ImPushFrame): void {
    this.frameSink?.(frame);
  }
}

// ============================================================================
// Minimal AppContext stub — routes invoke_command(im.*) back into the manifest,
// records wake() calls (so push→coalesce→ingest→wake can be asserted end-to-end).
// ============================================================================

interface TestCtx extends AppContext<ImProxyState> {
  wakes: WakeEvent[];
}

function makeCtx(app: ImProxyApp, initialState: ImProxyState): TestCtx {
  let state: ImProxyState = structuredClone(initialState);
  const wakes: WakeEvent[] = [];
  const manifest = app.manifest();
  const ctx: TestCtx = {
    app_id: 'im_proxy',
    wakes,
    get state() {
      return state;
    },
    set_state(updater) {
      state = updater(state);
    },
    list_commands: () => [],
    list_builders: () => [],
    list_blocks: () => [],
    // Route an im.* command full-name back to this manifest's command (host stamps
    // invoker:'app' for ctx.invoke_command — modeled by passing an 'app' invoker).
    async invoke_command(full_name, args) {
      const cmdName = full_name.split('.')[1];
      const factory = manifest.commands.find((f) => f(state).name === cmdName);
      if (factory === undefined) return { ok: false, error: `no command ${full_name}` };
      return factory(state).invoke(args, ctx, { invoker: 'app' });
    },
    async read() {
      return [];
    },
    on() {},
    emit() {},
    spawn_system_agent() {
      return { id: 'fake', stop() {} };
    },
    wake(event) {
      wakes.push(event);
    },
  };
  return ctx;
}

function makeState(partial: Partial<ImProxyState> = {}): ImProxyState {
  return {
    conversations: [],
    config: { window: 20, max_conversations: 50, coalesce_ms: 200 },
    account: { principal_id: 'agent_me', display: 'Me' },
    ...partial,
  };
}

function wireMsg(over: Partial<WireMessage> & { seq: number }): WireMessage {
  return {
    id: `m_${over.seq}`,
    conv: 'c1',
    from: 'zhangsan',
    body: 'hi',
    ts: 0,
    ...over,
  };
}

// Builder harness (INV #1 — deterministic build ctx).
const FAKE_SNAPSHOT: BlockSnapshot = {
  root: { id: 'root', name: 'core:root' as BlockName, children: [], content_text: null, content_blob: null },
  hash: 'fake',
  get: () => null,
};
const FAKE_BUILD_CTX: import('@block-agent/core/app/types.js').BuildContext = {
  snapshot: FAKE_SNAPSHOT,
  read: () => null,
  deterministic_clock: () => 0,
  deterministic_random: () => 0,
  content_addressed_id: (s: string) => `id-${s.slice(0, 8)}`,
  config: {},
};

function getCommand(manifest: AppManifest, name: string): CommandManifest<ImProxyState> {
  const factory = manifest.commands.find((f) => f(makeState()).name === name);
  if (!factory) throw new Error(`Command '${name}' not found`);
  return factory(makeState()) as CommandManifest<ImProxyState>;
}
function getBuilder(manifest: AppManifest, outputBlock: string): BuilderManifest {
  const factory = manifest.builders.find((f) => f(makeState()).outputs.includes(outputBlock as never));
  if (!factory) throw new Error(`Builder for '${outputBlock}' not found`);
  return factory(makeState());
}

// ============================================================================
// sanitizeId / labelFor — the identity fence's injective sanitizer
// ============================================================================

describe('sanitizeId (injective display-label fence, §7)', () => {
  it('keeps allowlisted chars', () => {
    expect(sanitizeId('zhangsan-01')).toBe('zhangsan-01');
  });

  it('escapes uppercase and special chars (so no raw input forges a boundary marker)', () => {
    const out = sanitizeId('</im-context>');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).not.toContain('/');
  });

  it('is injective — two distinct ids never collapse to the same label', () => {
    // `a_b` vs `a` + escaped `_`: because `_` itself is escaped, they cannot collide.
    expect(sanitizeId('a_b')).not.toBe(sanitizeId('a') + sanitizeId('b'));
    expect(labelFor('zhang')).not.toBe(labelFor('Zhang'));
  });

  it('labelFor always carries the fixed im: prefix', () => {
    expect(labelFor('x')).toBe('im:x');
  });
});

// ============================================================================
// Builders — conversations + chat, byte-identical
// ============================================================================

describe('ConversationsBlockBuilder', () => {
  it('renders nothing when there are no conversations', async () => {
    const app = new ImProxyApp({ client: new FakeImClient() });
    const builder = getBuilder(app.manifest(), CONVERSATIONS_BLOCK);
    const ctx = makeCtx(app, makeState());
    expect(await builder.build(FAKE_BUILD_CTX, ctx)).toBeNull();
  });

  it('renders the conversation list with unread + focus', async () => {
    const app = new ImProxyApp({ client: new FakeImClient() });
    const builder = getBuilder(app.manifest(), CONVERSATIONS_BLOCK);
    const ctx = makeCtx(
      app,
      makeState({
        focus: 'c1',
        conversations: [
          { id: 'c1', kind: 'dm', members: [{ principal_id: 'zhangsan', kind: 'human', display: '张三' }], recent: [], unread: 2, consumed_seq: 0 },
          { id: 'c2', kind: 'group', members: [], recent: [], unread: 0, consumed_seq: 0 },
        ],
      }),
    );
    const block = await builder.build(FAKE_BUILD_CTX, ctx);
    expect(block!.content_text).toContain('# Conversations');
    expect(block!.content_text).toContain('2 unread');
    expect(block!.content_text).toContain('<- focus');
  });

  it('is byte-identical across two builds with same state (INV #1)', async () => {
    const app = new ImProxyApp({ client: new FakeImClient() });
    const builder = getBuilder(app.manifest(), CONVERSATIONS_BLOCK);
    const ctx = makeCtx(
      app,
      makeState({
        focus: 'c1',
        conversations: [{ id: 'c1', kind: 'dm', members: [], recent: [], unread: 1, consumed_seq: 0 }],
      }),
    );
    const a = await builder.build(FAKE_BUILD_CTX, ctx);
    const b = await builder.build(FAKE_BUILD_CTX, ctx);
    expect(a!.content_text).toBe(b!.content_text);
  });

  it('resolves a dm peer name from the consumed org_directory object (combine first)', async () => {
    const app = new ImProxyApp({ client: new FakeImClient() });
    const builder = getBuilder(app.manifest(), CONVERSATIONS_BLOCK);
    const ctx = makeCtx(
      app,
      makeState({
        focus: 'c1',
        // org_directory consumed as a SINGLE object { org_id, members } (not an array).
        directory: {
          org_id: 'org1',
          members: [{ principal_id: 'zhangsan', display: '张三', kind: 'human', name: 'Zhang San' }],
        },
        conversations: [
          { id: 'c1', kind: 'dm', members: [{ principal_id: 'zhangsan', kind: 'human', display: '' }], recent: [], unread: 0, consumed_seq: 0 },
        ],
      }),
    );
    const block = await builder.build(FAKE_BUILD_CTX, ctx);
    expect(block!.content_text).toContain('张三');
  });

  it('has owner system (INV #4) + slow_changing tier', () => {
    const app = new ImProxyApp({ client: new FakeImClient() });
    const builder = getBuilder(app.manifest(), CONVERSATIONS_BLOCK);
    expect(builder.owner).toBe('system');
    expect(builder.cache_tier).toBe('slow_changing');
  });
});

describe('ChatBlockBuilder', () => {
  it('renders the focused conversation window with [me] and @me highlight', async () => {
    const app = new ImProxyApp({ client: new FakeImClient() });
    const builder = getBuilder(app.manifest(), CHAT_BLOCK);
    const ctx = makeCtx(
      app,
      makeState({
        focus: 'c1',
        conversations: [
          {
            id: 'c1',
            kind: 'group',
            members: [],
            recent: [
              { id: 'm1', from_label: labelFor('zhangsan'), body: 'who deploys?', seq: 1 },
              { id: 'm2', from_label: labelFor('lisi'), body: 'you do it', seq: 2, mentioned_me: true },
              { id: 'm3', from_label: labelFor('agent_me'), body: 'got it', seq: 3 },
            ],
            unread: 0,
            consumed_seq: 3,
          },
        ],
      }),
    );
    const block = await builder.build(FAKE_BUILD_CTX, ctx);
    const text = block!.content_text!;
    expect(text).toContain('# Chat');
    expect(text).toContain('[im:zhangsan] who deploys?');
    expect(text).toContain('@me'); // lisi's message highlights the self-mention
    expect(text).toContain('[me] got it'); // own message renders as [me]
  });

  it('renders nothing when no conversation is focused', async () => {
    const app = new ImProxyApp({ client: new FakeImClient() });
    const builder = getBuilder(app.manifest(), CHAT_BLOCK);
    const ctx = makeCtx(app, makeState({ conversations: [] }));
    expect(await builder.build(FAKE_BUILD_CTX, ctx)).toBeNull();
  });

  it('is byte-identical across two builds with same state (INV #1)', async () => {
    const app = new ImProxyApp({ client: new FakeImClient() });
    const builder = getBuilder(app.manifest(), CHAT_BLOCK);
    const ctx = makeCtx(
      app,
      makeState({
        focus: 'c1',
        conversations: [
          { id: 'c1', kind: 'dm', members: [], recent: [{ id: 'm1', from_label: labelFor('x'), body: 'hi', seq: 1 }], unread: 0, consumed_seq: 1 },
        ],
      }),
    );
    const a = await builder.build(FAKE_BUILD_CTX, ctx);
    const b = await builder.build(FAKE_BUILD_CTX, ctx);
    expect(a!.content_text).toBe(b!.content_text);
  });

  it('has volatile tier', () => {
    const app = new ImProxyApp({ client: new FakeImClient() });
    const builder = getBuilder(app.manifest(), CHAT_BLOCK);
    expect(builder.cache_tier).toBe('volatile');
  });
});

// ============================================================================
// ingest command — front door, app-only
// ============================================================================

describe('im.ingest', () => {
  it('is allowed_invokers: [app] (stricter than messages; agent cannot forge inbound)', () => {
    const app = new ImProxyApp({ client: new FakeImClient() });
    const cmd = getCommand(app.manifest(), 'ingest');
    expect(cmd.allowed_invokers).toEqual(['app']);
  });

  it('folds a batch into the matching conversation, bumping unread + consumed_seq', async () => {
    const app = new ImProxyApp({ client: new FakeImClient() });
    const cmd = getCommand(app.manifest(), 'ingest');
    const ctx = makeCtx(
      app,
      makeState({
        conversations: [{ id: 'c1', kind: 'dm', members: [], recent: [], unread: 0, consumed_seq: 0 }],
      }),
    );
    await cmd.invoke({ messages: [{ conv: 'c1', msg: wireMsg({ seq: 1, body: 'hello' }) }] }, ctx, { invoker: 'app' });
    const conv = ctx.state.conversations[0]!;
    expect(conv.recent).toHaveLength(1);
    expect(conv.recent[0]!.body).toBe('hello');
    expect(conv.unread).toBe(1);
    expect(conv.consumed_seq).toBe(1);
  });

  it('dedupes by seq — a re-delivered seq is dropped (idempotent)', async () => {
    const app = new ImProxyApp({ client: new FakeImClient() });
    const cmd = getCommand(app.manifest(), 'ingest');
    const ctx = makeCtx(
      app,
      makeState({
        conversations: [{ id: 'c1', kind: 'dm', members: [], recent: [], unread: 0, consumed_seq: 0 }],
      }),
    );
    await cmd.invoke({ messages: [{ conv: 'c1', msg: wireMsg({ seq: 1 }) }] }, ctx, { invoker: 'app' });
    await cmd.invoke({ messages: [{ conv: 'c1', msg: wireMsg({ seq: 1 }) }] }, ctx, { invoker: 'app' });
    expect(ctx.state.conversations[0]!.recent).toHaveLength(1);
    expect(ctx.state.conversations[0]!.unread).toBe(1);
  });
});

// ============================================================================
// push → coalesce → ingest → wake
// ============================================================================

describe('push → coalesce → ingest → wake', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('coalesces a burst of pushes into ONE ingest + ONE wake', async () => {
    const client = new FakeImClient();
    // bootstrap seeds the conversation shells from the client (on_install replaces state).
    client.conversations = [
      { id: 'c1', kind: 'dm', members: [] },
      { id: 'c2', kind: 'dm', members: [] },
    ];
    const app = new ImProxyApp({ client });
    const ctx = makeCtx(app, makeState());
    // Wire on_install so app.ctx is captured + subscribe is attached.
    await app.manifest().on_install!(ctx);

    // A burst across two conversations within the coalesce window.
    client.pushFrame({ type: 'message', conv: 'c1', msg: wireMsg({ conv: 'c1', seq: 1, body: 'a' }) });
    client.pushFrame({ type: 'message', conv: 'c2', msg: wireMsg({ conv: 'c2', seq: 1, body: 'b' }) });
    client.pushFrame({ type: 'message', conv: 'c1', msg: wireMsg({ conv: 'c1', seq: 2, body: 'c' }) });

    // Drive the coalesce timer.
    await vi.advanceTimersByTimeAsync(250);

    // ONE wake for the whole burst (wake-storm guard).
    expect(ctx.wakes).toHaveLength(1);
    const woke = ctx.wakes[0]!;
    expect(woke.kind).toBe('app_event');
    if (woke.kind === 'app_event') expect(woke.source).toBe('im_proxy');
    // Both conversations got their messages folded.
    const c1 = ctx.state.conversations.find((c) => c.id === 'c1')!;
    const c2 = ctx.state.conversations.find((c) => c.id === 'c2')!;
    expect(c1.recent.map((m) => m.body)).toEqual(['a', 'c']);
    expect(c2.recent.map((m) => m.body)).toEqual(['b']);
    expect(c1.consumed_seq).toBe(2);
  });
});

// ============================================================================
// inbound → RENDERED chat block (the "agent really sees the message in context"
// assertion, Architect §4): an ingested peer message must appear VERBATIM in the
// rendered `im_proxy:chat` prompt block — this is what makes the agent able to act
// on it. Separating "rendered into context" from "command produced" guards the
// E2E vertical against a false-green where a reply lands without the agent having
// actually seen the message. The cross-process harness proves the same property
// transitively (the reply echoes the human's exact text); this pins it directly.
// ============================================================================

describe('inbound message renders verbatim into im_proxy:chat (agent sees it in context)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('a pushed peer message appears verbatim in the rendered chat block', async () => {
    const client = new FakeImClient();
    client.conversations = [{ id: 'c1', kind: 'dm', members: ['alice'] }];
    const app = new ImProxyApp({ client });
    const ctx = makeCtx(app, makeState());
    await app.manifest().on_install!(ctx); // bootstrap seeds the conv shell + focus

    // A human pushes a message; the proxy coalesces → ingests → wakes.
    client.pushFrame({
      type: 'message',
      conv: 'c1',
      msg: wireMsg({ conv: 'c1', seq: 1, from: 'alice', body: 'please ack this' }),
    });
    await vi.advanceTimersByTimeAsync(250);

    // Render the chat block from post-ingest state — the body MUST be present verbatim, so a
    // real/mocked agent reading this block can act on it. (This is the in-proc equivalent of
    // asserting the message reached the agent's RenderedPrompt.)
    const builder = getBuilder(app.manifest(), CHAT_BLOCK);
    const block = await builder.build(FAKE_BUILD_CTX, ctx);
    expect(block).not.toBeNull();
    expect(block!.content_text).toContain('please ack this');
    // And it renders as an inbound line (sanitized peer label), not the agent's own `[me]`.
    expect(block!.content_text).toContain(`[${labelFor('alice')}] please ack this`);
  });
});

// ============================================================================
// send command — forwarding + optimistic append
// ============================================================================

describe('im.send', () => {
  it('forwards to the client (no `from` in the request — server derives it, §7)', async () => {
    const client = new FakeImClient();
    const app = new ImProxyApp({ client });
    const cmd = getCommand(app.manifest(), 'send');
    const ctx = makeCtx(
      app,
      makeState({
        focus: 'c1',
        conversations: [{ id: 'c1', kind: 'dm', members: [], recent: [], unread: 0, consumed_seq: 0 }],
      }),
    );
    const res = await cmd.invoke({ conv: 'c1', body: 'hello there' }, ctx, { invoker: 'agent' });
    expect(res.ok).toBe(true);
    expect(client.sendCalls).toHaveLength(1);
    expect(client.sendCalls[0]!.body).toBe('hello there');
    expect(client.sendCalls[0]!.client_msg_id).toBeTruthy();
    expect(client.sendCalls[0]).not.toHaveProperty('from');
  });

  it('optimistically appends the sent message to the focused window as [me]', async () => {
    const client = new FakeImClient();
    const app = new ImProxyApp({ client });
    const cmd = getCommand(app.manifest(), 'send');
    const ctx = makeCtx(
      app,
      makeState({
        focus: 'c1',
        conversations: [{ id: 'c1', kind: 'dm', members: [], recent: [], unread: 0, consumed_seq: 0 }],
      }),
    );
    await cmd.invoke({ conv: 'c1', body: 'my message' }, ctx, { invoker: 'agent' });
    const conv = ctx.state.conversations[0]!;
    expect(conv.recent).toHaveLength(1);
    expect(conv.recent[0]!.body).toBe('my message');
    expect(conv.recent[0]!.from_label).toBe(labelFor('agent_me'));
  });
});

// ============================================================================
// reply command — send to the FOCUSED conversation (no conv arg). The agent's
// natural "answer the chat I'm reading" door (mirrors messages.reply); the proof
// the agent can reply WITHOUT knowing a raw conv id (no block exposes one).
// ============================================================================

describe('im.reply (send to the focused conversation)', () => {
  it('forwards to the focused conv with no `conv` arg, optimistically appending the reply', async () => {
    const client = new FakeImClient();
    const app = new ImProxyApp({ client });
    const cmd = getCommand(app.manifest(), 'reply');
    const ctx = makeCtx(
      app,
      makeState({
        focus: 'c1',
        conversations: [{ id: 'c1', kind: 'dm', members: [], recent: [], unread: 0, consumed_seq: 0 }],
      }),
    );
    const res = await cmd.invoke({ body: 'an answer' }, ctx, { invoker: 'agent' });
    expect(res.ok).toBe(true);
    // It went to the focused conversation (the one the agent is reading), no conv arg needed.
    expect(client.sendCalls).toHaveLength(1);
    expect(client.sendCalls[0]!.conv).toBe('c1');
    expect(client.sendCalls[0]!.body).toBe('an answer');
    expect(client.sendCalls[0]).not.toHaveProperty('from'); // server derives `from` (§7)
    // And the reply is optimistically appended to the window.
    expect(ctx.state.conversations[0]!.recent.map((m) => m.body)).toEqual(['an answer']);
  });

  it('errors when no conversation is focused (nothing to reply to)', async () => {
    const client = new FakeImClient();
    const app = new ImProxyApp({ client });
    const cmd = getCommand(app.manifest(), 'reply');
    const ctx = makeCtx(app, makeState({ conversations: [{ id: 'c1', kind: 'dm', members: [], recent: [], unread: 0, consumed_seq: 0 }] }));
    const res = await cmd.invoke({ body: 'hi' }, ctx, { invoker: 'agent' });
    expect(res.ok).toBe(false);
    expect(client.sendCalls).toHaveLength(0);
  });

  it('rejects an empty/missing body', async () => {
    const app = new ImProxyApp({ client: new FakeImClient() });
    const cmd = getCommand(app.manifest(), 'reply');
    const ctx = makeCtx(app, makeState({ focus: 'c1', conversations: [{ id: 'c1', kind: 'dm', members: [], recent: [], unread: 0, consumed_seq: 0 }] }));
    expect((await cmd.invoke({}, ctx, { invoker: 'agent' })).ok).toBe(false);
  });

  it('is available to the agent (no user-only gate — the agent must be able to reply)', () => {
    const app = new ImProxyApp({ client: new FakeImClient() });
    const cmd = getCommand(app.manifest(), 'reply');
    // allowed_invokers undefined → all invokers (incl. agent), like im.send.
    expect(cmd.allowed_invokers).toBeUndefined();
  });
});

// ============================================================================
// per-conv consumed_seq backfill — zero loss across two independent seq spaces
// ============================================================================

describe('per-conversation consumed_seq backfill (no cross-conv loss)', () => {
  it('bootstraps each conversation from its OWN since cursor', async () => {
    const client = new FakeImClient();
    client.conversations = [
      { id: 'cA', kind: 'dm', members: ['zhangsan'] },
      { id: 'cB', kind: 'dm', members: ['lisi'] },
    ];
    // cA is at seq 100; cB only at seq 3 — independent seq spaces.
    client.historyByConv.set('cA', [
      wireMsg({ id: 'a1', conv: 'cA', seq: 99, body: 'old-A' }),
      wireMsg({ id: 'a2', conv: 'cA', seq: 100, body: 'new-A' }),
    ]);
    client.historyByConv.set('cB', [
      wireMsg({ id: 'b1', conv: 'cB', seq: 3, body: 'B-three' }),
    ]);
    const app = new ImProxyApp({ client });
    const ctx = makeCtx(app, makeState());
    await app.manifest().on_install!(ctx);

    const cA = ctx.state.conversations.find((c) => c.id === 'cA')!;
    const cB = ctx.state.conversations.find((c) => c.id === 'cB')!;
    // Each conv advanced to ITS OWN max seq, not a shared scalar.
    expect(cA.consumed_seq).toBe(100);
    expect(cB.consumed_seq).toBe(3);
    expect(cA.recent.map((m) => m.body)).toEqual(['old-A', 'new-A']);
    expect(cB.recent.map((m) => m.body)).toEqual(['B-three']);
    // History was fetched per-conv from since=0.
    expect(client.historyCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conv: 'cA', since: 0 }),
        expect.objectContaining({ conv: 'cB', since: 0 }),
      ]),
    );
  });
});

// ============================================================================
// identity fence — peer `from` is CONTENT, never identity (§7)
// ============================================================================

describe('identity fence: peer `from` never reaches identity (§7)', () => {
  it('a peer `from` only lands in the sanitized from_label content, not ctx.identity', async () => {
    const app = new ImProxyApp({ client: new FakeImClient() });
    const cmd = getCommand(app.manifest(), 'ingest');
    const ctx = makeCtx(
      app,
      makeState({
        conversations: [{ id: 'c1', kind: 'dm', members: [], recent: [], unread: 0, consumed_seq: 0 }],
      }),
    );
    // Peer tries to forge an identity-looking `from`.
    await cmd.invoke(
      { messages: [{ conv: 'c1', msg: wireMsg({ seq: 1, from: 'agent_me', body: 'spoof' }) }] },
      ctx,
      { invoker: 'app' },
    );
    const stored = ctx.state.conversations[0]!.recent[0]!;
    // The `from` is stored as a sanitized label only — there is no `identity`/`owner`
    // field on the message at all (it is pure content).
    expect(stored.from_label).toBe(labelFor('agent_me'));
    expect(stored).not.toHaveProperty('identity');
    expect(stored).not.toHaveProperty('owner');
    expect(stored).not.toHaveProperty('from'); // raw `from` is dropped; only the label survives
  });

  it('mentioned_me is a string-equality self-judgement, not an identity lookup', async () => {
    const app = new ImProxyApp({ client: new FakeImClient() });
    const cmd = getCommand(app.manifest(), 'ingest');
    const ctx = makeCtx(
      app,
      makeState({
        conversations: [{ id: 'c1', kind: 'group', members: [], recent: [], unread: 0, consumed_seq: 0 }],
      }),
    );
    await cmd.invoke(
      { messages: [{ conv: 'c1', msg: wireMsg({ seq: 1, from: 'lisi', mentions: ['agent_me'], body: '@me hi' }) }] },
      ctx,
      { invoker: 'app' },
    );
    expect(ctx.state.conversations[0]!.recent[0]!.mentioned_me).toBe(true);
  });

  it('a non-matching mention does NOT set mentioned_me', async () => {
    const app = new ImProxyApp({ client: new FakeImClient() });
    const cmd = getCommand(app.manifest(), 'ingest');
    const ctx = makeCtx(
      app,
      makeState({
        conversations: [{ id: 'c1', kind: 'group', members: [], recent: [], unread: 0, consumed_seq: 0 }],
      }),
    );
    await cmd.invoke(
      { messages: [{ conv: 'c1', msg: wireMsg({ seq: 1, from: 'lisi', mentions: ['someone_else'] }) }] },
      ctx,
      { invoker: 'app' },
    );
    expect(ctx.state.conversations[0]!.recent[0]!.mentioned_me).toBeUndefined();
  });
});

// ============================================================================
// set_config + group-management gates — user-only (anti-jailbreak)
// ============================================================================

describe('user-only gates', () => {
  it('set_config is allowed_invokers: [user]', () => {
    const app = new ImProxyApp({ client: new FakeImClient() });
    expect(getCommand(app.manifest(), 'set_config').allowed_invokers).toEqual(['user']);
  });

  it('group-management commands are all allowed_invokers: [user]', () => {
    const app = new ImProxyApp({ client: new FakeImClient() });
    const manifest = app.manifest();
    for (const name of ['create_group', 'add_member', 'remove_member', 'set_owner']) {
      expect(getCommand(manifest, name).allowed_invokers).toEqual(['user']);
    }
  });
});

// ============================================================================
// consume-refresh: org_directory folds as an OBJECT into state.directory
// (the bug Architect caught — a `type:'array'` schema would downgrade the consumer)
// ============================================================================

describe('consume-refresh: state.directory accepts the OrgDirectory object', () => {
  /** Pull the `directory` slice of the manifest's state_schema (what consume-refresh checks). */
  function directorySchema(): JsonSchema {
    const schema = new ImProxyApp({ client: new FakeImClient() }).manifest().state_schema as {
      properties: { directory: JsonSchema };
    };
    return schema.properties.directory;
  }

  it('the state_schema for `directory` validates an OrgDirectory object (not array)', () => {
    const folded = {
      org_id: 'org1',
      members: [{ principal_id: 'zhangsan', kind: 'human', name: 'Zhang San', display: '张三' }],
    };
    // This is exactly the check consume-refresh runs before set_state. An `array` schema
    // would fail here and silently downgrade the consumer (Architect's blocking bug).
    expect(validateAgainstSchema(folded, directorySchema())).toEqual({ ok: true });
    // And an array (the WRONG shape) must NOT validate against the object schema.
    expect(validateAgainstSchema([], directorySchema()).ok).toBe(false);
  });

  it('after directory folds in, displayName resolves a peer name (end-to-end)', async () => {
    const app = new ImProxyApp({ client: new FakeImClient() });
    const builder = getBuilder(app.manifest(), CHAT_BLOCK);
    const ctx = makeCtx(
      app,
      makeState({
        focus: 'c1',
        // Simulate the post-consume-refresh state: the folded OrgDirectory object is in place.
        directory: {
          org_id: 'org1',
          members: [{ principal_id: 'lisi', display: '李四', kind: 'human', name: 'Li Si' }],
        },
        conversations: [
          {
            id: 'c1',
            kind: 'dm',
            members: [{ principal_id: 'lisi', kind: 'human', display: '' }],
            recent: [{ id: 'm1', from_label: labelFor('lisi'), body: 'hi', seq: 1 }],
            unread: 0,
            consumed_seq: 1,
          },
        ],
      }),
    );
    const block = await builder.build(FAKE_BUILD_CTX, ctx);
    // The dm header resolves the peer's display name from the consumed directory.
    expect(block!.content_text).toContain('李四');
  });
});

// ============================================================================
// AppManifest invariants + contracts
// ============================================================================

describe('AppManifest invariants', () => {
  it('id + tree_namespace + trust/host', () => {
    const m = new ImProxyApp({ client: new FakeImClient() }).manifest();
    expect(m.id).toBe('im_proxy');
    expect(m.tree_namespace).toBe('/im_proxy');
    expect(m.trust).toBe('trusted');
    expect(m.host).toBe('in-process');
  });

  it('provides message_count via unread_count; consumes org_directory as directory', () => {
    const m = new ImProxyApp({ client: new FakeImClient() }).manifest();
    expect(m.provides).toEqual([{ contract: 'message_count', via: 'unread_count' }]);
    expect(m.consumes).toEqual([{ contract: 'org_directory', as: 'directory' }]);
  });

  it('unread_count returns the scalar total unread (contract output_schema)', async () => {
    const app = new ImProxyApp({ client: new FakeImClient() });
    const cmd = getCommand(app.manifest(), 'unread_count');
    const ctx = makeCtx(
      app,
      makeState({
        conversations: [
          { id: 'c1', kind: 'dm', members: [], recent: [], unread: 2, consumed_seq: 0 },
          { id: 'c2', kind: 'dm', members: [], recent: [], unread: 3, consumed_seq: 0 },
        ],
      }),
    );
    const res = await cmd.invoke({}, ctx, { invoker: 'app' });
    expect(res.data).toBe(5);
    expect(cmd.readonly).toBe(true);
    expect(cmd.allowed_invokers).toEqual(['app', 'user']);
  });
});

// ============================================================================
// IM_SERVICE_SELF — the agent's own principal_id seeds `account` (self-label).
// Symmetric with IM_SERVICE_URL/TOKEN; mirrors task_proxy's TASK_SERVICE_SELF.
// It is a LABEL (renders `[me]`/`@me`), NOT identity-authority (the §7 fence holds).
// ============================================================================

describe('IM_SERVICE_SELF seeds the self account', () => {
  it('seeds initial_state.account.principal_id from the env var', () => {
    const prev = process.env['IM_SERVICE_SELF'];
    process.env['IM_SERVICE_SELF'] = 'agent_a1';
    try {
      // No explicit `account` opt → the constructor reads the env (real-client path is fine; we
      // inject a fake client so no network, but the env read is independent of the client).
      const m = new ImProxyApp({ client: new FakeImClient() }).manifest();
      expect(m.initial_state).toMatchObject({ account: { principal_id: 'agent_a1', display: 'agent_a1' } });
    } finally {
      if (prev === undefined) delete process.env['IM_SERVICE_SELF'];
      else process.env['IM_SERVICE_SELF'] = prev;
    }
  });

  it('an explicit account opt overrides the env', () => {
    const prev = process.env['IM_SERVICE_SELF'];
    process.env['IM_SERVICE_SELF'] = 'from_env';
    try {
      const m = new ImProxyApp({ client: new FakeImClient(), account: { principal_id: 'explicit', display: 'X' } }).manifest();
      expect(m.initial_state).toMatchObject({ account: { principal_id: 'explicit', display: 'X' } });
    } finally {
      if (prev === undefined) delete process.env['IM_SERVICE_SELF'];
      else process.env['IM_SERVICE_SELF'] = prev;
    }
  });

  it('no env + no opt → no account (graceful: `[me]` simply does not render)', () => {
    const prev = process.env['IM_SERVICE_SELF'];
    delete process.env['IM_SERVICE_SELF'];
    try {
      const m = new ImProxyApp({ client: new FakeImClient() }).manifest();
      expect((m.initial_state as ImProxyState).account).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env['IM_SERVICE_SELF'] = prev;
    }
  });
});

// ============================================================================
// REGRESSION: WS graceful degrade when the IM service is ABSENT.
//
// The `ws` WebSocket is an EventEmitter — an unhandled 'error' event is RE-THROWN by Node as
// an uncaughtException and crashes the whole agent process. im_proxy is DEFAULT-OFF but, once
// enabled, on_install opens a subscribe socket immediately; if the IM service isn't up yet
// (a normal startup race / a misconfig), that connect fails and MUST degrade silently, never
// crash. This bug was invisible to the fake-client unit tests above (no real socket) and was
// caught only by a headless boot smoke; this test is its automated guard. Without the
// `socket.on('error', …)` handler in im_client.openSocket, this test fails (uncaughtException).
// ============================================================================
describe('ImClient — WS graceful degrade (no crash when the service is absent)', () => {
  it('subscribe() to an unreachable service swallows the ws error and does not crash', async () => {
    // REAL timers: a sibling test uses vi.useFakeTimers() (the coalesce window), and a leaked
    // fake clock would freeze the real-async wait below forever (a 5s timeout). The ws connect +
    // its 'error' event are real async, so we must run them under the real clock.
    vi.useRealTimers();
    // 127.0.0.1:9 (discard) is effectively unbound here → the WS connect fails fast. A real
    // ImClient (real `ws`) is required: the fake client never opens a socket.
    const client = new ImClient({ baseUrl: 'http://127.0.0.1:9', token: '' });
    const frames: ImPushFrame[] = [];
    const close = client.subscribe((f) => frames.push(f));
    // Let the async connect + 'error' event fire. If the error were unhandled, vitest's
    // uncaughtException hook would fail this test (the regression). Reaching the assertion = handled.
    await new Promise((r) => setTimeout(r, 250));
    expect(frames).toHaveLength(0); // no service → no frames, but no crash either
    close(); // idempotent teardown (closing a dead/null socket is harmless)
  });
});
