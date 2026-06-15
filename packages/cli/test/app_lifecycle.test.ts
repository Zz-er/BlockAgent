/**
 * test/app_lifecycle.test.ts — BUILTIN_APP_CATALOG + writeAppConfig + appsView two-segment
 * + /app command five sub-commands + purge gate + confirmation (impl-cli task #4).
 *
 * Design: ai_com/block-agent-app-lifecycle-impl-split.md §3, §3.5.
 *
 * All tests use temp directories; no real .block-agent dir is touched.
 * The fake agent/registry injects only the minimal seam appCommand needs:
 *   - agent.registry.list() / .get(id) — simulated via a plain object.
 *   - agent.hotUninstall             — a fake that records calls (uninstall branch).
 *   - agent.config_path              — typed field so writeAppConfig writes to a temp file.
 *   - agent.allow_purge              — typed field controlling the purge capability gate.
 *   - agent.storage_dir              — typed field pointing purge at a temp directory.
 *
 * (Integration #5 replaced the earlier `_configPath` / `_allowPurge` / `_storageDir`
 *  underscore-cast hacks with these typed LaunchedAgent fields that launch.ts sets.)
 *
 * Tests are UNIT-level: no launch(), no network, no Anthropic key.
 */

import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BUILTIN_APP_CATALOG } from '../src/app_catalog.js';
import { writeAppConfig, DEFAULTS } from '../src/config.js';
import { appsView, availableApps } from '../src/context_view.js';
import { dispatch } from '../src/commands.js';
import type { AppSummary, AvailableApp, CtxView, HotUninstallResult, LaunchedAgent } from '../src/types.js';

// ============================================================================
// Helpers
// ============================================================================

/** A minimal fake AppRegistry entry returned by list(). */
function fakeManifest(id: string): {
  id: string;
  version: string;
  builders: Array<(s: unknown) => { outputs: string[] }>;
  commands: Array<(s: unknown) => { name: string; allowed_invokers?: string[] }>;
  initial_state: unknown;
} {
  return {
    id,
    version: '1.0.0',
    builders: [() => ({ outputs: [`${id}:data`] })],
    commands: [
      () => ({
        name: 'info',
        allowed_invokers: ['user'],
      }),
    ],
    initial_state: {},
  };
}

/**
 * Build a minimal fake LaunchedAgent suitable for appCommand tests.
 * `installedIds` controls which apps registry.list() and registry.get() report.
 */
function makeFakeAgent(opts: {
  installedIds?: string[];
  configPath?: string;
  allowPurge?: boolean;
  storageDir?: string;
  hotUninstall?: (id: string) => Promise<HotUninstallResult>;
}): LaunchedAgent {
  const installed = (opts.installedIds ?? []).map(fakeManifest);
  const registry = {
    list: () => installed,
    get: (id: string) => installed.find((m) => m.id === id) ?? null,
  };
  return {
    // minimal stubs for fields not used by appCommand
    operations: {} as LaunchedAgent['operations'],
    renderer: {} as LaunchedAgent['renderer'],
    runtime: {} as LaunchedAgent['runtime'],
    registry: registry as unknown as LaunchedAgent['registry'],
    messages: null,
    provider: {} as LaunchedAgent['provider'],
    provider_id: 'mock',
    welcome: { cube: true },
    // typed LaunchedAgent fields launch.ts threads through (integration #5).
    ...(opts.configPath !== undefined ? { config_path: opts.configPath } : {}),
    ...(opts.allowPurge !== undefined ? { allow_purge: opts.allowPurge } : {}),
    ...(opts.storageDir !== undefined ? { storage_dir: opts.storageDir } : {}),
    ...(opts.hotUninstall !== undefined ? { hotUninstall: opts.hotUninstall } : {}),
  };
}

/** Capture the last CtxView a slash command pushed. */
function capture(): { setView: (v: CtxView) => void; last: () => CtxView | null } {
  let v: CtxView | null = null;
  return { setView: (next) => (v = next), last: () => v };
}

