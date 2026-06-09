/**
 * test/host.test.ts — unified-host UH-1: resolveHost / trust→carrier derivation.
 *
 * Covers app/host.ts: the default-trust rule, the trust→host defaults, the
 * override precedence, and the security invariant (sandboxed app can never be
 * hosted in-process — whether via manifest host or operator override).
 */

import { describe, expect, it } from 'vitest';

import { defaultHostFor, effectiveTrust, resolveHost } from '../src/app/host.js';
import type { AppHostKind } from '../src/app/types.js';

describe('effectiveTrust', () => {
  it('defaults an absent trust to trusted', () => {
    expect(effectiveTrust(undefined)).toBe('trusted');
  });
  it('passes through an explicit trust', () => {
    expect(effectiveTrust('sandboxed')).toBe('sandboxed');
    expect(effectiveTrust('trusted')).toBe('trusted');
  });
});

describe('defaultHostFor', () => {
  it('maps trusted → in-process, sandboxed → child-process', () => {
    expect(defaultHostFor('trusted')).toBe('in-process');
    expect(defaultHostFor('sandboxed')).toBe('child-process');
  });
});

describe('resolveHost', () => {
  it('defaults a trusted app (no trust/host) to in-process', () => {
    expect(resolveHost({ id: 'a' })).toBe('in-process');
  });

  it('defaults a sandboxed app to child-process', () => {
    expect(resolveHost({ id: 'a', trust: 'sandboxed' })).toBe('child-process');
  });

  it('honors a manifest host within the legal range', () => {
    // a trusted app may opt into isolation
    expect(resolveHost({ id: 'a', trust: 'trusted', host: 'child-process' })).toBe(
      'child-process',
    );
    expect(resolveHost({ id: 'a', trust: 'sandboxed', host: 'child-process' })).toBe(
      'child-process',
    );
  });

  it('lets an operator override beat the manifest', () => {
    expect(resolveHost({ id: 'a', trust: 'trusted', host: 'in-process' }, 'child-process')).toBe(
      'child-process',
    );
  });

  it('THROWS when a sandboxed app would be hosted in-process (manifest host)', () => {
    expect(() => resolveHost({ id: 'evil', trust: 'sandboxed', host: 'in-process' })).toThrow(
      /sandboxed/,
    );
  });

  it('THROWS when an operator override tries to downgrade a sandboxed app to in-process', () => {
    expect(() => resolveHost({ id: 'evil', trust: 'sandboxed' }, 'in-process')).toThrow(
      /cannot be hosted in-process/,
    );
  });

  it('is pure: same inputs → same output', () => {
    const m = { id: 'a', trust: 'sandboxed' as const };
    const first: AppHostKind = resolveHost(m);
    const second: AppHostKind = resolveHost(m);
    expect(first).toBe(second);
  });
});
