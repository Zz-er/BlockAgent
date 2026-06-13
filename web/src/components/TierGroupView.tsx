// One tier group in the sidebar — a header (tier name + ≈byte weight bar) and its
// list of block cards. The `stable` group's header carries the churn alarm (§4.5).

import type { TierGroup, ChurnAlarm } from '../session/types.js';
import { formatWeight } from '../lib/weight.js';
import { BlockCard } from './BlockCard.js';

const TIER_LABEL: Record<string, string> = {
  stable: 'stable',
  slow_changing: 'slow-changing',
  volatile: 'volatile',
};

interface TierGroupViewProps {
  group: TierGroup;
  /** total bytes across all tiers, for the relative weight bar width. */
  maxBytes: number;
  churn: ChurnAlarm;
  onExpandBlock: (name: string, content_hash: string) => void;
  onAcknowledgeChurn: () => void;
}

export function TierGroupView({
  group,
  maxBytes,
  churn,
  onExpandBlock,
  onAcknowledgeChurn,
}: TierGroupViewProps): JSX.Element {
  const isStable = group.tier === 'stable';
  const alarmActive = isStable && churn.active;
  const widthPct = maxBytes > 0 ? Math.max(2, (group.bytes / maxBytes) * 100) : 0;

  const headerClasses = [
    'tier-group__header',
    group.changedThisTurn ? 'changed' : '',
    alarmActive ? 'alarm' : '',
  ]
    .filter(Boolean)
    .join(' ');

  // `left` cards are kept (not filtered) so they can shrink+fade before unmount.
  const cards = group.cards;

  return (
    <section className="tier-group" data-tier={group.tier}>
      <div className={headerClasses}>
        <span className="tier-group__name">{TIER_LABEL[group.tier] ?? group.tier}</span>
        <span className="tier-group__weight">{formatWeight(group.bytes)}</span>
        <div className="tier-group__bar">
          <div className="tier-group__bar-fill" style={{ width: `${widthPct}%` }} />
        </div>
      </div>

      {alarmActive && (
        <div className="churn-banner" role="alert">
          <span className="churn-banner__text">
            ⚠ stable prefix changed this turn — prompt cache likely broke
            {churn.blocks.length > 0 && (
              <span className="churn-banner__blocks"> ({churn.blocks.join(', ')})</span>
            )}
          </span>
          <button className="churn-banner__ack" onClick={onAcknowledgeChurn} aria-label="dismiss alarm">
            ✕
          </button>
        </div>
      )}

      <div className="tier-group__cards">
        {cards.length === 0 ? (
          <div className="tier-group__empty">— empty this turn —</div>
        ) : (
          cards.map((card) => (
            <BlockCard key={card.name} card={card} onExpand={onExpandBlock} />
          ))
        )}
      </div>
    </section>
  );
}