// ============================================================================
// BUILTIN_APP_CATALOG
// ============================================================================

describe('BUILTIN_APP_CATALOG', () => {
  it('contains exactly 8 entries (the 5 originals + actions + the contract-model task / stats)', () => {
    const ids = BUILTIN_APP_CATALOG.map((e) => e.id);
    expect(ids).toHaveLength(8);
    expect(ids).toContain('agent_identity');
    expect(ids).toContain('messages');
    expect(ids).toContain('tools');
    expect(ids).toContain('memory');
    expect(ids).toContain('actions');
    expect(ids).toContain('memory_letta');
    expect(ids).toContain('task');
    expect(ids).toContain('stats');
  });

  it('default_enabled values mirror DEFAULTS.apps', () => {
    for (const entry of BUILTIN_APP_CATALOG) {
      const defaultEnabled = DEFAULTS.apps[entry.id as keyof typeof DEFAULTS.apps]?.enabled;
      // Use a conditional so a failure message includes the offending app id.
      if (defaultEnabled !== entry.default_enabled) {
        throw new Error(
          `catalog.${entry.id}.default_enabled (${String(entry.default_enabled)}) does not match DEFAULTS.apps.${entry.id}.enabled (${String(defaultEnabled)})`,
        );
      }
    }
  });

  it('memory_letta has default_enabled=false and a requires field', () => {
    const letta = BUILTIN_APP_CATALOG.find((e) => e.id === 'memory_letta');
    expect(letta).toBeDefined();
    expect(letta!.default_enabled).toBe(false);
    expect(typeof letta!.requires).toBe('string');
    expect(letta!.requires!.length).toBeGreaterThan(0);
  });

  it('all four core apps have default_enabled=true', () => {
    for (const id of ['agent_identity', 'messages', 'tools', 'memory'] as const) {
      const entry = BUILTIN_APP_CATALOG.find((e) => e.id === id);
      expect(entry?.default_enabled).toBe(true);
    }
  });
});

// ============================================================================
// writeAppConfig
// ============================================================================

describe('writeAppConfig', () => {
  let dir: string;
  let cfgPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'block-agent-wac-'));
    cfgPath = join(dir, 'block-agent.config.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the file when absent, writing only the patched apps section', () => {
    writeAppConfig(cfgPath, { apps: { memory: { enabled: false } } });
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    const apps = parsed['apps'] as Record<string, { enabled: boolean }>;
    expect(apps['memory']?.enabled).toBe(false);
    // No other top-level keys (file was absent → minimal write).
    expect(Object.keys(parsed).filter((k) => k !== 'apps')).toHaveLength(0);
  });

  it('patches apps.<id>.enabled while preserving all other keys', () => {
    const original = {
      provider: { kind: 'openai-compat', model: 'deepseek' },
      storage_dir: '/data',
      apps: {
        memory: { enabled: true, notes_char_limit: 3000 },
        messages: { enabled: true, display_count: 5 },
      },
    };
    writeFileSync(cfgPath, JSON.stringify(original, null, 2), 'utf8');

    writeAppConfig(cfgPath, { apps: { memory: { enabled: false } } });

    const result = JSON.parse(readFileSync(cfgPath, 'utf8')) as typeof original;
    // patched field
    expect(result.apps.memory.enabled).toBe(false);
    // other fields in same app preserved
    expect(result.apps.memory.notes_char_limit).toBe(3000);
    // sibling app preserved
    expect(result.apps.messages.enabled).toBe(true);
    expect(result.apps.messages.display_count).toBe(5);
    // top-level fields preserved
    expect(result.provider.kind).toBe('openai-compat');
    expect(result.storage_dir).toBe('/data');
  });

  it('patches multiple apps in one call', () => {
    const original = {
      apps: {
        memory: { enabled: true },
        memory_letta: { enabled: false },
      },
    };
    writeFileSync(cfgPath, JSON.stringify(original, null, 2), 'utf8');
    writeAppConfig(cfgPath, {
      apps: { memory: { enabled: false }, memory_letta: { enabled: true } },
    });
    const result = JSON.parse(readFileSync(cfgPath, 'utf8')) as typeof original;
    expect(result.apps.memory.enabled).toBe(false);
    expect(result.apps.memory_letta.enabled).toBe(true);
  });

  it('throws on malformed JSON (does not silently clobber)', () => {
    writeFileSync(cfgPath, '{ this is not valid json', 'utf8');
    expect(() => writeAppConfig(cfgPath, { apps: { memory: { enabled: false } } })).toThrow();
  });

  it('never writes API keys (key-iron-law assertion)', () => {
    writeAppConfig(cfgPath, { apps: { memory: { enabled: true } } });
    const raw = readFileSync(cfgPath, 'utf8');
    expect(raw).not.toContain('api_key');
    expect(raw).not.toContain('API_KEY');
  });
});

