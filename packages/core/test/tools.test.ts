/**
 * test/tools.test.ts — the `tools` meta-app (impl-tools). Spec: v3.1 §6.7 +
 * ai_com/design/actions-app-architecture.md §3.2/§4.
 *
 * These drive the REAL standard app `apps/tools` through the REAL `AppRegistry` +
 * `PolicyEngine`. tools is now DISPLAY-FREE: its recent-N projection moved to the
 * `actions` app (one tool call must not appear in BOTH `tools:recent` and
 * `actions:recent`). tools keeps only EXECUTION — each command runs its tool and
 * returns the result body in `CommandResult.data` (`{ tool, id, result }`), which is
 * the single path the tool output reaches the agent (`actions` captures it via
 * `onCommand`). We assert:
 *   (a) every tool is registered as a `tools.<tool>` command (no set_config anymore);
 *   (b) tools renders NO block (no `tools:recent` builder / owner);
 *   (c) a tool call EXECUTES and returns its body in `result.data.result`;
 *   (d) capability gating is UNCHANGED (bash → pending for the agent, http_request
 *       net:http, read_file/grep allowed, `enabled[]` gates independently).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AppRegistry } from '../src/app/registry.js';
import { PolicyEngine } from '../src/core/policy.js';
import type { BlockName, InvokerContext } from '../src/core/types.js';
import type { CommandResult } from '../src/app/types.js';
import {
  BUILTIN_TOOLS,
  TOOLS_APP_ID,
  ToolsApp,
  type ToolsState,
} from '@block-agent/app-tools/manifest.js';

// ---------------------------------------------------------------------------
// Harness: install tools into a real registry + policy, and invoke the way
// Operations.invoke_command does (policy.check → registry.route).
// ---------------------------------------------------------------------------

/** A fresh temp base dir (kept for ToolsApp's signature; tools no longer uses disk). */
function freshBaseDir(): string {
  return mkdtempSync(join(tmpdir(), 'tools-test-'));
}

interface Harness {
  reg: AppRegistry;
  app: ToolsApp;
  policy: PolicyEngine;
  install: { installed_id: string; warnings: string[] };
}

/**
 * Build the registry with the tools app installed, plus a PolicyEngine whose
 * resolvers read the app's `capabilities` AND `allowed_invokers` (exactly how
 * core/operations.ts wires them).
 */
function setup(baseDir: string = freshBaseDir()): Harness {
  const reg = new AppRegistry();
  const app = new ToolsApp(baseDir);
  const manifest = app.manifest();
  const install = reg.install(manifest);
  const policy = new PolicyEngine({
    capability_resolver: (fn) => reg.resolve_command(fn)?.capabilities ?? [],
    allowed_invokers_resolver: (fn) => reg.resolve_command(fn)?.allowed_invokers ?? null,
  });
  return { reg, app, policy, install };
}

/** Mirror Operations.invoke_command: policy.check → (if allowed) registry.route. */
async function invoke(
  h: Harness,
  full_name: string,
  args: unknown,
  invoker: InvokerContext,
): Promise<{ decision: ReturnType<PolicyEngine['check']>; result: CommandResult | null }> {
  const decision = h.policy.check({ full_name, args }, invoker);
  if (decision.kind !== 'allow') return { decision, result: null };
  const result = await h.reg.route(full_name, args, invoker);
  return { decision, result };
}

const AGENT: InvokerContext = { invoker: 'agent', identity: 'main' };
const USER: InvokerContext = { invoker: 'user', identity: 'kendrick' };

