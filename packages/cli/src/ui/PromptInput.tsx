/**
 * cli/ui/PromptInput.tsx — controlled input box (impl-cli-ui owned).
 *
 * Design: ai_com/block-agent-cli-design.md §4. A lean useInput-driven controlled
 * input (borrows the claude-code PromptInput shape, not its size — design §8):
 *   - printable chars / pastes append at the cursor; backspace/delete remove;
 *     left/right move the cursor.
 *   - Enter submits the trimmed-but-preserved draft (App decides plain vs /slash)
 *     and the parent clears `value`.
 *   - Ctrl-C exits the process (useApp().exit()); Ctrl-U clears the line.
 * The draft is lifted to App (value/onChange) so SlashHint can read it.
 */

import { Box, Text, useApp, useInput } from '../ink.js';

export interface PromptInputProps {
  onSubmit: (text: string) => void;
  /** Current draft text, lifted to App so SlashHint can read it. */
  value: string;
  onChange: (value: string) => void;
  /** Disable input capture while a turn is in flight. */
  busy?: boolean;
}

export function PromptInput({ onSubmit, value, onChange, busy }: PromptInputProps): JSX.Element {
  const { exit } = useApp();

  useInput(
    (char, key) => {
      if (key.ctrl && char === 'c') {
        exit();
        return;
      }
      if (key.ctrl && char === 'u') {
        onChange('');
        return;
      }
      if (key.return) {
        onSubmit(value);
        return;
      }
      if (key.backspace || key.delete) {
        onChange(value.slice(0, -1));
        return;
      }
      // Ignore navigation / modifier-only keys; append printable input (incl. pastes).
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab || key.escape) {
        return;
      }
      if (char && !key.ctrl && !key.meta) {
        onChange(value + char);
      }
    },
    { isActive: !busy },
  );

  return (
    <Box>
      <Text color={busy ? 'gray' : 'cyan'}>{'› '}</Text>
      <Text>{value}</Text>
      {busy ? null : <Text inverse> </Text>}
    </Box>
  );
}
