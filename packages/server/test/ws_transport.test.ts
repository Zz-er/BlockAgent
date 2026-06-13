/**
 * server/test/ws_transport.test.ts — drive the SessionHost over a real ws loopback.
 *
 * Starts the WS transport on an OS-assigned port, connects a `ws` client, and asserts the
 * frame round-trip end to end: hello → capabilities, submit → turn stream, query → context.
 * Each frame is one JSON text frame both ways.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { launch } from '@block-agent/cli/launch.js';
import type { LaunchedAgent } from '@block-agent/cli/types.js';
import { SessionHost } from '@block-agent/server/session_host.js';
import { startWsTransport, type WsTransport } from '@block-agent/server/ws_transport.js';
import type { InboundFrame, OutboundFrame } from '@block-agent/protocol/index.js';

import { mockConfig } from './_support.js';

let cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function startServer(): Promise<{ transport: WsTransport; host: SessionHost; agent: LaunchedAgent }> {
  const agent = await launch(mockConfig());
  const host = new SessionHost(agent);
  const transport = await startWsTransport(host, { port: 0 });
  cleanup.push(() => transport.close(), () => host.close());
  return { transport, host, agent };
}

/** Open a client, collecting every received frame; resolves once OPEN. */
async function openClient(port: number): Promise<{
  ws: WebSocket;
  frames: OutboundFrame[];
  send: (frame: InboundFrame) => void;
  waitFor: (kind: OutboundFrame['kind'], timeoutMs?: number) => Promise<OutboundFrame>;
}> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames: OutboundFrame[] = [];
  const waiters: Array<{ kind: OutboundFrame['kind']; resolve: (f: OutboundFrame) => void }> = [];

  ws.on('message', (raw: Buffer) => {
    const frame = JSON.parse(raw.toString()) as OutboundFrame;
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i]!.kind === frame.kind) {
        waiters[i]!.resolve(frame);
        waiters.splice(i, 1);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  cleanup.push(() => ws.close());

  return {
    ws,
    frames,
    send: (frame: InboundFrame) => ws.send(JSON.stringify(frame)),
    waitFor: (kind, timeoutMs = 4000) =>
      new Promise<OutboundFrame>((resolve, reject) => {
        const existing = frames.find((f) => f.kind === kind);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${kind}`)), timeoutMs);
        waiters.push({
          kind,
          resolve: (f) => {
            clearTimeout(timer);
            resolve(f);
          },
        });
      }),
  };
}

describe('WS transport — frame round-trip end to end', () => {
  it('hello → capabilities', async () => {
    const { transport } = await startServer();
    const client = await openClient(transport.port);

    client.send({ kind: 'hello', v: '0', client: 'ws-test', understands: ['turn'] });
    const caps = await client.waitFor('capabilities');
    expect(caps.kind).toBe('capabilities');
    if (caps.kind === 'capabilities') expect(caps.model).toBe('mock');
  });

  it('submit → turn stream over the socket', async () => {
    const { transport } = await startServer();
    const client = await openClient(transport.port);

    client.send({ kind: 'submit', v: '0', text: 'hi over ws' });
    const turn = await client.waitFor('turn');
    expect(turn.kind).toBe('turn');
    if (turn.kind === 'turn') expect(typeof turn.ts).toBe('string');
  });

  it('query → context response with the echoed request_id', async () => {
    const { transport } = await startServer();
    const client = await openClient(transport.port);

    client.send({ kind: 'query', v: '0', request_id: 'q-ws', target: 'context' });
    const ctx = await client.waitFor('context');
    if (ctx.kind === 'context') {
      expect(ctx.request_id).toBe('q-ws');
      expect(ctx.scope).toBe('summary');
    }
  });

  it('a malformed frame gets a benign error, not a dropped connection', async () => {
    const { transport } = await startServer();
    const client = await openClient(transport.port);

    client.ws.send('not json at all');
    const err = await client.waitFor('error');
    expect(err.kind).toBe('error');
    if (err.kind === 'error') expect(err.message).toMatch(/malformed JSON/);
    // Connection still works afterwards.
    client.send({ kind: 'hello', v: '0', client: 'x', understands: [] });
    const caps = await client.waitFor('capabilities');
    expect(caps.kind).toBe('capabilities');
  });
});
