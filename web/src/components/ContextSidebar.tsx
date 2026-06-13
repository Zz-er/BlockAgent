// The context sidebar — the centerpiece (D3 §4). Three tier groups in fixed order
// (stable → slow_changing → volatile), each a list of collapsible block cards.

import type { ChurnAlarm, TierGroup } from '../session/types.js';
import { TierGroupView } from './TierGroupView.js';

interface ContextSidebarProps {
  tierGroups: TierGroup[];
  churn: ChurnAlarm;
  onExpandBlock: (name: string, content_hash: string) => void;
  onAcknowledgeChurn: () => void;
}

export function ContextSidebar({
  tierGroups,
  churn,
  onExpandBlock,
  onAcknowledgeChurn,
}: ContextSidebarProps): JSX.Element {
  const maxBytes = tierGroups.reduce((m, g) => Math.max(m, g.bytes), 0);

  return (
    <aside className="sidebar">
      <header className="sidebar__header">
        <h2>context</h2>
        <span className="sidebar__hint">≈byte weights · lazy bodies</span>
      </header>
      <div className="sidebar__groups">
        {tierGroups.map((group) => (
          <TierGroupView
            key={group.tier}
            group={group}
            maxBytes={maxBytes}
            churn={churn}
            onExpandBlock={onExpandBlock}
            onAcknowledgeChurn={onAcknowledgeChurn}
          />
        ))}
      </div>
    </aside>
  );
}
