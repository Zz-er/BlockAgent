/**
 * server/test/session_host.test.ts — drive the SessionHost in-process with a mock provider.
 *
 * Asserts the load-bearing protocol behaviors (D2):
 *   - submit routes to invoke_command as invoker:'user' (the host stamps it host-side) and
 *     the mock turn produces an outbound `turn` frame.
 *   - query is served read-only (never invoke_command) and never mutates the tree.
 *   - control pause parks wakes; resume replays them; drain settles.
 *   - onTurn / onThinking emit framed outbound; thinking text is opaque.
 *   - hello → capabilities handshake.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { launch } from '@block-agent/cli/launch.js';
import type { LaunchedAgent } from '@block-agent/cli/types.js';
import { SessionHost } from '@block-agent/server/session_host.js';
import { connectInProcess } from '@block-agent/server/in_process_transport.js';

import { mockConfig, collectingSink } from './_support.js';

let openAgents: LaunchedAgent[] = [];

afterEach(() => {
  openAgents = [];
  vi.restoreAllMocks();
});

async function makeHost(): Promise<{ host: SessionHost; agent: LaunchedAgent }> {
  const agent = await launch(mockConfig());
  openAgents.push(agent);
  return { host: new SessionHost(agent), agent };
}

describe('SessionHost — handshake', () => {
  it('answers hello with a capabilities frame carrying the model + emits/accepts', async () => {
    const { host } = await makeHost();
    const { sink, ofKind } = collectingSink();
    const conn = connectInProcess(host, sink);

    await conn.send({ kind: 'hello', v: '0', client: 'test', understands: ['turn', 'thinking'] });

    const caps = ofKind('capabilities');
    expect(caps).toHaveLength(1);
    expect(caps[0]!.model).toBe('mock');
    expect(caps[0]!.accepts).toContain('submit');
    expect(caps[0]!.emits).toContain('turn');
    expect(caps[0]!.features.supervisor).toBe(false);

    conn.close();
    host.close();
  });
});

describe('SessionHost — submit', () => {
  it('routes submit to invoke_command as invoker:user and emits a turn frame', async () => {
    const { host, agent } = await makeHost();
    const spy = vi.spyOn(agent.operations, 'invoke_command');
    const { sink, ofKind } = collectingSink();
    const conn = connectInProcess(host, sink);

    await conn.send({ kind: 'submit', v: '0', text: 'hello agent' });

    // The host stamped invoker:'user' host-side and routed to messages.ingest.
    expect(spy).toHaveBeenCalledWith(
      'messages.ingest',
      { content: 'hello agent' },
      { invoker: 'user' },
    );
    // The mock turn produced at least one turn frame on the broadcast stream.
    expect(ofKind('turn').length).toBeGreaterThanOrEqual(1);

    conn.close();
    host.close();
  });

  it('the host stamps invoker:user on the ingest it routes (never forges via submit)', async () => {
    const { host, agent } = await makeHost();
    const spy = vi.spyOn(agent.operations, 'invoke_command');
    const conn = connectInProcess(host, () => undefined);

    await conn.send({ kind: 'submit', v: '0', text: 'hi' });

    // Within a turn the runtime legitimately routes the AGENT's own tool_calls
    // (messages.reply as invoker:'agent', focus.record as invoker:'app') through
    // invoke_command too — those are correct and NOT the host's doing. The host's
    // contribution is exactly the messages.ingest call, which MUST be invoker:'user'.
    const ingestCalls = spy.mock.calls.filter((c) => c[0] === 'messages.ingest');
    expect(ingestCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of ingestCalls) {
      const ctx = call[2] as { invoker?: string };
      expect(ctx.invoker).toBe('user');
    }
    conn.close();
    host.close();
  });

  it('emits a reply frame carrying the agent reply content (MessagesApp.onReply seam)', async () => {
    const { host } = await makeHost();
    const { sink, ofKind } = collectingSink();
    const conn = connectInProcess(host, sink);

    await conn.send({ kind: 'submit', v: '0', text: 'hello agent' });

    // The agent's reply must reach the chat stream as a `reply` frame (not only as a `turn`
    // telemetry frame). Without this the web chat shows only the user's own messages.
    const replies = ofKind('reply');
    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(typeof replies[0]!.id).toBe('string');
    expect(replies[0]!.content.length).toBeGreaterThan(0);

    conn.close();
    host.close();
  });

  it('does NOT surface the reply (end_turn) command as a tool_call frame', async () => {
    const { host } = await makeHost();
    const { sink, ofKind } = collectingSink();
    const conn = connectInProcess(host, sink);

    await conn.send({ kind: 'submit', v: '0', text: 'hello agent' });

    // The mock's only command is messages.reply (end_turn) — surfaced as the `reply` frame
    // (the chat bubble), NOT as a tool_call (the runtime skips the end_turn command so the web
    // doesn't double-show it / strand the live-activity panel). A non-reply command WOULD emit
    // a tool_call frame (covered at the runtime onToolCall channel level in core).
    expect(ofKind('reply').length).toBeGreaterThanOrEqual(1);
    expect(ofKind('tool_call')).toHaveLength(0);

    conn.close();
    host.close();
  });
});

describe('SessionHost — query is read-only', () => {
  it('serves a context summary via invoke_query/render and never invoke_command', async () => {
    const { host, agent } = await makeHost();
    // Settle the initial state first (no submit), then watch for any mutation during query.
    const cmdSpy = vi.spyOn(agent.operations, 'invoke_command');
    const before = agent.operations.snapshot().hash;

    const { sink, ofKind } = collectingSink();
    const conn = connectInProcess(host, sink);

    await conn.send({ kind: 'query', v: '0', request_id: 'q1', target: 'context' });

    const ctx = ofKind('context');
    expect(ctx).toHaveLength(1);
    expect(ctx[0]!.request_id).toBe('q1');
    expect(ctx[0]!.scope).toBe('summary');
    expect(Array.isArray(ctx[0]!.segments)).toBe(true);
    // segment_hashes present so the diff layer can work.
    expect(ctx[0]!.segment_hashes).toBeDefined();

    // No invoke_command fired for a query, and the tree is unchanged (read-only, INV #1).
    expect(cmdSpy).not.toHaveBeenCalled();
    expect(agent.operations.snapshot().hash).toBe(before);

    conn.close();
    host.close();
  });

  it('serves attribution + blocks scopes; blocks carries per-block rows', async () => {
    const { host } = await makeHost();
    const { sink, ofKind } = collectingSink();
    const conn = connectInProcess(host, sink);

    await conn.send({ kind: 'query', v: '0', request_id: 'a1', target: 'attribution' });
    await conn.send({ kind: 'query', v: '0', request_id: 'b1', target: 'blocks' });

    const frames = ofKind('context');
    const attribution = frames.find((f) => f.scope === 'attribution');
    const blocks = frames.find((f) => f.scope === 'blocks');

    expect(attribution?.attribution?.installed.some((a) => a.id === 'messages')).toBe(true);
    expect(Array.isArray(blocks?.blocks)).toBe(true);
    // The agent_identity:identity block is seeded from turn 1 — it must appear with attribution.
    const identity = blocks?.blocks?.find((b) => b.name.startsWith('agent_identity:'));
    expect(identity?.app_id).toBe('agent_identity');
    expect(identity?.tier).toBeTruthy();
    // bytes must be the RENDERED size (builder output), not the snapshot's empty stored
    // content_text. A regression to raw content_text reports 0 here (the "all 0B" bug).
    expect(identity?.bytes).toBeGreaterThan(0);

    conn.close();
    host.close();
  });

  it('serves a single block body (scope:block) whose hash matches the blocks layer', async () => {
    const { host } = await makeHost();
    const { sink, ofKind } = collectingSink();
    const conn = connectInProcess(host, sink);

    // First learn a real block name + its hash from the blocks layer.
    await conn.send({ kind: 'query', v: '0', request_id: 'bl1', target: 'blocks' });
    const blocksFrame = ofKind('context').find((f) => f.scope === 'blocks')!;
    const row = blocksFrame.blocks!.find((b) => b.name.startsWith('agent_identity:'))!;
    expect(row).toBeTruthy();

    // Now lazily fetch that one block's body; the content_hash MUST match the row's hash
    // (the D3 cache key), and text must be present.
    await conn.send({ kind: 'query', v: '0', request_id: 'bb1', target: 'block', block_name: row.name });
    const bodyFrame = ofKind('context').find((f) => f.scope === 'block')!;
    expect(bodyFrame.request_id).toBe('bb1');
    expect(bodyFrame.block?.name).toBe(row.name);
    expect(bodyFrame.block?.content_hash).toBe(row.content_hash);
    expect(typeof bodyFrame.block?.text).toBe('string');
    // The body is the RENDERED text (builder output), so it is non-empty for a seeded block —
    // and its hash matches the blocks-layer row's hash (both hash the rendered text).
    expect((bodyFrame.block?.text ?? '').length).toBeGreaterThan(0);

    conn.close();
    host.close();
  });

  it('returns a null body for an unknown block name (scope:block)', async () => {
    const { host } = await makeHost();
    const { sink, ofKind } = collectingSink();
    const conn = connectInProcess(host, sink);

    await conn.send({ kind: 'query', v: '0', request_id: 'nb', target: 'block', block_name: 'does_not:exist' });
    const bodyFrame = ofKind('context').find((f) => f.scope === 'block')!;
    expect(bodyFrame.block?.text).toBeNull();

    conn.close();
    host.close();
  });

  it('honors the verbose flag with full segment text', async () => {
    const { host } = await makeHost();
    const { sink, ofKind } = collectingSink();
    const conn = connectInProcess(host, sink);

    await conn.send({ kind: 'query', v: '0', request_id: 'v1', target: 'context', verbose: true });

    const seg = ofKind('context')[0]!.segments?.[0];
    expect(typeof seg?.text).toBe('string');

    conn.close();
    host.close();
  });
});

describe('SessionHost — control gates the wake seam', () => {
  it('pause parks wakes, resume replays them, drain settles', async () => {
    const { host, agent } = await makeHost();
    const { sink, ofKind } = collectingSink();
    const conn = connectInProcess(host, sink);

    // Pause: a submit's wake is parked, so no turn runs while paused.
    await conn.send({ kind: 'control', v: '0', op: 'pause' });

    // Fire the ingest WITHOUT the submit's awaitTurnsSettled (which would deadlock while
    // parked); we want to observe that the turn does not run until resume.
    await agent.operations.invoke_command('messages.ingest', { content: 'while paused' }, { invoker: 'user' });

    // No turn yet (the wake is parked).
    expect(ofKind('turn')).toHaveLength(0);

    // Resume replays the parked wake → the turn now runs and emits a turn frame.
    await conn.send({ kind: 'control', v: '0', op: 'resume' });
    await conn.send({ kind: 'control', v: '0', op: 'drain' });

    expect(ofKind('turn').length).toBeGreaterThanOrEqual(1);

    conn.close();
    host.close();
  });
});

describe('SessionHost — outbound streams', () => {
  it('emits thinking frames (opaque text) during a turn', async () => {
    const { host } = await makeHost();
    const { sink, ofKind } = collectingSink();
    const conn = connectInProcess(host, sink);

    await conn.send({ kind: 'submit', v: '0', text: 'go' });

    const thinking = ofKind('thinking');
    // The hard-coded mock script emits a thinking line before the reply.
    expect(thinking.length).toBeGreaterThanOrEqual(1);
    expect(typeof thinking[0]!.text).toBe('string');

    conn.close();
    host.close();
  });

  it('stamps ts on the turn frame and carries the TurnRecord fields', async () => {
    const { host } = await makeHost();
    const { sink, ofKind } = collectingSink();
    const conn = connectInProcess(host, sink);

    await conn.send({ kind: 'submit', v: '0', text: 'go' });

    const turn = ofKind('turn')[0]!;
    expect(typeof turn.ts).toBe('string');
    expect(() => new Date(turn.ts).toISOString()).not.toThrow();
    expect(typeof turn.turn_id).toBe('string');
    expect(turn.ended_by).toBeTruthy();

    conn.close();
    host.close();
  });
});

describe('SessionHost — forward compat', () => {
  it('answers an unknown inbound kind with a benign error, not a throw', async () => {
    const { host } = await makeHost();
    const { sink, ofKind } = collectingSink();
    const conn = connectInProcess(host, sink);

    // Cast through unknown — an unknown kind a future client might send.
    await conn.send({ kind: 'mystery', v: '0' } as unknown as Parameters<typeof conn.send>[0]);

    const errs = ofKind('error');
    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toMatch(/unknown inbound kind/);

    conn.close();
    host.close();
  });
});
