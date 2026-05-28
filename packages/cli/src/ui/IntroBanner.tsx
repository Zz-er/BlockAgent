/**
 * cli/ui/IntroBanner.tsx — animated startup header (impl-cli-ui owned).
 *
 * Spec: docs/superpowers/specs/2026-05-29-cli-intro-banner-design.md
 *
 * Owns the animation phase state machine. Renders a pseudo-3D ASCII keyboard
 * whose B/L/O/C/K keys light up in sequence on App mount, followed by a BLOCK
 * wordmark (outline → filled) and the status line. Animation runs ONCE on mount
 * (~2.3s total); BLOCK_AGENT_SKIP_INTRO=1 jumps straight to the final phase
 * with no timers — tests rely on this to avoid 2.3s waits per render.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { Box, Text } from '../ink.js';

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export const KB_ROWS: readonly (readonly string[])[] = [
  ['Q','W','E','R','T','Y','U','I','O','P'],
  ['A','S','D','F','G','H','J','K','L',';'],
  ['Z','X','C','V','B','N','M',',','.','/'],
];

export const LIT_BY_PHASE: Readonly<Record<number, ReadonlySet<string>>> = {
  0: new Set(),
  1: new Set(['B']),
  2: new Set(['B','L']),
  3: new Set(['B','L','O']),
  4: new Set(['B','L','O','C']),
  5: new Set(['B','L','O','C','K']),
  7: new Set(['B','L','O','C','K']),
  8: new Set(['B','L','O','C','K']),
};

export const OUTLINE: readonly string[] = [
  '·┄┄┄· ·┄┄┄· ·┄┄┄· ·┄┄┄· ·┄┄┄·',
  '·   · ·   · ·   · ·   · ·   ·',
  '·┄┄┄· ·┄┄┄· ·┄┄┄· ·┄┄┄· ·┄┄┄·',
];

export const FILLED: readonly string[] = [
  '█████ █████ █████ █████ █████',
  '█ B █ █ L █ █ O █ █ C █ █ K █',
  '█████ █████ █████ █████ █████',
];

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

const KB_INDENT = '   ';
const OUTER_TOP = '┌─────┐';
const OUTER_BOTTOM = '└─────┘';
const INNER_TOP = '┌───┐';
const INNER_BOTTOM = '└───┘';

export interface KeyboardProps {
  litKeys: ReadonlySet<string>;
}

export function Keyboard({ litKeys }: KeyboardProps): JSX.Element {
  return (
    <Box flexDirection="column">
      {KB_ROWS.map((row, ri) => (
        <Box key={ri} flexDirection="column">
          {/* Outer top: dim for every key */}
          <Text dimColor>{KB_INDENT + OUTER_TOP.repeat(row.length)}</Text>
          {/* Inner top: per-key, lit keys cyan-bold */}
          <Text>
            {KB_INDENT}
            {row.map((letter, ki) => (
              <Text key={ki}>
                <Text dimColor>│</Text>
                {litKeys.has(letter) ? (
                  <Text color="cyan" bold>{INNER_TOP}</Text>
                ) : (
                  <Text dimColor>{INNER_TOP}</Text>
                )}
                <Text dimColor>│</Text>
              </Text>
            ))}
          </Text>
          {/* Letter row: per-key, lit keys cyan-bold-inverse */}
          <Text>
            {KB_INDENT}
            {row.map((letter, ki) => (
              <Text key={ki}>
                <Text dimColor>│</Text>
                {litKeys.has(letter) ? (
                  <Text color="cyan" bold inverse>{`│ ${letter} │`}</Text>
                ) : (
                  <Text dimColor>{`│ ${letter} │`}</Text>
                )}
                <Text dimColor>│</Text>
              </Text>
            ))}
          </Text>
          {/* Inner bottom */}
          <Text>
            {KB_INDENT}
            {row.map((letter, ki) => (
              <Text key={ki}>
                <Text dimColor>│</Text>
                {litKeys.has(letter) ? (
                  <Text color="cyan" bold>{INNER_BOTTOM}</Text>
                ) : (
                  <Text dimColor>{INNER_BOTTOM}</Text>
                )}
                <Text dimColor>│</Text>
              </Text>
            ))}
          </Text>
          {/* Outer bottom: dim for every key */}
          <Text dimColor>{KB_INDENT + OUTER_BOTTOM.repeat(row.length)}</Text>
        </Box>
      ))}
    </Box>
  );
}

export interface BlockWordmarkProps {
  filled: boolean;
}

export function BlockWordmark({ filled }: BlockWordmarkProps): JSX.Element {
  const lines = filled ? FILLED : OUTLINE;
  return (
    <Box flexDirection="column" marginTop={1}>
      {lines.map((line, i) =>
        filled ? (
          <Text key={i} color="cyan" bold>
            {KB_INDENT + line}
          </Text>
        ) : (
          <Text key={i} dimColor>
            {KB_INDENT + line}
          </Text>
        ),
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface IntroBannerProps {
  providerId: string;
}

export function IntroBanner({ providerId }: IntroBannerProps): JSX.Element {
  const [phase, setPhase] = useState<number>(() =>
    process.env.BLOCK_AGENT_SKIP_INTRO === '1' ? 8 : 0,
  );

  // Schedule timers synchronously during first render so vi.useFakeTimers() spies
  // can observe all 7 setTimeout calls immediately after render() returns.
  // useRef guard prevents re-scheduling on subsequent renders.
  const timersRef = useRef<ReturnType<typeof setTimeout>[] | null>(null);
  if (timersRef.current === null) {
    if (phase === 8) {
      timersRef.current = []; // SKIP_INTRO path — no timers
    } else {
      timersRef.current = [
        setTimeout(() => setPhase(1), 150),
        setTimeout(() => setPhase(2), 300),
        setTimeout(() => setPhase(3), 450),
        setTimeout(() => setPhase(4), 600),
        setTimeout(() => setPhase(5), 750),
        setTimeout(() => setPhase(7), 950),
        setTimeout(() => setPhase(8), 1350),
      ];
    }
  }

  // useLayoutEffect runs synchronously on commit/unmount, ensuring clearTimeout
  // is called synchronously when unmount() is invoked (required by tests).
  useLayoutEffect(() => {
    return () => {
      for (const t of timersRef.current ?? []) clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once
  }, []);

  const litKeys = LIT_BY_PHASE[phase] ?? new Set<string>();
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Keyboard litKeys={litKeys} />
      {phase >= 7 && <BlockWordmark filled={phase >= 8} />}
      {phase >= 8 && (
        <Text dimColor>{`${providerId} · /help 看命令 · Ctrl-C 退出`}</Text>
      )}
    </Box>
  );
}