// ============================================================================
// appsView two-segment
// ============================================================================

describe('appsView two-segment', () => {
  it('installed segment contains only installed app ids, available contains the rest', () => {
    const agent = makeFakeAgent({ installedIds: ['memory'] });
    const { installed, available } = appsView(agent);

    const installedIds = installed.map((a: AppSummary) => a.id);
    expect(installedIds).toEqual(['memory']);

    const availableIds = available.map((a: AvailableApp) => a.id);
    // All catalog entries except 'memory' should be in available.
    const expectedAvailable = BUILTIN_APP_CATALOG.map((e) => e.id).filter((id) => id !== 'memory');
    expect(availableIds).toEqual(expect.arrayContaining(expectedAvailable));
    expect(availableIds).not.toContain('memory');
  });

  it('available is empty when all catalog apps are installed', () => {
    const allIds = BUILTIN_APP_CATALOG.map((e) => e.id);
    const agent = makeFakeAgent({ installedIds: allIds });
    const { available } = appsView(agent);
    expect(available).toHaveLength(0);
  });

  it('available entries carry summary, default_enabled, requires from catalog', () => {
    const agent = makeFakeAgent({ installedIds: [] });
    const { available } = appsView(agent);
    const letta = available.find((a: AvailableApp) => a.id === 'memory_letta');
    expect(letta).toBeDefined();
    expect(letta!.default_enabled).toBe(false);
    expect(typeof letta!.requires).toBe('string');
    expect(letta!.summary.length).toBeGreaterThan(0);
  });

  it('availableApps accepts a custom catalog (installed ids are excluded)', () => {
    const fakeCatalog = [
      { id: 'alpha', summary: 'Alpha app', default_enabled: true },
      { id: 'beta', summary: 'Beta app', default_enabled: false },
    ];
    const agent = makeFakeAgent({ installedIds: ['alpha'] });
    const result = availableApps(agent, fakeCatalog);
    expect(result.map((a: AvailableApp) => a.id)).toEqual(['beta']);
  });
});

// ============================================================================
// /app command dispatch
// ============================================================================

