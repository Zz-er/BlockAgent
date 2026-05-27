/**
 * test/app_lifecycle.test.ts — unit tests for AppRegistry lifecycle primitives
 * added in block-agent-app-lifecycle v1:
 *   - unseedProjectionBlocks: inverse of seedProjectionBlocks (soft-delete owned
 *     projection blocks via injected apply, idempotent, registry never touches tree)
 *   - ceiling_resolver seam: install()-time capability ceiling check (report-only,
 *     no reject; unset → zero behaviour change)
 *
 * Owned by impl-core (task #3).  Only imports from registry.ts + types.ts + core/types.ts.
 */

import { describe, expect, it, vi } from 'vitest';

import { AppRegistry } from '../src/app/registry.js';
import type { AppTrustLevel } from '../src/app/registry.js';
import type { AppManifest, BuilderManifest, CommandManifest } from '../src/app/types.js';
import type { BlockName, BlockOp } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function builder(outputs: BlockName[]): BuilderManifest {
  return {
    name: `builder-${outputs.join('-')}`,
    version: '1.0.0',
    owner: 'system',
    inputs: [],
    outputs,
    cache_tier: 'volatile',
    async build() { return null; },
  };
}

function builderWithCaps(outputs: BlockName[], capNames: string[]): BuilderManifest {
  return {
    ...builder(outputs),
    name: `builder-${outputs.join('-')}-caps`,
    capabilities: capNames.map((name) => ({ name })),
  };
}

function command(name: string, capNames?: string[]): CommandManifest {
  const cmd: CommandManifest = {
    name,
    description: `command ${name}`,
    invoke: async () => ({ ok: true }),
  };
  if (capNames) cmd.capabilities = capNames.map((n) => ({ name: n }));
  return cmd;
}

function appManifest(id: string, opts?: {
  builders?: BuilderManifest[];
  commands?: CommandManifest[];
}): AppManifest {
  return {
    id,
    version: '1.0.0',
    depends_on: [],
    tree_namespace: `/${id}`,
    initial_state: {},
    state_schema: {},
    builders: (opts?.builders ?? []).map((b) => () => b),
    commands: (opts?.commands ?? []).map((c) => () => c),
  };
}

// ---------------------------------------------------------------------------
// unseedProjectionBlocks
// ---------------------------------------------------------------------------

