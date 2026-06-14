/**
 * server/test/health.test.ts — the poll-able liveness/progress probe (D6 §8 seam 3).
 *
 * `serve()` exposes `GET /health` on the SAME port as the WS server, returning the runtime's
 * `{state, wake_seq, turn_index}`. A supervisor polls it for liveness: a fresh wake bumps
 * `wake_seq`, a live turn advances `turn_index`, so `running` with a frozen `wake_seq` over N
 * polls is the unambiguous wedged-turn signal. These tests drive the real HTTP route over a
 * mock-provider serve() on an OS-assigned port.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { serve, type RunningServer } from '@block-agent/server/serve.js';
import type { HealthSnapshot } from '@block-agent/server/session_host.js';

import { mockConfig } from './_support.js';

let cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function startServed(): Promise<RunningServer> {
  const server = await serve(mockConfig(), { port: 0 });
  cleanup.push(() => server.close());
  return server;
}

/** Fetch + parse the /health JSON body on a port. */
async function getHealth(port: number): Promise<{ status: number; body: HealthSnapshot }> {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const body = (await res.json()) as HealthSnapshot;
  return { status: res.status, body };
}

describe('GET /health — liveness/progress probe', () => {
  it('returns {state, wake_seq, turn_index} as JSON on the serve() port', async () => {
    const server = await startServed();
    const { status, body } = await getHealth(server.port);

    expect(status).toBe(200);
    // Fresh boot, no wake yet: idle, zero counters.
    expect(body.state).toBe('idle');
    expect(body.wake_seq).toBe(0);
    expect(body.turn_index).toBe(0);
  });

  it('wake_seq advances after a submit drives a turn (progress is observable)', async () => {
    const server = await startServed();

    // Drive one turn through the host (mock replies once, then idles).
    await server.host.handle({ kind: 'submit', v: '0', text: 'hi' }, () => {});

    const { body } = await getHealth(server.port);
    expect(body.state).toBe('idle'); // settled back to idle after the reply
    expect(body.wake_seq).toBeGreaterThanOrEqual(1); // the wake was counted
  });

  it('matches SessionHost.health() (the HTTP route reads the same snapshot)', async () => {
    const server = await startServed();
    const direct = server.host.health();
    const { body } = await getHealth(server.port);
    expect(body).toEqual(direct);
  });

  it('a non-/health path 404s without dropping the server', async () => {
    const server = await startServed();
    const res = await fetch(`http://127.0.0.1:${server.port}/nope`);
    expect(res.status).toBe(404);
    // The /health route still works afterwards.
    const { status } = await getHealth(server.port);
    expect(status).toBe(200);
  });
});
