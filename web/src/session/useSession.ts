// ============================================================================
// useSession — owns the WS client and turns protocol frames into view state
// ============================================================================
//
// Data flow (D3 §3.3, lazy-pull):
//   • thinking/error/turn frames stream in → accumulate conversation + turn state.
//   • each `turn` frame's segment_hashes drives the FREE tier-level diff + the
//     stable-churn alarm — no block bytes needed.
//   • when any tier's hash MOVED this turn, we pull ONE `query(target:'blocks')`
//     (the per-block array across all tiers), fan rows out by their `tier`, diff
//     each tier against its cached previous view, and classify each card (§4.3).
//   • a card's full body is shown lazily on expand: until the host serves verbose
//     per-block text, the collapsed one-line preview stands in (no extra fetch).
//
// The only write this hook issues is submit() (§4.7).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HIGHLIGHT_FADE_MS, WS_URL } from '../config.js';
import { SessionProtocolClient, type ConnectionState } from '../protocol/client.js';
import type {
  BlockAttribution,
  CacheTier,
  ContextFrame,
  OutboundFrame,
} from '../protocol/index.js';
import { TIER_ORDER } from '../protocol/index.js';
import { computeChurnAlarm, diffBlocks } from './diff.js';
import type {
  BlockCardView,
  ChatEntry,
  ChurnAlarm,
  ErrorEntry,
  TierGroup,
  ToolCallEntry,
  TurnActivity,
  TurnInfo,
} from './types.js';

let idSeq = 0;
const nextId = () => `e-${++idSeq}`;

type TierMap<T> = Record<CacheTier, T>;
const emptyTierMap = <T,>(make: () => T): TierMap<T> => ({
  stable: make(),
  slow_changing: make(),
  volatile: make(),
});

export interface SessionApi {
  connection: ConnectionState;
  model: string | null;
  chat: ChatEntry[];
  /** the in-flight turn's reasoning + tool calls, shown expanded until the reply lands. */
  liveActivity: TurnActivity | null;
  errors: ErrorEntry[];
  lastTurn: TurnInfo | null;
  tierGroups: TierGroup[];
  churn: ChurnAlarm;
  /** the one write: send a user message. */
  submit: (text: string) => void;
  /** expand a card → lazily fetch its full rendered body (scope:'block'), cached by hash. */
  fetchBlockBody: (name: string, content_hash: string) => void;
  /** dismiss the churn alarm latch. */
  acknowledgeChurn: () => void;
}

