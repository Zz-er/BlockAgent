/**
 * cli/ink.ts — single Ink re-export point (impl-cli-ui owned surface; architect stub).
 *
 * Every UI component imports Ink primitives from HERE, not from 'ink' directly —
 * mirrors claude-code's src/ink.ts single wrapper (see design §8). One import site
 * makes it trivial to add a theme provider, swap the renderer, or stub Ink in tests
 * later, without touching every component.
 *
 * This is a thin pass-through for v3.0. TODO(impl-cli-ui): add a theme/color helper
 * here if/when needed; keep it the ONLY module that imports 'ink'.
 */

export { render, Box, Text, useApp, useInput, useStdin } from 'ink';
export type { Key } from 'ink';
