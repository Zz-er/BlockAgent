/**
 * app/state_quota.ts — UH-2 SS4a / task#16 (architecture §7 前置3): the byte quota
 * on a SANDBOXED App's state cell.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * A sandboxed App's state is the SOURCE the GenericProjectionBuilder (SS4b) renders
 * into the LLM context (方案 A declarative projection). An untrusted App that writes
 * an ever-growing or huge `state` would (a) bloat the prompt and (b) — because a
 * projection block changing every turn poisons the cache prefix — defeat the volatile
 * tier pin. The schema check (INV #14) gates SHAPE, not SIZE; this is the size gate.
 *
 * ── Scope (fail-closed, zero-regression) ───────────────────────────────────
 * The quota applies ONLY to a `trust:'sandboxed'` App, on BOTH state-write paths:
 *   - in-process `AppContext.set_state` (registry `makeContext`), and
 *   - the child-process write-back `AppRegistry.write_app_cell` (a sandboxed child
 *     framing its set_state home — the same untrusted App, different carrier).
 * A trusted App is unmetered (it is on the trusted render path already), so existing
 * built-in Apps are byte-for-byte unaffected.
 *
 * ── Behavior: REJECT, never clip ────────────────────────────────────────────
 * On over-quota we THROW (the caller leaves the cell untouched — the prior state
 * stands), rather than silently clipping. Clipping would mutate the App's own state
 * semantics behind its back (a half-written object), which is worse than a rejected
 * transition the App can observe and handle. This mirrors the schema-breach path,
 * which also rejects-and-keeps-previous (INV #14).
 *
 * Pure + O(size): one `JSON.stringify` + a byte count. No IO, no clock, no random.
 */

import type { AppTrust } from './types.js';
import { effectiveTrust } from './host.js';

/**
 * Default ceiling for a sandboxed App's serialized state, in BYTES (UTF-8). 64 KiB:
 * generous for legitimate scalar/小记录 state (the projection use-case — a few
 * fields, a short list), but far below "bloat the prompt / poison the cache". Not a
 * config knob today (a sandboxed App must not be able to widen its own limit); a host
 * may pass an override to `assertStateWithinQuota` if a future need arises.
 */
export const DEFAULT_MAX_STATE_BYTES = 64 * 1024;

/**
 * Thrown when a sandboxed App's next state exceeds the byte quota. The caller catches
 * it the same way it catches a schema breach: the cell is NOT written, the App keeps
 * its previous state. Carries the measured/limit bytes for tests + telemetry.
 */
export class AppStateQuotaError extends Error {
  constructor(
    readonly app_id: string,
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(
      `AppStateQuotaError[${app_id}]: state is ${bytes} bytes, exceeds the ` +
        `${limit}-byte quota for a sandboxed app`,
    );
    this.name = 'AppStateQuotaError';
  }
}

/**
 * The UTF-8 byte length of `value`'s JSON serialization. The serialized form is what
 * actually rides the cell / RPC frame and what the projection renders, so it is the
 * right thing to meter (not a shallow key count). `undefined` (which `JSON.stringify`
 * drops to `undefined`, not a string) measures as 0 — an empty/cleared cell.
 */
export function stateByteLength(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) return 0;
  // Byte length, not code-unit length: a multibyte char (CJK / emoji) costs its real
  // wire size, so the quota meters the true prompt/RPC footprint.
  return Buffer.byteLength(json, 'utf8');
}

/**
 * Enforce the byte quota for a sandboxed App's next state. No-op for a trusted App
 * (returns immediately — the gate is sandboxed-only, zero regression). For a sandboxed
 * App, throws `AppStateQuotaError` when `next` serializes to more than `limit` bytes
 * so the caller leaves the cell untouched. `trust` is the App's authored
 * `manifest.trust`; absent ⇒ trusted (the codebase-wide default).
 */
export function assertStateWithinQuota(
  app_id: string,
  trust: AppTrust | undefined,
  next: unknown,
  limit: number = DEFAULT_MAX_STATE_BYTES,
): void {
  if (effectiveTrust(trust) !== 'sandboxed') return; // trusted apps are unmetered
  const bytes = stateByteLength(next);
  if (bytes > limit) throw new AppStateQuotaError(app_id, bytes, limit);
}
