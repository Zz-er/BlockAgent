/**
 * test/intro_banner.test.tsx — IntroBanner data + render + timer + skip-intro.
 *
 * Spec: docs/superpowers/specs/2026-05-29-cli-intro-banner-design.md
 */

import { describe, expect, it } from 'vitest';
import { KB_ROWS, LIT_BY_PHASE, OUTLINE, FILLED } from '../src/ui/IntroBanner.js';

describe('IntroBanner data', () => {
  it('KB_ROWS is the QWERTY top three letter rows, 10 keys each', () => {
    expect(KB_ROWS).toHaveLength(3);
    expect(KB_ROWS[0]).toEqual(['Q','W','E','R','T','Y','U','I','O','P']);
    expect(KB_ROWS[1]).toEqual(['A','S','D','F','G','H','J','K','L',';']);
    expect(KB_ROWS[2]).toEqual(['Z','X','C','V','B','N','M',',','.','/']);
  });

  it('LIT_BY_PHASE adds one BLOCK letter per phase up to phase 5, then holds', () => {
    expect([...LIT_BY_PHASE[0]]).toEqual([]);
    expect([...LIT_BY_PHASE[1]]).toEqual(['B']);
    expect([...LIT_BY_PHASE[2]]).toEqual(['B','L']);
    expect([...LIT_BY_PHASE[3]]).toEqual(['B','L','O']);
    expect([...LIT_BY_PHASE[4]]).toEqual(['B','L','O','C']);
    expect([...LIT_BY_PHASE[5]]).toEqual(['B','L','O','C','K']);
    expect([...LIT_BY_PHASE[7]]).toEqual(['B','L','O','C','K']);
    expect([...LIT_BY_PHASE[8]]).toEqual(['B','L','O','C','K']);
  });

  it('OUTLINE wordmark has 3 lines of dashed empty boxes, one per BLOCK letter', () => {
    expect(OUTLINE).toHaveLength(3);
    expect(OUTLINE[0]).toBe('·┄┄┄· ·┄┄┄· ·┄┄┄· ·┄┄┄· ·┄┄┄·');
    expect(OUTLINE[1]).toBe('·   · ·   · ·   · ·   · ·   ·');
    expect(OUTLINE[2]).toBe('·┄┄┄· ·┄┄┄· ·┄┄┄· ·┄┄┄· ·┄┄┄·');
  });

  it('FILLED wordmark has 3 lines of solid blocks with letters', () => {
    expect(FILLED).toHaveLength(3);
    expect(FILLED[0]).toBe('█████ █████ █████ █████ █████');
    expect(FILLED[1]).toBe('█ B █ █ L █ █ O █ █ C █ █ K █');
    expect(FILLED[2]).toBe('█████ █████ █████ █████ █████');
  });
});

import React from 'react';
import { render } from 'ink-testing-library';
import { Keyboard } from '../src/ui/IntroBanner.js';