/** This test file's own absolute path (a real file read_file/grep can target). */
function thisFile(): string {
  return new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

/** Narrow a CommandResult's `data` to the tool-result shape the agent reads back. */
function dataOf(result: CommandResult | null): { tool?: string; id?: string; result?: string } {
  return (result?.data ?? {}) as { tool?: string; id?: string; result?: string };
}

// ---------------------------------------------------------------------------
// (a) meta-app shape: each tool is a `tools.<tool>` command (no set_config)
// ---------------------------------------------------------------------------

describe('tools meta-app — command registration', () => {
  it('installs under id "tools" with the /tools namespace', () => {
    const { install, reg } = setup();
    expect(install.installed_id).toBe(TOOLS_APP_ID);
    expect(reg.get(TOOLS_APP_ID)?.tree_namespace).toBe('/tools');
  });

  it('registers every builtin tool as `tools.<tool>`; no set_config command', () => {
    const { reg } = setup();
    for (const tool of BUILTIN_TOOLS) {
      const manifest = reg.resolve_command(`${TOOLS_APP_ID}.${tool}`);
      expect(manifest, `tools.${tool} should resolve`).not.toBeNull();
      expect(manifest?.name).toBe(tool);
    }
    // The display + its user-only retune moved to `actions` — tools tunes nothing.
    expect(reg.resolve_command('tools.set_config')).toBeNull();
    expect(reg.resolve_command('tools.nope')).toBeNull();
  });

  it('initial state holds only the enabled tool set (no display window/config)', () => {
    const { reg } = setup();
    const state = reg.get(TOOLS_APP_ID)?.initial_state as ToolsState;
    expect(state.enabled).toEqual([...BUILTIN_TOOLS]);
    expect(Object.keys(state)).toEqual(['enabled']);
  });
});

// ---------------------------------------------------------------------------
// (b) tools renders NO block (the recent-N display moved to `actions`)
// ---------------------------------------------------------------------------

describe('tools meta-app — no display block', () => {
  it('owns no builder / no tools:recent block (display is the actions app now)', () => {
    const { reg } = setup();
    expect(reg.resolve_builder('tools:recent' as BlockName)).toBeNull();
    // No dynamic per-id result blocks either.
    expect(reg.resolve_builder('tools:tool_result.anything' as BlockName)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (c) tool EXECUTION: the command runs the tool and returns the body in data
// ---------------------------------------------------------------------------

describe('tools meta-app — tool execution returns its body in data', () => {
  it('read_file executes and returns the file body in data.result', async () => {
    const h = setup();
    const { result } = await invoke(h, 'tools.read_file', { path: thisFile(), invocation_id: 'r1' }, AGENT);
    expect(result?.ok).toBe(true);
    const data = dataOf(result);
    expect(data.tool).toBe('read_file');
    expect(data.id).toBe('r1');
    expect(data.result).toContain('tool EXECUTION'); // a line from THIS file
  });

  it('grep executes and returns matching lines in data.result', async () => {
    const h = setup();
    const { result } = await invoke(
      h,
      'tools.grep',
      { pattern: 'PolicyEngine', path: thisFile(), invocation_id: 'g1' },
      AGENT,
    );
    expect(result?.ok).toBe(true);
    const data = dataOf(result);
    expect(data.tool).toBe('grep');
    expect((data.result?.length ?? 0)).toBeGreaterThan(0);
    expect(data.result).toContain('PolicyEngine');
  });

  it('a missing required arg fails the command (still returns data.tool)', async () => {
    const h = setup();
    const { result } = await invoke(h, 'tools.read_file', { invocation_id: 'r2' }, AGENT);
    expect(result?.ok).toBe(false);
    expect(result?.error).toMatch(/missing string arg/);
    expect(dataOf(result).tool).toBe('read_file');
  });

  it('the same call (no explicit id) derives a stable invocation id', async () => {
    const h = setup();
    const a = await invoke(h, 'tools.grep', { pattern: 'x', path: thisFile() }, AGENT);
    const b = await invoke(h, 'tools.grep', { pattern: 'x', path: thisFile() }, AGENT);
    expect(dataOf(a.result).id).toBe(dataOf(b.result).id); // identical (tool,args) → identical id
  });
});

// ---------------------------------------------------------------------------
// (d) capability gating UNCHANGED (the per-id design's security is preserved)
// ---------------------------------------------------------------------------

describe('tools meta-app — capability gating (§9.4, unchanged)', () => {
  it('bash (op:dangerous) → PENDING for the agent, handler never runs', async () => {
    const h = setup();
    const { decision, result } = await invoke(h, 'tools.bash', { command: 'rm -rf /', invocation_id: 'b1' }, AGENT);
    expect(decision.kind).toBe('pending');
    expect(result).toBeNull(); // gated before the handler
  });

  it('bash → ALLOW for the user; returns a stubbed result (no shell spawned)', async () => {
    const h = setup();
    const { decision, result } = await invoke(h, 'tools.bash', { command: 'echo hi', invocation_id: 'b2' }, USER);
    expect(decision.kind).toBe('allow');
    expect(result?.ok).toBe(true);
    expect(dataOf(result).result).toContain('[bash stub]');
    expect(dataOf(result).result).toContain('echo hi');
  });

  it('http_request declares net:http and stubs for the agent (no socket)', async () => {
    const h = setup();
    const { decision, result } = await invoke(
      h,
      'tools.http_request',
      { url: 'https://example.com', method: 'GET', invocation_id: 'h1' },
      AGENT,
    );
    expect(decision.kind).toBe('allow');
    expect(result?.ok).toBe(true);
    expect(dataOf(result).result).toContain('[http_request stub]');
    expect(dataOf(result).result).toContain('https://example.com');
    expect(
      h.reg.resolve_command('tools.http_request')?.capabilities?.some((c) => c.name === 'net:http'),
    ).toBe(true);
  });

  it('read_file / grep are not dangerous — agent is allowed directly', async () => {
    const h = setup();
    const rf = await invoke(h, 'tools.read_file', { path: thisFile(), invocation_id: 'r3' }, AGENT);
    const gr = await invoke(h, 'tools.grep', { pattern: 'a', path: thisFile(), invocation_id: 'g2' }, AGENT);
    expect(rf.decision.kind).toBe('allow');
    expect(gr.decision.kind).toBe('allow');
    expect(rf.result?.ok).toBe(true);
    expect(gr.result?.ok).toBe(true);
  });

  it('a disabled tool refuses even when policy allows (enabled[] gates independently)', async () => {
    // Install with grep disabled by mutating initial_state on the manifest.
    const reg = new AppRegistry();
    const app = new ToolsApp(freshBaseDir());
    const manifest = app.manifest();
    (manifest.initial_state as ToolsState).enabled = ['read_file']; // grep/bash/http off
    reg.install(manifest);
    const policy = new PolicyEngine({
      capability_resolver: (fn) => reg.resolve_command(fn)?.capabilities ?? [],
      allowed_invokers_resolver: (fn) => reg.resolve_command(fn)?.allowed_invokers ?? null,
    });
    const h: Harness = { reg, app, policy, install: { installed_id: TOOLS_APP_ID, warnings: [] } };

    const enabled = await invoke(h, 'tools.read_file', { path: thisFile(), invocation_id: 'e1' }, AGENT);
    expect(enabled.result?.ok).toBe(true);

    const disabled = await invoke(h, 'tools.grep', { pattern: 'x', path: thisFile(), invocation_id: 'e2' }, AGENT);
    expect(disabled.decision.kind).toBe('allow'); // policy would let it through…
    expect(disabled.result?.ok).toBe(false); // …but the tool itself refuses (not enabled)
    expect(disabled.result?.error).toMatch(/not enabled/);
  });
});
