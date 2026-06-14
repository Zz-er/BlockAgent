/**
 * server/test/bin.test.ts — the headless serve entry's config resolution (D6 §8 seam 2 / §3.1).
 *
 * `resolveServeConfig` turns `--config <path> --name <id> [--port] [--host]` into the
 * LauncherConfig + the instance's endpoint, reusing `loadConfig`'s precedence chain. These
 * tests assert the §3.1 instance keying (name required; per-instance data dir) and that the
 * API key never enters the resolved config (it stays env-only — loadConfig never reads a key).
 * Pure: no socket bind here (the live serve()+/health path is covered by health.test.ts).
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveServeConfig } from '@block-agent/server/bin.js';

describe('resolveServeConfig — headless serve instance keying', () => {
  it('requires --name (it keys the data dir + endpoint)', () => {
    expect(() => resolveServeConfig(['--provider', 'mock'], {})).toThrow(/--name/);
  });

  it('derives a per-instance storage_dir nested under the resolved base', () => {
    const { config, name } = resolveServeConfig(
      ['--name', 'agent-7', '--provider', 'mock', '--storage-dir', '/data'],
      {},
    );
    expect(name).toBe('agent-7');
    // Each instance gets its OWN data dir so two co-located instances never collide.
    expect(config.storage_dir).toBe(join('/data', 'agent-7'));
  });

  it('keys port/host from flags (port-per-instance), defaulting host to loopback', () => {
    const { port, host } = resolveServeConfig(['--name', 'a', '--port', '9100'], {});
    expect(port).toBe(9100);
    expect(host).toBe('127.0.0.1');
  });

  it('falls back to the default port when --port is absent', () => {
    const { port } = resolveServeConfig(['--name', 'a'], {});
    expect(port).toBe(7345);
  });

  it('honors the loadConfig precedence chain (flags resolve the provider)', () => {
    const { config } = resolveServeConfig(['--name', 'a', '--provider', 'mock'], {});
    expect(config.provider.kind).toBe('mock');
  });

  it('never carries an API key in the resolved config (key stays env-only)', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-should-not-leak', OPENAI_API_KEY: 'sk-also-not' };
    const { config } = resolveServeConfig(['--name', 'a', '--provider', 'mock'], env);
    // No key field anywhere in the config (loadConfig never reads/echoes a key).
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain('sk-should-not-leak');
    expect(serialized).not.toContain('sk-also-not');
  });
});
