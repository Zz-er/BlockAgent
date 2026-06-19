/**
 * test/state_quota.test.ts — UH-2 SS4a / task#16 (架构 §7 前置3): the sandboxed
 * state byte quota.
 *
 * Two surfaces:
 *   1. the pure predicate (`stateByteLength` / `assertStateWithinQuota`) — boundary +
 *      trust-scope unit coverage, independent of the registry wiring;
 *   2. the two LIVE write paths the registry exposes — in-process `AppContext.set_state`
 *      and the child-process write-back `write_app_cell` — proving a sandboxed over-quota
 *      write is REJECTED (cell keeps its previous value) on BOTH carriers, while a
 *      trusted app is unmetered (zero regression).
 *
 * Raven SS4 ②: "超大 state / 每轮变 → 字节配额拦 cache 污染" — these are the gatekeeper
 * tests for the size half of that (the tier-pin half lands with the projection builder).
 */

import { describe, expect, it } from 'vitest';

import { AppRegistry } from '../src/app/registry.js';
import {
  DEFAULT_MAX_STATE_BYTES,
  AppStateQuotaError,
  stateByteLength,
  assertStateWithinQuota,
} from '../src/app/state_quota.js';
import type { AppManifest } from '../src/app/types.js';
import { inProcessChildFactory } from './_support/in_process_child_factory.js';

/**
 * Install an app, injecting the test-only in-process child factory FIRST so a
 * `trust:'sandboxed'` manifest runs in-process (production forks a real child; engine
 * tests run it in-process — SS3c footgun guard, see _support/in_process_child_factory).
 * A trusted app ignores the factory.
 */
function installApp(reg: AppRegistry, manifest: AppManifest): void {
  reg.child_host_factory = inProcessChildFactory;
  reg.install(manifest);
}

// ---------------------------------------------------------------------------
// Pure predicate
// ---------------------------------------------------------------------------

describe('stateByteLength — UTF-8 byte length of the JSON serialization', () => {
  it('measures the JSON form, not a key count', () => {
    expect(stateByteLength({ a: 1 })).toBe(JSON.stringify({ a: 1 }).length); // ASCII: bytes == chars
  });

  it('counts multibyte chars by their real wire size', () => {
    // A CJK char is 3 UTF-8 bytes; `"中"` serializes to `"中"` (quote + char + quote).
    expect(stateByteLength('中')).toBe(Buffer.byteLength(JSON.stringify('中'), 'utf8'));
    expect(stateByteLength('中')).toBeGreaterThan('中'.length); // bytes > code units
  });

  it('treats undefined (a cleared cell) as 0 bytes', () => {
    expect(stateByteLength(undefined)).toBe(0);
  });
});