describe('Keyboard render', () => {
  it('phase 0: renders three rows of 10 keys, all letters present', () => {
    const { lastFrame } = render(<Keyboard litKeys={new Set()} />);
    const frame = lastFrame() ?? '';

    // All 30 keys should appear in the frame, each as "│ X │" within a key box.
    for (const row of [
      ['Q','W','E','R','T','Y','U','I','O','P'],
      ['A','S','D','F','G','H','J','K','L',';'],
      ['Z','X','C','V','B','N','M',',','.','/'],
    ]) {
      for (const letter of row) {
        expect(frame).toContain(`│ ${letter} │`);
      }
    }
  });

  it('phase 0: keyboard outer frame rows appear three times each', () => {
    const { lastFrame } = render(<Keyboard litKeys={new Set()} />);
    const frame = lastFrame() ?? '';
    const outerTop = '┌─────┐'.repeat(10);
    const outerBottom = '└─────┘'.repeat(10);
    expect(frame.split(outerTop)).toHaveLength(4);    // 3 occurrences → split into 4
    expect(frame.split(outerBottom)).toHaveLength(4);
  });

  it('phase 5: BLOCK letter rows contain ANSI color codes around lit letters', () => {
    const { lastFrame } = render(
      <Keyboard litKeys={new Set(['B','L','O','C','K'])} />,
    );
    const frame = lastFrame() ?? '';

    // All 5 BLOCK letters still appear as the same "│ X │" structural cell.
    for (const letter of ['B','L','O','C','K']) {
      expect(frame).toContain(`│ ${letter} │`);
    }
    // ANSI cyan foreground SGR code (36) appears somewhere in the frame.
    // Lit keys use color="cyan"; if no ANSI is emitted the test environment is
    // misconfigured and the test should fail loudly.
    expect(frame).toMatch(/\x1b\[[^m]*36/);
  });

  it('all-dim: no cyan ANSI codes appear when no keys are lit', () => {
    const { lastFrame } = render(<Keyboard litKeys={new Set()} />);
    const frame = lastFrame() ?? '';
    expect(frame).not.toMatch(/\x1b\[[^m]*36/);
  });
});

import { BlockWordmark } from '../src/ui/IntroBanner.js';

describe('BlockWordmark render', () => {
  it('outline: contains the dashed-box pattern, no solid blocks', () => {
    const { lastFrame } = render(<BlockWordmark filled={false} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('·┄┄┄·');
    expect(frame).not.toContain('█');
  });

  it('filled: contains the solid blocks with letters, no outline dots', () => {
    const { lastFrame } = render(<BlockWordmark filled={true} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('█████');
    expect(frame).toContain('█ B █');
    expect(frame).toContain('█ K █');
    expect(frame).not.toContain('·┄┄┄·');
  });
});

import { IntroBanner } from '../src/ui/IntroBanner.js';
import { afterEach, beforeEach, vi } from 'vitest';

describe('IntroBanner skip-intro', () => {
  beforeEach(() => {
    vi.stubEnv('BLOCK_AGENT_SKIP_INTRO', '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('renders the final-phase frame on mount: keyboard + filled BLOCK + status line', () => {
    const { lastFrame } = render(<IntroBanner providerId="deepseek-chat" />);
    const frame = lastFrame() ?? '';

    // Keyboard present (sample one letter from each row).
    expect(frame).toContain('│ Q │');
    expect(frame).toContain('│ A │');
    expect(frame).toContain('│ Z │');

    // Filled BLOCK present.
    expect(frame).toContain('█ B █');
    expect(frame).toContain('█ K █');

    // Status line present, with provider id.
    expect(frame).toContain('deepseek-chat');
    expect(frame).toContain('/help');
    expect(frame).toContain('Ctrl-C');
  });

  it('schedules no timers when skip-intro is set', () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    render(<IntroBanner providerId="mock" />);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});

describe('IntroBanner animation progression', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.unstubAllEnvs(); // ensure SKIP_INTRO is NOT set
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('schedules exactly 7 setTimeout calls on mount', () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    render(<IntroBanner providerId="mock" />);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(7);
  });

  it('starts at phase 0: keyboard present, no BLOCK wordmark, no status line', () => {
    const { lastFrame } = render(<IntroBanner providerId="mock" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('│ Q │');
    expect(frame).not.toContain('█');
    expect(frame).not.toContain('·┄┄┄·');
    expect(frame).not.toContain('/help');
  });

  it('after 950ms: outline BLOCK wordmark appears, still no status line', () => {
    const { lastFrame } = render(<IntroBanner providerId="mock" />);
    vi.advanceTimersByTime(950);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('·┄┄┄·');
    expect(frame).not.toContain('█████');
    expect(frame).not.toContain('/help');
  });

  it('after 1350ms: BLOCK wordmark fills, status line appears', () => {
    const { lastFrame } = render(<IntroBanner providerId="deepseek-chat" />);
    vi.advanceTimersByTime(1350);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('█ B █');
    expect(frame).not.toContain('·┄┄┄·');
    expect(frame).toContain('deepseek-chat');
  });

  it('unmount before timers fire clears all scheduled timers', () => {
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
    const { unmount } = render(<IntroBanner providerId="mock" />);
    unmount();
    // 7 timers were scheduled; cleanup must clear all 7.
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(7);
  });
});
