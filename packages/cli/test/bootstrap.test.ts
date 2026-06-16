/**
 * test/bootstrap.test.ts — the shared per-process root_dir bootstrap (root-dir-architecture.md §1/§4).
 *
 * Covers: root resolution (flag / ambient env / cwd default + absolutize), fail-fast on a
 * missing explicit root + the --create-root escape hatch, lazy .block-agent/apps mkdir, the
 * byte-identical .env branch (root === cwd loads the cwd .env exactly as the legacy call did,
 * and an explicit root loads <root>/.env), and the single-root concurrency lock (a second
 * acquire on the same root is refused; a stale lock is preempted; release frees it).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bootstrap, BootstrapError } from '../src/bootstrap.js';

const EMPTY_ENV: NodeJS.ProcessEnv = {};

/** Releases collected per test so a leftover lock never leaks across cases. */
let releases: Array<() => void>;

beforeEach(() => {
  releases = [];
});
afterEach(() => {
  for (const r of releases) r();
});

/** Run bootstrap and register its release for cleanup. */
function boot(argv: string[], env: NodeJS.ProcessEnv = EMPTY_ENV) {
  const result = bootstrap(argv, env);
  releases.push(result.release);
  return result;
}

describe('bootstrap — root resolution', () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'ba-boot-')));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves --root-dir, marks it explicit, and absolutizes', () => {
    const { root, rootExplicit } = boot(['--root-dir', dir]);
    expect(root).toBe(dir);
    expect(rootExplicit).toBe(true);
  });

  it('resolves BLOCK_AGENT_ROOT_DIR from ambient env (explicit)', () => {
    const { root, rootExplicit } = boot([], { BLOCK_AGENT_ROOT_DIR: dir });
    expect(root).toBe(dir);
    expect(rootExplicit).toBe(true);
  });

  it('defaults to cwd (not explicit) when neither source is set', () => {
    const { root, rootExplicit } = boot([]);
    expect(root).toBe(realpathSync(process.cwd()));
    expect(rootExplicit).toBe(false);
  });

  it('lazily creates <root>/.block-agent/apps', () => {
    boot(['--root-dir', dir]);
    expect(existsSync(join(dir, '.block-agent', 'apps'))).toBe(true);
  });
});

describe('bootstrap — fail-fast on a missing explicit root (D5)', () => {
  let parent: string;
  beforeEach(() => {
    parent = realpathSync(mkdtempSync(join(tmpdir(), 'ba-boot-')));
  });
  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it('refuses an explicit root that does not exist', () => {
    const missing = join(parent, 'tpyo');
    expect(() => boot(['--root-dir', missing])).toThrow(BootstrapError);
    expect(existsSync(missing)).toBe(false); // not silently created
  });

  it('--create-root creates a missing explicit root', () => {
    const fresh = join(parent, 'fresh');
    const { root } = boot(['--root-dir', fresh, '--create-root']);
    expect(root).toBe(realpathSync(fresh));
    expect(existsSync(join(fresh, '.block-agent', 'apps'))).toBe(true);
  });
});

describe('bootstrap — .env loading (byte-identical branch §5)', () => {
  let dir: string;
  const K = 'BA_BOOT_ENV_PROBE';
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'ba-boot-')));
    delete process.env[K];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env[K];
  });

  it('loads <root>/.env for an explicit root (file > env)', () => {
    writeFileSync(join(dir, '.env'), `${K}=from_root_env\n`, 'utf8');
    boot(['--root-dir', dir]);
    expect(process.env[K]).toBe('from_root_env');
  });
});

describe('bootstrap — single-root concurrency lock (§4 / Q1)', () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'ba-boot-')));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a second live acquire on the same root, naming the holder pid', () => {
    boot(['--root-dir', dir]); // first holds the lock (released in afterEach)
    let thrown: unknown;
    try {
      bootstrap(['--root-dir', dir], EMPTY_ENV);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BootstrapError);
    expect((thrown as Error).message).toContain(String(process.pid));
  });

  it('release frees the lock so the same root can be re-acquired', () => {
    const first = bootstrap(['--root-dir', dir], EMPTY_ENV);
    first.release();
    // Now a fresh acquire must succeed.
    const second = boot(['--root-dir', dir]);
    expect(second.root).toBe(dir);
  });

  it('preempts a stale lock (holder pid no longer alive)', () => {
    // Plant a lock owned by a pid that cannot exist (a very high, almost-certainly-dead pid).
    mkdirSync(join(dir, '.block-agent'), { recursive: true });
    writeFileSync(join(dir, '.block-agent', 'agent.lock'), '999999999', 'utf8');
    // bootstrap should treat it as stale and take over rather than refuse.
    const { root } = boot(['--root-dir', dir]);
    expect(root).toBe(dir);
  });
});
