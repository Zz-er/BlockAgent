// Client-side view models the React tree renders. These are derived from protocol
// frames (never imported from core); they live here so components stay declarative.

import type { BlockAttribution, CacheTier, TurnRecord } from '../protocol/index.js';

/** One tool_call the agent invoked (command name + whether it succeeded). */
export interface ToolCallEntry {
  name: string;
  ok: boolean;
}

/**
 * TurnActivity — the reasoning + tool-call trace accumulated during ONE agent response
 * (from the user's message until the agent's reply lands). Shown LIVE+expanded while the
 * turn runs, then COLLAPSED onto the agent's reply once it completes.
 */
export interface TurnActivity {
  thinking: string[];
  toolCalls: ToolCallEntry[];
}

/** A line in the conversation pane. */
export interface ChatEntry {
  id: string;
  role: 'user' | 'agent';
  text: string;
  /**
   * The thinking + tool-call trace that produced this reply (agent entries only). Rendered
   * as a collapsed disclosure under the bubble. Absent on user entries / a reply with no
   * surfaced activity.
   */
  activity?: TurnActivity;
}

/** A surfaced reasoning chunk (UI-only thinking stream). */
export interface ThinkingEntry {
  id: string;
  text: string;
  spawn_depth: number;
}

/** A normalized error banner item. */
export interface ErrorEntry {
  id: string;
  message: string;
  phase: 'send' | 'turn';
}

/** The transition state assigned to a card on each turn (§4.3). */
export type CardTransition =
  | 'entered'
  | 'left'
  | 'grew'
  | 'shrank'
  | 'changed-in-place'
  | 'unchanged';

/**
 * A block card's view model: its current attribution plus the per-turn diff verdict
 * and the transient `changed` flash flag (§4.5). `delta` is the byte change vs the
 * previous turn (0 unless grew/shrank).
 */
export interface BlockCardView extends BlockAttribution {
  transition: CardTransition;
  delta: number;
  /** transient highlight flag — set on change, cleared ~1.5s later. */
  flashing: boolean;
  /** lazily-fetched full rendered body (when the host serves verbose text). */
  body?: string;
}

/** One tier group in the sidebar, in fixed render order. */
export interface TierGroup {
  tier: CacheTier;
  cards: BlockCardView[];
  /** byte sum across the group's cards (the tier weight bar). */
  bytes: number;
  /** true this turn if this tier's segment hash moved. */
  changedThisTurn: boolean;
}

/** The stable-prefix churn alarm latch (§4.5). */
export interface ChurnAlarm {
  /** active = a stable-tier change happened this turn (cache likely broke). */
  active: boolean;
  /** which stable blocks changed (named in the banner), if known. */
  blocks: string[];
  /** the kind of stable change, for the message. */
  reason: 'value' | 'appeared' | 'disappeared' | null;
}

/** The last turn's label, shown in the conversation pane footer. */
export interface TurnInfo {
  turn_id: string;
  ended_by: TurnRecord['ended_by'];
  ts: string;
  snapshot_hash: string;
  perTierBytes: Partial<Record<CacheTier, number>>;
}
