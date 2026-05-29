/**
 * test/cube_renderer.test.ts — unit tests for the pure cube rasteriser.
 *
 * Test plan (spec §task #1):
 *   1. Byte-identical: same opts + angles → identical string on two calls.
 *   2. Back-face cull: rest pose renders at least some non-space characters.
 *   3. Default-param smoke: no throw, output length = W*H + H.
 *   4. Buffer reuse: repeated calls do not throw (OOM-guard, no heap snapshot).
 *   5. TypeScript: file compiles under strict/NodeNext/ESM (vitest run = tsc 0).
 */

import { describe, expect, it } from 'vitest';
import { createRenderer } from '../src/ui/cube_renderer.js';

const W = 40;
const H = 20;

describe('createRenderer / renderFrame', () => {
  it('byte-identical: same opts + angles returns equal strings', () => {
    const renderer = createRenderer({ width: W, height: H });
    const angles = { A: 0.5, B: 1.2, C: 0.3 };
    const first = renderer.renderFrame(angles);
    const second = renderer.renderFrame(angles);
    expect(first).toBe(second);
  });

  it('back-face cull: rest pose (A=B=C=0) has non-space cells', () => {
    // At A=B=C=0 the -Z face is front-facing (nz < 0 after rotation = identity),
    // so at least some cells must be shaded non-space characters.
    const renderer = createRenderer({ width: W, height: H });
    const frame = renderer.renderFrame({ A: 0, B: 0, C: 0 });
    const nonSpace = [...frame].filter(ch => ch !== ' ' && ch !== '\n');
    expect(nonSpace.length).toBeGreaterThan(0);
  });

  it('default-param smoke: no throw, output length = W*H + H', () => {
    const renderer = createRenderer({ width: W, height: H });
    let frame: string;
    expect(() => {
      frame = renderer.renderFrame({ A: 0, B: 0, C: 0 });
    }).not.toThrow();
    // W chars per row + '\n' terminator per row → total = W*H + H.
    expect(frame!.length).toBe(W * H + H);
  });

  it('default-param smoke: output has exactly H lines separated by newlines', () => {
    const renderer = createRenderer({ width: W, height: H });
    const frame = renderer.renderFrame({ A: 1.0, B: 2.0, C: 0.5 });
    const lines = frame.split('\n');
    // split('\n') on "row\n".repeat(H) gives H non-empty entries + 1 empty tail.
    expect(lines.length).toBe(H + 1);
    expect(lines.at(H)).toBe('');
    for (let i = 0; i < H; i++) {
      expect(lines.at(i)?.length).toBe(W);
    }
  });

  it('buffer reuse: 200 sequential calls do not throw', () => {
    const renderer = createRenderer({ width: W, height: H });
    expect(() => {
      for (let i = 0; i < 200; i++) {
        renderer.renderFrame({ A: i * 0.1, B: i * 0.07, C: i * 0.05 });
      }
    }).not.toThrow();
  });
});
