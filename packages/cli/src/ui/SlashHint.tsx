/**
 * cli/ui/SlashHint.tsx — slash command completion hint (impl-cli-ui owned).
 *
 * Design: ai_com/block-agent-cli-design.md §4 / §5. When the draft input starts
 * with '/', list matching SLASH_COMMANDS (name + summary) as a completion hint.
 * Read-only over the registry — matches only the first token so the hint stays once
 * the operator starts typing arguments.
 */

import { Box, Text } from '../ink.js';
import { SLASH_COMMANDS } from '../commands.js';

export interface SlashHintProps {
  /** Current draft input (lifted from PromptInput in App). */
  input: string;
}

export function SlashHint({ input }: SlashHintProps): JSX.Element | null {
  if (!input.startsWith('/')) return null;
  const firstToken = input.split(/\s/, 1)[0] ?? input;
  const typed = firstToken.slice(1).toLowerCase();
  const matches = SLASH_COMMANDS.filter((c) => c.name.toLowerCase().startsWith(typed));
  if (matches.length === 0) return null;
  return (
    <Box flexDirection="column">
      {matches.map((c) => (
        <Text key={c.name} dimColor>
          <Text color="cyan">{`/${c.name}`}</Text>
          {c.usage ? <Text dimColor>{` ${c.usage}`}</Text> : null}
          <Text dimColor>{`  — ${c.summary}`}</Text>
        </Text>
      ))}
    </Box>
  );
}
