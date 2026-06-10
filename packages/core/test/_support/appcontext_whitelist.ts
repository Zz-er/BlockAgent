/**
 * test/_support/appcontext_whitelist.ts — the SINGLE source of truth for the
 * AppContext member whitelist (UH-2/SS3b parity gate).
 *
 * The in-process AppContext (policy_ceiling.test.ts) and the cross-process
 * AppContextProxy (appcontext_proxy.test.ts) MUST expose the EXACT same member set —
 * "interface orthogonal to carrier" (impl-spec §3.3). If a future change adds a member
 * to one carrier but not the other, or leaks a chokepoint handle (apply / Operations /
 * the RpcChannel / its transport / the AppHost) onto either, the shared assertions
 * here fail. Keeping ONE helper (not two divergent copies) is the point: a parity drift
 * cannot hide behind two test files that disagree (Raven SS3 hard-gate).
 */

import { expect } from 'vitest';

/** The exact members an app's AppContext (in-process OR proxied) is allowed to hold. */
export const APP_CONTEXT_WHITELIST: readonly string[] = [
  'app_id',
  'state',
  'set_state',
  'list_commands',
  'list_builders',
  'list_blocks',
  'invoke_command',
  'read',
  'on',
  'emit',
  'spawn_system_agent',
  'wake',
];

/** Every member NAME reachable on an object, including its whole prototype chain. */
export function allMemberNames(obj: object): Set<string> {
  const names = new Set<string>();
  let cur: object | null = obj;
  while (cur && cur !== Object.prototype) {
    for (const k of Object.getOwnPropertyNames(cur)) names.add(k);
    cur = Object.getPrototypeOf(cur);
  }
  return names;
}

/**
 * Assert an object is a legal AppContext surface for a sandboxed app: its ENUMERABLE
 * OWN members are exactly the whitelist, and NOTHING reachable (own + proto) is named
 * `apply` (any casing) or fails the `forbiddenValue` probe (e.g. an Operations / RPC /
 * host handle). `forbiddenValue(v)` returns true for a value that must never leak.
 */
export function assertAppContextWhitelist(
  ctx: object,
  forbiddenValue: (v: unknown) => boolean = () => false,
): void {
  // (1) exact own-member set — adding/removing a member fails this (conscious review).
  expect(new Set(Object.keys(ctx))).toEqual(new Set(APP_CONTEXT_WHITELIST));

  // (2) no `apply` reachable anywhere (own + proto), any casing.
  const members = allMemberNames(ctx);
  expect(members.has('apply')).toBe(false);
  for (const name of members) {
    expect(name.toLowerCase()).not.toBe('apply');
  }

  // (3) no member VALUE is a forbidden handle (Operations / RpcChannel / Transport /
  //     AppHost / write-end taint store). Probe defensively — a throwing getter exposes
  //     nothing usable.
  for (const name of members) {
    let value: unknown;
    try {
      value = (ctx as Record<string, unknown>)[name];
    } catch {
      continue;
    }
    expect(forbiddenValue(value)).toBe(false);
  }
}
