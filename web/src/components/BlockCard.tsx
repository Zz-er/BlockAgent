// A single collapsible block card (§4.2). Collapsed = one-line preview header;
// expanded = lazily-fetched rendered bytes. The `.changed` flash → fade-back is a
// pure CSS transition (§4.5), driven by the `flashing` flag from useSession.

import { useState } from 'react';
import type { BlockCardView } from '../session/types.js';
import { formatDelta, formatWeight } from '../lib/weight.js';

interface BlockCardProps {
  card: BlockCardView;
  /** called when the card is expanded → lazy body fetch (cached by content_hash). */
  onExpand: (name: string, content_hash: string) => void;
}

export function BlockCard({ card, onExpand }: BlockCardProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && card.body === undefined) onExpand(card.name, card.content_hash);
  };

  const delta = formatDelta(card.delta);
  const isBlob = card.bytes === 0 && card.preview.startsWith('blob://');
  const owner = card.owner ?? 'system';
  const appLabel = card.app_id ?? 'core';

  const classes = [
    'block-card',
    card.flashing ? 'changed' : '',
    card.transition === 'left' ? 'leaving' : '',
    card.transition === 'entered' ? 'entering' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} data-tier={card.tier ?? 'untiered'}>
      <button className="block-card__header" onClick={toggle} aria-expanded={expanded}>
        <span className={`badge badge--${owner}`} title={`owner: ${owner}`}>{appLabel}</span>
        <span className="block-card__name">{card.name}</span>
        <span className="block-card__spacer" />
        {delta && (
          <span className={`block-card__delta ${card.delta > 0 ? 'pos' : 'neg'}`}>{delta}</span>
        )}
        <span className="block-card__weight" title={isBlob ? 'counts the blob handle, not the deref' : 'byte proxy, not exact tokens'}>
          {formatWeight(card.bytes)}
        </span>
        <span className="block-card__chevron">{expanded ? '▾' : '▸'}</span>
      </button>

      {!expanded && <div className="block-card__preview">{card.preview}</div>}

      {expanded && (
        <pre className="block-card__body">
          {card.body !== undefined ? card.body : 'loading…'}
        </pre>
      )}
    </div>
  );
}
