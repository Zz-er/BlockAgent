/**
 * test/rpc_channel.test.ts — unified-host UH-2/SS3a: RpcChannel unit tests.
 *
 * Exercises FramedRpcChannel against a PAIRED IN-MEMORY transport (no process) —
 * proving the channel is carrier-agnostic (SS3b plugs a child_process transport with
 * the same shape). Covers: req/reply round-trip both directions, handler errors,
 * per-call deadline reject, circuit-breaker degrade (immediate reject once dead), a
 * malformed/garbage peer not crashing us, a hung transport not hanging the caller,
 * dispose draining in-flight calls, and INV#18 by-value blob→handle serialization.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  FramedRpcChannel,
  RpcChannelDeadError,
  RpcDeadlineError,
  RpcSerializationError,
  toByValue,
  type RpcFrame,
  type Transport,
} from '../src/app/rpc/channel.js';
import type { Blob } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// paired in-memory transport — two ends that deliver frames to each other
// ---------------------------------------------------------------------------

interface Port extends Transport {
  /** Drop a peer: stop delivering inbound frames (simulates a wedged/dead carrier). */
  wedge(): void;
}

/** A bidirectional pair of transports; frames `send`-ed on A arrive at B and v.v. */
function makePair(): { a: Port; b: Port } {
  let aHandler: ((f: RpcFrame) => void) | null = null;
  let bHandler: ((f: RpcFrame) => void) | null = null;
  let aWedged = false;
  let bWedged = false;
  let aClosed = false;
  let bClosed = false;

  const a: Port = {
    send(frame) {
      if (aClosed) throw new Error('port a closed');
      // Deliver async (next microtask) to mimic real IPC ordering.
      if (!bWedged) queueMicrotask(() => bHandler?.(structuredClone(frame)));
    },
    onMessage(h) {
      aHandler = h;
    },
    close() {
      aClosed = true;
    },
    wedge() {
      bWedged = true; // frames from a no longer reach b
    },
  };
  const b: Port = {
    send(frame) {
      if (bClosed) throw new Error('port b closed');
      if (!aWedged) queueMicrotask(() => aHandler?.(structuredClone(frame)));
    },
    onMessage(h) {
      bHandler = h;
    },
    close() {
      bClosed = true;
    },
    wedge() {
      aWedged = true;
    },
  };
  return { a, b };
}

// ===========================================================================
// req / reply round-trip
// ===========================================================================

describe('FramedRpcChannel — request/reply', () => {
  it('round-trips a call to a peer handler and resolves with its return', async () => {
    const { a, b } = makePair();
    const client = new FramedRpcChannel(a);
    const server = new FramedRpcChannel(b);
    server.on('echo', (args) => ({ got: args }));

    await expect(client.call('echo', { x: 1 })).resolves.toEqual({ got: { x: 1 } });
    client.dispose();
    server.dispose();
  });

  it('is symmetric — the server end can call the client end', async () => {
    const { a, b } = makePair();
    const client = new FramedRpcChannel(a);
    const server = new FramedRpcChannel(b);
    client.on('ping', () => 'pong');

    await expect(server.call('ping', null)).resolves.toBe('pong');
    client.dispose();
    server.dispose();
  });

  it('a void handler return replies with null (not a hang)', async () => {
    const { a, b } = makePair();
    const client = new FramedRpcChannel(a);
    const server = new FramedRpcChannel(b);
    server.on('fire', () => undefined);

    await expect(client.call('fire', {})).resolves.toBeNull();
    client.dispose();
    server.dispose();
  });

  it('rejects with the peer handler error message', async () => {
    const { a, b } = makePair();
    const client = new FramedRpcChannel(a);
    const server = new FramedRpcChannel(b);
    server.on('boom', () => {
      throw new Error('handler exploded');
    });

    await expect(client.call('boom', {})).rejects.toThrow(/handler exploded/);
    client.dispose();
    server.dispose();
  });

  it('rejects when no peer handler is registered for the method', async () => {
    const { a, b } = makePair();
    const client = new FramedRpcChannel(a);
    const server = new FramedRpcChannel(b);
    void server;

    await expect(client.call('unknown', {})).rejects.toThrow(/no handler/);
    client.dispose();
    server.dispose();
  });
});

// ===========================================================================
// per-call deadline
// ===========================================================================

