/**
 * test/child_process_transport.test.ts — unified-host UH-2/SS3b: the child_process
 * Transport unit tests (no real process — a fake duplex). Focus: the channel ⟂ transport
 * responsibility split (Raven SS3a forward-finding #2) — the INBOUND size/depth caps live
 * here, so a hostile peer cannot flood a huge/deep frame into the channel (memory DoS).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  parentTransport,
  childTransport,
  DEFAULT_LIMITS,
  type ChildProcessLike,
  type ProcessLike,
} from '../src/app/rpc/child_process_transport.js';
import type { RpcFrame } from '../src/app/rpc/channel.js';

function fakeChild() {
  let onMsg: ((m: unknown) => void) | null = null;
  const sent: unknown[] = [];
  const child: ChildProcessLike = {
    send: (m) => (sent.push(m), true),
    on(event: string, l: (a: never) => void) {
      if (event === 'message') onMsg = l as (m: unknown) => void;
      return child;
    },
  };
  return { child, sent, deliver: (m: unknown) => onMsg?.(m) };
}

describe('parentTransport — send + inbound delivery', () => {
  it('send hands the frame to child.send; inbound valid frames reach the handler', () => {
    const fc = fakeChild();
    const t = parentTransport(fc.child);
    const received: RpcFrame[] = [];
    t.onMessage((f) => received.push(f));

    t.send({ t: 'req', id: 1, method: 'm', args: { ok: 1 } });
    expect(fc.sent[0]).toMatchObject({ t: 'req', id: 1, method: 'm' });

    fc.deliver({ t: 'reply', id: 1, ok: true, value: 42 });
    expect(received).toEqual([{ t: 'reply', id: 1, ok: true, value: 42 }]);
  });

  it('drops non-frame garbage inbound (no throw, not delivered)', () => {
    const fc = fakeChild();
    const t = parentTransport(fc.child);
    const received: RpcFrame[] = [];
    t.onMessage((f) => received.push(f));

    for (const g of [null, undefined, 42, 'x', {}, { t: 123 }, []]) {
      expect(() => fc.deliver(g)).not.toThrow();
    }
    expect(received).toHaveLength(0); // none were valid frames
  });
});

describe('parentTransport — inbound size/depth caps (Raven ff#2, channel ⟂ transport)', () => {
  it('DROPS an over-size inbound frame (let the channel deadline degrade, no OOM)', () => {
    const fc = fakeChild();
    const t = parentTransport(fc.child, { max_frame_bytes: 100, max_frame_depth: 64 });
    const received: RpcFrame[] = [];
    t.onMessage((f) => received.push(f));

    // a valid frame shape but huge value → over the 100-byte cap → dropped.
    fc.deliver({ t: 'reply', id: 1, ok: true, value: 'x'.repeat(500) });
    expect(received).toHaveLength(0);

    // a small frame still passes.
    fc.deliver({ t: 'reply', id: 2, ok: true, value: 'ok' });
    expect(received).toHaveLength(1);
  });

  it('DROPS an over-depth inbound frame (deep-nesting bomb)', () => {
    const fc = fakeChild();
    const t = parentTransport(fc.child, { max_frame_bytes: 1_000_000, max_frame_depth: 5 });
    const received: RpcFrame[] = [];
    t.onMessage((f) => received.push(f));

    // build a value nested deeper than the depth cap.
    let deep: unknown = 0;
    for (let i = 0; i < 20; i++) deep = { d: deep };
    fc.deliver({ t: 'reply', id: 1, ok: true, value: deep });
    expect(received).toHaveLength(0); // dropped, no stack/memory blow-up

    fc.deliver({ t: 'reply', id: 2, ok: true, value: { shallow: true } });
    expect(received).toHaveLength(1);
  });

  it('exposes sane defaults (1MB / depth 64)', () => {
    expect(DEFAULT_LIMITS.max_frame_bytes).toBe(1_000_000);
    expect(DEFAULT_LIMITS.max_frame_depth).toBe(64);
  });
});

describe('childTransport — over the child process IPC', () => {
  it('throws on send when the process has no IPC channel (not forked with ipc)', () => {
    const proc = { on: vi.fn() } as unknown as ProcessLike; // no `send`
    const t = childTransport(proc);
    expect(() => t.send({ t: 'ack', id: 1 })).toThrow(/no IPC channel/);
  });

  it('sends via process.send and bounds inbound frames', () => {
    const holder: { onMsg: (m: unknown) => void } = { onMsg: () => undefined };
    const sent: unknown[] = [];
    const proc: ProcessLike = {
      send: (m) => (sent.push(m), true),
      on(_e, l) {
        holder.onMsg = l as (m: unknown) => void;
        return undefined as unknown;
      },
    };
    const t = childTransport(proc, { max_frame_bytes: 100, max_frame_depth: 64 });
    const received: RpcFrame[] = [];
    t.onMessage((f) => received.push(f));

    t.send({ t: 'ack', id: 1 });
    expect(sent[0]).toMatchObject({ t: 'ack', id: 1 });

    holder.onMsg({ t: 'req', id: 1, method: 'm', args: 'x'.repeat(500) }); // over cap → dropped
    holder.onMsg({ t: 'req', id: 2, method: 'm', args: 'ok' });
    expect(received.map((f) => (f as { id: number }).id)).toEqual([2]);
  });
});
