/**
 * app/in_process_host.ts — unified-host UH-1: the in-process AppHost (impl-spec §3.2).
 *
 * The trusted, zero-overhead carrier: the app's command/state code runs directly in
 * the runtime, so its AppContext is a direct reference — exactly today's behavior.
 * This host is a thin wrapper that re-exposes the live ctx the registry already
 * constructs at install (AppRegistry.instantiate → makeContext), so wrapping it
 * changes NO semantics: same instance, same read-through `state` getter, same
 * synchronous availability (impl-spec §3.2: "InProcessHost.active 恒 true").
 *
 * Sync/async seam (see app_host.ts header): because the ctx exists eagerly from
 * install, `current_context()` is always non-null and `activate()` resolves
 * immediately with that same ctx — so the synchronous render path is unchanged and
 * the async door is a no-op pass-through. This is the in-process degenerate case of
 * impl-spec §3.6 ("consume 读 cell 不触发激活").
 *
 * PURE module wrt the core closure: no fs/clock/random/env; only type + the AppHost
 * contract. (CI core-closure.)
 */

import type { AppContext } from './types.js';
import type { AppHost } from './app_host.js';

export class InProcessHost implements AppHost {
  readonly kind = 'in-process' as const;

  /**
   * @param app_id  installed app id (registry key).
   * @param ctx     the LIVE AppContext the registry built at install — the SAME
   *                instance handed to commands/lifecycle hooks. Held by reference,
   *                never copied (its `state` is a read-through getter over the app's
   *                mutable cell; INV#16 builders only read).
   * @param run_uninstall  injected closure that runs ONLY the app's `on_uninstall`
   *                hook (the registry's `runUninstallHook`, registry.ts) — NOT the
   *                full `uninstall` (which also drops the index + deletes the entry).
   *                Hook-only is deliberate: it lets `dispose()` be safely routed onto
   *                the teardown path without recursing back into `uninstall`
   *                (uninstall→dispose→uninstall); the index drop / entry removal stay
   *                the registry's / HotMutator's job, run AFTER dispose.
   */
  constructor(
    readonly app_id: string,
    private readonly ctx: AppContext,
    private readonly run_uninstall: () => void,
  ) {}

  /** In-process is always active — the ctx is live from install onward. */
  get active(): boolean {
    return true;
  }

  /** No carrier to start: resolve immediately with the live ctx (idempotent). */
  async activate(): Promise<AppContext> {
    return this.ctx;
  }

  /** Synchronous render-path accessor — always the live ctx for in-process. */
  current_context(): AppContext | null {
    return this.ctx;
  }

  /**
   * Graceful teardown: run the app's `on_uninstall` hook (via the injected
   * hook-only runner). There is no carrier process to terminate for in-process, so
   * this is the whole of dispose. Does NOT drop the registry index or delete the
   * entry — those stay the registry's job (see the `run_uninstall` doc above).
   */
  async dispose(): Promise<void> {
    this.run_uninstall();
  }
}
