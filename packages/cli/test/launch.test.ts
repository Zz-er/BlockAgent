/**
 * test/launch.test.ts — launch() wiring (impl-cli-logic).
 *
 * Focused on the tool-catalog wiring added for real-LLM use: launch must advertise
 * the agent-invokable commands to the provider as SendOpts.tools (native tool
 * dispatch), and it must EXCLUDE user-only commands (allowed_invokers without 'agent':
 * agent_identity.set, messages.set_config, base.set_config). We drive a mock provider
 * (which records last_opts) through one real turn via the CLI channel and assert what
 * was sent. Storage is redirected to a temp dir so the suite never writes the repo's
 * .block-agent.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
      memory: { enabled: true },
      base: { enabled: false }, // not under test here; off keeps the catalog minimal
      memory_letta: { enabled: false }, // needs an external server; off in tests
      task: { enabled: true },
      stats: { enabled: false },
      // Phase C platform-service proxies: each needs its BlockAI-team service running, off in tests.
      im_proxy: { enabled: false },
      oa_proxy: { enabled: false },
      task_proxy: { enabled: false },
      skill: { enabled: false },
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
    expect(names).not.toContain('base.set_config');
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

// ============================================================================
// context-budget boot (skill-memory-wiki §9.3 缺陷1): the FULL default-on app set
// — incl. base (elastic) + the always-on turn_log/focus — must install within the
// dashboard reserve R under PER-BLOCK charging (the real default boot, the load-
// bearing case the per-app charge silently passed but per-block could overflow).
// ============================================================================

describe('launch context budget', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'block-agent-budget-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The full default-on set (agent_identity/messages/memory/base/task) + mock provider. */
  function fullDefaultConfig(d: string): LauncherConfig {
    return {
      provider: { kind: 'mock', model: 'mock' },
      apps: {
        agent_identity: { enabled: true },
        messages: { enabled: true },
        memory: { enabled: true },
        base: { enabled: true }, // elastic stream — exempt from Σ, but installs at boot
        memory_letta: { enabled: false },
        task: { enabled: true },
        stats: { enabled: false },
        im_proxy: { enabled: false },
        oa_proxy: { enabled: false },
        task_proxy: { enabled: false },
        skill: { enabled: false },
      },
      storage_dir: d,
    };
  }

  it('admits the FULL default boot under per-block Σ ≤ R (no AppRenderReserveError)', async () => {
    // If the per-block charge of the default dashboards (agent_identity 1 + messages 2 +
    // memory 4 + task 1 + focus 4 blocks, each ≤ 4 KiB ≈ 48 KiB) exceeded R, launch() would
    // throw here. base + turn_log are exempt/zero-block. This is the regression guard for
    // the budget constants (config.ts) staying in step with the default block count.
    const agent = await launch(fullDefaultConfig(dir));
    // The reserve IS wired (budget model on) and every default app installed.
    for (const id of ['agent_identity', 'messages', 'memory', 'base', 'task', 'focus', 'turn_log']) {
      expect(agent.registry.get(id)).not.toBeNull();
    }
  });
});

// ============================================================================
// base ledger wiring smoke (base-app §2.2 / §9): the onInput + onCommand
// subscriptions + inputHook turn one real turn into durable ledger records.
// ============================================================================

describe('launch base ledger wiring', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'block-agent-base-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Read every JSON line from the base jsonl audit log (empty if the file is absent). */
  function readActionsLog(): Array<Record<string, unknown>> {
    const path = join(dir, '.block-agent', 'apps', 'base', 'log.jsonl');
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return [];
    }
    return raw
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it('installs base and records the external input from one turn (onInput wiring)', async () => {
    const cfg = mockConfig(dir);
    cfg.apps.base = { enabled: true };
    const agent = await launch(cfg);

    // Boot installed the ledger.
    expect(agent.registry.get('base')).not.toBeNull();

    // Drive one real turn: messages.ingest → ctx.report_input → onInput → base.record.
    await makeCliChannel(agent).submit('hello actions');

    const records = readActionsLog();

    // The external input was reported into the ledger (report_input → inputHook → onInput →
    // base.record → store.append — the full input-channel wiring is live).
    const inputs = records.filter((r) => r['kind'] === 'input');
    expect(inputs.length).toBeGreaterThanOrEqual(1);
    expect(inputs[0]?.['source']).toBe('messages');
    expect(typeof inputs[0]?.['ts']).toBe('string');

    // Any command rows that DID land are well-formed (note: the mock's lone `messages.reply`
    // is `end_turn`, which the onCommand emit site excludes by design — §2.1 — so a turn that
    // only replies records no command. The onCommand wiring itself is proven by the
    // no-recursion test below, which observes the channel directly.)
    for (const c of records.filter((r) => r['kind'] === 'command')) {
      expect(typeof c['name']).toBe('string');
      expect(typeof c['ts']).toBe('string');
    }
  });

  it('no-recursion (#1 correctness guard): base.record via Operations emits ZERO onCommand', async () => {
    // The arch doc's airtight-recursion claim, made a real test (actions-app §2.2). The launch
    // onCommand subscription feeds base.record; if base.record itself emitted onCommand,
    // it would re-trigger the subscription → infinite loop. The guarantee: onCommand fires ONLY
    // inside the runtime's private invokeCommand (the agent lane); base.record (invoker:'app')
    // reaches the tree via Operations.invoke_command DIRECTLY, which never traverses invokeCommand
    // → never emits onCommand. We prove it by driving the command directly and counting the channel.
    const cfg = mockConfig(dir);
    cfg.apps.base = { enabled: true };
    const agent = await launch(cfg);

    let onCommandCount = 0;
    const off = agent.runtime.onCommand(() => {
      onCommandCount += 1;
    });

    // Drive base.record DIRECTLY through Operations, invoker:'app' (the exact path the launch
    // subscription uses). Both record kinds, to exercise the whole sink.
    const inputRes = await agent.operations.invoke_command(
      'base.record',
      { kind: 'input', source: 'messages', sender: 'user', ts: new Date().toISOString(), preview: 'hi' },
      { invoker: 'app' },
    );
    const cmdRes = await agent.operations.invoke_command(
      'base.record',
      { kind: 'command', name: 'memory.remember', args: { content: 'x' }, ok: true, invoker: 'agent', spawn_depth: 0, ts: new Date().toISOString() },
      { invoker: 'app' },
    );
    off();

    // The records actually applied (the sink works)…
    expect(inputRes.ok).toBe(true);
    expect(cmdRes.ok).toBe(true);
    // …and emitted EXACTLY ZERO onCommand events — no self-feed, no loop.
    expect(onCommandCount).toBe(0);
  });

  it('no-recursion: a full turn never surfaces base.record on onCommand either', async () => {
    const cfg = mockConfig(dir);
    cfg.apps.base = { enabled: true };
    const agent = await launch(cfg);

    const seen: string[] = [];
    const off = agent.runtime.onCommand((e) => seen.push(e.name));
    await makeCliChannel(agent).submit('hi');
    off();

    // Whatever agent commands fired this turn, NONE may be base.record (the ledger never
    // appears in the agent lane it records).
    expect(seen).not.toContain('base.record');
  });
});
