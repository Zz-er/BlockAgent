// ============================================================================
// Pure diff engine — block-card transitions + the stable-churn alarm (§4.3/§4.5)
// ============================================================================
//
// These are pure functions over protocol payloads (no React, no I/O), so the diff
// logic is testable in isolation and the host stays the single source of truth.

import type { BlockAttribution, CacheTier } from '../protocol/index.js';
import type { CardTransition, ChurnAlarm } from './types.js';

export interface CardDiff {
  attribution: BlockAttribution;
  transition: CardTransition;
  /** byte delta vs the previous turn (0 for entered/left/unchanged). */
  delta: number;
  /** true if this card should flash this turn. */
  changed: boolean;
}

/**
 * Compare a tier's previous block set with the current one, by block name +
 * content hash, and classify each card (§4.3). `left` cards are returned too (so
 * the UI can shrink-and-unmount them); callers decide how long to keep them.
 */
export function diffBlocks(
  prev: readonly BlockAttribution[] | undefined,
  next: readonly BlockAttribution[],
): { current: CardDiff[]; left: BlockAttribution[] } {
  const prevByName = new Map<string, BlockAttribution>();
  for (const b of prev ?? []) prevByName.set(b.name, b);

  const current: CardDiff[] = [];
  const seen = new Set<string>();

  for (const block of next) {
    seen.add(block.name);
    const before = prevByName.get(block.name);

    if (!before) {
      current.push({ attribution: block, transition: 'entered', delta: 0, changed: true });
      continue;
    }
    const delta = block.bytes - before.bytes;
    if (delta !== 0) {
      current.push({
        attribution: block,
        transition: delta > 0 ? 'grew' : 'shrank',
        delta,
        changed: true,
      });
    } else if (before.content_hash !== block.content_hash) {
      current.push({ attribution: block, transition: 'changed-in-place', delta: 0, changed: true });
    } else {
      current.push({ attribution: block, transition: 'unchanged', delta: 0, changed: false });
    }
  }

  const left: BlockAttribution[] = [];
  for (const b of prev ?? []) {
    if (!seen.has(b.name)) left.push(b);
  }
  return { current, left };
}

/**
 * Decide the stable-prefix churn alarm from two turns' segment_hashes (§4.5).
 * Three triggers — value change, appeared (absent→present), disappeared
 * (present→absent) — because in a Partial map, the *presence* of the `stable` key
 * is itself meaningful.
 *
 * `changedStableBlocks` (if the caller pulled the stable tier's blocks) names the
 * offending blocks in the alarm banner.
 */
export function computeChurnAlarm(
  prevHashes: Partial<Record<CacheTier, string>> | undefined,
  nextHashes: Partial<Record<CacheTier, string>>,
  changedStableBlocks: string[] = [],
): ChurnAlarm {
  const before = prevHashes?.stable;
  const after = nextHashes.stable;

  // No previous turn yet → nothing to compare; not an alarm.
  if (prevHashes === undefined) {
    return { active: false, blocks: [], reason: null };
  }

  let reason: ChurnAlarm['reason'] = null;
  if (before !== undefined && after !== undefined && before !== after) reason = 'value';
  else if (before === undefined && after !== undefined) reason = 'appeared';
  else if (before !== undefined && after === undefined) reason = 'disappeared';

  return {
    active: reason !== null,
    blocks: changedStableBlocks,
    reason,
  };
}

/** Which tiers' segment hashes moved between two turns (free, no bytes). */
export function changedTiers(
  prevHashes: Partial<Record<CacheTier, string>> | undefined,
  nextHashes: Partial<Record<CacheTier, string>>,
): Set<CacheTier> {
  const tiers: CacheTier[] = ['stable', 'slow_changing', 'volatile'];
  const changed = new Set<CacheTier>();
  for (const tier of tiers) {
    const before = prevHashes?.[tier];
    const after = nextHashes[tier];
    if (before !== after) changed.add(tier);
  }
  return changed;
}