describe('unseedProjectionBlocks', () => {
  it('emits soft-delete ops for each owned projection block that is live in tree', async () => {
    const reg = new AppRegistry();
    reg.install(appManifest('app_a', {
      builders: [builder(['app_a:x', 'app_a:y'])],
    }));

    const live = new Set<BlockName>(['app_a:x', 'app_a:y']);
    const appliedOps: BlockOp[] = [];
    const apply = vi.fn(async (ops: BlockOp[]) => { appliedOps.push(...ops); });

    const removed = await reg.unseedProjectionBlocks('app_a', (n) => live.has(n), apply);

    expect(removed).toEqual(['app_a:x', 'app_a:y']); // sorted
    expect(apply).toHaveBeenCalledOnce();
    expect(appliedOps).toHaveLength(2);
    for (const op of appliedOps) {
      expect(op.kind).toBe('delete');
      // physical must be absent / falsy (soft delete, INV #5)
      expect((op as { kind: 'delete'; target: BlockName; physical?: boolean }).physical).toBeFalsy();
    }
    const targets = appliedOps.map((o) => (o as { kind: 'delete'; target: BlockName }).target).sort();
    expect(targets).toEqual(['app_a:x', 'app_a:y']);
  });

  it('skips names not present in the tree (idempotent when tree already clean)', async () => {
    const reg = new AppRegistry();
    reg.install(appManifest('app_b', {
      builders: [builder(['app_b:z'])],
    }));

    // Simulate tree where the block was already removed.
    const apply = vi.fn(async (_ops: BlockOp[]) => {});
    const removed = await reg.unseedProjectionBlocks('app_b', () => false, apply);

    expect(removed).toEqual([]);
    expect(apply).not.toHaveBeenCalled();
  });

  it('is fully idempotent across two calls (second call returns [] when has=false)', async () => {
    const reg = new AppRegistry();
    reg.install(appManifest('app_c', {
      builders: [builder(['app_c:w'])],
    }));

    let live = true;
    const apply = vi.fn(async (_ops: BlockOp[]) => { live = false; });

    const first = await reg.unseedProjectionBlocks('app_c', () => live, apply);
    expect(first).toEqual(['app_c:w']);

    // Second call: has() returns false, nothing to delete.
    const second = await reg.unseedProjectionBlocks('app_c', () => false, apply);
    expect(second).toEqual([]);
    expect(apply).toHaveBeenCalledOnce(); // not called again
  });

  it('does not touch blocks owned by a different app', async () => {
    const reg = new AppRegistry();
    reg.install(appManifest('app_d', {
      builders: [builder(['app_d:d1'])],
    }));
    reg.install(appManifest('app_e', {
      builders: [builder(['app_e:e1'])],
    }));

    const live = new Set<BlockName>(['app_d:d1', 'app_e:e1']);
    const appliedOps: BlockOp[] = [];
    const apply = vi.fn(async (ops: BlockOp[]) => { appliedOps.push(...ops); });

    // Unseed only app_d.
    await reg.unseedProjectionBlocks('app_d', (n) => live.has(n), apply);

    const targets = appliedOps.map((o) => (o as { kind: 'delete'; target: BlockName }).target);
    expect(targets).toEqual(['app_d:d1']); // app_e not touched
    expect(targets).not.toContain('app_e:e1');
  });

  it('returns [] without calling apply when app_id is unknown', async () => {
    const reg = new AppRegistry();
    const apply = vi.fn(async (_ops: BlockOp[]) => {});

    const removed = await reg.unseedProjectionBlocks('nonexistent', () => true, apply);

    expect(removed).toEqual([]);
    expect(apply).not.toHaveBeenCalled();
  });

  it('returns [] (and does not error) when called after uninstall (app already gone)', async () => {
    const reg = new AppRegistry();
    reg.install(appManifest('app_f', {
      builders: [builder(['app_f:f1'])],
    }));
    reg.uninstall('app_f');

    const apply = vi.fn(async (_ops: BlockOp[]) => {});
    const removed = await reg.unseedProjectionBlocks('app_f', () => true, apply);

    expect(removed).toEqual([]);
    expect(apply).not.toHaveBeenCalled();
  });

  it('returns names sorted for determinism', async () => {
    const reg = new AppRegistry();
    // outputs declared in reverse alphabetical order; result should still be sorted.
    reg.install(appManifest('app_g', {
      builders: [builder(['app_g:zzz', 'app_g:aaa', 'app_g:mmm'])],
    }));

    const removed = await reg.unseedProjectionBlocks('app_g', () => true, async () => {});
    expect(removed).toEqual(['app_g:aaa', 'app_g:mmm', 'app_g:zzz']);
  });
});

// ---------------------------------------------------------------------------
// ceiling_resolver seam
// ---------------------------------------------------------------------------

