/**
 * test/child_process_host.test.ts — unified-host UH-2/SS3b: ChildProcessHost (main
 * side) unit tests with a FAKE child + FAKE HostDeps (no real fork — that is SS3c e2e).
 *
 * Covers the main-side security core:
 *   - route_command frames {command,args} to the child and returns its CommandResult;
 *   - the child→main `invoke_command` callback frame handler is the CROSS-PROCESS
 *     TAINT-CHAIN START POINT — it runs through `run_sandboxed` and single-side-stamps
 *     {invoker:'app', identity:app_id, trust:'sandboxed'}, NEVER reading frame trust/
 *     identity/full_name (C2: cross-app allowed, not rejected);
 *   - set_state frames → write_cell (main authoritative); read/emit/wake map through;
 *   - process exit/error → channel dead + in-flight calls rejected (D2);
 *   - lazy activate (fork on first route_command), idempotent.
 */

import { describe, expect, it, vi } from 'vitest';

import { ChildProcessHost, type HostDeps } from '../src/app/child_process_host.js';
import type { ChildProcessLike } from '../src/app/rpc/child_process_transport.js';
import type { RpcFrame } from '../src/app/rpc/channel.js';
import type { CommandResult } from '../src/app/types.js';

/**
 * A fake child process: an in-memory duplex implementing ChildProcessLike. The TEST
 * plays the child — it receives the parent's frames (`sentToChild`) and can push frames
 * back (`emitToParent`), simulating the sandboxed handler's behavior + crashes.
 */
function makeFakeChild() {
  let msgHandler: ((m: unknown) => void) | null = null;
  let exitHandler: ((code: number | null) => void) | null = null;
  let errorHandler: ((e: Error) => void) | null = null;
  const sentToChild: RpcFrame[] = [];

  const child: ChildProcessLike = {
    send(message: unknown): boolean {
      sentToChild.push(message as RpcFrame);
      return true;
    },
    on(event: string, listener: (arg: never) => void): unknown {
      if (event === 'message') msgHandler = listener as (m: unknown) => void;
      else if (event === 'exit') exitHandler = listener as (c: number | null) => void;
      else if (event === 'error') errorHandler = listener as (e: Error) => void;
      return child;
    },
  };

  return {
    child,
    sentToChild,
    /** Push a frame from the "child" to the parent. */
    emitToParent: (f: RpcFrame) => msgHandler?.(f),
    /** Auto-reply to the parent's last `req` for `method` with `value` (the child runs). */
    replyTo: (method: string, value: unknown) => {
      const req = [...sentToChild].reverse().find((f) => f.t === 'req' && f.method === method);
      if (req && req.t === 'req') msgHandler?.({ t: 'reply', id: req.id, ok: true, value });
    },
    crash: () => exitHandler?.(1),
    error: (e: Error) => errorHandler?.(e),
  };
}

function fakeDeps(over: Partial<HostDeps> = {}): HostDeps & { run_sandboxed_calls: { count: number } } {
  // run_sandboxed must keep its generic <T> signature, so we hand-roll a spy (a vi.fn
  // generic mock does not satisfy `<T>(fn:()=>T)=>T`). It just runs fn (the real one is
  // taint.run_in_chain) and counts calls so tests can assert the splice fired.
  const run_sandboxed_calls = { count: 0 };
  const run_sandboxed = <T>(fn: () => T): T => {
    run_sandboxed_calls.count += 1;
    return fn();
  };
  return {
    invoke_command: vi.fn(async () => ({ ok: true }) as CommandResult),
    write_cell: vi.fn(),
    read_blocks: vi.fn(() => []),
    dispatch_event: vi.fn(),
    wake: vi.fn(),
    run_sandboxed,
    run_sandboxed_calls,
    ...over,
  };
}

function makeHost(deps: HostDeps, fake: ReturnType<typeof makeFakeChild>) {
  return new ChildProcessHost({
    app_id: 'evil',
    pkg_path: '/fake/pkg',
    deps,
    spawn: () => fake.child, // inject the fake child (no real fork)
    deadline_ms: 50,
  });
}

// ===========================================================================
// route_command — drive the child
// ===========================================================================