describe('assertStateWithinQuota — trust-scoped, fail-closed', () => {
  const big = 'x'.repeat(DEFAULT_MAX_STATE_BYTES + 1); // serializes to > the limit

  it('THROWS for a sandboxed app over quota', () => {
    expect(() => assertStateWithinQuota('evil', 'sandboxed', big)).toThrow(AppStateQuotaError);
  });

  it('does NOT throw for a sandboxed app within quota', () => {
    expect(() => assertStateWithinQuota('evil', 'sandboxed', { ok: true })).not.toThrow();
  });

  it('NEVER throws for a trusted app, even far over the limit (unmetered)', () => {
    expect(() => assertStateWithinQuota('builtin', 'trusted', big)).not.toThrow();
    expect(() => assertStateWithinQuota('builtin', undefined, big)).not.toThrow(); // absent ⇒ trusted
  });

  it('the thrown error carries measured bytes and the limit', () => {
    try {
      assertStateWithinQuota('evil', 'sandboxed', big);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppStateQuotaError);
      const e = err as AppStateQuotaError;
      expect(e.limit).toBe(DEFAULT_MAX_STATE_BYTES);
      expect(e.bytes).toBeGreaterThan(DEFAULT_MAX_STATE_BYTES);
    }
  });

  it('respects a caller-supplied lower limit', () => {
    expect(() => assertStateWithinQuota('evil', 'sandboxed', 'abcdef', 4)).toThrow(AppStateQuotaError);
  });

  it('P0.4 force: meters a TRUSTED app when force=true (declares-projection lane)', () => {
    // A trusted app is normally unmetered, but the registry passes force=true when it
    // DECLARES projection — its state reaches the prompt via the generic builder, so it
    // must respect the quota even though it is trusted (GUARD2).
    expect(() => assertStateWithinQuota('proj', 'trusted', big, undefined, true)).toThrow(
      AppStateQuotaError,
    );
    // ...and force=false (the default) keeps a trusted app unmetered (zero regression).
    expect(() => assertStateWithinQuota('proj', 'trusted', big, undefined, false)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Live write paths through the registry
// ---------------------------------------------------------------------------

/** A minimal app, parameterized by trust, with a free-form `data` state field. */
function quotaApp(trust: 'trusted' | 'sandboxed'): AppManifest {
  return {
    id: 'q',
    version: '0.0.0',
    depends_on: [],
    tree_namespace: '/q',
    initial_state: { data: 'seed' },
    // Permissive schema: any object passes the shape check, so the quota is the only
    // gate under test (not the schema check).
    state_schema: { type: 'object' },
    trust,
    builders: [],
    commands: [],
  };
}

const OVERSIZED = 'x'.repeat(DEFAULT_MAX_STATE_BYTES + 1);

describe('in-process set_state quota (AppContext.set_state)', () => {
  it('REJECTS a sandboxed over-quota set_state and keeps the previous state', () => {
    const reg = new AppRegistry();
    installApp(reg, quotaApp('sandboxed'));
    const ctx = reg.get_app_context('q')!;
    expect(() => ctx.set_state(() => ({ data: OVERSIZED }))).toThrow(AppStateQuotaError);
    // The cell is untouched — the prior seed stands (reject, never clip).
    expect((ctx.state as { data: string }).data).toBe('seed');
  });

  it('ALLOWS a sandboxed within-quota set_state', () => {
    const reg = new AppRegistry();
    installApp(reg, quotaApp('sandboxed'));
    const ctx = reg.get_app_context('q')!;
    ctx.set_state(() => ({ data: 'small' }));
    expect((ctx.state as { data: string }).data).toBe('small');
  });

  it('does NOT meter a trusted app (zero regression — large state applies)', () => {
    const reg = new AppRegistry();
    installApp(reg, quotaApp('trusted'));
    const ctx = reg.get_app_context('q')!;
    expect(() => ctx.set_state(() => ({ data: OVERSIZED }))).not.toThrow();
    expect((ctx.state as { data: string }).data).toBe(OVERSIZED);
  });
});

describe('child-process write-back quota (AppRegistry.write_app_cell)', () => {
  it('REJECTS a sandboxed over-quota write-back and keeps the previous cell', () => {
    const reg = new AppRegistry();
    installApp(reg, quotaApp('sandboxed'));
    expect(() => reg.write_app_cell('q', { data: OVERSIZED })).toThrow(AppStateQuotaError);
    expect((reg.get_app_context('q')!.state as { data: string }).data).toBe('seed');
  });

  it('ALLOWS a sandboxed within-quota write-back', () => {
    const reg = new AppRegistry();
    installApp(reg, quotaApp('sandboxed'));
    reg.write_app_cell('q', { data: 'fresh' });
    expect((reg.get_app_context('q')!.state as { data: string }).data).toBe('fresh');
  });

  it('does NOT meter a trusted app write-back (zero regression)', () => {
    const reg = new AppRegistry();
    installApp(reg, quotaApp('trusted'));
    expect(() => reg.write_app_cell('q', { data: OVERSIZED })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// P0.4 GUARD2 — a TRUSTED app that DECLARES projection is metered (set_state)
// ---------------------------------------------------------------------------

describe('declares-projection widens metering to a trusted app', () => {
  /** A TRUSTED app that declares projection (no own builder for the block — GUARD1). */
  function projectingTrustedApp(): AppManifest {
    return {
      id: 'q',
      version: '0.0.0',
      depends_on: [],
      tree_namespace: '/q',
      initial_state: { data: 'seed' },
      state_schema: { type: 'object' },
      trust: 'trusted',
      builders: [],
      projection: [{ block: 'q:view', from: 'data' }],
      commands: [],
    };
  }

  it('REJECTS an over-quota set_state on a trusted declares-projection app', () => {
    const reg = new AppRegistry();
    reg.install(projectingTrustedApp()); // trusted: no child factory needed
    const ctx = reg.get_app_context('q')!;
    expect(() => ctx.set_state(() => ({ data: OVERSIZED }))).toThrow(AppStateQuotaError);
    expect((ctx.state as { data: string }).data).toBe('seed'); // cell untouched
  });

  it('ALLOWS a within-quota set_state on the same app', () => {
    const reg = new AppRegistry();
    reg.install(projectingTrustedApp());
    const ctx = reg.get_app_context('q')!;
    ctx.set_state(() => ({ data: 'small' }));
    expect((ctx.state as { data: string }).data).toBe('small');
  });
});
