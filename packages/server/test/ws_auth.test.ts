/**
 * server/test/ws_auth.test.ts — the fail-closed non-loopback bind guard + the auth membrane
 * forward seam (D2 §4.3). The host stamps invoker:'user' by default — sound ONLY for a
 * trusted local connection — so the WS transport refuses a non-loopback bind without an
 * `authenticate` hook, and when a hook IS provided it stamps from the hook's return.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { launch } from '@block-agent/cli/launch.js';
import type { LaunchedAgent } from '@block-agent/cli/types.js';
import { SessionHost } from '@block-agent/server/session_host.js';
import { startWsTransport, type WsTransport } from '@block-agent/server/ws_transport.js';

import { mockConfig } from './_support.js';

let cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function makeHost(): Promise<SessionHost> {
  const agent: LaunchedAgent = await launch(mockConfig());
  const host = new SessionHost(agent);
  cleanup.push(() => host.close());
  return host;
}

describe('WS bind guard — fail closed on non-loopback without auth', () => {
  it('THROWS on a non-loopback bind when no authenticate hook is given', async () => {
    const host = await makeHost();
    // Synchronous throw (before bind) — assert it rejects with the §4.3 message.
    expect(() => startWsTransport(host, { port: 0, host: '0.0.0.0' })).toThrow(/non-loopback/i);
  });

  it('allows a loopback bind with no auth hook (the v0 local default)', async () => {
    const host = await makeHost();
    const transport: WsTransport = await startWsTransport(host, { port: 0, host: '127.0.0.1' });
    cleanup.push(() => transport.close());
    expect(transport.port).toBeGreaterThan(0);
  });

  it('allows a non-loopback bind WHEN an authenticate hook is provided', async () => {
    const host = await makeHost();
    const transport = await startWsTransport(host, {
      port: 0,
      host: '0.0.0.0',
      authenticate: () => ({ invoker: 'app', identity: 'ext:test' }),
    });
    cleanup.push(() => transport.close());
    expect(transport.port).toBeGreaterThan(0);
  });
});

describe('WS auth membrane — stamps invoker from the hook, never from the wire', () => {
  it('stamps the hook-returned invoker on submit (foreign → app), not user', async () => {
    const host = await makeHost();
    const agent = host.launched;
    // Spy the chokepoint to see what invoker the host stamps on the ingest.
    const calls: Array<{ full: string; ctx: { invoker?: string; identity?: string } }> = [];
    const orig = agent.operations.invoke_command.bind(agent.operations);
    agent.operations.invoke_command = (async (full: string, args: unknown, ctx: unknown) => {
      calls.push({ full, ctx: ctx as { invoker?: string; identity?: string } });
      return orig(full, args as never, ctx as never);
    }) as typeof agent.operations.invoke_command;

    const transport = await startWsTransport(host, {
      port: 0,
      host: '127.0.0.1',
      authenticate: () => ({ invoker: 'app', identity: 'ext:remote' }),
    });
    cleanup.push(() => transport.close());

    const ws = new WebSocket(`ws://127.0.0.1:${transport.port}`);
    cleanup.push(() => ws.close());
    await new Promise<void>((res, rej) => {
      ws.on('open', () => res());
      ws.on('error', rej);
    });
    ws.send(JSON.stringify({ kind: 'submit', v: '0', text: 'from a foreign driver' }));

    // Wait until the ingest call lands.
    await new Promise<void>((res) => {
      const t = setInterval(() => {
        if (calls.some((c) => c.full === 'messages.ingest')) {
          clearInterval(t);
          res();
        }
      }, 20);
    });

    const ingest = calls.find((c) => c.full === 'messages.ingest')!;
    expect(ingest.ctx.invoker).toBe('app');
    expect(ingest.ctx.identity).toBe('ext:remote');
  });

  it('rejects (closes) a connection whose authenticate returns null', async () => {
    const host = await makeHost();
    const transport = await startWsTransport(host, {
      port: 0,
      host: '127.0.0.1',
      authenticate: () => null,
    });
    cleanup.push(() => transport.close());

    const ws = new WebSocket(`ws://127.0.0.1:${transport.port}`);
    cleanup.push(() => ws.close());

    const closeCode = await new Promise<number>((res, rej) => {
      ws.on('close', (code: number) => res(code));
      ws.on('error', rej);
    });
    expect(closeCode).toBe(1008);
  });
});
