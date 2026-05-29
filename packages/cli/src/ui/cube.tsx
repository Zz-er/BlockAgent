/**
 * cli/ui/cube.tsx — animated ASCII cube Ink component (impl-cube-ink owned).
 *
 * Design: ai_com/cube-design-final.md §1.2, §1.3, §1.4.
 * Delegates all math to cube_renderer.ts (impl-cube-renderer).
 *
 * Non-TTY guard: returns null immediately — no setInterval, no setRawMode risk.
 * Timer cleanup: useEffect return clears the interval on unmount.
 * Angle state: held in useRef (no setState on each tick) — only the rendered
 * string triggers a re-render via useState, minimising reconcile cost.
 */

import { useEffect, useRef, useState } from 'react';
import { Text } from '../ink.js';
import { createRenderer } from './cube_renderer.js';

export interface CubeProps {
  width?: number;    // default 52
  height?: number;   // default 26
  fps?: number;      // default 20
  stopped?: boolean; // default false; true = freeze at current frame, no angle updates
}

// Spec §1.3 rotation constants
const BASE_SPEED = 0.8;  // rad/s
const SPEED     = 0.7;   // multiplier → 0.56 rad/s overall
const WA        = 0.7;   // X-axis weight
const WB        = 1.0;   // Y-axis weight (primary)
const WC        = 0.3;   // Z-axis weight (gentle roll)
const DT_MAX    = 1 / 30; // ~33 ms clamp — prevents angle jump after tab-back

export function Cube({ width = 52, height = 26, fps = 20, stopped = false }: CubeProps): JSX.Element | null {
  // Non-TTY guard — no animation, no setRawMode risk
  if (process.stdout.isTTY === false) return null;

  return <CubeInner width={width} height={height} fps={fps} stopped={stopped} />;
}

// Separated so the hooks are only called in a TTY environment
function CubeInner({ width, height, fps, stopped }: Required<CubeProps>): JSX.Element {
  const renderer = useRef(createRenderer({ width, height }));

  // Angles live in refs — no useState so tick doesn't force a full tree re-render
  const angleA = useRef(0);
  const angleB = useRef(0);
  const angleC = useRef(0);
  const lastTs  = useRef<number>(Date.now());

  // The rendered string IS state — changes here trigger Ink to repaint this Text node
  const [frame, setFrame] = useState<string>(() =>
    renderer.current.renderFrame({ A: 0, B: 0, C: 0 }),
  );

  useEffect(() => {
    const intervalMs = Math.round(1000 / fps);

    const id = setInterval(() => {
      const now = Date.now();
      const dt  = Math.min(DT_MAX, (now - lastTs.current) / 1000);
      lastTs.current = now;

      if (!stopped) {
        const delta = dt * SPEED * BASE_SPEED;
        angleA.current += delta * WA;
        angleB.current += delta * WB;
        angleC.current += delta * WC;
      }

      setFrame(renderer.current.renderFrame({ A: angleA.current, B: angleB.current, C: angleC.current }));
    }, intervalMs);

    return () => clearInterval(id);
  }, [fps, stopped]);

  return <Text color="cyan">{frame}</Text>;
}
