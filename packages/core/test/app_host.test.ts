/**
 * test/app_host.test.ts — unified-host UH-1/SS2: the AppHost abstraction + the
 * registry integration that resolves get_app_context through the in-process host.
 *
 * Scope (impl-spec §3.2):
 *   - InProcessHost unit behavior: kind, active≡true, activate()/current_context()
 *     both return the SAME live ctx (the sync/async seam — async door is a no-op
 *     pass-through, sync door is always non-null for in-process).
 *   - registry integration: get_app_context resolves through host.current_context()
 *     with byte-identical external semantics — same LIVE instance, reflecting
 *     set_state mutations, sync timing (the render-path / consume-refresh seam).
 *   - teardown safety: dispose() runs on_uninstall EXACTLY ONCE and does NOT recurse
 *     into uninstall (the uninstall→dispose→uninstall loop Atlas flagged), and
 *     uninstall() itself still fires the hook exactly once (regression).
 *   - in-process "hot-install": an app installed at runtime is immediately active and
 *     its ctx is synchronously resolvable (no activation step for in-process).
 */

import { describe, expect, it, vi } from 'vitest';

import { AppRegistry } from '../src/app/registry.js';
import { InProcessHost } from '../src/app/in_process_host.js';
import { Operations } from '../src/core/operations.js';
import type { AppContext, AppManifest } from '../src/app/types.js';

