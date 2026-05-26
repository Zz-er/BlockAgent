/**
 * cli/ui/MessageList.tsx — user + agent message history (impl-cli-ui owned).
 *
 * Design: ai_com/block-agent-cli-design.md §4 / §6. Renders the conversation:
 * user lines (local echo on submit) + agent replies (pushed in via
 * CliChannel.onDeliver → MessagesApp.onReply). Read-side only — the CLI never calls
 * messages.reply itself (§9 reply-is-read-side invariant).
 */

import { Box, Text } from '../ink.js';

export interface UiMessage {
  role: 'user' | 'agent';
  content: string;
}

export interface MessageListProps {
  items: readonly UiMessage[];
}

export function MessageList({ items }: MessageListProps): JSX.Element {
  return (
    <Box flexDirection="column">
      {items.map((m, i) => {
        const isUser = m.role === 'user';
        return (
          <Box key={i} flexDirection="row">
            <Text color={isUser ? 'cyan' : 'green'} bold>
              {isUser ? 'you' : 'agent'}
            </Text>
            <Text>{'  '}</Text>
            <Box flexGrow={1}>
              <Text wrap="wrap">{m.content}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
