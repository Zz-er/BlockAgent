/**
 * test/appcontext_proxy.test.ts — unified-host UH-2/SS3b: AppContextProxy parity +
 * no-leak + frame-mapping unit tests (child-side proxy over a paired in-memory channel,
 * no real process).
 *
 * The load-bearing gate (Raven SS3): the proxy's member surface == the in-process
 * AppContext whitelist (shared helper, ONE source of truth), and nothing reachable on
 * it is the RpcChannel / its transport / an Operations|apply handle / the taint
 * write-end. Plus: function args (set_state updater, on handler) never cross the wire;
 * invoke_command / read / emit / set_state / wake map to the right frames.
 */

import { describe, expect, it, vi } from 'vitest';

import { FramedRpcChannel, type RpcFrame, type Transport } from '../src/app/rpc/channel.js';
import { makeAppContextProxy, type ProxySeed } from '../src/app/rpc/app_context_proxy.js';
import {
  assertAppContextWhitelist,
  allMemberNames,
} from './_support/appcontext_whitelist.js';

// Paired in-memory transports (same as rpc_channel.test) so child↔main round-trip.
function makePair(): { a: Transport; b: Transport } {
  let aH: ((f: RpcFrame) => void) | null = null;
  let bH: ((f: RpcFrame) => void) | null = null;
  const a: Transport = {
    send: (f) => queueMicrotask(() => bH?.(structuredClone(f))),
    onMessage: (h) => { aH = h; },
    close: () => {},
  };
  const b: Transport = {
    send: (f) => queueMicrotask(() => aH?.(structuredClone(f))),
    onMessage: (h) => { bH = h; },
    close: () => {},
  };
  return { a, b };
}

function seed(over: Partial<ProxySeed> = {}): ProxySeed {
  return { app_id: 'evil', initial_state: { n: 0 }, commands: [], builders: [], ...over };
}

// ===========================================================================
// whitelist parity + no-leak (Raven SS3 hard-gate)
// ===========================================================================

describe('AppContextProxy — whitelist parity + no carrier/handle leak', () => {
  it('exposes exactly the AppContext whitelist; no channel/transport/Operations leaked', () => {
    const { a } = makePair();
    const channel = new FramedRpcChannel(a);
    const proxy = makeAppContextProxy(channel, seed());

    // Same shared assertion the in-process AppContext uses (one source of truth).
    // forbiddenValue: any RpcChannel instance must never be a reachable member value.
    assertAppContextWhitelist(proxy as object, (v) => v instanceof FramedRpcChannel);
    channel.dispose();
  });

  it('does NOT expose the taint write-end or the channel by any member name', () => {
    const { a } = makePair();
    const channel = new FramedRpcChannel(a);
    const proxy = makeAppContextProxy(channel, seed());
    const members = allMemberNames(proxy as object);
    for (const forbidden of ['channel', 'transport', 'run_in_chain', 'taintStore', 'apply', 'operations']) {
      expect(members.has(forbidden)).toBe(false);
    }
    channel.dispose();
  });
});

// ===========================================================================
// function args never cross the wire
// ===========================================================================

describe('AppContextProxy — functions stay in the child', () => {
  it('set_state runs the updater LOCALLY and frames only the next value', async () => {
    const { a, b } = makePair();
    const child = new FramedRpcChannel(a);
    const main = new FramedRpcChannel(b);
    let framedNext: unknown;
    main.on('set_state', (args) => {
      framedNext = (args as { next: unknown }).next;
      return null;
    });
    const proxy = makeAppContextProxy<{ n: number }>(child, seed() as ProxySeed<{ n: number }>);

    proxy.set_state((s) => ({ ...s, n: s.n + 5 }));
    // local copy updated synchronously (the updater ran in-child)
    expect(proxy.state.n).toBe(5);
    // and only the resulting value was framed (no function on the wire)
    await new Promise((r) => setTimeout(r, 10));
    expect(framedNext).toEqual({ n: 5 });
    child.dispose();
    main.dispose();
  });

  it('on registers locally; an __event frame from main dispatches to the local handler', async () => {
    const { a, b } = makePair();
    const child = new FramedRpcChannel(a);
    const main = new FramedRpcChannel(b);
    const proxy = makeAppContextProxy(child, seed());

    const seen: unknown[] = [];
    proxy.on('ping', (e) => seen.push(e.payload));
    // main delivers an event by framing __event to the child
    await main.call('__event', { event: 'ping', appEvent: { topic: 'ping', payload: 42 } });
    expect(seen).toEqual([42]);
    child.dispose();
    main.dispose();
  });
});

// ===========================================================================
// channel mapping — invoke_command / read / emit / wake
// ===========================================================================

describe('AppContextProxy — channel frame mapping', () => {
  it('invoke_command frames {full_name,args} and returns the main CommandResult', async () => {
    const { a, b } = makePair();
    const child = new FramedRpcChannel(a);
    const main = new FramedRpcChannel(b);
    const got: unknown[] = [];
    main.on('invoke_command', (args) => {
      got.push(args);
      return { ok: true, data: { echoed: true } };
    });
    const proxy = makeAppContextProxy(child, seed());

    const res = await proxy.invoke_command('messages.reply', { content: 'hi' });
    expect(got[0]).toEqual({ full_name: 'messages.reply', args: { content: 'hi' } });
    expect(res).toEqual({ ok: true, data: { echoed: true } });
    child.dispose();
    main.dispose();
  });

  it('read frames {blockname} and returns the (deep-copied) blocks', async () => {
    const { a, b } = makePair();
    const child = new FramedRpcChannel(a);
    const main = new FramedRpcChannel(b);
    main.on('read', (args) => {
      expect((args as { blockname: string }).blockname).toBe('other:public');
      return [{ id: 'x', name: 'other:public', children: [], content_text: 'hi', content_blob: null }];
    });
    const proxy = makeAppContextProxy(child, seed());

    const blocks = await proxy.read('other:public' as never);
    expect(blocks).toHaveLength(1);
    child.dispose();
    main.dispose();
  });

  it('emit frames {event,payload} to main (doorbell only)', async () => {
    const { a, b } = makePair();
    const child = new FramedRpcChannel(a);
    const main = new FramedRpcChannel(b);
    const got: unknown[] = [];
    main.on('emit', (args) => { got.push(args); return null; });
    const proxy = makeAppContextProxy(child, seed());

    proxy.emit('changed', { id: 1 });
    await new Promise((r) => setTimeout(r, 10));
    expect(got[0]).toEqual({ event: 'changed', payload: { id: 1 } });
    child.dispose();
    main.dispose();
  });

  it('list_commands/list_builders return seeded reflections locally (no frame)', () => {
    const { a } = makePair();
    const channel = new FramedRpcChannel(a);
    const cmd = { name: 'reply', version: '1', owner: 'system', app_id: 'evil' } as never;
    const proxy = makeAppContextProxy(channel, seed({ commands: [cmd] }));
    expect(proxy.list_commands()).toHaveLength(1);
    expect(proxy.list_builders()).toHaveLength(0);
    channel.dispose();
  });
});
