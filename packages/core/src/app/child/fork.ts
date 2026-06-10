/**
 * app/child/fork.ts — unified-host UH-2/SS3c: the PRODUCTION fork of a sandboxed
 * app's child process (impl-spec §3.9, Atlas D3 ruling).
 *
 * ChildProcessHost takes an injected `spawn` so it stays testable (unit tests pass a
 * fake child, no real process). This is the real one the launcher injects: it forks
 * `app/child/main.ts` with the tsx ESM loader so the child can run TypeScript directly
 * — the repo has NO dist build (everything runs via `tsx`), so we fork the `.ts` entry
 * and self-register the loader via `execArgv: ['--import', 'tsx']`. The explicit
 * execArgv is REQUIRED: production starts via the cli's tsx, but tests start via
 * vitest's esbuild (which does NOT register tsx in the child), so the child must carry
 * its own loader regardless of how the parent was launched.
 *
 * Isolation (§3.9): the child's argv carries ONLY the app package path + app_id; its
 * env is a SCRUBBED allowlist (never the parent's full env — no ambient secrets). The
 * child holds no fs/tree/Operations/blob bytes beyond what it imports + what the RPC
 * channel hands it.
 *
 * PURE wrt the closure: only `node:child_process` + `node:url`. Cold start carries a
 * tsx compile (~tens of ms, amortized by lazy activation — impl-spec §7).
 */

import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { ChildProcessLike } from '../rpc/child_process_transport.js';

/** The child entry (`app/child/main.ts`), resolved relative to THIS module (ESM). */
const CHILD_MAIN_URL = new URL('./main.ts', import.meta.url);

/**
 * A minimal, scrubbed env for the child (§3.9): never pass the parent's full
 * `process.env`. Only the few vars Node/tsx need to run at all. NO app/provider
 * secrets, NO ambient config — the child gets its app + id via argv and everything
 * else over the RPC channel.
 */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const allow = ['PATH', 'NODE_PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'PATHEXT'];
  const out: NodeJS.ProcessEnv = {};
  for (const k of allow) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Fork the sandboxed app's child process. The returned `ChildProcess` satisfies
 * `ChildProcessLike` (send/on(message|exit|error)) so it plugs straight into
 * `parentTransport`. `{ stdio: ['ignore','inherit','inherit','ipc'] }` keeps the IPC
 * channel (required for `child.send`/`on('message')`) while surfacing the child's
 * stdout/stderr for debugging; the sandboxed app gets no stdin.
 */
export function forkChildApp(app_id: string, pkg_path: string): ChildProcessLike {
  const child: ChildProcess = fork(fileURLToPath(CHILD_MAIN_URL), [pkg_path, app_id], {
    execArgv: ['--import', 'tsx'], // self-register the tsx loader (parent-launch-agnostic)
    env: scrubbedEnv(), // §3.9 isolation — never the parent's full env
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  return child as ChildProcessLike;
}
