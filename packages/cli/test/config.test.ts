/**
 * test/config.test.ts — loadConfig multi-source merge (impl-cli-logic).
 *
 * Covers the design §3 precedence (flags > file > env > defaults), the api-key-never-in-
 * config rule, --dry-run forcing mock, --no-<app> disabling, and the defensive bad-JSON
 * file behavior (defaults win, never throws). The flag parser variants (`--k v` /
 * `--k=v` / `--flag`) are exercised through loadConfig + parseFlags directly.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULTS, loadConfig, loadDotenv, parseFlags } from '../src/config.js';

/** An empty env so a stray real env var never leaks into a test's expectations. */
const EMPTY_ENV: NodeJS.ProcessEnv = {};

describe('parseFlags', () => {
  it('parses --k v, --k=v, and bare --flag', () => {
    const f = parseFlags(['--model', 'm1', '--provider=mock', '--dry-run', '--base-url']);
    expect(f['model']).toBe('m1');
    expect(f['provider']).toBe('mock');
    expect(f['dry-run']).toBe(true);
    // A bare flag at the end (no following value) is boolean true.
    expect(f['base-url']).toBe(true);
  });

  it('treats a flag followed by another flag as boolean', () => {
    const f = parseFlags(['--no-tools', '--model', 'm']);
    expect(f['no-tools']).toBe(true);
    expect(f['model']).toBe('m');
  });
});

describe('loadConfig precedence', () => {
  it('returns the compiled defaults with no flags/env/file', () => {
    const cfg = loadConfig([], EMPTY_ENV);
    expect(cfg.provider.kind).toBe(DEFAULTS.provider.kind);
    expect(cfg.provider.model).toBe(DEFAULTS.provider.model);
    expect(cfg.apps.agent_identity.enabled).toBe(true);
    expect(cfg.apps.messages.enabled).toBe(true);
    expect(cfg.apps.tools.enabled).toBe(true);
  });

  it('env overrides defaults; flags override env', () => {
    const env: NodeJS.ProcessEnv = {
      BLOCK_AGENT_PROVIDER: 'openai-compat',
      BLOCK_AGENT_MODEL: 'env-model',
    };
    const fromEnv = loadConfig([], env);
    expect(fromEnv.provider.kind).toBe('openai-compat');
    expect(fromEnv.provider.model).toBe('env-model');

    const fromFlags = loadConfig(['--model', 'flag-model'], env);
    expect(fromFlags.provider.model).toBe('flag-model'); // flag wins over env
    expect(fromFlags.provider.kind).toBe('openai-compat'); // env still supplies kind
  });

  it('--dry-run forces the mock provider over every other source', () => {
    const env: NodeJS.ProcessEnv = { BLOCK_AGENT_PROVIDER: 'anthropic' };
    const cfg = loadConfig(['--provider', 'anthropic', '--dry-run'], env);
    expect(cfg.provider.kind).toBe('mock');
  });

  it('--no-<app> disables an app', () => {
    const cfg = loadConfig(['--no-tools', '--no-messages'], EMPTY_ENV);
    expect(cfg.apps.tools.enabled).toBe(false);
    expect(cfg.apps.messages.enabled).toBe(false);
    expect(cfg.apps.agent_identity.enabled).toBe(true);
  });

  it('never places an api key into the resolved config', () => {
    const env: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: 'sk-secret',
      OPENAI_API_KEY: 'sk-secret-2',
    };
    const cfg = loadConfig([], env);
    const serialized = JSON.stringify(cfg);
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('api_key');
  });
});

describe('loadConfig config file', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'block-agent-cfg-'));
    file = join(dir, 'block-agent.config.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a valid file over defaults; flags still win over the file', () => {
    writeFileSync(
      file,
      JSON.stringify({
        provider: { kind: 'openai-compat', model: 'file-model', base_url: 'http://x' },
        apps: { messages: { display_count: 3 } },
      }),
      'utf8',
    );
    const fromFile = loadConfig(['--config', file], EMPTY_ENV);
    expect(fromFile.provider.kind).toBe('openai-compat');
    expect(fromFile.provider.model).toBe('file-model');
    expect(fromFile.apps.messages.display_count).toBe(3);

    // A flag overrides the file value.
    const overridden = loadConfig(['--config', file, '--model', 'flag-model'], EMPTY_ENV);
    expect(overridden.provider.model).toBe('flag-model');
  });

  it('config file overrides env (file is authoritative over ambient env vars)', () => {
    writeFileSync(
      file,
      JSON.stringify({
        provider: { kind: 'openai-compat', model: 'file-model', base_url: 'http://from-file' },
      }),
      'utf8',
    );
    const env: NodeJS.ProcessEnv = {
      BLOCK_AGENT_PROVIDER: 'anthropic',
      BLOCK_AGENT_MODEL: 'env-model',
      OPENAI_BASE_URL: 'http://from-env',
    };
    const cfg = loadConfig(['--config', file], env);
    // File beats env for every provider field…
    expect(cfg.provider.kind).toBe('openai-compat');
    expect(cfg.provider.model).toBe('file-model');
    expect(cfg.provider.base_url).toBe('http://from-file');

    // …but a flag still beats the file.
    const withFlag = loadConfig(['--config', file, '--model', 'flag-model'], env);
    expect(withFlag.provider.model).toBe('flag-model');
  });

  it('ignores a malformed JSON file (defaults win, never throws)', () => {
    writeFileSync(file, '{ this is not json', 'utf8');
    const cfg = loadConfig(['--config', file], EMPTY_ENV);
    expect(cfg.provider.kind).toBe(DEFAULTS.provider.kind);
    expect(cfg.provider.model).toBe(DEFAULTS.provider.model);
  });

  it('ignores a missing config file', () => {
    const cfg = loadConfig(['--config', join(dir, 'does-not-exist.json')], EMPTY_ENV);
    expect(cfg.provider.kind).toBe(DEFAULTS.provider.kind);
  });
});

describe('loadDotenv', () => {
  let dir: string;
  // Unique key names so a test's writes never collide with the real environment.
  const K1 = '__BA_DOTENV_TEST_K1';
  const K2 = '__BA_DOTENV_TEST_K2';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'block-agent-dotenv-'));
    delete process.env[K1];
    delete process.env[K2];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env[K1];
    delete process.env[K2];
  });

  it('populates process.env from a .env file (KEY=VALUE, comments + quotes)', () => {
    const file = join(dir, '.env');
    writeFileSync(file, `# a comment\n${K1}=plain-value\n${K2}="quoted value"\n\n`, 'utf8');
    loadDotenv(file);
    expect(process.env[K1]).toBe('plain-value');
    expect(process.env[K2]).toBe('quoted value'); // surrounding quotes stripped
  });

  it('OVERRIDES a pre-existing ambient env var (file > env)', () => {
    process.env[K1] = 'from-shell';
    const file = join(dir, '.env');
    writeFileSync(file, `${K1}=from-dotenv`, 'utf8');
    loadDotenv(file);
    expect(process.env[K1]).toBe('from-dotenv');
  });

  it('is a no-op for a missing file (never throws)', () => {
    process.env[K1] = 'untouched';
    expect(() => loadDotenv(join(dir, 'does-not-exist'))).not.toThrow();
    expect(process.env[K1]).toBe('untouched');
  });
});
