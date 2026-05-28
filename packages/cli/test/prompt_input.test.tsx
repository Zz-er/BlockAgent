/**
 * test/prompt_input.test.tsx — DashLine sandwich + width adaptation.
 *
 * Spec: docs/superpowers/specs/2026-05-29-cli-intro-banner-design.md §"Input box"
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { PromptInput } from '../src/ui/PromptInput.js';

describe('PromptInput dashed dividers', () => {
  it('renders a dashed line above and below the input row', () => {
    const { lastFrame } = render(
      <PromptInput value="" onChange={() => {}} onSubmit={() => {}} />,
    );
    const frame = lastFrame() ?? '';
    // The frame should contain a run of at least 10 ┄ characters (defaults to
    // 60 wide when stdout.columns is unavailable; ink-testing-library reports
    // an 80-col stdout). Either way, ≥10 is a very loose lower bound.
    const matches = frame.match(/┄{10,}/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('still renders the prompt arrow and the value text between the dashes', () => {
    const { lastFrame } = render(
      <PromptInput value="hello" onChange={() => {}} onSubmit={() => {}} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('›');
    expect(frame).toContain('hello');
    // Structural check: ›/hello sit between two ┄ runs, not before or after both.
    const arrowIdx = frame.indexOf('›');
    const firstDashIdx = frame.indexOf('┄');
    const lastDashIdx = frame.lastIndexOf('┄');
    expect(firstDashIdx).toBeLessThan(arrowIdx);
    expect(arrowIdx).toBeLessThan(lastDashIdx);
  });
});