describe('FramedRpcChannel — per-call deadline', () => {
  it('rejects a slow call with RpcDeadlineError', async () => {
    const { a, b } = makePair();
    const client = new FramedRpcChannel(a, { default_deadline_ms: 20 });
    const server = new FramedRpcChannel(b);
    // Handler never replies (and we suppress the ack by not registering): the deadline
    // must fire. Register a handler that hangs forever.
    server.on('hang', () => new Promise<never>(() => {}));

    await expect(client.call('hang', {})).rejects.toBeInstanceOf(RpcDeadlineError);
    client.dispose();
    server.dispose();
  });

  it('honors a per-call deadline override', async () => {
    const { a, b } = makePair();
    const client = new FramedRpcChannel(a, { default_deadline_ms: 1000 });
    const server = new FramedRpcChannel(b);
    server.on('hang', () => new Promise<never>(() => {}));

    const start = Date.now();
    await expect(client.call('hang', {}, { deadline_ms: 15 })).rejects.toBeInstanceOf(
      RpcDeadlineError,
    );
    expect(Date.now() - start).toBeLessThan(500); // used the 15ms override, not 1000ms
    client.dispose();
    server.dispose();
  });
});

// ===========================================================================
// circuit breaker
// ===========================================================================

describe('FramedRpcChannel — circuit breaker', () => {
  it('trips to dead after consecutive deadline failures, then rejects immediately', async () => {
    const { a, b } = makePair();
    const client = new FramedRpcChannel(a, { default_deadline_ms: 10, breaker_threshold: 2 });
    const server = new FramedRpcChannel(b);
    server.on('hang', () => new Promise<never>(() => {}));

    await expect(client.call('hang', {})).rejects.toBeInstanceOf(RpcDeadlineError);
    await expect(client.call('hang', {})).rejects.toBeInstanceOf(RpcDeadlineError);
    expect(client.is_dead).toBe(true);

    // Now dead: a further call rejects IMMEDIATELY (degrade, no dispatch, no wait).
    const start = Date.now();
    await expect(client.call('hang', {})).rejects.toBeInstanceOf(RpcChannelDeadError);
    expect(Date.now() - start).toBeLessThan(5);
    client.dispose();
    server.dispose();
  });

  it('a clean reply resets the consecutive-failure count (no premature trip)', async () => {
    const { a, b } = makePair();
    const client = new FramedRpcChannel(a, { default_deadline_ms: 30, breaker_threshold: 2 });
    const server = new FramedRpcChannel(b);
    server.on('ok', () => 1);
    server.on('hang', () => new Promise<never>(() => {}));

    await expect(client.call('hang', {})).rejects.toBeInstanceOf(RpcDeadlineError); // failure 1
    await expect(client.call('ok', {})).resolves.toBe(1); // reset
    await expect(client.call('hang', {})).rejects.toBeInstanceOf(RpcDeadlineError); // failure 1 again
    expect(client.is_dead).toBe(false); // never reached 2 consecutive
    client.dispose();
    server.dispose();
  });
});

// ===========================================================================
// fault tolerance — bad peer / hung transport / dispose
// ===========================================================================

