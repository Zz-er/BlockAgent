/**
 * test/fixtures/sandbox_app.ts — a minimal SANDBOXED app fixture for the SS3c real
 * tsx-fork e2e. The ChildProcessHost forks `app/child/main.ts`, which imports THIS file
 * (pkg_path → here) and calls `createManifest()` to get the AppManifest, then runs its
 * command handlers IN THE CHILD over the AppContextProxy.
 *
 * Commands exercise the cross-process security paths:
 *   - `bump`           : ctx.set_state (frames the next state to the main cell, 补强①)
 *   - `relay_hard`     : ctx.invoke_command('trustedb.hard') — a cross-app call to a
 *                        TRUSTED app's destructive command. The main-side callback frame
 *                        handler re-establishes the sandboxed taint chain, so the
 *                        last hop is DENIED (cross-process taint two-hop deny).
 *   - `relay_ok`       : ctx.invoke_command('trustedb.noop') — benign cross-app call (C2:
 *                        cross-app allowed, just capability-tightened) → allowed.
 *   - `read_other`     : ctx.read('trustedb:public') — cross-app read (deep copies).
 *   - `noop`           : returns ok (a control).
 *
 * This file runs IN THE CHILD process — it never holds the tree/Operations/main env.
 */

import type { AppManifest } from '../../src/app/types.js';

interface State {
  n: number;
}

export function createManifest(): AppManifest<State> {
  return {
    id: 'sbx',
    version: '0.0.0',
    depends_on: [],
    tree_namespace: '/sbx',
    initial_state: { n: 0 },
    state_schema: {},
    trust: 'sandboxed',
    builders: [],
    commands: [
      () => ({
        name: 'bump',
        description: 'set_state +1 (frames next state to the main cell)',
        capabilities: [{ name: 'block:write' }],
        invoke: async (_args, ctx) => {
          ctx.set_state((s) => ({ n: (s as State).n + 1 }));
          return { ok: true, data: { n: (ctx.state as State).n } };
        },
      }),
      () => ({
        name: 'relay_hard',
        description: 'cross-app call to a trusted app destructive command (taint two-hop)',
        capabilities: [{ name: 'block:write' }],
        invoke: async (_args, ctx) => {
          const r = await ctx.invoke_command('trustedb.hard', {});
          return { ok: r.ok, data: r.data };
        },
      }),
      () => ({
        name: 'relay_ok',
        description: 'benign cross-app call (C2: allowed)',
        capabilities: [{ name: 'block:write' }],
        invoke: async (_args, ctx) => {
          const r = await ctx.invoke_command('trustedb.noop', {});
          return { ok: r.ok, data: r.data };
        },
      }),
      () => ({
        name: 'read_other',
        description: 'cross-app read (deep copies across the boundary)',
        capabilities: [{ name: 'block:write' }],
        invoke: async (_args, ctx) => {
          const blocks = await ctx.read('trustedb:public' as never);
          return { ok: true, data: { count: blocks.length } };
        },
      }),
      () => ({
        name: 'noop',
        description: 'control',
        capabilities: [{ name: 'block:write' }],
        invoke: async () => ({ ok: true }),
      }),
    ],
  };
}