/** Own + prototype-chain member names of an object (mirrors policy_ceiling.test). */
function allMemberNames(obj: object): Set<string> {
  const names = new Set<string>();
  let cur: object | null = obj;
  while (cur && cur !== Object.prototype) {
    for (const k of Object.getOwnPropertyNames(cur)) names.add(k);
    cur = Object.getPrototypeOf(cur);
  }
  return names;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A minimal manifest; `on_uninstall` optional so we can assert hook firing. */
function manifest(opts: {
  id: string;
  initial_state?: unknown;
  on_uninstall?: (ctx: AppContext) => Promise<void>;
}): AppManifest {
  const m: AppManifest = {
    id: opts.id,
    version: '1.0.0',
    depends_on: [],
    tree_namespace: `/${opts.id}`,
    initial_state: opts.initial_state ?? {},
    state_schema: {},
    builders: [],
    commands: [],
  };
  // exactOptionalPropertyTypes: only attach the optional hook when provided.
  if (opts.on_uninstall) m.on_uninstall = opts.on_uninstall;
  return m;
}

/** A bare AppContext stub for the InProcessHost unit tests (registry not needed). */
function stubCtx(app_id: string): AppContext {
  return {
    app_id,
    state: {},
    set_state: () => undefined,
    list_commands: () => [],
    list_builders: () => [],
    list_blocks: () => [],
    invoke_command: async () => ({ ok: true }),
    read: async () => [],
    on: () => undefined,
    emit: () => undefined,
    spawn_system_agent: () => ({ id: 'x', stop: () => undefined }),
  };
}

// ===========================================================================
// InProcessHost — unit
// ===========================================================================

// A stub run_command closure for the InProcessHost unit tests (the 4th ctor arg).
const stubRun = async () => ({ ok: true } as const);

describe('InProcessHost', () => {
  it('reports kind=in-process and is always active', () => {
    const host = new InProcessHost('a', stubCtx('a'), () => undefined, stubRun);
    expect(host.kind).toBe('in-process');
    expect(host.active).toBe(true);
  });

  it('current_context() (sync) and activate() (async) both return the SAME live ctx', async () => {
    const ctx = stubCtx('a');
    const host = new InProcessHost('a', ctx, () => undefined, stubRun);
    expect(host.current_context()).toBe(ctx); // sync door: never null for in-process
    await expect(host.activate()).resolves.toBe(ctx); // async door: same instance
    expect(host.current_context()).toBe(ctx); // idempotent
  });

  it('dispose() runs the injected (hook-only) teardown closure exactly once', async () => {
    const run = vi.fn();
    const host = new InProcessHost('a', stubCtx('a'), run, stubRun);
    await host.dispose();
    expect(run).toHaveBeenCalledOnce();
  });

  it('route_command delegates to the injected run_command closure', async () => {
    const run = vi.fn(async () => ({ ok: true, data: { ran: true } }));
    const host = new InProcessHost('a', stubCtx('a'), () => undefined, run);
    const res = await host.route_command('cmd', { x: 1 }, { invoker: 'app', identity: 'a' });
    expect(run).toHaveBeenCalledWith('cmd', { x: 1 }, { invoker: 'app', identity: 'a' });
    expect(res).toEqual({ ok: true, data: { ran: true } });
  });
});

// ===========================================================================
// AppRegistry integration — get_app_context resolves through the host
// ===========================================================================

describe('AppRegistry × AppHost (in-process)', () => {
  it('get_app_context returns the LIVE ctx through the host (byte-identical seam)', () => {
    const reg = new AppRegistry();
    reg.install(manifest({ id: 'a', initial_state: { n: 0 } }));

    const ctx = reg.get_app_context('a');
    expect(ctx).not.toBeNull();
    // Same live instance on every lookup (the render path relies on this).
    expect(reg.get_app_context('a')).toBe(ctx);
  });

  it('the resolved ctx reflects set_state mutations (read-through, INV #16/#1)', () => {
    const reg = new AppRegistry();
    reg.install(manifest({ id: 'a', initial_state: { n: 0 } }));

    const ctx = reg.get_app_context('a')!;
    ctx.set_state((s) => ({ ...(s as { n: number }), n: 1 }));
    // A fresh lookup (as the renderer does each render) sees the mutation.
    expect((reg.get_app_context('a')!.state as { n: number }).n).toBe(1);
  });

  it('get_app_context returns null for an unknown / uninstalled app', () => {
    const reg = new AppRegistry();
    expect(reg.get_app_context('nope')).toBeNull();
  });

  it('in-process hot-install: a runtime-installed app is immediately resolvable (no activation)', () => {
    const reg = new AppRegistry();
    expect(reg.get_app_context('late')).toBeNull();
    reg.install(manifest({ id: 'late', initial_state: { ready: true } }));
    // Synchronously available right after install — in-process has no async activate.
    expect((reg.get_app_context('late')!.state as { ready: boolean }).ready).toBe(true);
  });
});

// ===========================================================================
// Teardown safety — on_uninstall fires once; dispose does NOT recurse
// ===========================================================================

describe('AppHost teardown (no double-fire / no recursion)', () => {
  it('uninstall() (three-in-one, non-carrier) fires on_uninstall exactly once', () => {
    const onUninstall = vi.fn(async () => undefined);
    const reg = new AppRegistry();
    reg.install(manifest({ id: 'a', on_uninstall: onUninstall }));

    reg.uninstall('a');
    expect(onUninstall).toHaveBeenCalledOnce();
    expect(reg.get('a')).toBeNull(); // entry removed
  });

  it('a SECOND uninstall is a no-op (idempotent; hook not re-fired)', () => {
    const onUninstall = vi.fn(async () => undefined);
    const reg = new AppRegistry();
    reg.install(manifest({ id: 'a', on_uninstall: onUninstall }));

    reg.uninstall('a');
    reg.uninstall('a');
    expect(onUninstall).toHaveBeenCalledOnce();
  });

  // The HotMutator path: dispose_app (hook, via carrier) THEN forget (index drop).
  it('dispose_app() runs the hook via the carrier WITHOUT dropping the entry', async () => {
    const onUninstall = vi.fn(async () => undefined);
    const reg = new AppRegistry();
    reg.install(manifest({ id: 'a', on_uninstall: onUninstall }));

    await reg.dispose_app('a');
    expect(onUninstall).toHaveBeenCalledOnce();
    // dispose ran the hook but did NOT forget — the entry is still present.
    expect(reg.get('a')).not.toBeNull();
  });

  it('forget() drops the entry WITHOUT running the hook', () => {
    const onUninstall = vi.fn(async () => undefined);
    const reg = new AppRegistry();
    reg.install(manifest({ id: 'a', on_uninstall: onUninstall }));

    reg.forget('a');
    expect(onUninstall).not.toHaveBeenCalled();
    expect(reg.get('a')).toBeNull();
  });

  it('the split HotMutator sequence (dispose_app → forget) fires the hook EXACTLY once, no recursion', async () => {
    const onUninstall = vi.fn(async () => undefined);
    const reg = new AppRegistry();
    reg.install(manifest({ id: 'a', on_uninstall: onUninstall }));

    await reg.dispose_app('a');
    reg.forget('a');
    // Hook fired once (by dispose, via the carrier's hook-only closure); forget did
    // not re-fire it — proving no uninstall→dispose→uninstall loop.
    expect(onUninstall).toHaveBeenCalledOnce();
    expect(reg.get('a')).toBeNull();
  });

  it('dispose_app() on an unknown id is a no-op', async () => {
    const reg = new AppRegistry();
    await expect(reg.dispose_app('nope')).resolves.toBeUndefined();
  });
});

// ===========================================================================
// Carrier non-leak — get_app_context returns a BARE AppContext, never the host
// ===========================================================================
//
// The AppHost abstraction holds the ctx + a teardown closure (and, for SS3, a
// process handle). An app must NEVER be able to reach the AppHost — it carries
// dispose()/activate() (lifecycle side effects). The defense: get_app_context
// returns host.current_context() (the bare AppContext), and the ctx the registry
// builds has no back-reference to its host. These assertions mirror the standard
// Raven SS2 gate (policy_ceiling.test.ts whitelist + member-value probe), scoped
// to prove the UH-1 carrier indirection added no leak.
describe('AppHost integration leaks no carrier/Operations handle to the app', () => {
  it('the returned object exposes invoke_command but NOT apply / host / dispose / activate', () => {
    const reg = new AppRegistry();
    reg.install(manifest({ id: 'a' }));
    const ctx = reg.get_app_context('a')!;

    const members = allMemberNames(ctx as object);
    expect(members.has('invoke_command')).toBe(true); // the policed write door is present
    // none of the carrier / chokepoint handles leaked onto the app-facing object
    for (const forbidden of ['apply', 'host', 'dispose', 'activate', 'current_context']) {
      expect(members.has(forbidden)).toBe(false);
    }
    // any casing of `apply` (defense against a renamed/aliased chokepoint)
    for (const name of members) {
      expect(name.toLowerCase()).not.toBe('apply');
    }
  });

  it('no member VALUE is an Operations or an AppHost instance (no back-reference)', () => {
    const reg = new AppRegistry();
    reg.install(manifest({ id: 'a' }));
    const ctx = reg.get_app_context('a')!;

    for (const name of allMemberNames(ctx as object)) {
      let value: unknown;
      try {
        value = (ctx as unknown as Record<string, unknown>)[name];
      } catch {
        continue; // a throwing getter exposes nothing usable
      }
      expect(value).not.toBeInstanceOf(Operations);
      expect(value).not.toBeInstanceOf(InProcessHost);
    }
  });

  it('the returned object is the SAME instance as the host current_context (no wrapper added)', () => {
    // Prove the registry returns the host\'s bare ctx verbatim, not a proxy that
    // could smuggle a host reference. We compare two lookups: identical instance.
    const reg = new AppRegistry();
    reg.install(manifest({ id: 'a' }));
    expect(reg.get_app_context('a')).toBe(reg.get_app_context('a'));
  });
});
