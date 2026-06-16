/**
 * server/bin.ts — the headless single-agent serve entry (D6 §8 seam 2 / §3.1).
 *
 * `block-agent-serve --config <path> --name <id> [--port <n>] [--host <h>]` boots ONE agent
 * process from a config file and fronts it with the SessionProtocol WS server + the `/health`
 * liveness probe — the "可被监督的进程" the platform Supervisor launches per instance. It is
 * the headless twin of the interactive Ink CLI (`packages/cli` `bin`): no readline/stdin loop,
 * just serve() + block until a signal.
 *
 * Design: ai_com/design/multi-agent-team-platform.md §3.1 (`--config <path> --name <id>`,
 * name=id keys the instance's socket/data-dir/health) + §8 (the headless serve bin is "net
 * new" — today's `bin` is the interactive CLI and serve() had zero non-test callers).
 *
 * INSTANCE KEYING (`--name`): the `name` is the instance id. It keys the data dir
 * (`<storage_base>/<name>` so two instances on one machine never share `.block-agent` state —
 * the §8 `appsBaseDir` `<instance>` segment) and labels logs. The port keys the socket/web
 * endpoint; the platform assigns it (port-per-instance). The runtime config (provider/model/
 * apps) comes from `--config` via the SAME `loadConfig` precedence the CLI uses.
 *
 * KEY IRON LAW: the API key is read from env ONLY (never a flag, never the config file) — this
 * bin never touches it; `launch()` reads `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` straight from env.
 * We MUST pass the flags through `loadConfig` (not invent our own parse) so a key can never
 * leak in via a config field.
 *
 * DOTENV PARITY WITH THE CLI: like the interactive CLI (`main.tsx`), `main()` calls `loadDotenv()`
 * ONCE at startup so a repo-root `.env` populates `process.env` BEFORE `launch()` reads the key.
 * Without it, this bin (which fronts the web inspector) only saw the ambient shell env — a key
 * living solely in `.env` looked "missing" and the web appeared to require a hard-set key. The key
 * still flows env-only (the iron law holds); `.env` just populates `process.env`, same as the CLI.
 */

import { join } from 'node:path';
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

import { loadConfig, parseFlags } from '@block-agent/cli/config.js';
import { bootstrap, BootstrapError } from '@block-agent/cli/bootstrap.js';
import type { LauncherConfig } from '@block-agent/cli/types.js';

import { serve, type RunningServer } from './serve.js';

/** Default WS/health port when `--port` is absent (the platform normally assigns one). */
const DEFAULT_PORT = 7345;

/**
 * resolveServeConfig — turn argv+env into the LauncherConfig + the instance's port/host/name.
 * Reuses `loadConfig` for the full precedence chain (flags > config file > env > defaults), so
 * the API-key-is-env-only rule is preserved (loadConfig never reads a key). Then it layers the
 * §3.1 instance keying on top: `--name` derives a per-instance `storage_dir` (so each instance
 * owns its own `.block-agent` data dir), and `--port`/`--host` bind this instance's endpoint.
 *
 * Exported (not just used by `main`) so a test can assert the instance keying without binding
 * a socket.
 */
export function resolveServeConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  opts?: { rootDir?: string; rootExplicit?: boolean },
): { config: LauncherConfig; name: string; port: number; host: string } {
  const flags = parseFlags(argv);
  const name = typeof flags['name'] === 'string' ? flags['name'] : '';
  if (name === '') {
    throw new Error(
      "block-agent-serve: --name <id> is required (it keys this instance's data dir + endpoint).",
    );
  }

  // The full runtime config from the SAME precedence chain the CLI uses (flags > file > env >
  // defaults). `--config <path>` is honored inside loadConfig (it reads that key itself). The
  // root_dir (resolved by bootstrap, default cwd) homes the config file + storage base.
  const base = loadConfig(argv, env, opts);

  // root + --name are orthogonal two layers (root-dir-architecture.md §4): root = the
  // process-level isolation boundary, --name = the instance sub-division INSIDE it. The
  // per-instance data dir is `<root>/<name>` so two co-located instances never collide on
  // `.block-agent` state. `base.storage_dir` is now ALWAYS the root (loadConfig sets it),
  // so the old `?? cwd` is gone — a missing InstanceConfig root can no longer leak to cwd.
  const root = base.storage_dir ?? process.cwd();
  const config: LauncherConfig = { ...base, storage_dir: join(root, name) };

  const portFlag = flags['port'];
  const port =
    typeof portFlag === 'string' && Number.isFinite(Number(portFlag)) ? Number(portFlag) : DEFAULT_PORT;
  const host = typeof flags['host'] === 'string' ? flags['host'] : '127.0.0.1';

  return { config, name, port, host };
}

/**
 * main — boot the instance and block until a termination signal, then shut down cleanly.
 * stdout/stderr are the only UI (no Ink). The §8 "干净的生命周期(drain/stop)": on SIGINT/SIGTERM
 * we `close()` the transport (detaches host subscriptions, restores the wake hook) — the agent's
 * durable data is NEVER deleted here (INV #5 archival; physical delete is a separate path).
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  // Per-process root bootstrap (root-dir-architecture.md §1/§4), the SAME shared prologue the
  // interactive CLI runs: resolve --root-dir / BLOCK_AGENT_ROOT_DIR (ambient-only) → absolutize
  // → fail-fast on a missing explicit root (unless --create-root) → mkdir .block-agent/apps →
  // take the single-root lock → load <root>/.env (file > env). The key still flows env-only.
  let boot;
  try {
    boot = bootstrap(argv, env);
  } catch (err) {
    // A missing explicit root or a held root lock → clean stderr message + non-zero exit.
    process.stderr.write(
      `${err instanceof BootstrapError ? err.message : err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const { config, name, port, host } = resolveServeConfig(argv, env, {
    rootDir: boot.root,
    rootExplicit: boot.rootExplicit,
  });

  let server: RunningServer;
  try {
    server = await serve(config, { port, host });
  } catch (err) {
    // A missing provider key (or a non-loopback bind without auth) surfaces here. Print
    // actionable guidance to stderr and exit non-zero — never a key value.
    process.stderr.write(
      `block-agent-serve[${name}]: failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `block-agent-serve[${name}]: listening on ws://${host}:${server.port} ` +
      `(health: http://${host}:${server.port}/health)\n`,
  );

  // Block until a termination signal; then drain + stop. Resolve the returned promise so a
  // test harness can await main() ending; in production the process lives until signaled.
  await new Promise<void>((resolve) => {
    const shutdown = (signal: string): void => {
      process.stdout.write(`block-agent-serve[${name}]: ${signal} → draining + stopping\n`);
      void server.close().then(() => resolve());
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  });
}

// Run when invoked directly as the bin (tsx src/bin.ts / node dist/bin.js). The
// import-meta-vs-argv guard keeps `main`/`resolveServeConfig` importable by tests without
// auto-launching a server. `pathToFileURL` normalizes the entry path to a file:// URL the
// SAME way `import.meta.url` is formed (incl. the Windows `file:///E:/…` drive form), so the
// compare is robust across platforms — a hand-rolled `file://${argv[1]}` would mismatch on
// Windows (two slashes vs three) and never auto-launch.
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  void main();
}