describe('/app command dispatch', () => {
  let dir: string;
  let cfgPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'block-agent-app-'));
    cfgPath = join(dir, 'block-agent.config.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('/app (no sub-command) shows usage text', async () => {
    const agent = makeFakeAgent({ installedIds: [], configPath: cfgPath });
    const cap = capture();
    await dispatch(agent, '/app', cap.setView);
    const v = cap.last() as Extract<CtxView, { kind: 'command_result' }>;
    expect(v.ok).toBe(false);
    expect(v.text).toContain('usage:');
    expect(v.text).toContain('info');
    expect(v.text).toContain('install');
    expect(v.text).toContain('uninstall');
    expect(v.text).toContain('swap');
    expect(v.text).toContain('purge');
  });

  // ── info ─────────────────────────────────────────────────────────────────

  it('/app info <installed-id> returns read-only details without writing any file', async () => {
    const agent = makeFakeAgent({ installedIds: ['memory'], configPath: cfgPath });
    const cap = capture();
    await dispatch(agent, '/app info memory', cap.setView);
    const v = cap.last();
    expect(v?.kind).toBe('message');
    const msg = (v as Extract<CtxView, { kind: 'message' }>).text;
    expect(msg).toContain('memory');
    expect(msg).toContain('installed');
    // No config file should have been written.
    expect(existsSync(cfgPath)).toBe(false);
  });

  it('/app info <catalog-id-not-installed> shows catalog entry with requires', async () => {
    const agent = makeFakeAgent({ installedIds: [], configPath: cfgPath });
    const cap = capture();
    await dispatch(agent, '/app info memory_letta', cap.setView);
    const v = cap.last();
    expect(v?.kind).toBe('message');
    const msg = (v as Extract<CtxView, { kind: 'message' }>).text;
    expect(msg).toContain('memory_letta');
    expect(msg).toContain('not installed');
    expect(msg).toContain('requires');
  });

  it('/app info <unknown-id> reports error', async () => {
    const agent = makeFakeAgent({ installedIds: [], configPath: cfgPath });
    const cap = capture();
    await dispatch(agent, '/app info no_such_app', cap.setView);
    const v = cap.last() as Extract<CtxView, { kind: 'command_result' }>;
    expect(v.ok).toBe(false);
    expect(v.text).toContain('unknown app id');
  });

  // ── install ───────────────────────────────────────────────────────────────

  it('/app install <id> writes enabled:true + shows restart warning', async () => {
    const agent = makeFakeAgent({ installedIds: [], configPath: cfgPath });
    const cap = capture();
    await dispatch(agent, '/app install memory_letta', cap.setView);
    const v = cap.last() as Extract<CtxView, { kind: 'command_result' }>;
    expect(v.ok).toBe(true);
    expect(v.text).toContain('Restart');

    const result = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
      apps: { memory_letta: { enabled: boolean } };
    };
    expect(result.apps.memory_letta.enabled).toBe(true);
  });

  it('/app install <unknown-id> rejects without writing config', async () => {
    const agent = makeFakeAgent({ installedIds: [], configPath: cfgPath });
    const cap = capture();
    await dispatch(agent, '/app install not_a_real_app', cap.setView);
    const v = cap.last() as Extract<CtxView, { kind: 'command_result' }>;
    expect(v.ok).toBe(false);
    expect(v.text).toContain('unknown app id');
    expect(existsSync(cfgPath)).toBe(false);
  });

  // ── uninstall ─────────────────────────────────────────────────────────────

  it('/app uninstall calls hotUninstall (fake injection) + writes config enabled:false', async () => {
    const hotCalls: string[] = [];
    const fakeHot = async (id: string): Promise<HotUninstallResult> => {
      hotCalls.push(id);
      return { ok: true, removed_blocks: [`${id}:data`] };
    };
    const agent = makeFakeAgent({
      installedIds: ['memory'],
      configPath: cfgPath,
      hotUninstall: fakeHot,
    });

    const cap = capture();
    await dispatch(agent, '/app uninstall memory', cap.setView);
    const v = cap.last() as Extract<CtxView, { kind: 'command_result' }>;
    expect(v.ok).toBe(true);

    // hotUninstall was called with the correct id.
    expect(hotCalls).toEqual(['memory']);

    // Config written enabled:false.
    const result = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
      apps: { memory: { enabled: boolean } };
    };
    expect(result.apps.memory.enabled).toBe(false);
  });

  it('/app uninstall: busy runtime → error result, config NOT written', async () => {
    const fakeHot = async (_id: string): Promise<HotUninstallResult> => ({
      ok: false,
      reason: 'busy',
    });
    const agent = makeFakeAgent({
      installedIds: ['memory'],
      configPath: cfgPath,
      hotUninstall: fakeHot,
    });

    const cap = capture();
    await dispatch(agent, '/app uninstall memory', cap.setView);
    const v = cap.last() as Extract<CtxView, { kind: 'command_result' }>;
    expect(v.ok).toBe(false);
    // Message explains the busy state; no 'busy' keyword required — check for 'turn'.
    expect(v.text).toContain('turn');
    // Config NOT written when busy.
    expect(existsSync(cfgPath)).toBe(false);
  });

  it('/app uninstall: no hotUninstall hook → fallback: writes config + restart hint', async () => {
    const agent = makeFakeAgent({
      installedIds: ['memory'],
      configPath: cfgPath,
      // hotUninstall intentionally absent
    });

    const cap = capture();
    await dispatch(agent, '/app uninstall memory', cap.setView);
    const v = cap.last() as Extract<CtxView, { kind: 'command_result' }>;
    expect(v.ok).toBe(true);
    expect(v.text).toContain('Restart');

    const result = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
      apps: { memory: { enabled: boolean } };
    };
    expect(result.apps.memory.enabled).toBe(false);
  });

  it('/app uninstall <not-installed-id> rejects', async () => {
    const agent = makeFakeAgent({ installedIds: [], configPath: cfgPath });
    const cap = capture();
    await dispatch(agent, '/app uninstall memory', cap.setView);
    const v = cap.last() as Extract<CtxView, { kind: 'command_result' }>;
    expect(v.ok).toBe(false);
    expect(v.text).toContain('not installed');
  });

  // ── F1: protected-app uninstall guard (actions-app §6) ──────────────────────

  it('F1: /app uninstall actions is rejected (observation floor) — no hotUninstall, no config write', async () => {
    // hotUninstall must NOT be called and the config must NOT be written: the guard fires
    // BEFORE both. `actions` is installed here so we are not just hitting the not-installed path.
    const hotCalls: string[] = [];
    const fakeHot = async (id: string): Promise<HotUninstallResult> => {
      hotCalls.push(id);
      return { ok: true };
    };
    const agent = makeFakeAgent({
      installedIds: ['actions'],
      configPath: cfgPath,
      hotUninstall: fakeHot,
    });

    const cap = capture();
    await dispatch(agent, '/app uninstall actions', cap.setView);
    const v = cap.last() as Extract<CtxView, { kind: 'command_result' }>;

    expect(v.ok).toBe(false);
    // Message names the app + the reason it is protected.
    expect(v.text).toContain('actions');
    expect(v.text).toContain('observation floor');
    // The guard short-circuits: hotUninstall never ran, config never written.
    expect(hotCalls).toEqual([]);
    expect(existsSync(cfgPath)).toBe(false);
  });

  it('F1: the guard fires even when actions is NOT installed (protected by id, not state)', async () => {
    // The guard is keyed on the id, so it rejects before the not-installed check — a user
    // can never uninstall the observation floor regardless of current install state.
    const agent = makeFakeAgent({ installedIds: [], configPath: cfgPath });
    const cap = capture();
    await dispatch(agent, '/app uninstall actions', cap.setView);
    const v = cap.last() as Extract<CtxView, { kind: 'command_result' }>;
    expect(v.ok).toBe(false);
    expect(v.text).toContain('observation floor');
    // Reaches the guard message, not the generic "not installed" rejection.
    expect(v.text).not.toContain('not installed');
    expect(existsSync(cfgPath)).toBe(false);
  });

  // ── swap ──────────────────────────────────────────────────────────────────

  it('/app swap writes enabled:false for current + enabled:true for next', async () => {
    const agent = makeFakeAgent({ installedIds: ['memory'], configPath: cfgPath });
    const cap = capture();
    await dispatch(agent, '/app swap memory memory_letta', cap.setView);
    const v = cap.last() as Extract<CtxView, { kind: 'command_result' }>;
    expect(v.ok).toBe(true);
    expect(v.text).toContain('Restart');

    const result = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
      apps: { memory: { enabled: boolean }; memory_letta: { enabled: boolean } };
    };
    expect(result.apps.memory.enabled).toBe(false);
    expect(result.apps.memory_letta.enabled).toBe(true);
  });

  it('/app swap rejects when current id is not installed', async () => {
    const agent = makeFakeAgent({ installedIds: [], configPath: cfgPath });
    const cap = capture();
    await dispatch(agent, '/app swap memory memory_letta', cap.setView);
    const v = cap.last() as Extract<CtxView, { kind: 'command_result' }>;
    expect(v.ok).toBe(false);
    expect(existsSync(cfgPath)).toBe(false);
  });

  it('/app swap rejects when next id is not in catalog', async () => {
    const agent = makeFakeAgent({ installedIds: ['memory'], configPath: cfgPath });
    const cap = capture();
    await dispatch(agent, '/app swap memory totally_fake_app', cap.setView);
    const v = cap.last() as Extract<CtxView, { kind: 'command_result' }>;
    expect(v.ok).toBe(false);
    expect(existsSync(cfgPath)).toBe(false);
  });

  // ── purge ─────────────────────────────────────────────────────────────────

  it('/app purge: allow_purge=false (default) → rejects with allow_purge guidance', async () => {
    const agent = makeFakeAgent({
      installedIds: ['memory'],
      configPath: cfgPath,
      allowPurge: false,
    });
    const cap = capture();
    // Even with confirmation, purge must be blocked if capability is off.
    await dispatch(agent, '/app purge memory yes', cap.setView);
    const v = cap.last() as Extract<CtxView, { kind: 'command_result' }>;
    expect(v.ok).toBe(false);
    expect(v.text).toContain('allow_purge');
  });

  it('/app purge: allow_purge=true, no confirmation → prints warning, does NOT delete dir', async () => {
    const appDir = join(dir, '.block-agent', 'apps', 'memory');
    mkdirSync(appDir, { recursive: true });

    const agent = makeFakeAgent({
      installedIds: ['memory'],
      configPath: cfgPath,
      allowPurge: true,
      storageDir: dir,
    });
    const cap = capture();
    // No 'yes' or --confirm.
    await dispatch(agent, '/app purge memory', cap.setView);
    const v = cap.last() as Extract<CtxView, { kind: 'command_result' }>;
    expect(v.ok).toBe(false);
    expect(v.text).toContain('WARNING');
    // Directory must NOT be deleted — user didn't confirm.
    expect(existsSync(appDir)).toBe(true);
  });

  it('/app purge: allow_purge=true + "yes" confirmation → deletes app directory', async () => {
    const appDir = join(dir, '.block-agent', 'apps', 'memory');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'data.json'), '{}');

    const agent = makeFakeAgent({
      installedIds: ['memory'],
      configPath: cfgPath,
      allowPurge: true,
      storageDir: dir,
    });
    const cap = capture();
    await dispatch(agent, '/app purge memory yes', cap.setView);
    const v = cap.last() as Extract<CtxView, { kind: 'command_result' }>;
    expect(v.ok).toBe(true);
    expect(v.text).toContain('Purged');
    // Directory must be deleted.
    expect(existsSync(appDir)).toBe(false);
  });

  it('/app purge: unknown sub-command reports error', async () => {
    const agent = makeFakeAgent({ installedIds: [], configPath: cfgPath });
    const cap = capture();
    await dispatch(agent, '/app bogus_subcmd', cap.setView);
    const v = cap.last() as Extract<CtxView, { kind: 'command_result' }>;
    expect(v.ok).toBe(false);
    expect(v.text).toContain('unknown /app sub-command');
  });
});