describe('FramedRpcChannel — fault tolerance', () => {
  it('a malformed inbound frame does not throw / crash the channel', async () => {
    // Capture the inbound sink so we can shove garbage straight at the channel.
    let inbound: ((f: RpcFrame) => void) | null = null;
    const sent: RpcFrame[] = [];
    const transport: Transport = {
      send(f) {
        sent.push(f);
      },
      onMessage(h) {
        inbound = h;
      },
      close() {},
    };
    const channel = new FramedRpcChannel(transport, { breaker_threshold: 100 });
    channel.on('ok', () => 'fine');

    // Garbage frames of various malformed shapes — none may throw out of onFrame.
    const garbage = [
      undefined,
      null,
      42,
      'not-a-frame',
      {},
      { t: 'bogus' },
      { t: 'reply', id: 999 }, // reply for an unknown id
      { t: 'ack', id: 999 }, // ack for an unknown id
    ];
    for (const g of garbage) {
      expect(() => inbound!(g as unknown as RpcFrame)).not.toThrow();
    }

    // The channel still serves a real inbound req after the garbage barrage.
    inbound!({ t: 'req', id: 7, method: 'ok', args: {} });
    await Promise.resolve();
    const reply = sent.find((f) => f.t === 'reply' && f.id === 7);
    expect(reply).toMatchObject({ t: 'reply', id: 7, ok: true, value: 'fine' });
    channel.dispose();
  });

  it('a wedged transport (peer never receives) times out, never hangs', async () => {
    const { a, b } = makePair();
    const client = new FramedRpcChannel(a, { default_deadline_ms: 20 });
    const server = new FramedRpcChannel(b);
    server.on('x', () => 1);

    a.wedge(); // frames from client no longer reach server → no reply ever
    await expect(client.call('x', {})).rejects.toBeInstanceOf(RpcDeadlineError);
    client.dispose();
    server.dispose();
  });

  it('a transport that throws on send fails the call + charges the breaker', async () => {
    let calls = 0;
    const throwing: Transport = {
      send() {
        calls += 1;
        throw new Error('carrier gone');
      },
      onMessage() {},
      close() {},
    };
    const client = new FramedRpcChannel(throwing, { breaker_threshold: 2 });
    await expect(client.call('x', {})).rejects.toThrow(/carrier gone/);
    await expect(client.call('x', {})).rejects.toThrow(/carrier gone/);
    expect(client.is_dead).toBe(true);
    await expect(client.call('x', {})).rejects.toBeInstanceOf(RpcChannelDeadError);
    expect(calls).toBe(2); // dead channel did not even attempt a 3rd send
  });

  it('dispose() rejects all in-flight calls (no dangling promises)', async () => {
    const { a, b } = makePair();
    const client = new FramedRpcChannel(a, { default_deadline_ms: 1000 });
    const server = new FramedRpcChannel(b);
    server.on('hang', () => new Promise<never>(() => {}));

    const inflight = client.call('hang', {});
    client.dispose();
    await expect(inflight).rejects.toBeInstanceOf(RpcChannelDeadError);
    server.dispose();
  });
});

// ===========================================================================
// INV#18 by-value serialization — blob → blob://<sha256> handle
// ===========================================================================

describe('toByValue — INV#18 by-value + blob handle', () => {
  it('replaces inline blob bytes with a blob://<sha256> handle', () => {
    const blob: Blob = { data: 'AAAA-inline-base64', mime_type: 'image/png', filename: 'x.png' };
    const out = toByValue({ b: blob }) as { b: Blob };
    expect(out.b.data).toMatch(/^blob:\/\/[0-9a-f]{64}$/);
    expect(out.b.mime_type).toBe('image/png');
    expect(out.b.filename).toBe('x.png');
    // deterministic: same bytes → same handle
    expect((toByValue({ b: blob }) as { b: Blob }).b.data).toBe(out.b.data);
  });

  it('passes an already-blob:// handle through unchanged', () => {
    const handle = `blob://${'a'.repeat(64)}`;
    const blob: Blob = { data: handle, mime_type: 'image/png' };
    expect((toByValue(blob) as Blob).data).toBe(handle);
  });

  it('deep-copies so the wire value is decoupled from the source', () => {
    const src = { nested: { arr: [1, 2, 3] } };
    const out = toByValue(src) as typeof src;
    expect(out).toEqual(src);
    expect(out.nested).not.toBe(src.nested);
    expect(out.nested.arr).not.toBe(src.nested.arr);
  });

  it('drops undefined properties (JSON semantics) and rejects functions / cycles', () => {
    expect(toByValue({ a: 1, b: undefined })).toEqual({ a: 1 });
    expect(() => toByValue({ f: () => 1 })).toThrow(RpcSerializationError);
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => toByValue(cyc)).toThrow(RpcSerializationError);
  });

  it('a non-serializable arg rejects the call synchronously (breaker not charged)', async () => {
    const { a, b } = makePair();
    const client = new FramedRpcChannel(a, { breaker_threshold: 1 });
    const server = new FramedRpcChannel(b);
    void server;

    await expect(client.call('x', { f: () => 1 })).rejects.toBeInstanceOf(RpcSerializationError);
    expect(client.is_dead).toBe(false); // a caller's bad arg must not trip the breaker
    client.dispose();
    server.dispose();
  });

  it('blobs in call args travel as handles (args direction, team-lead)', async () => {
    const { a, b } = makePair();
    const client = new FramedRpcChannel(a);
    const server = new FramedRpcChannel(b);
    let received: unknown;
    server.on('store', (args) => {
      received = args;
      return 'ok';
    });

    const blob: Blob = { data: 'inline-bytes-here', mime_type: 'audio/mp3' };
    await client.call('store', { blob });
    expect((received as { blob: Blob }).blob.data).toMatch(/^blob:\/\/[0-9a-f]{64}$/);
    client.dispose();
    server.dispose();
  });
});
