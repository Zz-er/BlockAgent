/**
 * cli/bootstrap.ts — the per-process root_dir bootstrap (root-dir-architecture.md §1/§4).
 *
 * `bootstrap(argv, env)` is the SINGLE shared boot prologue both entry points run: the
 * interactive Ink CLI (`main.tsx`) and the headless serve bin (`server/bin.ts`). Folding
 * `resolveRootDir + resolve + existence-check + mkdir + loadDotenv + lock` into one function
 * is deliberate (§1 / D6): two entry points = two chances to drift, so they share this.
 *
 * Phase 0 — define the root (argv + AMBIENT env only; the bootstrap paradox of §1):
 *   root = resolveRootDir(argv, env) ?? process.cwd()
 *   root = path.resolve(root)                  // absolutize ONCE (R5: relative root drifts on fork)
 *   - An EXPLICIT root that does not exist → FAIL-FAST (D5: `--root-dir /tpyo` silently
 *     starting empty = the agent's amnesia). `--create-root` opts into mkdir-ing it.
 *   - The DEFAULT root (= cwd) always exists → legacy behavior, never fails.
 *   mkdirSync(<root>/.block-agent/apps, {recursive})   // lazy parent for jsonl append paths
 *
 * Phase 0.5 — concurrency guard (§4 / Q1): acquire `<root>/.block-agent/agent.lock`
 *   (O_EXCL, pid inside; realpathSync(root) first to defeat a symlink alias). A second
 *   process pointed at the SAME root is REFUSED (it prints the holder pid); a stale lock
 *   (holder pid no longer alive) is preempted. Released on process exit.
 *
 * Phase 1 — load `.env` from the root (loadDotenv writes process.env, file > env). The
 *   byte-identical branch: when root === cwd we call `loadDotenv()` with NO argument (the
 *   exact legacy call), so a no-root run is provably unchanged (§5 / R3).
 *
 * What this does NOT do: read the config file or the API key (both downstream of here).
 * `loadConfig(argv, env, {rootDir, rootExplicit})` runs AFTER, in the entry point.
 *
 * KEY IRON LAW: this prologue never reads/echoes an API key; it only positions `.env` so
 * `launch()` can read `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` from `process.env` env-only.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

import { loadDotenv, resolveRootDir } from './config.js';

/** The hidden state dir under the root (`<root>/.block-agent`); apps live in `apps/` under it. */
const STATE_DIR = '.block-agent';
/** The advisory single-process lock file under the state dir (§4 / Q1). */
const LOCK_FILE = 'agent.lock';

/** What `bootstrap` hands back to the entry point for `loadConfig`. */
export interface BootstrapResult {
  /** The absolutized per-process root (`storage_dir` derives from this). */
  root: string;
  /**
   * Was the root EXPLICITLY chosen (`--root-dir` / `BLOCK_AGENT_ROOT_DIR`), vs defaulted to
   * cwd? Threaded into `loadConfig` so an explicit root wins over the deprecated
   * `--storage-dir` aliases (§6), while a defaulted root yields to them (escape hatch).
   */
  rootExplicit: boolean;
  /** Releases the agent.lock. Idempotent. Registered on process exit; callers may also hold it. */
  release: () => void;
}

/** A boot-time failure with a clean operator message (no stack noise from the entry point). */
export class BootstrapError extends Error {
  override readonly name = 'BootstrapError';
}

/**
 * acquireLock — take `<root>/.block-agent/agent.lock` exclusively (§4 / Q1). `realpathSync`
 * the root FIRST so two paths that symlink to the same dir contend on ONE lock. Writes our
 * pid via `O_EXCL` (fails if the file exists). On EEXIST: read the holder pid — if it is a
 * LIVE process, refuse to start (print the pid); if it is STALE (process gone), preempt by
 * removing the file and retrying once. Returns a `release()` that removes our lock.
 */
