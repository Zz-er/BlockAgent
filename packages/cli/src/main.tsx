#!/usr/bin/env node
/**
 * cli/main.tsx — the CLI entry (impl-cli-ui owned).
 *
 * Design: ai_com/block-agent-cli-design.md §2 / §7. Flow:
 *   loadConfig(argv, env) → launch(config) → render(<App agent=.../>).
 *
 * Top-level error handling + exit codes live here. On a missing provider key,
 * launch() throws a MissingProviderKeyError (the contract tag in types.ts, carrying
 * `provider_kind` + the `env_var` to set); main narrows on it via
 * isMissingProviderKeyError, prints the graceful guidance — which env var to set, and
 * `--dry-run` to try offline — and exits non-zero BEFORE mounting the UI. Any other
 * launch failure prints its message and exits non-zero too; we never enter the REPL on
 * a failed launch. The API key is read from env inside launch() and never echoed here.
 *
 * TTY guard: the Ink REPL needs an interactive terminal — its input box uses raw mode
 * (Ink `useInput` → `setRawMode`), which THROWS on a non-TTY stdin (a pipe, a
 * redirect, or a CI/headless run). We detect that up front and exit with a clear
 * message instead of letting Ink crash with a React stack trace. (Headless callers
 * should drive the logic layer — launch()/makeCliChannel — directly, not the UI.)
 */

import { render } from './ink.js';
import { loadConfig } from './config.js';
import { bootstrap, BootstrapError } from './bootstrap.js';
import { launch } from './launch.js';
import { App } from './ui/App.js';
import { isMissingProviderKeyError, type MissingProviderKeyError } from './types.js';

/** A one-screen guide for the no-key case (printed to stderr, not the Ink UI). */
function printMissingKeyHelp(err: MissingProviderKeyError): void {
  const { provider_kind: kind, env_var: envVar } = err;
  console.error(
    [
      `block-agent: no API key for the '${kind}' provider.`,
      '',
      `Set ${envVar} in your environment, then re-run:`,
      `  PowerShell:  $env:${envVar} = "<your-key>"`,
      `  bash/zsh:    export ${envVar}="<your-key>"`,
      '',
      'Or run offline against the mock provider (no key, no network):',
      '  npm start -- --dry-run',
      '',
    ].join('\n'),
  );
}

/**
 * Is stdin an interactive terminal? The Ink input box needs raw mode, which only a
 * TTY supports. `process.stdin.isTTY` is `true` only on a real terminal; under a pipe
 * / redirect / CI it is `undefined`. (Ink also exposes `isRawModeSupported`, but that
 * is only readable once mounted — by which point the throw has already happened, so we
 * gate on the stdin TTY flag here, before render.)
 */
function stdinIsInteractive(): boolean {
  return process.stdin.isTTY === true;
}

/** A one-screen guide for the non-interactive (no-TTY) case. */
function printNoTtyHelp(): void {
  console.error(
    [
      'block-agent: the interactive CLI needs a real terminal (TTY).',
      'stdin is not a TTY here (a pipe, redirect, or headless/CI run), so the input',
      'box cannot enable raw mode.',
      '',
      'Run it directly in your terminal:',
      '  npm start',
      '',
      'For scripted/headless use, drive the logic layer (launch / makeCliChannel)',
      'directly instead of mounting the UI.',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Per-process root bootstrap (root-dir-architecture.md §1): resolve --root-dir /
  // BLOCK_AGENT_ROOT_DIR (ambient-only) → absolutize → fail-fast if an explicit root is
  // missing (unless --create-root) → mkdir .block-agent/apps → take the single-root lock →
  // load <root>/.env (file > env; byte-identical when root === cwd). Shared with the headless
  // serve bin so the CLI and web/server paths behave identically. The key stays env-only.
  let boot;
  try {
    boot = bootstrap(argv, process.env);
  } catch (err) {
    // A missing explicit root or a held root lock → clean message + non-zero exit, no UI.
    console.error(err instanceof BootstrapError ? err.message : err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const config = loadConfig(argv, process.env, {
    rootDir: boot.root,
    rootExplicit: boot.rootExplicit,
  });
  let agent;
  try {
    agent = await launch(config);
  } catch (err) {
    if (isMissingProviderKeyError(err)) {
      printMissingKeyHelp(err);
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    process.exitCode = 1;
    return;
  }

  // Guard the Ink mount: a non-TTY stdin can't enter raw mode, so the input box would
  // crash. Fail clearly here instead. (Checked AFTER launch so a no-key run still gets
  // the more specific provider-key guidance above.)
  if (!stdinIsInteractive()) {
    printNoTtyHelp();
    process.exitCode = 1;
    return;
  }

  render(<App agent={agent} />);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
