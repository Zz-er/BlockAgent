/**
 * cli/ui/ThinkingStream.tsx — live thinking side-channel (impl-cli-ui owned).
 *
 * Design: ai_com/block-agent-cli-design.md §4. Renders runtime.onThinking events
 * (dim, indented by spawn_depth) so the operator sees reasoning live and visually
 * distinct from agent replies. Thinking is UI-only (DR-27): rendered here, never fed
 * back anywhere — the runtime gives the CLI no path to do so even if it wanted to.
 * The render-helper idea is borrowed from claude-code utils/thinking.ts (design §8);
 * its ultrathink/GrowthBook logic is deliberately NOT imported.
 */

import { Box, Text } from '../ink.js';
import type { ThinkingEvent } from '@block-agent/core/core/types.js';

export interface ThinkingStreamProps {
  events: readonly ThinkingEvent[];
}

export function ThinkingStream({ events }: ThinkingStreamProps): JSX.Element | null {
  if (events.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Text dimColor italic>
        thinking
      </Text>
      {events.map((e, i) => (
        <Box key={i} flexDirection="row" paddingLeft={2 + e.spawn_depth * 2}>
          <Text dimColor wrap="wrap">
            {e.text}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
