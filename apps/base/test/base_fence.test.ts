/**
 * test/base_fence.test.ts — the root_dir realpath fence on base's file tools (P0.3).
 *
 * Drives the REAL base app through the REAL `AppRegistry` + `PolicyEngine` (exactly how
 * Operations.invoke_command wires them: policy.check → registry.route), but constructs
 * `BaseApp` with an EXPLICIT `allowedRoots` temp dir so the test fully owns the fence
 * boundary. We assert the four承重 cases from the briefing:
 *   (a) read / grep a file INSIDE the allowed root → OK;
 *   (b) `../` traversal OR an absolute path OUTSIDE the root → REFUSED (no read);
 *   (c) a symlink whose REAL target is outside the root → REFUSED after realpath;
 *   (d) a sibling whose name shares the root's prefix (`<root>-evil`) → NOT mis-allowed.
 *
 * The refusal is fail-closed: a blocked path returns `ok:false` with an "outside the
 * allowed root" error and the file body never appears in the result.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppRegistry } from '@block-agent/core/app/registry.js';
import { PolicyEngine } from '@block-agent/core/core/policy.js';
import type { InvokerContext } from '@block-agent/core/core/types.js';
import type { CommandResult } from '@block-agent/core/app/types.js';

import { BaseApp, RootFence } from '../src/manifest.js';

// ---------------------------------------------------------------------------
// Temp layout: a sandbox dir holding `<sandbox>/root` (the allowed root, where
// base's data ALSO lives) and `<sandbox>/outside` + `<sandbox>/root-evil` (off-limits).
// ---------------------------------------------------------------------------

let sandbox: string;
let root: string; // the allowed root
let outside: string; // a sibling dir OUTSIDE the root
let rootEvil: string; // `<...>/root-evil` — shares the root's textual prefix

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'base-fence-'));
  root = join(sandbox, 'root');
  outside = join(sandbox, 'outside');
  rootEvil = join(sandbox, 'root-evil');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(rootEvil, { recursive: true });
});
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

interface Harness {
  reg: AppRegistry;
  policy: PolicyEngine;
}

/** Install base with the fence pinned to `[root]`, plus a real PolicyEngine. */
function setup(): Harness {
  const reg = new AppRegistry();
  // base's data dir lives under the allowed root; the fence is pinned to that root.
  const app = new BaseApp(join(root, '.data'), { allowedRoots: [root] });
  reg.install(app.manifest());
  const policy = new PolicyEngine({
    capability_resolver: (fn) => reg.resolve_command(fn)?.capabilities ?? [],
    allowed_invokers_resolver: (fn) => reg.resolve_command(fn)?.allowed_invokers ?? null,
  });
  return { reg, policy };
}

async function invoke(
  h: Harness,
  full_name: string,
  args: unknown,
  invoker: InvokerContext,
): Promise<{ decision: ReturnType<PolicyEngine['check']>; result: CommandResult | null }> {
  const decision = h.policy.check({ full_name, args }, invoker);
  if (decision.kind !== 'allow') return { decision, result: null };
  const result = await h.reg.route(full_name, args, invoker);
  return { decision, result };
}

const AGENT: InvokerContext = { invoker: 'agent', identity: 'main' };

function dataOf(result: CommandResult | null): { result?: string } {
  return (result?.data ?? {}) as { result?: string };
}

// ===========================================================================
// (a) in-root reads / grep are allowed
// ===========================================================================

describe('fence — in-root reads are allowed', () => {
  it('read_file reads a file inside the allowed root', async () => {
    const h = setup();
    const f = join(root, 'note.txt');
    writeFileSync(f, 'hello-in-root\n');
    const { result } = await invoke(h, 'base.read_file', { path: f, invocation_id: 'a1' }, AGENT);
    expect(result?.ok).toBe(true);
    expect(dataOf(result).result).toContain('hello-in-root');
  });

  it('read_file reads a file in a NESTED subdir of the root', async () => {
    const h = setup();
    const sub = join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    const f = join(sub, 'deep.txt');
    writeFileSync(f, 'deep-body\n');
    const { result } = await invoke(h, 'base.read_file', { path: f, invocation_id: 'a2' }, AGENT);
    expect(result?.ok).toBe(true);
    expect(dataOf(result).result).toContain('deep-body');
  });

  it('grep matches lines in an in-root file', async () => {
    const h = setup();
    const f = join(root, 'src.txt');
    writeFileSync(f, 'alpha\nbeta NEEDLE here\ngamma\n');
    const { result } = await invoke(
      h,
      'base.grep',
      { pattern: 'NEEDLE', path: f, invocation_id: 'a3' },
      AGENT,
    );
    expect(result?.ok).toBe(true);
    expect(dataOf(result).result).toContain('NEEDLE');
  });
});

// ===========================================================================
// (b) `../` traversal + absolute escape are refused
// ===========================================================================

