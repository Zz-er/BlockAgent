/**
 * test/launch.test.ts — launch() wiring (impl-cli-logic).
 *
 * Focused on the tool-catalog wiring added for real-LLM use: launch must advertise
 * the agent-invokable commands to the provider as SendOpts.tools (native tool
 * dispatch), and it must EXCLUDE user-only commands (allowed_invokers without 'agent':
 * agent_identity.set, messages.set_config, tools.set_config). We drive a mock provider
 * (which records last_opts) through one real turn via the CLI channel and assert what
 * was sent. Storage is redirected to a temp dir so the suite never writes the repo's
 * .block-agent.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MockProvider } from '@block-agent/core/provider/mock.js';

import { launch } from '../src/launch.js';
import { makeCliChannel } from '../src/cli_channel.js';
import type { LauncherConfig } from '../src/types.js';

/** A mock-provider config with all three standard apps enabled, storage in `dir`. */
function mockConfig(dir: string): LauncherConfig {
  return {
    provider: { kind: 'mock', model: 'mock' },
    apps: {
      agent_identity: { enabled: true },
      messages: { enabled: true },
      tools: { enabled: true },
      memory: { enabled: true },
      memory_letta: { enabled: false }, // needs an external server; off in tests
    },
    storage_dir: dir,
  };
}

describe('launch tool catalog', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'block-agent-launch-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('advertises agent commands as SendOpts.tools and excludes user-only commands', async () => {
    const agent = await launch(mockConfig(dir));

    // Drive one real turn (ingest → wake → turn loop) so the provider is sent the
    // catalog. The mock script replies once then ends.
    await makeCliChannel(agent).submit('hello');

    const provider = agent.provider as MockProvider;
    const tools = provider.last_opts?.tools ?? [];
    const names = tools.map((t) => t.name);

    // The agent can reply (messages.reply is advertised)…
    expect(names).toContain('messages.reply');
    // …every advertised tool carries a description (provider maps it to function specs).
    expect(tools.every((t) => typeof t.description === 'string' && t.description.length > 0)).toBe(
      true,
    );

    // …but user-only commands are filtered OUT (PolicyEngine would deny them anyway).
    expect(names).not.toContain('messages.set_config');
    expect(names).not.toContain('tools.set_config');
    expect(names).not.toContain('agent_identity.set');
    expect(names).not.toContain('memory.set_config');
    // agent_identity's only command is user-only, so the agent sees none of its commands.
    expect(names.some((n) => n.startsWith('agent_identity.'))).toBe(false);
  });

  it('installs the built-in memory app and advertises its agent commands', async () => {
    const agent = await launch(mockConfig(dir));

    // The memory app is installed in the registry (boot did not crash with it on).
    expect(agent.registry.get('memory')).not.toBeNull();

    // Its agent-invokable commands reach the provider tool catalog after one turn.
    await makeCliChannel(agent).submit('hello');
    const provider = agent.provider as MockProvider;
    const names = (provider.last_opts?.tools ?? []).map((t) => t.name);

    expect(names).toContain('memory.remember');
    expect(names).toContain('memory.recall');
    // user-only memory config command is NOT advertised to the agent.
    expect(names).not.toContain('memory.set_config');
  });
});
