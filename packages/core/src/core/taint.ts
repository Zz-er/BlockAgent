/**
 * core/taint.ts — unified-host UH-2/SS3: sandbox-taint propagation along the
 * invoke_command CALL CHAIN (carrier-gating fatal fix; team-lead ruling = ALS).
 *
 * ── The hole ──────────────────────────────────────────────────────────────────
 * `AppContext.invoke_command` (registry.ts) stamps a NESTED cross-App call with
 * `{invoker:'app', identity:app_id}` and NO trust. So a chain
 *     sandboxed → trustedA.cmd → (inside its handler) trustedB.dangerouscmd
 * ends with `effective_trust(trust_of(trustedB), undefined) = trusted` on the last
 * hop — the trusted intermediary LAUNDERS the sandbox taint, and the dangerous op
 * runs under the FULL ceiling. The single-call stamp is not enough: taint must
 * travel the whole nested chain.
 *
 * ── Why AsyncLocalStorage, not a global push/pop stack (team-lead ruling) ──────
 * Command handlers are async and INTERLEAVE: §3.7 runs consume-refresh providers
 * under `Promise.all`, and any `await` inside a handler yields the event loop to a
 * concurrent chain. A module-global "current trust" stack would let chain A's
 * sandboxed taint leak onto a concurrently-suspended chain B (and vice-versa) — a
 * safety-FATAL cross-contamination. `AsyncLocalStorage` binds the current chain
 * trust to the async execution context itself: each chain carries its own store,
 * interleaving never crosses them. `node:async_hooks` is a Node built-in, so this
 * stays inside @block-agent/core's empty runtime closure (CI core-closure).
 *
 * ── How it threads (the four touchpoints) ──────────────────────────────────────
 * 1. `Operations.invoke_command_detailed`: after computing THIS call's effective
 *    trust, run `route(...)` inside `run_in_chain(stricter(chain, thisCall), …)`.
 *    A nested `ctx.invoke_command` inside the handler therefore executes WITHIN this
 *    chain's store.
 * 2. `AppContext.invoke_command` (registry): reads `current_chain_trust()` and stamps
 *    it onto the nested ctx as `trust`, so the engine's `effective_trust` takes the
 *    stricter of the target's resolved trust and the inherited chain trust.
 * 3. `Operations.apply` / per-op re-gate: fold `current_chain_trust()` into the
 *    per-op ctx (stricter with any explicit stamp), so even an unstamped op inside a
 *    tainted chain is gated under the sandboxed floor (team-lead ④).
 * 4. (SS4/task#19, same source) provenance fencing reads the same chain trust to
 *    decide untrusted-origin tagging.
 *
 * PURE wrt the closure: only `node:async_hooks` + a type-only `AppTrust` import.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { AppTrust } from '../app/types.js';

/** What rides the async chain: the current effective trust of the call chain. */
export interface TaintContext {
  trust: AppTrust;
}

/**
 * THE module-level store (one per process). Both `core/operations.ts` (writer) and
 * `app/registry.ts` (reader, via `AppContext.invoke_command`) import THIS singleton,
 * so a value `run`-bound on one side is visible to the other within the same async
 * chain. Module identity is the contract — never construct a second instance.
 */
const taintStore = new AsyncLocalStorage<TaintContext>();

/**
 * The stricter of two trusts ("sandboxed wins"), with the codebase-wide "absent
 * means trusted" default on both sides. Mirrors `policy.ts effective_trust` /
 * `host.ts effectiveTrust` — taint can only TIGHTEN as it flows down a chain, never
 * relax (a trusted callee inside a sandboxed chain stays sandboxed).
 */
export function stricter_trust(a: AppTrust | undefined, b: AppTrust | undefined): AppTrust {
  return a === 'sandboxed' || b === 'sandboxed' ? 'sandboxed' : 'trusted';
}

/**
 * The trust of the CURRENTLY-EXECUTING call chain, or `undefined` outside any chain
 * (a top-level call, a plain in-process read). Callers fold this into their own
 * trust decision with `stricter_trust` — they MUST NOT treat `undefined` as trusted
 * on its own; it just means "no inherited chain floor".
 */
export function current_chain_trust(): AppTrust | undefined {
  return taintStore.getStore()?.trust;
}

/**
 * Run `fn` with the chain trust set to `trust` for the whole async subtree it spawns
 * (including any `await`ed nested `invoke_command`). Idempotent re-entry: a nested
 * `run_in_chain` simply layers a (stricter) value for its own subtree. Returns `fn`'s
 * result/promise unchanged.
 */
export function run_in_chain<T>(trust: AppTrust, fn: () => T): T {
  return taintStore.run({ trust }, fn);
}
