/**
 * app/host.ts — unified-host: trust → host-carrier resolution.
 *
 * The unified-host model keeps ONE BlockApp shape (`AppManifest`) and turns
 * "in-process vs cross-process" into a deployment config: a manifest declares its
 * `trust` (and optionally a `host` override), and the runtime resolves which
 * carrier the App runs in. This mirrors VSCode's `extensionKind → host kind`
 * derivation — the interface (AppContext) is identical regardless of carrier; only
 * the carrier differs (direct reference vs RPC proxy).
 *
 * Design: ai_com/design/blockapp-unified-host-architecture.md §4.1 (位置作配置) +
 * blockapp-unified-host-impl-spec.md §3.1 (`resolveHost`). This module is PURE:
 * no fs / clock / random / env, zero dependencies beyond the type-only import of
 * the trust/host unions — so it stays inside @block-agent/core's empty runtime
 * closure (CI core-closure check).
 *
 * Scope: BOTH carriers are wired (UH-2 landed). `'in-process'` runs trusted apps
 * directly; a `'child-process'` resolution forks a `ChildProcessHost` (its production
 * factory is injected in `launch.ts`, fail-closed — never degrades a sandboxed app to
 * in-process). This module only RESOLVES the carrier kind — it never imports either
 * host, so the empty-closure invariant holds. Not there yet: no sandboxed app ships,
 * and hot-installing one is UH-3.
 */

import type { AppHostKind, AppTrust } from './types.js';

/**
 * The effective trust of a manifest field value: absent ⇒ `'trusted'`. Centralized
 * so the "absent means trusted" default lives in exactly one place (callers should
 * not re-implement the `?? 'trusted'`).
 */
export function effectiveTrust(trust: AppTrust | undefined): AppTrust {
  return trust ?? 'trusted';
}

/**
 * The carrier a given trust defaults to when a manifest does not pin `host`:
 *   trusted   → in-process   (direct reference, zero overhead)
 *   sandboxed → child-process (isolated OS process, RPC-proxied AppContext)
 */
export function defaultHostFor(trust: AppTrust): AppHostKind {
  return trust === 'sandboxed' ? 'child-process' : 'in-process';
}

/**
 * resolveHost — decide which carrier an App runs in (UH-1, impl-spec §3.1).
 *
 * Precedence: explicit `override` (operator config) > manifest `host` > derived
 * from `trust`. The ONE hard rule it enforces is the security invariant: a
 * `trust:'sandboxed'` App may never be hosted `'in-process'` (that would put
 * untrusted code in the trusted, in-process domain) — any attempt throws, whether
 * it comes from the manifest's own `host` or an operator override. A `'trusted'`
 * App may run either carrier (operators can opt a trusted App into isolation).
 *
 * Pure + deterministic; never reads ambient state. `app_id` is only used to make
 * the thrown message actionable.
 */
export function resolveHost(
  manifest: { id: string; trust?: AppTrust; host?: AppHostKind },
  override?: AppHostKind,
): AppHostKind {
  const trust = effectiveTrust(manifest.trust);
  const want = override ?? manifest.host ?? defaultHostFor(trust);
  if (trust === 'sandboxed' && want === 'in-process') {
    throw new Error(
      `app '${manifest.id}': a sandboxed (untrusted) app cannot be hosted in-process; ` +
        `use host:'child-process' (or remove the override).`,
    );
  }
  return want;
}