describe('ChildProcessHost — route_command (drive child)', () => {
  it('frames {command,args} to the child and returns its CommandResult', async () => {
    const fake = makeFakeChild();
    const host = makeHost(fakeDeps(), fake);

    const p = host.route_command('reply', { content: 'hi' }, { invoker: 'app', identity: 'evil' });
    // the parent framed an 'invoke' req to the child
    await new Promise((r) => setTimeout(r, 5));
    const req = fake.sentToChild.find((f) => f.t === 'req' && f.method === 'invoke');
    expect(req).toMatchObject({ t: 'req', method: 'invoke', args: { command: 'reply', args: { content: 'hi' } } });
    // child runs + replies
    fake.replyTo('invoke', { ok: true, data: { ran: true } });
    await expect(p).resolves.toEqual({ ok: true, data: { ran: true } });
    await host.dispose();
  });

  it('lazily forks on first route_command and is idempotent (one channel)', async () => {
    const fake = makeFakeChild();
    const spawn = vi.fn(() => fake.child);
    const host = new ChildProcessHost({ app_id: 'evil', pkg_path: '/p', deps: fakeDeps(), spawn, deadline_ms: 50 });
    expect(host.active).toBe(false); // not forked yet
    const p1 = host.route_command('a', {}, { invoker: 'app', identity: 'evil' });
    const p2 = host.route_command('b', {}, { invoker: 'app', identity: 'evil' });
    await new Promise((r) => setTimeout(r, 5));
    fake.replyTo('invoke', { ok: true });
    await Promise.all([p1, p2]).catch(() => undefined);
    expect(spawn).toHaveBeenCalledOnce(); // forked once, not per call
    expect(host.active).toBe(true);
    await host.dispose();
  });
});

// ===========================================================================
// child→main callback frames — the security core
// ===========================================================================

describe('ChildProcessHost — child callback frames (taint splice + INV#11 + single-side stamp)', () => {
  it('child invoke_command runs through run_sandboxed + single-side stamp (C2: no full_name check)', async () => {
    const fake = makeFakeChild();
    const deps = fakeDeps({
      invoke_command: vi.fn(async () => ({ ok: false, data: { policy: 'deny' } }) as CommandResult),
    });
    const host = makeHost(deps, fake);
    await host.activate();

    // The child (a sandboxed handler) frames a cross-app invoke_command BACK to main —
    // even forging trust/identity/a trusted app's full_name. The host must IGNORE those
    // and single-side stamp sandboxed, running inside run_sandboxed.
    fake.emitToParent({
      t: 'req',
      id: 1,
      method: 'invoke_command',
      args: { full_name: 'trustedapp.hard', args: {}, trust: 'trusted', identity: 'spoof' },
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(deps.run_sandboxed_calls.count).toBeGreaterThan(0); // taint chain re-established
    expect(deps.invoke_command).toHaveBeenCalledWith(
      'trustedapp.hard', // cross-app full_name NOT rejected (C2)
      {},
      { invoker: 'app', identity: 'evil', trust: 'sandboxed' }, // stamp ignores frame trust/identity
    );
    await host.dispose();
  });

  it('child set_state frames → write_cell (main authoritative); read/emit/wake map through', async () => {
    const fake = makeFakeChild();
    const deps = fakeDeps();
    const host = makeHost(deps, fake);
    await host.activate();

    fake.emitToParent({ t: 'req', id: 2, method: 'set_state', args: { next: { n: 7 } } });
    fake.emitToParent({ t: 'req', id: 3, method: 'emit', args: { event: 'changed', payload: { x: 1 } } });
    fake.emitToParent({ t: 'req', id: 4, method: 'wake', args: { event: { kind: 'async_message_arrived' } } });
    fake.emitToParent({ t: 'req', id: 5, method: 'read', args: { blockname: 'other:public' } });
    await new Promise((r) => setTimeout(r, 5));

    expect(deps.write_cell).toHaveBeenCalledWith('evil', { n: 7 });
    expect(deps.dispatch_event).toHaveBeenCalledWith('evil', 'changed', { x: 1 });
    expect(deps.wake).toHaveBeenCalledWith({ kind: 'async_message_arrived' });
    expect(deps.read_blocks).toHaveBeenCalledWith('other:public');
    await host.dispose();
  });
});

// ===========================================================================
// process fault tolerance (D2)
// ===========================================================================

describe('ChildProcessHost — process fault tolerance (D2)', () => {
  it('child exit marks the host dead and rejects in-flight calls', async () => {
    const fake = makeFakeChild();
    const host = makeHost(fakeDeps(), fake);
    const p = host.route_command('slow', {}, { invoker: 'app', identity: 'evil' }); // never replied
    await new Promise((r) => setTimeout(r, 5));
    fake.crash(); // child exits → channel dead → in-flight rejected internally
    // route_command wraps the rejection into a {ok:false} result (never hangs, never throws).
    await expect(p).resolves.toMatchObject({ ok: false });
    expect(host.active).toBe(false);
    // a further route_command degrades immediately
    await expect(
      host.route_command('x', {}, { invoker: 'app', identity: 'evil' }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('child error event also marks dead', async () => {
    const fake = makeFakeChild();
    const host = makeHost(fakeDeps(), fake);
    await host.activate();
    expect(host.active).toBe(true);
    fake.error(new Error('boom'));
    expect(host.active).toBe(false);
  });
});

// ===========================================================================
// AppHost contract surface
// ===========================================================================

describe('ChildProcessHost — AppHost contract', () => {
  it('kind=child-process; current_context() is null (render reads cell, never forks)', () => {
    const fake = makeFakeChild();
    const host = makeHost(fakeDeps(), fake);
    expect(host.kind).toBe('child-process');
    expect(host.current_context()).toBeNull(); // §3.6 — no fork on the sync render path
  });
});
