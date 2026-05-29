/**
 * cli/ui/welcome.tsx — two-column welcome screen (impl-cube-ink owned).
 *
 * Design: ai_com/cube-design-final.md §1.4, §2.
 * Left column: animated <Cube> (hidden when showCube=false or non-TTY).
 * Right column: 26-row welcome text from WELCOME_LINES constant.
 *
 * Unmount behaviour is handled by the parent (App.tsx) — once the user submits
 * their first message, App unmounts <WelcomeScreen> entirely.
 */

import { Box, Text } from '../ink.js';
import { Cube } from './cube.js';
import { WELCOME_LINES } from './welcome_lines.js';

export interface WelcomeScreenProps {
  showCube?: boolean;  // default true
  stopped?: boolean;   // forwarded to <Cube>
}

export function WelcomeScreen({ showCube = true, stopped = false }: WelcomeScreenProps): JSX.Element {
  const renderCube = showCube && process.stdout.isTTY !== false;

  // Outer Box: row layout, justifyContent="center" centers the cube+welcome pair
  // horizontally within the terminal width (the Box stretches to the column-parent's
  // width by default, then justifies its child to the centre).
  // Inner Box: alignItems="center" vertically aligns Cube and the welcome column so
  // their midlines match — the welcome content is rebalanced (2 blank top + 21 rows
  // + 3 blank bottom, midline at row 13) to coincide with the cube's halfH.
  return (
    <Box flexDirection="row" justifyContent="center">
      <Box flexDirection="row" alignItems="center">
        {renderCube && (
          <Cube stopped={stopped} />
        )}
        <Box flexDirection="column" marginLeft={renderCube ? 1 : 0}>
          {WELCOME_LINES.map((line, i) => {
            if (line.color === 'gray') {
              return <Text key={i} dimColor>{line.text}</Text>;
            }
            if (line.color === 'cyan') {
              return <Text key={i} color="cyan">{line.text}</Text>;
            }
            // white — default foreground, no color prop
            return <Text key={i}>{line.text}</Text>;
          })}
        </Box>
      </Box>
    </Box>
  );
}
