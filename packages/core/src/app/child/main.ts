/**
 * app/child/main.ts — unified-host UH-2/SS3b: the sandboxed-app child entry (§3.9).
 *
 * This module runs INSIDE the forked child process (ChildProcessHost forks it via
 * `fork(thisUrl, [pkgPath, app_id], { execArgv: ['--import','tsx'], env: <allowlist> })`).
 * It is the untrusted side: it loads the app's manifest, runs its command handlers,
 * and proxies state/events back to the main process over an RpcChannel. It NEVER holds
 * the tree, Operations, the PolicyEngine, real blob bytes, the main-process env, or fs
 * beyond the app's own package — isolation is the whole point (§3.2).
 *
 * Sequence (§3.9):
 *   1. read app package path + app_id from ARGV (never the main-process env — the fork
 *      passes a scrubbed env; we do not read ambient secrets).
 *   2. import the app package → produce its AppManifest.
 *   3. build the RpcChannel over `childTransport(process)`.
 *   4. on('invoke', {command, args}) → run the command's handler against the
 *      AppContextProxy → frame back its CommandResult (ops/data). The MAIN process
 *      re-enters PolicyEngine on those ops (INV#11) — the child does not apply.
 *   5. the proxy's set_state frames the next state to the main cell; emit/wake/read/
 *      invoke_command frame to the main process (see app_context_proxy).
 *   6. on('dispose') → run on_uninstall → exit.
 *
 * Builders do NOT run in the child (方案 A): an untrusted app's blocks are rendered by
 * the main-process GenericProjectionBuilder (SS4) from the core-side cell, never by
 * child code. So this entry only wires commands + state + the cross-app channels.
 *
 * PURE wrt the closure: node:process + the RpcChannel/transport/proxy (all node:/core).
 */

import { FramedRpcChannel } from '../rpc/channel.js';
import { childTransport } from '../rpc/child_process_transport.js';
import { makeAppContextProxy, type ProxySeed } from '../rpc/app_context_proxy.js';
import type { AppManifest, CommandManifest, CommandResult } from '../types.js';

/**
 * The app-load convention (sandboxed apps): the child imports the package entry
 * pointed to by `pkgPath` and obtains its AppManifest. An app package exposes EITHER a
 * `createManifest(): AppManifest` factory OR a default-exported class with a
 * `.manifest()` method (the built-in apps' shape, e.g. `new TaskApp().manifest()`).
 * `app_id` is the INSTALLED id (post collision-rename) the main process assigned; the
 * child trusts the main process for it (it is the proxy/identity key, not a secret).
 *
 * NOTE: kept as a single documented seam so a future packaging convention change
 * touches one place. The import is dynamic (the package path is only known at runtime).
 */
async function loadManifest(pkgPath: string): Promise<AppManifest> {
  const mod = (await import(pkgPath)) as Record<string, unknown>;
  if (typeof mod.createManifest === 'function') {
    return (mod.createManifest as () => AppManifest)();
  }
  const Ctor = (mod.default ?? mod.App) as (new () => { manifest(): AppManifest }) | undefined;
  if (typeof Ctor === 'function') {
    return new Ctor().manifest();
  }
  if (mod.manifest && typeof (mod.manifest as { manifest?: unknown }) === 'object') {
    return mod.manifest as AppManifest;
  }
  throw new Error(
    `child: app package '${pkgPath}' exposes no createManifest()/default class.manifest()/manifest`,
  );
}

/** Reflect a manifest's commands/builders BY VALUE for the proxy seed (no handlers). */
function reflectForSeed(manifest: AppManifest): Pick<ProxySeed, 'commands' | 'builders'> {
  const commands: CommandManifest[] = manifest.commands.map((f) => {
    const c = f(manifest.initial_state);
    // strip the handler — only the by-value descriptor crosses to list_commands.
    const { invoke: _omit, ...rest } = c as CommandManifest & { invoke?: unknown };
    return rest as CommandManifest;
  });
  const builders = manifest.builders.map((f) => f(manifest.initial_state));
  return { commands, builders };
}

export async function childMain(argv: string[], proc: NodeJS.Process): Promise<void> {
  // (1) argv only — never read the main-process env. fork passes [pkgPath, app_id].
  const [pkgPath, app_id] = argv.slice(2);
  if (!pkgPath || !app_id) {
    throw new Error('child: missing argv [pkgPath, app_id]');
  }

  // (2) load the app manifest in the child.
  const manifest = await loadManifest(pkgPath);

  // (3) build the channel over this process's IPC.
  const channel = new FramedRpcChannel(childTransport(proc));

  // child-local command map + state cell (the handler's view; main holds the cell).
  const commands = new Map<string, CommandManifest>();
  let cell: unknown = manifest.initial_state;
  for (const factory of manifest.commands) {
    const c = factory(cell);
    commands.set(c.name, c);
  }

  // The proxy handed to handlers. set_state updates the local cell AND frames the next
  // value to the main authoritative cell (re-validated there, 补强①).
  const seed: ProxySeed = {
    app_id,
    initial_state: cell,
    ...reflectForSeed(manifest),
  };
  const ctx = makeAppContextProxy(channel, seed);
  // Keep the child cell in sync with the proxy's local copy (the proxy owns the copy;
  // we read it back through ctx.state for the next handler invocation).

  // (4) invoke: the main process frames {command, args}; we run the handler and frame
  // back its CommandResult. We do NOT apply ops here — the main process re-enters
  // PolicyEngine on the returned ops (INV#11).
  channel.on('invoke', async (payload): Promise<CommandResult> => {
    const { command, args } = payload as { command: string; args: unknown };
    const cmd = commands.get(command);
    if (!cmd) return { ok: false, error: `child: unknown command '${command}'` };
    try {
      return await cmd.invoke(args, ctx, { invoker: 'app', identity: app_id });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // (6) dispose: run on_uninstall (graceful teardown), then exit. The main process
  // terminates us if we don't exit promptly (dispose deadline).
  channel.on('dispose', async (): Promise<null> => {
    try {
      await manifest.on_uninstall?.(ctx);
    } finally {
      // Let the reply flush, then exit cleanly.
      setTimeout(() => proc.exit?.(0), 0);
    }
    return null;
  });

  // Signal readiness to the main process (handshake complete; seed already carried in
  // the proxy construction here, so the main side just needs the ack).
  await channel.call('__ready', { app_id }).catch(() => {
    /* main may not register __ready in minimal wirings; non-fatal */
  });
}

// Auto-run when forked as a script (not when imported by a test). The main process
// always forks this file as the child entry; a test imports `childMain` directly.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void childMain(process.argv, process);
}