describe('ceiling_resolver (capability ceiling seam)', () => {
  it('no ceiling_resolver injected → install succeeds without any ceiling warnings', () => {
    const reg = new AppRegistry();
    // ceiling_resolver not set — existing behaviour must be preserved.
    const result = reg.install(appManifest('myapp', {
      commands: [command('do_it', ['block:write', 'cred:read_blob'])],
    }));

    expect(result.installed_id).toBe('myapp');
    const ceilingWarnings = result.warnings.filter((w) => w.includes('ceiling'));
    expect(ceilingWarnings).toHaveLength(0);
  });

  it('ceiling_resolver injected with full set → no ceiling warnings for built-in caps', () => {
    const reg = new AppRegistry();
    // "All built-in caps pass" ceiling.
    reg.ceiling_resolver = (_trust: AppTrustLevel) =>
      new Set(['block:write', 'block:read', 'net:http', 'cred:read_blob']);

    const result = reg.install(appManifest('myapp', {
      commands: [command('do_it', ['block:write', 'cred:read_blob'])],
    }));

    expect(result.installed_id).toBe('myapp');
    const ceilingWarnings = result.warnings.filter((w) => w.includes('ceiling'));
    expect(ceilingWarnings).toHaveLength(0);
  });

  it('ceiling_resolver injected with restricted set → reports warning for out-of-ceiling cap, but install still succeeds (report-only)', () => {
    const reg = new AppRegistry();
    // Ceiling that excludes cred:read_blob.
    reg.ceiling_resolver = (_trust: AppTrustLevel) =>
      new Set(['block:write', 'block:read', 'net:http']);

    const result = reg.install(appManifest('myapp', {
      commands: [command('do_it', ['block:write', 'cred:read_blob'])],
    }));

    // Install must succeed (report-only, not reject).
    expect(result.installed_id).toBe('myapp');
    expect(reg.get('myapp')).not.toBeNull();

    // A warning must be present for the out-of-ceiling cap.
    const ceilingWarnings = result.warnings.filter((w) => w.includes('ceiling'));
    expect(ceilingWarnings.length).toBeGreaterThanOrEqual(1);
    expect(ceilingWarnings.some((w) => w.includes('cred:read_blob'))).toBe(true);
  });

  it('ceiling check covers builder capabilities too', () => {
    const reg = new AppRegistry();
    reg.ceiling_resolver = (_trust: AppTrustLevel) => new Set(['block:write']);

    const result = reg.install(appManifest('myapp', {
      builders: [builderWithCaps(['myapp:out'], ['block:delete_physical'])],
    }));

    expect(result.installed_id).toBe('myapp');
    const ceilingWarnings = result.warnings.filter((w) => w.includes('ceiling'));
    expect(ceilingWarnings.length).toBeGreaterThanOrEqual(1);
    expect(ceilingWarnings.some((w) => w.includes('block:delete_physical'))).toBe(true);
  });

  it('ceiling check issues no warnings for commands with no capabilities declared', () => {
    const reg = new AppRegistry();
    reg.ceiling_resolver = (_trust: AppTrustLevel) => new Set<string>(); // empty ceiling

    // Command with no capabilities.
    const result = reg.install(appManifest('myapp', {
      commands: [command('no_caps')],
    }));

    expect(result.installed_id).toBe('myapp');
    const ceilingWarnings = result.warnings.filter((w) => w.includes('ceiling'));
    expect(ceilingWarnings).toHaveLength(0);
  });

  it('all out-of-ceiling caps across multiple commands produce individual warnings', () => {
    const reg = new AppRegistry();
    reg.ceiling_resolver = (_trust: AppTrustLevel) => new Set(['block:write']);

    const result = reg.install(appManifest('myapp', {
      commands: [
        command('cmd1', ['block:write', 'cred:read_blob']),
        command('cmd2', ['net:http', 'block:delete_physical']),
      ],
    }));

    const ceilingWarnings = result.warnings.filter((w) => w.includes('ceiling'));
    // Expect warnings for cred:read_blob, net:http, and block:delete_physical.
    expect(ceilingWarnings.length).toBe(3);
    expect(ceilingWarnings.some((w) => w.includes('cred:read_blob'))).toBe(true);
    expect(ceilingWarnings.some((w) => w.includes('net:http'))).toBe(true);
    expect(ceilingWarnings.some((w) => w.includes('block:delete_physical'))).toBe(true);
  });

  it('ceiling_resolver receives trust level "trusted" for v1 apps', () => {
    const reg = new AppRegistry();
    const trustLevels: AppTrustLevel[] = [];
    reg.ceiling_resolver = (trust: AppTrustLevel) => {
      trustLevels.push(trust);
      return new Set(['block:write']);
    };

    reg.install(appManifest('myapp', {
      commands: [command('do_it', ['block:write'])],
    }));

    // v1 always calls resolver with 'trusted'.
    expect(trustLevels.every((t) => t === 'trusted')).toBe(true);
  });
});
