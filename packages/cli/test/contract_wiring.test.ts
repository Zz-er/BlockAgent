/**
 * test/contract_wiring.test.ts — launch() wiring for the contract-model apps
 * (impl-cli, exec-wave4).
 *
 * Asserts the R-6 boot wiring lands correctly without driving a real model:
 *   1. With task + stats + messages enabled, launch installs all of them and boot
 *      does NOT crash (the registerContract → install → runtime(registry) → seed
 *      order is intact; an unsatisfiable bind or a mis-seeded bookkeeping block would
 *      throw or fail to install here).
 *   2. The agent tool catalog EXCLUDES the contract-model plumbing commands: the
 *      readonly `via` count commands (task.count / messages.count), the read-only
 *      query commands (task.list / task.get), and the externally-fed task.ingest
 *      (allowed_invokers excludes the agent on all of these) — while the agent's own
 *      write commands (task.add / task.complete) ARE advertised.
 *   3. stats is DISABLED by default (DEFAULTS.apps.stats.enabled === false), so a
 *      default-config boot installs no `stats` app.
 *
 * Storage is redirected to a temp dir so the suite never writes the repo's
 * .block-agent. Mirrors launch.test.ts (drive one mock turn to capture the catalog).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MockProvider } from '@block-agent/core/provider/mock.js';

import { launch } from '../src/launch.js';
import { makeCliChannel } from '../src/cli_channel.js';
import { makeExternalTaskAdapter } from '../src/external_task_adapter.js';
import { loadConfig, DEFAULTS } from '../src/config.js';
import type { LauncherConfig } from '../src/types.js';

/** A mock-provider config with task + stats + messages all enabled, storage in `dir`. */
function fourAppConfig(dir: string): LauncherConfig {
  return {
    provider: { kind: 'mock', model: 'mock' },
    apps: {
      agent_identity: { enabled: true },
      messages: { enabled: true },
      tools: { enabled: false }, // not under test here; keep the catalog small
      memory: { enabled: false },
      memory_letta: { enabled: false },
      task: { enabled: true },
      stats: { enabled: true },
      im_proxy: { enabled: false },
      oa_proxy: { enabled: false },
      task_proxy: { enabled: false },
    },
    storage_dir: dir,
  };
}

describe('contract-model launch wiring', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'block-agent-contract-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('installs task + stats + messages without crashing the boot', async () => {
    const agent = await launch(fourAppConfig(dir));

    // All three contract-model apps are registered (registerContract → install order
    // held; an unresolvable provides/consumes bind would have failed installation).
    expect(agent.registry.get('messages')).not.toBeNull();
    expect(agent.registry.get('task')).not.toBeNull();
    expect(agent.registry.get('stats')).not.toBeNull();

    // The seed pass (under runtime.root) attached the projection blocks: a render
    // produces a non-empty prompt (the runtime bookkeeping blocks + app blocks).
    const prompt = await agent.renderer.render(agent.operations.snapshot());
    expect(prompt.segments.length).toBeGreaterThan(0);
  });

  it('excludes count/query/ingest commands from the agent tool catalog, keeps writes', async () => {
    const agent = await launch(fourAppConfig(dir));

    // Drive one real turn so the provider is sent the catalog (mock replies once).
    await makeCliChannel(agent).submit('hello');

    const provider = agent.provider as MockProvider;
    const names = (provider.last_opts?.tools ?? []).map((t) => t.name);

    // The contract `via` count commands are readonly + app/user-only → never advertised.
    expect(names).not.toContain('task.count');
    expect(names).not.toContain('messages.count');
    // Read-only query commands (agent already sees the projection block) → excluded.
    expect(names).not.toContain('task.list');
    expect(names).not.toContain('task.get');
    // External-only ingestion (agent must not forge a task) → excluded.
    expect(names).not.toContain('task.ingest');
    // Physical purge is operator-only → excluded.
    expect(names).not.toContain('task.remove_physical');
    // User-only config command → excluded.
    expect(names).not.toContain('task.set_config');
    expect(names).not.toContain('stats.set_config');

    // …but the agent's own write commands ARE advertised (it can act on tasks).
    expect(names).toContain('task.add');
    expect(names).toContain('task.complete');
    expect(names).toContain('task.reopen');
    expect(names).toContain('task.remove');
  });

  it('stats is disabled by default — a default-config boot installs no stats app', async () => {
    // DEFAULTS pins stats off (§4.4): assert the source of truth first…
    expect(DEFAULTS.apps.stats.enabled).toBe(false);

    // …then a boot from the resolved default config (mock provider, no flags) must not
    // install stats, while task (default on) is present.
    const cfg = loadConfig(['--dry-run'], { BLOCK_AGENT_STORAGE_DIR: dir });
    const agent = await launch(cfg);
    expect(agent.registry.get('stats')).toBeNull();
    expect(agent.registry.get('task')).not.toBeNull();
  });
});

describe('ExternalTaskAdapter', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'block-agent-ext-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('authenticates as invoker=app with an ext:<source> identity', async () => {
    const agent = await launch(fourAppConfig(dir));
    const adapter = makeExternalTaskAdapter(agent.operations, 'webhook');
    const ctx = adapter.authenticate();
    expect(ctx.invoker).toBe('app');
    expect(ctx.identity).toBe('ext:webhook');
    expect(adapter.id).toBe('external_task');
    expect(adapter.source).toBe('webhook');
  });

  it('ingests an external task through the chokepoint (invoker=app passes the gate)', async () => {
    const agent = await launch(fourAppConfig(dir));
    const adapter = makeExternalTaskAdapter(agent.operations, 'github');

    // task.ingest is allowed_invokers ['app','user']; the adapter's invoker=app passes.
    const res = (await adapter.ingest({ title: 'review PR #7', ext_id: 'gh-7' })) as {
      ok: boolean;
    };
    expect(res.ok).toBe(true);

    // The task is now durably present: task.count (invoker=app, readonly query) reports 1.
    const count = (await agent.operations.invoke_command('task.count', {}, { invoker: 'app' })) as {
      ok: boolean;
      data?: unknown;
    };
    expect(count.ok).toBe(true);
    expect(count.data).toBe(1);
  });
});
