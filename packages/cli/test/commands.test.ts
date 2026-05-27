/**
 * test/commands.test.ts — slash registry + dispatch (impl-cli-logic).
 *
 * Covers design §5: the registry exposes the expected commands; /cmd parses JSON args
 * and routes through invoke_command (invoker=user) with helpful local errors for an
 * unknown command or bad JSON; /context|/apps|/status produce the right CtxView kinds;
 * an unknown /slash reports a message rather than throwing.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { launch } from '../src/launch.js';
import { SLASH_COMMANDS, dispatch } from '../src/commands.js';
import type { CtxView, LauncherConfig, LaunchedAgent } from '../src/types.js';

function mockConfig(storage_dir: string): LauncherConfig {
  return {
    provider: { kind: 'mock', model: 'mock' },
    apps: {
      agent_identity: { enabled: true },
      messages: { enabled: true },
      tools: { enabled: true },
      memory: { enabled: false },
      memory_letta: { enabled: false },
    },
    storage_dir,
  };
}

/** Capture the last CtxView a command pushed. */
function capture(): { setView: (v: CtxView) => void; last: () => CtxView | null } {
  let v: CtxView | null = null;
  return { setView: (next) => (v = next), last: () => v };
}

describe('SLASH_COMMANDS registry', () => {
  it('registers the v3.0 command set including /app', () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['cmd', 'context', 'dump', 'apps', 'app', 'status', 'help', 'quit', 'exit']),
    );
  });
});

describe('dispatch', () => {
  let dir: string;
  let agent: LaunchedAgent;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'block-agent-cmd-'));
    agent = await launch(mockConfig(dir));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('/cmd parses JSON args and routes through invoke_command as the user', async () => {
    const cap = capture();
    // agent_identity.set is user-only; invoker=user must be ALLOWED through the chokepoint.
    await dispatch(agent, '/cmd agent_identity.set {"role":"tester"}', cap.setView);
    const view = cap.last();
    expect(view?.kind).toBe('command_result');
    expect((view as Extract<CtxView, { kind: 'command_result' }>).ok).toBe(true);
  });

  it('/cmd reports an unknown command without issuing a call', async () => {
    const cap = capture();
    await dispatch(agent, '/cmd no.such_command {}', cap.setView);
    const view = cap.last() as Extract<CtxView, { kind: 'command_result' }>;
    expect(view.ok).toBe(false);
    expect(view.text).toContain('unknown command');
  });

  it('/cmd reports bad JSON args locally', async () => {
    const cap = capture();
    await dispatch(agent, '/cmd messages.peek {not json}', cap.setView);
    const view = cap.last() as Extract<CtxView, { kind: 'command_result' }>;
    expect(view.ok).toBe(false);
    expect(view.text).toContain('bad JSON');
  });

  it('/context pushes a context view with segments + a snapshot hash', async () => {
    const cap = capture();
    await dispatch(agent, '/context', cap.setView);
    const view = cap.last();
    expect(view?.kind).toBe('context');
    const ctx = view as Extract<CtxView, { kind: 'context' }>;
    expect(typeof ctx.snapshot_hash).toBe('string');
    expect(Array.isArray(ctx.segments)).toBe(true);
  });

  it('/apps lists installed apps with commands flagged user_only, plus available catalog entries', async () => {
    const cap = capture();
    await dispatch(agent, '/apps', cap.setView);
    const view = cap.last() as Extract<CtxView, { kind: 'apps' }>;
    expect(view.kind).toBe('apps');
    // installed segment
    const identity = view.installed.find((a) => a.id === 'agent_identity');
    expect(identity).toBeDefined();
    const setCmd = identity!.commands.find((c) => c.full_name === 'agent_identity.set');
    expect(setCmd?.user_only).toBe(true); // allowed_invokers: ['user'] excludes 'agent'
    // available segment: memory + memory_letta not installed in mockConfig
    const availableIds = view.available.map((a) => a.id);
    expect(availableIds).toEqual(expect.arrayContaining(['memory', 'memory_letta']));
  });

  it('/status reports runtime state, provider id, and app count', async () => {
    const cap = capture();
    await dispatch(agent, '/status', cap.setView);
    const view = cap.last() as Extract<CtxView, { kind: 'status' }>;
    expect(view.kind).toBe('status');
    expect(view.provider_id).toBe('mock');
    expect(view.app_count).toBe(3);
  });

  it('an unknown /slash reports a message, never throws', async () => {
    const cap = capture();
    await expect(dispatch(agent, '/nope', cap.setView)).resolves.toBeUndefined();
    const view = cap.last() as Extract<CtxView, { kind: 'command_result' }>;
    expect(view.ok).toBe(false);
    expect(view.text).toContain('unknown command');
  });
});
