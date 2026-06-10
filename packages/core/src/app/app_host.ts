/**
 * app/app_host.ts — unified-host UH-1/UH-2: the AppHost abstraction (impl-spec §3.2).
 *
 * An AppHost answers ONE question for the registry/runtime: "where does this app's
 * command/state code run, and how do I get its AppContext?" — without the caller
 * caring whether that is a direct in-process reference (UH-1) or an RPC proxy over
 * a child process (UH-2). The AppContext signature is identical for both carriers
 * ("interface orthogonal to carrier", VSCode rpcProtocol evidence; impl-spec §3.3),
 * so registry/runtime hold an AppHost and never branch on kind.
 *
 * ── The sync/async seam (impl-spec §3.6; the load-bearing shape decision) ─────────
 * `activate()` is async — a ChildProcessHost must lazily fork + handshake the first
 * time the app is needed (impl-spec §3.2/§4 惰性激活). But the render path is
 * SYNCHRONOUS: the Renderer resolves an app's context every render via
 * `app_context_provider: (id) => registry.get_app_context(id)` (index.ts:111), and
 * consume-refresh folds through the same live ctx synchronously (registry.ts:572).
 * We must NOT make `activate()` the only door to the ctx, or those hot, sync,
 * byte-deterministic (INV#1) paths would be forced async.
 *
 * So AppHost exposes TWO doors, deliberately distinct:
 *   - `activate(): Promise<AppContext>` — the lazy-activation door (may start a
 *     process). Idempotent: re-activation returns the already-live ctx.
 *   - `current_context(): AppContext | null` — a SYNCHRONOUS "ctx if already active,
 *     else null" getter for the render path. It NEVER activates (impl-spec §3.6:
 *     "consume 读 cell 不触发激活"). For an InProcessHost it is always non-null
 *     (the ctx is constructed eagerly at install and `active` is forever true), so
 *     the render path keeps today's exact synchronous semantics with zero change.
 *     For a not-yet-activated ChildProcessHost it returns null, and the caller falls
 *     back to the core-side cell (the pull-from-cache source, impl-spec §3.6) — it
 *     does NOT block the render to fork a process.
 *
 * Design refs: impl-spec §3.2 (this interface), §3.6 (pull-from-cache / why sync),
 * architecture §4.1. PURE module: type-only imports, no fs/clock/random/env, stays
 * inside @block-agent/core's empty runtime closure (CI core-closure).
 */

import type { AppContext } from './types.js';
import type { AppHostKind } from './types.js';

export interface AppHost {
  /** Installed app id (post collision-rename) — the key the registry indexes by. */
  readonly app_id: string;

  /** Which carrier this host is — reuses the existing union (types.ts:266). */
  readonly kind: AppHostKind;

  /**
   * Whether the app is currently activated. The registry reads this to decide
   * whether a consume can read the live ctx (active) vs the core-side cache
   * (not yet active) — never to trigger activation. InProcessHost: forever true.
   */
  readonly active: boolean;

  /**
   * Lazy activation: on first need, start the carrier (fork + handshake for
   * child-process) and return this app's AppContext. Idempotent — calling it when
   * already active resolves immediately with the same live ctx. This is the ONLY
   * async door; see the sync/async seam note above for why the render path does
   * not go through here.
   */
  activate(): Promise<AppContext>;

  /**
   * SYNCHRONOUS render-path accessor: the live AppContext iff already active, else
   * null. MUST NOT activate (no process start, no IPC). The render/consume-refresh
   * paths use this to preserve byte-deterministic, synchronous reads (INV#1); a
   * null result means "fall back to the core-side cell", never "block to fork".
   */
  current_context(): AppContext | null;

  /**
   * Graceful shutdown: run the app's `on_uninstall` (deactivate), then — for a
   * child-process carrier — terminate the process and reclaim the channel. Async
   * because process teardown is async; for in-process it just runs on_uninstall
   * via the existing uninstall path (registry.ts:450) and does not double-fire it.
   */
  dispose(): Promise<void>;
}
