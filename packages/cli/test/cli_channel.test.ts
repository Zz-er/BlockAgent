/**
 * test/cli_channel.test.ts — the CLI ChannelAdapter (impl-cli-logic).
 *
 * Verifies the trust-membrane contract (design §1 / §6 / §9):
 *   - authenticate() always stamps invoker=user.
 *   - submit(text) goes through messages.ingest (the chokepoint front door) as
 *     invoker=user, runs the turn (mock provider replies), and the reply is delivered
 *     to an onDeliver subscriber (reply=Option B push), never forging invoker=agent.
 *
 * Uses launch() with the mock provider (--dry-run equivalent) + a temp storage dir, so
 * no API key / network is needed and the full turn loop runs deterministically.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { launch } from '../src/launch.js';
import { makeCliChannel } from '../src/cli_channel.js';
import type { LauncherConfig, LaunchedAgent, ReplyEvent } from '../src/types.js';

function mockConfig(storage_dir: string): LauncherConfig {
  return {
    provider: { kind: 'mock', model: 'mock' },
    apps: {
      agent_identity: { enabled: true },
      messages: { enabled: true },
      memory: { enabled: false },
      base: { enabled: false },
      memory_letta: { enabled: false },
      task: { enabled: false },
      stats: { enabled: false },
      im_proxy: { enabled: false },
      oa_proxy: { enabled: false },
      task_proxy: { enabled: false },
    },
    storage_dir,
  };
}

describe('CliChannel', () => {
  let dir: string;
  let agent: LaunchedAgent;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'block-agent-chan-'));
    agent = await launch(mockConfig(dir));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('authenticate stamps invoker=user', () => {
    const channel = makeCliChannel(agent);
    expect(channel.authenticate()).toEqual({ invoker: 'user' });
    expect(channel.id).toBe('cli');
  });

  it('submit routes through messages.ingest as invoker=user and delivers the reply', async () => {
    const channel = makeCliChannel(agent);
    const delivered: ReplyEvent[] = [];
    const off = channel.onDeliver((e) => delivered.push(e));

    await channel.submit('hello agent');

    // The mock provider's scripted reply was pushed to onDeliver (reply=Option B).
    expect(delivered.length).toBe(1);
    expect(delivered[0]!.content).toContain('mock');

    off();
  });

  it('submit goes through the chokepoint (the user message is recorded as a user turn)', async () => {
    const channel = makeCliChannel(agent);
    await channel.submit('a user line');

    // peek the conversation: the user message is present with role=user — proof it
    // entered via ingest (invoker=user), not some forged path.
    const peek = await agent.operations.invoke_command('messages.peek', {}, { invoker: 'user' });
    expect(peek.ok).toBe(true);
    const data = peek.data as { recent: Array<{ role: string; content: string }> };
    expect(data.recent.some((m) => m.role === 'user' && m.content === 'a user line')).toBe(true);
  });

  it('onDeliver returns an inert unsubscribe when the messages app is disabled', async () => {
    const noMsgDir = mkdtempSync(join(tmpdir(), 'block-agent-nomsg-'));
    try {
      const cfg = mockConfig(noMsgDir);
      cfg.apps.messages.enabled = false;
      const noMsgAgent = await launch(cfg);
      const channel = makeCliChannel(noMsgAgent);
      const off = channel.onDeliver(() => {
        throw new Error('should never fire');
      });
      expect(typeof off).toBe('function');
      off(); // no throw
    } finally {
      rmSync(noMsgDir, { recursive: true, force: true });
    }
  });
});