describe('fence — out-of-root paths are refused (fail-closed)', () => {
  it('an absolute path OUTSIDE the root is refused, body never read', async () => {
    const h = setup();
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'TOP-SECRET\n');
    const { result } = await invoke(h, 'base.read_file', { path: secret, invocation_id: 'b1' }, AGENT);
    expect(result?.ok).toBe(false);
    expect(result?.error).toMatch(/outside the allowed root/);
    expect(dataOf(result).result ?? '').not.toContain('TOP-SECRET');
  });

  it('a `../` traversal that climbs out of the root is refused', async () => {
    const h = setup();
    const secret = join(outside, 'secret2.txt');
    writeFileSync(secret, 'CLIMB-SECRET\n');
    // A relative `../outside/secret2.txt` from inside the root climbs out — must be refused.
    const traversal = join(root, '..', 'outside', 'secret2.txt');
    const { result } = await invoke(h, 'base.read_file', { path: traversal, invocation_id: 'b2' }, AGENT);
    expect(result?.ok).toBe(false);
    expect(result?.error).toMatch(/outside the allowed root/);
  });

  it('grep is fenced the same way as read_file', async () => {
    const h = setup();
    const secret = join(outside, 'secret3.txt');
    writeFileSync(secret, 'GREP-SECRET\n');
    const { result } = await invoke(
      h,
      'base.grep',
      { pattern: 'GREP', path: secret, invocation_id: 'b3' },
      AGENT,
    );
    expect(result?.ok).toBe(false);
    expect(result?.error).toMatch(/outside the allowed root/);
  });
});

// ===========================================================================
// (c) a symlink whose REAL target is outside the root is refused after realpath
// ===========================================================================

describe('fence — symlink escape is refused after realpath', () => {
  it('a symlink INSIDE the root pointing to a file OUTSIDE is refused', async () => {
    const h = setup();
    const secret = join(outside, 'real-secret.txt');
    writeFileSync(secret, 'SYMLINK-SECRET\n');
    const link = join(root, 'link-to-secret.txt');
    try {
      symlinkSync(secret, link, 'file');
    } catch {
      // Some CI/Windows configs forbid creating symlinks; skip rather than false-pass.
      return;
    }
    // The link's TEXTUAL path is inside the root, but realpath resolves it to `outside`.
    const { result } = await invoke(h, 'base.read_file', { path: link, invocation_id: 'c1' }, AGENT);
    expect(result?.ok).toBe(false);
    expect(result?.error).toMatch(/outside the allowed root/);
    expect(dataOf(result).result ?? '').not.toContain('SYMLINK-SECRET');
  });

  it('a symlinked DIRECTORY inside the root pointing outside is refused', async () => {
    const h = setup();
    const secret = join(outside, 'd', 'leak.txt');
    mkdirSync(join(outside, 'd'), { recursive: true });
    writeFileSync(secret, 'DIR-LEAK\n');
    const linkDir = join(root, 'escape-dir');
    try {
      symlinkSync(join(outside, 'd'), linkDir, 'dir');
    } catch {
      return; // symlinks unavailable — skip
    }
    const via = join(linkDir, 'leak.txt');
    const { result } = await invoke(h, 'base.read_file', { path: via, invocation_id: 'c2' }, AGENT);
    expect(result?.ok).toBe(false);
    expect(result?.error).toMatch(/outside the allowed root/);
  });
});

// ===========================================================================
// (d) prefix-confusion: `<root>-evil` must NOT be admitted by the fence
// ===========================================================================

describe('fence — prefix confusion is not mis-allowed', () => {
  it('a sibling dir sharing the root prefix (`root-evil`) is refused', async () => {
    const h = setup();
    const f = join(rootEvil, 'evil.txt');
    writeFileSync(f, 'EVIL-PREFIX\n');
    const { result } = await invoke(h, 'base.read_file', { path: f, invocation_id: 'd1' }, AGENT);
    expect(result?.ok).toBe(false);
    expect(result?.error).toMatch(/outside the allowed root/);
    expect(dataOf(result).result ?? '').not.toContain('EVIL-PREFIX');
  });
});

// ===========================================================================
// RootFence unit checks (the containment primitive in isolation)
// ===========================================================================

describe('RootFence — containment primitive', () => {
  it('admits the root itself and descendants, rejects parents/siblings/prefix-twins', () => {
    const f = new RootFence([root]);
    const inside = join(root, 'x', 'y.txt');
    writeFileSync(join(root, 'z.txt'), 'z'); // an existing in-root file
    expect(f.check(join(root, 'z.txt'))).not.toBeNull(); // existing descendant
    expect(f.check(inside)).not.toBeNull(); // non-existent descendant (write-side ready)
    expect(f.check(sandbox)).toBeNull(); // parent
    expect(f.check(outside)).toBeNull(); // sibling
    expect(f.check(rootEvil)).toBeNull(); // prefix twin
    expect(f.check('')).toBeNull(); // empty → fail-closed
  });

  it('the bash write-side fence refuses an out-of-root cwd (framework in place)', async () => {
    const h = setup();
    // bash is allowed for the agent only after approval; drive it directly via the registry
    // route with a USER invoker so policy lets the handler run, then assert the cwd gate.
    const USER: InvokerContext = { invoker: 'user', identity: 'kendrick' };
    const blocked = await invoke(
      h,
      'base.bash',
      { command: 'echo hi', cwd: outside, invocation_id: 'bash1' },
      USER,
    );
    expect(blocked.result?.ok).toBe(false);
    expect(blocked.result?.error).toMatch(/outside the allowed root/);

    const okRun = await invoke(
      h,
      'base.bash',
      { command: 'echo hi', cwd: root, invocation_id: 'bash2' },
      USER,
    );
    expect(okRun.result?.ok).toBe(true);
    expect((okRun.result?.data as { result?: string })?.result).toContain('[bash stub]');
  });
});
