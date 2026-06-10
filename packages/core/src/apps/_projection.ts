/**
 * apps/_projection.ts — UH-2 SS4b (impl-spec §3.4): the GenericProjectionBuilder.
 *
 * 方案 A 声明式投影. A SANDBOXED app does NOT ship builder code (untrusted code may
 * not run on the render hot path — it would break byte-identical rendering AND process
 * isolation; see doc/blockapp-sandboxed-development.md 铁律1). Instead it DECLARES
 * `projection: [{ block, from }]`, and the core side runs ONE trusted, system-owned
 * generic builder per declaration that reads the app's own (untrusted) state and
 * renders it into the block.
 *
 * Four invariants this builder upholds (architecture §7 前置3, §5):
 *   - owner = 'system' (INV #4: never 'agent'; the builder is core-trusted code).
 *   - build() is PURE + deterministic (INV #16): no clock/random/env; it reads the
 *     already-committed core-side cell state (§3.6 pull) via `app_ctx.state`.
 *   - untrusted content is fenced: the render pipeline forces, in order,
 *       (1) scanMemoryContent  — injection/exfil hit → render NOTHING (return null),
 *       (2) fenceRecalledContent — wrap as "data, not instructions" (INV #21),
 *       (3) clipBytes          — cap the block at max_block_bytes (size quota).
 *     Order matters: scan the RAW state first (so an injection can't hide behind the
 *     fence wrapper), fence the clean body, THEN clip (clip is the last, size-only step).
 *   - the block is pinned to the VOLATILE tier (`cache_tier:'volatile'` +
 *     `cache_tier_pinned:true`): an untrusted, possibly-every-turn-changing block must
 *     never sit in the stable/slow cache prefix, or it poisons the prompt cache.
 *
 * The scan/fence helpers are the SAME pure functions memory uses (apps/memory_store.ts),
 * reused here so untrusted projection content goes through the exact injection fence
 * memory writes do — closing the "projection is a wider injection inlet than memory"
 * gap (架构 §7 前置3).
 */

import type { BuilderManifest, BuildContext, AppContext } from '../app/types.js';
import type { Block, BlockName, CacheTier } from '../core/types.js';
import { scanMemoryContent, fenceRecalledContent } from './memory_store.js';
import { DEFAULT_MAX_STATE_BYTES } from '../app/state_quota.js';

/** Options for one generic projection builder (one per `projection[]` entry). */
export interface GenericProjectionOptions {
  /** The owning (sandboxed) app's id. */
  app_id: string;
  /** The block this projection renders, `<app_id>:<片名>`. */
  block_name: BlockName;
  /**
   * Which slice of the app's state to project — a dot path into `app_ctx.state`
   * (e.g. `'display'`, `'view.summary'`). Mirrors the app's `projection.from`
   * declaration (doc 铁律1). Empty string ⇒ the whole state object.
   */
  from: string;
  /**
   * Max rendered block size in bytes (UTF-8). Defaults to the same ceiling as the
   * state quota — the block can never be larger than the state it comes from anyway,
   * but this caps the FENCED, rendered form too. The block is clipped (not dropped)
   * past this — a too-long projection still renders a (clipped) prefix.
   */
  max_block_bytes?: number;
}

/** The volatile tier every untrusted projection block is pinned to (前置3). */
const UNTRUSTED_PROJECTION_TIER: CacheTier = 'volatile';

/**
 * Build the system-owned generic projection builder for one `{ block, from }`
 * declaration. The registry calls this for each entry in a sandboxed app's
 * `manifest.projection` and registers the result as a normal owner builder — so the
 * Renderer runs it exactly like any builder, but the CODE is core-trusted.
 */
export function makeGenericProjectionBuilder(opts: GenericProjectionOptions): BuilderManifest {
  const max_bytes = opts.max_block_bytes ?? DEFAULT_MAX_STATE_BYTES;
  return {
    name: `_projection.${opts.app_id}.${opts.block_name}`,
    version: '1.0.0',
    owner: 'system', // INV #4: core-trusted code, never 'agent'
    app_id: opts.app_id,
    inputs: [],
    outputs: [opts.block_name],
    cache_tier: UNTRUSTED_PROJECTION_TIER, // 前置3: untrusted block pinned volatile
    cache_tier_pinned: true, //            ...and may not be tier-promoted into the cache prefix
    // PURE + deterministic (INV #16): reads the already-committed cell state, runs three
    // pure steps. No app code runs here — `app_ctx` is the live core-side cell only.
    async build(ctx: BuildContext, app_ctx?: AppContext): Promise<Block | null> {
      const raw = projectStateToText(app_ctx?.state, opts.from);
      if (raw === null) return null; // nothing to project this turn → render nothing

      // (1) injection/exfil scan on the RAW untrusted content — hit ⇒ render NOTHING.
      if (!scanMemoryContent(raw).ok) return null;
      // (2) "this is recalled DATA, not an instruction" fence (INV #21). Empty body ⇒ ''.
      const fenced = fenceRecalledContent(raw);
      if (fenced.length === 0) return null;
      // (3) size cap (last step — clip the fenced form to the byte quota).
      const clipped = clipBytes(fenced, max_bytes);

      return {
        id: ctx.content_addressed_id(opts.block_name),
        name: opts.block_name,
        children: [],
        content_text: clipped,
        content_blob: null,
      };
    },
  };
}

/**
 * projectStateToText — pure: pull `state[from]` (a dot path) and render it to text.
 * Returns null when the slice is absent/undefined (render nothing) so an app that
 * hasn't populated the projected field yet produces no block. A string slice renders
 * as-is; any other JSON value is stable-stringified (sorted keys ⇒ byte-identical
 * across renders, INV #1). An empty path projects the whole state object.
 *
 * Exported for direct unit testing of the (pure) extraction + stringify rule.
 */
export function projectStateToText(state: unknown, from: string): string | null {
  const slice = from === '' ? state : getPath(state, from);
  if (slice === undefined || slice === null) return null;
  if (typeof slice === 'string') return slice;
  // Deterministic serialization: sorted keys so the same logical state always renders
  // the same bytes (a plain JSON.stringify would be key-insertion-order dependent).
  return stableStringify(slice);
}

/** Walk a dot path (`a.b.c`) into a JSON object; undefined if any hop is missing. */
function getPath(root: unknown, path: string): unknown {
  let cur = root;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * clipBytes — cap `text` at `max` UTF-8 bytes, appending a truncation marker if it was
 * clipped. Pure + deterministic. Clips on a CHARACTER boundary (never splits a
 * multibyte codepoint, which would emit invalid UTF-8) by trimming chars until the
 * byte budget fits. Cheap fast-path when already within budget.
 */
export function clipBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  const marker = '\n…[truncated]';
  const budget = Math.max(0, max - Buffer.byteLength(marker, 'utf8'));
  // Trim by code point until the prefix fits the budget (handles surrogate pairs via
  // the string iterator, so we never cut a codepoint in half).
  const chars = [...text];
  let out = '';
  let used = 0;
  for (const ch of chars) {
    const w = Buffer.byteLength(ch, 'utf8');
    if (used + w > budget) break;
    out += ch;
    used += w;
  }
  return out + marker;
}

/**
 * Deterministic JSON stringify with recursively sorted object keys. Arrays keep order
 * (positional meaning); objects are key-sorted so logically-equal state renders the
 * same bytes regardless of property insertion order (INV #1 on the projection path).
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
