/**
 * test/hot_uninstall_e2e.test.ts — REAL hot-uninstall over the live launch() graph.
 *
 * The app_lifecycle.test.ts unit tests cover the /app dispatch + a FAKE-injected
 * hotUninstall. This e2e drives the genuine path: launch() (mock provider, no LLM/TTY) →
 * agent.hotUninstall(id) → assert the actual lifecycle effects on the live object graph
 * (registry removal, projection-block removal via the safe-window executor, no collateral
 * to other apps, runtime survives idle). Mirrors projection_e2e's "real graph" posture.
 * Storage is a temp dir so the suite never touches the repo's .block-agent.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { launch } from '../src/launch.js';
import type { LauncherConfig } from '../src/types.js';

function mockConfig(dir: string): LauncherConfig {
  return {
    provider: { kind: 'mock', model: 'mock' },
    apps: {
      agent_identity: { enabled: true },
      messages: { enabled: true },
      memory: { enabled: true },
      base: { enabled: false },
      memory_letta: { enabled: false },
      task: { enabled: false },
      stats: { enabled: false },
      im_proxy: { enabled: false },
      oa_proxy: { enabled: false },
      task_proxy: { enabled: false },
      skill: { enabled: false },
    },
    storage_dir: dir,
  };
}

describe('hot-uninstall (real launch + agent.hotUninstall)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'block-agent-hotuninstall-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes the app from registry + drops its projection block, leaving other apps intact', async () => {
    const agent = await launch(mockConfig(dir));

    // Precondition: messages installed + its projection block seeded into the tree.
    // (tools is display-free now — it owns no projection block — so we exercise the
    // projection-block-removal path through messages, which renders messages:recent.)
    expect(agent.registry.list().some((m) => m.id === 'messages')).toBe(true);
    expect(agent.operations.has('messages:recent')).toBe(true);
    expect(typeof agent.hotUninstall).toBe('function');

    const res = await agent.hotUninstall!('messages');

    // Hot-uninstall succeeded and reported the removed projection block.
    expect(res.ok).toBe(true);
    expect(res.removed_blocks).toContain('messages:recent');

    // messages is gone from the registry + its projection block soft-deleted from the tree.
    expect(agent.registry.list().some((m) => m.id === 'messages')).toBe(false);
    expect(agent.operations.has('messages:recent')).toBe(false);

    // No collateral: another installed app (memory) + its projection block remain.
    expect(agent.registry.list().some((m) => m.id === 'memory')).toBe(true);
    expect(agent.operations.has('memory:notes')).toBe(true);

    // The runtime survived the safe-window mutation and is back to idle (not wedged).
    expect(agent.runtime.state.kind).toBe('idle');

    // The prompt still renders and no longer carries any messages content.
    const prompt = await agent.renderer.render(agent.operations.snapshot());
    const text = prompt.segments
      .map((s) =>
        typeof s.rendered === 'string'
          ? s.rendered
          : s.rendered.map((p) => (p.type === 'text' ? p.value : '')).join(''),
      )
      .join('\n');
    expect(prompt.segments.length).toBeGreaterThan(0);
    expect(text).not.toContain('messages:recent');
  });

  it('returns a non-ok result for an unknown app id', async () => {
    const agent = await launch(mockConfig(dir));
    const res = await agent.hotUninstall!('does_not_exist');
    expect(res.ok).toBe(false);
  });
});
