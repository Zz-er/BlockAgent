/**
 * test/context_view.test.ts — /context summarize + /dump (impl-cli-logic).
 *
 * Verifies the read-only context helpers (design §5): summarize abbreviates each render
 * segment to tier/bytes/cache_boundary/preview with the snapshot hash; dumpFull writes
 * the complete prompt text + a header to a file; appsView reflects blocks + commands.
 * These touch no per-invoker param + inject no clock, so INV #1 (byte-identical render)
 * is undisturbed — summarize over the same snapshot returns the same hash.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { launch } from '../src/launch.js';
import { summarize, dumpFull, appsView } from '../src/context_view.js';
import type { LauncherConfig, LaunchedAgent } from '../src/types.js';

function mockConfig(storage_dir: string): LauncherConfig {
  return {
    provider: { kind: 'mock', model: 'mock' },
    apps: {
      agent_identity: { enabled: true },
      messages: { enabled: true },
      tools: { enabled: true },
    },
    storage_dir,
  };
}

describe('context_view', () => {
  let dir: string;
  let agent: LaunchedAgent;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'block-agent-ctx-'));
    agent = await launch(mockConfig(dir));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('summarize abbreviates segments and is stable for a given snapshot (INV #1)', async () => {
    const a = await summarize(agent);
    expect(a.kind).toBe('context');
    expect(typeof a.snapshot_hash).toBe('string');
    for (const seg of a.segments) {
      expect(typeof seg.tier).toBe('string');
      expect(typeof seg.bytes).toBe('number');
      expect(typeof seg.cache_boundary).toBe('boolean');
      expect(typeof seg.preview).toBe('string');
    }
    // Re-summarize with no intervening mutation → identical hash (byte-identical render).
    const b = await summarize(agent);
    expect(b.snapshot_hash).toBe(a.snapshot_hash);
  });

  it('dumpFull writes the full prompt text + header to a file', async () => {
    const out = join(dir, 'dump.txt');
    await dumpFull(agent, out);
    const text = readFileSync(out, 'utf8');
    expect(text).toContain('# block-agent context dump');
    expect(text).toContain('snapshot_hash:');
    expect(text).toContain('segments:');
  });

  it('appsView reflects each app id, version, blocks, and commands', () => {
    const apps = appsView(agent);
    const ids = apps.map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(['agent_identity', 'messages', 'tools']));

    const messages = apps.find((a) => a.id === 'messages')!;
    // messages owns the recent + summary projection blocks.
    expect(messages.blocks).toEqual(expect.arrayContaining(['messages:recent', 'messages:summary']));
    // messages.set_config is user-only.
    const setConfig = messages.commands.find((c) => c.full_name === 'messages.set_config');
    expect(setConfig?.user_only).toBe(true);
  });
});