export function useSession(): SessionApi {
  const clientRef = useRef<SessionProtocolClient | null>(null);

  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [model, setModel] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [liveActivity, setLiveActivity] = useState<TurnActivity | null>(null);
  const [errors, setErrors] = useState<ErrorEntry[]>([]);

  // Accumulators for the in-flight agent turn (thinking + tool calls since the user's last
  // message). On the reply frame they're collapsed onto the agent ChatEntry, then reset.
  const pendingThinking = useRef<string[]>([]);
  const pendingToolCalls = useRef<ToolCallEntry[]>([]);
  const bumpLive = useCallback(() => {
    setLiveActivity({
      thinking: [...pendingThinking.current],
      toolCalls: [...pendingToolCalls.current],
    });
  }, []);
  const resetActivity = useCallback(() => {
    pendingThinking.current = [];
    pendingToolCalls.current = [];
    setLiveActivity(null);
  }, []);
  const [lastTurn, setLastTurn] = useState<TurnInfo | null>(null);
  const [churn, setChurn] = useState<ChurnAlarm>({ active: false, blocks: [], reason: null });

  // Per-tier card maps. Cards persist across turns (stable React keys) so the DOM
  // node animates rather than remounting. content_hash keys the body cache + flash.
  const [cardsByTier, setCardsByTier] = useState<TierMap<BlockCardView[]>>(() =>
    emptyTierMap<BlockCardView[]>(() => []),
  );

  // Turn-over-turn memory for the diff (kept in refs — not render state).
  const prevSegmentHashes = useRef<Partial<Record<CacheTier, string>> | undefined>(undefined);
  const prevBlocksByTier = useRef<Partial<TierMap<BlockAttribution[]>>>({});
  const bodyCache = useRef<Map<string, string>>(new Map());
  const flashTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // --- inbound frame handling ----------------------------------------------

  const applyBlocksForTier = useCallback((tier: CacheTier, blocks: BlockAttribution[]) => {
    const prev = prevBlocksByTier.current[tier];
    const { current, left } = diffBlocks(prev, blocks);

    const cards: BlockCardView[] = current.map((d) => {
      const body = bodyCache.current.get(d.attribution.content_hash);
      return {
        ...d.attribution,
        transition: d.transition,
        delta: d.delta,
        flashing: d.changed,
        // exactOptionalPropertyTypes: only set `body` when we actually have one.
        ...(body !== undefined ? { body } : {}),
      };
    });

    // Keep `left` cards briefly as leaving so the UI can shrink+fade them.
    for (const b of left) {
      cards.push({ ...b, transition: 'left', delta: 0, flashing: false });
    }

    prevBlocksByTier.current[tier] = blocks;
    setCardsByTier((m) => ({ ...m, [tier]: cards }));

    // schedule flash clears (§4.5) keyed by content_hash.
    for (const d of current) {
      if (!d.changed) continue;
      const key = d.attribution.content_hash;
      const existing = flashTimers.current.get(key);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        flashTimers.current.delete(key);
        setCardsByTier((m) => ({
          ...m,
          [tier]: m[tier].map((c) => (c.content_hash === key ? { ...c, flashing: false } : c)),
        }));
      }, HIGHLIGHT_FADE_MS);
      flashTimers.current.set(key, timer);
    }

    // drop `left` cards after the fade window.
    if (left.length > 0) {
      setTimeout(() => {
        setCardsByTier((m) => ({
          ...m,
          [tier]: m[tier].filter((c) => c.transition !== 'left'),
        }));
      }, HIGHLIGHT_FADE_MS);
    }
  }, []);

  const handleContext = useCallback(
    (frame: ContextFrame) => {
      // (1) per-block ATTRIBUTION layer (scope:'blocks') → fan out by tier + diff.
      if (frame.scope === 'blocks' && frame.blocks) {
        const byTier = emptyTierMap<BlockAttribution[]>(() => []);
        for (const b of frame.blocks) {
          // rows with a null tier aren't part of the cache-tiered prompt the
          // sidebar groups — skip them.
          if (b.tier && b.tier in byTier) byTier[b.tier].push(b);
        }
        for (const tier of TIER_ORDER) applyBlocksForTier(tier, byTier[tier]);
        return;
      }

      // (2) single-block BODY layer (scope:'block', lazy body-on-expand). The
      // body's content_hash equals the blocks-layer hash for that name (Backend's
      // cache-key contract), so we cache by hash and reuse on an unchanged hash.
      // text === null ⇒ the block dropped/emptied this snapshot → drop the card.
      if (frame.scope === 'block') {
        const body = frame.block;
        if (!body) return;
        if (body.text === null) {
          setCardsByTier((m) => {
            const out = { ...m };
            for (const t of TIER_ORDER) out[t] = out[t].filter((c) => c.name !== body.name);
            return out;
          });
          return;
        }
        bodyCache.current.set(body.content_hash, body.text);
        const text = body.text;
        setCardsByTier((m) => {
          const out = { ...m };
          for (const t of TIER_ORDER) {
            out[t] = out[t].map((c) =>
              c.name === body.name && c.content_hash === body.content_hash ? { ...c, body: text } : c,
            );
          }
          return out;
        });
      }
    },
    [applyBlocksForTier],
  );

  const handleFrame = useCallback(
    (frame: OutboundFrame) => {
      switch (frame.kind) {
        case 'capabilities':
          setModel(frame.model);
          break;
        case 'thinking':
          // Accumulate into the in-flight turn (shown live, collapsed onto the reply later).
          pendingThinking.current = [...pendingThinking.current, frame.text];
          bumpLive();
          break;
        case 'tool_call':
          // One command the agent invoked this turn (name + ok). Grouped with thinking.
          pendingToolCalls.current = [...pendingToolCalls.current, { name: frame.name, ok: frame.ok }];
          bumpLive();
          break;
        case 'reply': {
          // The agent's conversational turn (MessagesApp.onReply). Append as the 'agent' role
          // and COLLAPSE this turn's accumulated thinking + tool calls onto the entry (rendered
          // as a foldable disclosure). Then reset the accumulators + clear the live panel.
          const activity: TurnActivity | undefined =
            pendingThinking.current.length > 0 || pendingToolCalls.current.length > 0
              ? { thinking: [...pendingThinking.current], toolCalls: [...pendingToolCalls.current] }
              : undefined;
          setChat((c) => [
            ...c,
            { id: nextId(), role: 'agent', text: frame.content, ...(activity ? { activity } : {}) },
          ]);
          resetActivity();
          break;
        }
        case 'error':
          setErrors((e) => [...e, { id: nextId(), message: frame.message, phase: frame.phase }]);
          break;
        case 'turn': {
          // snapshot_hash / segment_hashes / per_tier_bytes are absent if the turn
          // failed BEFORE render (e.g. send_error — TurnRecord optionals,
          // core/types.ts:388-393). That is a DIFFERENT absence from "a tier is
          // empty this turn" (a missing KEY inside a present Partial map, D3 §4.1):
          // a no-render turn carries no render info at all, so it must NOT touch the
          // churn alarm, the tier diff, or the prevSegmentHashes baseline (the next
          // real turn should diff against the last RENDERED turn, not this gap).
          setLastTurn({
            turn_id: frame.turn_id,
            ended_by: frame.ended_by,
            ts: frame.ts,
            snapshot_hash: frame.snapshot_hash ?? '',
            perTierBytes: frame.per_tier_bytes ?? {},
          });

          const segHashes = frame.segment_hashes;
          if (segHashes === undefined) break; // failed before render — nothing to diff.

          // FREE tier diff + churn alarm from segment_hashes (no bytes).
          const alarm = computeChurnAlarm(prevSegmentHashes.current, segHashes);
          if (alarm.active) setChurn(alarm);

          // If any tier's hash moved, pull the per-block view ONCE (the `blocks`
          // scope returns all tiers; we fan it out in handleContext).
          const client = clientRef.current;
          if (client) {
            let anyMoved = false;
            for (const tier of TIER_ORDER) {
              if (prevSegmentHashes.current?.[tier] !== segHashes[tier]) anyMoved = true;
            }
            if (anyMoved) client.query('blocks', { scope: 'blocks' });
          }
          prevSegmentHashes.current = segHashes;
          break;
        }
        case 'context':
          handleContext(frame);
          break;
        case 'context_diff':
        case 'session_list_result':
        case 'attach_result':
          // not consumed by the single-session sidebar; ignored (forward-compat).
          break;
      }
    },
    [handleContext, bumpLive, resetActivity],
  );

  // --- lifecycle -----------------------------------------------------------

  useEffect(() => {
    const client = new SessionProtocolClient({ url: WS_URL });
    clientRef.current = client;
    const offFrame = client.onFrame(handleFrame);
    const offState = client.onState(setConnection);
    client.connect();
    const timers = flashTimers.current;
    return () => {
      offFrame();
      offState();
      client.dispose();
      clientRef.current = null;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, [handleFrame]);

  // --- public actions ------------------------------------------------------

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      // A new user message starts a fresh turn: clear any leftover live activity so the next
      // reply only carries THIS turn's thinking + tool calls.
      resetActivity();
      setChat((c) => [...c, { id: nextId(), role: 'user', text: trimmed }]);
      clientRef.current?.submit(trimmed);
    },
    [resetActivity],
  );

  const fetchBlockBody = useCallback((name: string, content_hash: string) => {
    // Lazy body-on-expand (scope:'block'). Cache-key contract: the body's
    // content_hash equals the blocks-layer hash, so a cached body for this hash is
    // still current — skip the fetch (§3.3). Only pull when the hash isn't cached.
    if (bodyCache.current.has(content_hash)) {
      const text = bodyCache.current.get(content_hash)!;
      setCardsByTier((m) => {
        const out = { ...m };
        for (const t of TIER_ORDER) {
          out[t] = out[t].map((c) =>
            c.name === name && c.content_hash === content_hash ? { ...c, body: text } : c,
          );
        }
        return out;
      });
      return;
    }
    clientRef.current?.query('block', { scope: 'block', block_name: name });
  }, []);

  const acknowledgeChurn = useCallback(() => {
    setChurn({ active: false, blocks: [], reason: null });
  }, []);

  // --- derived: tier groups in fixed order ---------------------------------

  const tierGroups = useMemo<TierGroup[]>(() => {
    const changed = new Set<CacheTier>();
    for (const tier of TIER_ORDER) {
      if (cardsByTier[tier].some((c) => c.flashing)) changed.add(tier);
    }
    return TIER_ORDER.map((tier) => {
      const cards = cardsByTier[tier];
      const bytes = cards.reduce((sum, c) => (c.transition === 'left' ? sum : sum + c.bytes), 0);
      return { tier, cards, bytes, changedThisTurn: changed.has(tier) };
    });
  }, [cardsByTier]);

  return {
    connection,
    model,
    chat,
    liveActivity,
    errors,
    lastTurn,
    tierGroups,
    churn,
    submit,
    fetchBlockBody,
    acknowledgeChurn,
  };
}