function acquireLock(stateDir: string): () => void {
  // Resolve any symlink on the *state dir* so an aliased root cannot dodge the lock. The
  // dir already exists (mkdir ran before us); realpath is safe.
  const canonicalStateDir = realpathSync(stateDir);
  const lockPath = join(canonicalStateDir, LOCK_FILE);

  const tryCreate = (): number | undefined => {
    try {
      // wx = O_CREAT | O_EXCL | O_WRONLY: fails with EEXIST if the lock is already held.
      return openSync(lockPath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
      throw err;
    }
  };

  let fd = tryCreate();
  if (fd === undefined) {
    // Lock exists — is the holder alive or stale?
    const holderPid = readLockPid(lockPath);
    if (holderPid !== undefined && isProcessAlive(holderPid)) {
      throw new BootstrapError(
        `block-agent: another process (pid ${holderPid}) already holds the root lock ` +
          `at ${lockPath}.\nA single root_dir may host only one running agent. Point this ` +
          `process at a different --root-dir, or stop the holder first.`,
      );
    }
    // Stale (holder gone, or an unreadable/empty lock left by a crash) → preempt.
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // If we cannot remove it, the retry below will surface a clearer error.
    }
    fd = tryCreate();
    if (fd === undefined) {
      // Lost a race to preempt — someone else just took it. Treat as held.
      const racePid = readLockPid(lockPath);
      throw new BootstrapError(
        `block-agent: the root lock at ${lockPath} was just acquired by another process` +
          (racePid !== undefined ? ` (pid ${racePid})` : '') +
          `. Use a different --root-dir.`,
      );
    }
  }

  try {
    writeSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Only remove the lock if it is still OURS (do not clobber a process that preempted us).
    try {
      if (readLockPid(lockPath) === process.pid) rmSync(lockPath, { force: true });
    } catch {
      // Best-effort release; a leftover lock is preempted as stale by the next start.
    }
  };
}

/** Read the integer pid out of a lock file, or undefined if missing/empty/garbage. */
function readLockPid(lockPath: string): number | undefined {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    if (raw === '') return undefined;
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Is `pid` a live process? `kill(pid, 0)` probes without signaling (ESRCH = gone). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but we cannot signal it (still alive); ESRCH means it is gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * bootstrap — run the shared boot prologue and return the resolved root + a lock release.
 * Throws `BootstrapError` (clean message) on a missing explicit root or a held lock; the
 * entry point prints `.message` and exits non-zero.
 */
export function bootstrap(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): BootstrapResult {
  const picked = resolveRootDir(argv, env);
  const rootExplicit = picked !== undefined;
  // Default = cwd (legacy, byte-identical). Absolutize ONCE here (R5).
  const root = resolvePath(picked ?? process.cwd());

  // Existence: an explicit root must already exist (D5 fail-fast — defend against a typo
  // silently spinning up empty state = amnesia). `--create-root` opts into creating it.
  // The default root (= cwd) always exists, so this only gates explicit roots.
  if (rootExplicit && !existsSync(root)) {
    const flags = parseCreateRoot(argv);
    if (!flags) {
      throw new BootstrapError(
        `block-agent: --root-dir ${root} does not exist.\n` +
          `Refusing to start (a typo'd root would silently create empty state = amnesia).\n` +
          `Create the directory yourself, or pass --create-root to create it now.`,
      );
    }
    mkdirSync(root, { recursive: true });
  }

  // Lazy-create the app data dir (jsonl append paths need their parent). fail-soft: a mkdir
  // failure on an existing tree is harmless (recursive). This always runs (default + explicit).
  const stateDir = join(root, STATE_DIR);
  mkdirSync(join(stateDir, 'apps'), { recursive: true });

  // Concurrency guard (§4): one running agent per root. Acquire BEFORE loading .env so a
  // refused second process never half-initializes.
  const release = acquireLock(stateDir);
  // Release the lock when this process exits (normal exit + the signals the serve bin traps).
  // `exit` fires for process.exit / natural end; serve's SIGINT/SIGTERM handlers call exit too.
  process.once('exit', release);

  // Load .env from the root (file > env). BYTE-IDENTICAL branch (§5 / R3): when root is the
  // cwd, call loadDotenv() with NO arg — the exact legacy call — so a no-root run is provably
  // unchanged down to the relative-vs-absolute path.
  if (root === process.cwd()) {
    loadDotenv();
  } else {
    loadDotenv(join(root, '.env'));
  }

  return { root, rootExplicit, release };
}

/** Is `--create-root` present (bare boolean flag)? Tiny local parse — bootstrap stays self-contained. */
function parseCreateRoot(argv: readonly string[]): boolean {
  return argv.includes('--create-root') || argv.includes('--create-root=true');
}
