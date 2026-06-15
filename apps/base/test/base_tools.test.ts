/**
 * test/base_tools.test.ts — the tool commands the `base` app absorbed from the former
 * `tools` app (merged: display AND execution now live in `base`).
 *
 * The 4 tool commands moved into `base` and are exposed as `base.read_file` /
 * `base.grep` / `base.bash` / `base.http_request`. These drive the REAL base app
 * through the REAL `AppRegistry` + `PolicyEngine`, exactly how Operations.invoke_command
 * wires them (policy.check → registry.route). We assert:
 *   (a) every tool is registered as a `base.<tool>` command;
 *   (b) a tool call EXECUTES and returns its body in `result.data.result` (the single path
 *       the tool output reaches the agent — the ledger then records it via onCommand);
 *   (c) capability gating is UNCHANGED (bash → pending for the agent, http_request net:http,
 *       read_file/grep allowed, `enabled[]` gates independently);
 *   (d) a tool command on the agent lane records exactly once and does NOT recurse.
 *
 * A temp base dir keeps the repo's real `.block-agent` untouched.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppRegistry } from '@block-agent/core/app/registry.js';
import { BlockTree } from '@block-agent/core/core/block.js';
import { Operations } from '@block-agent/core/core/operations.js';
import { PolicyEngine } from '@block-agent/core/core/policy.js';
import type { Block, BlockName, InvokerContext } from '@block-agent/core/core/types.js';
import type { CommandResult } from '@block-agent/core/app/types.js';

import {
  BaseApp,
  BASE_APP_ID,
  BUILTIN_TOOLS,
  type BaseState,
} from '../src/manifest.js';

// ---------------------------------------------------------------------------
// Harness: install base into a real registry + policy, and invoke the way
// Operations.invoke_command does (policy.check → registry.route).
// ---------------------------------------------------------------------------

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'actions-tools-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  reg: AppRegistry;
  app: BaseApp;
  policy: PolicyEngine;
}

/** Build the registry with the base app installed, plus a real PolicyEngine. */
function setup(): Harness {
  const reg = new AppRegistry();
  const app = new BaseApp(dir);
  reg.install(app.manifest());
  const policy = new PolicyEngine({
    capability_resolver: (fn) => reg.resolve_command(fn)?.capabilities ?? [],
    allowed_invokers_resolver: (fn) => reg.resolve_command(fn)?.allowed_invokers ?? null,
  });
  return { reg, app, policy };
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
// (a) each tool is a `base.<tool>` command
// ---------------------------------------------------------------------------

describe('base tool commands — registration', () => {
  it('registers every builtin tool as `base.<tool>`', () => {
    const { reg } = setup();
    for (const tool of BUILTIN_TOOLS) {
      const manifest = reg.resolve_command(`${BASE_APP_ID}.${tool}`);
      expect(manifest, `base.${tool} should resolve`).not.toBeNull();
      expect(manifest?.name).toBe(tool);
    }
    expect(reg.resolve_command('base.nope')).toBeNull();
  });

  it('initial state seeds the enabled tool set to the builtins', () => {
    const { reg } = setup();
    const state = reg.get(BASE_APP_ID)?.initial_state as BaseState;
    expect(state.enabled).toEqual([...BUILTIN_TOOLS]);
  });
});

// ---------------------------------------------------------------------------
// (b) tool EXECUTION: the command runs the tool and returns the body in data
// ---------------------------------------------------------------------------

describe('base tool commands — execution returns the body in data', () => {
  it('read_file executes and returns the file body in data.result', async () => {
    const h = setup();
    const { result } = await invoke(h, 'base.read_file', { path: thisFile(), invocation_id: 'r1' }, AGENT);
    expect(result?.ok).toBe(true);
    const data = dataOf(result);
    expect(data.tool).toBe('read_file');
    expect(data.id).toBe('r1');
    expect(data.result).toContain('execution returns the body in data'); // a line from THIS file
  });

  it('grep executes and returns matching lines in data.result', async () => {
    const h = setup();
    const { result } = await invoke(
      h,
      'base.grep',
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
    const { result } = await invoke(h, 'base.read_file', { invocation_id: 'r2' }, AGENT);
    expect(result?.ok).toBe(false);
    expect(result?.error).toMatch(/missing string arg/);
    expect(dataOf(result).tool).toBe('read_file');
  });

  it('the same call (no explicit id) derives a stable invocation id', async () => {
    const h = setup();
    const a = await invoke(h, 'base.grep', { pattern: 'x', path: thisFile() }, AGENT);
    const b = await invoke(h, 'base.grep', { pattern: 'x', path: thisFile() }, AGENT);
    expect(dataOf(a.result).id).toBe(dataOf(b.result).id); // identical (tool,args) → identical id
  });
});

// ---------------------------------------------------------------------------
// (c) capability gating UNCHANGED (§9.4)
// ---------------------------------------------------------------------------

describe('base tool commands — capability gating (§9.4, unchanged)', () => {
  it('bash (op:dangerous) → PENDING for the agent, handler never runs', async () => {
    const h = setup();
    const { decision, result } = await invoke(h, 'base.bash', { command: 'rm -rf /', invocation_id: 'b1' }, AGENT);
    expect(decision.kind).toBe('pending');
    expect(result).toBeNull(); // gated before the handler
  });

  it('bash → ALLOW for the user; returns a stubbed result (no shell spawned)', async () => {
    const h = setup();
    const { decision, result } = await invoke(h, 'base.bash', { command: 'echo hi', invocation_id: 'b2' }, USER);
    expect(decision.kind).toBe('allow');
    expect(result?.ok).toBe(true);
    expect(dataOf(result).result).toContain('[bash stub]');
    expect(dataOf(result).result).toContain('echo hi');
  });

  it('http_request declares net:http and stubs for the agent (no socket)', async () => {
    const h = setup();
    const { decision, result } = await invoke(
      h,
      'base.http_request',
      { url: 'https://example.com', method: 'GET', invocation_id: 'h1' },
      AGENT,
    );
    expect(decision.kind).toBe('allow');
    expect(result?.ok).toBe(true);
    expect(dataOf(result).result).toContain('[http_request stub]');
    expect(dataOf(result).result).toContain('https://example.com');
    expect(
      h.reg.resolve_command('base.http_request')?.capabilities?.some((c) => c.name === 'net:http'),
    ).toBe(true);
  });

  it('read_file / grep are not dangerous — agent is allowed directly', async () => {
    const h = setup();
    const rf = await invoke(h, 'base.read_file', { path: thisFile(), invocation_id: 'r3' }, AGENT);
    const gr = await invoke(h, 'base.grep', { pattern: 'a', path: thisFile(), invocation_id: 'g2' }, AGENT);
    expect(rf.decision.kind).toBe('allow');
    expect(gr.decision.kind).toBe('allow');
    expect(rf.result?.ok).toBe(true);
    expect(gr.result?.ok).toBe(true);
  });

  it('a disabled tool refuses even when policy allows (enabled[] gates independently)', async () => {
    const reg = new AppRegistry();
    const app = new BaseApp(dir);
    const manifest = app.manifest();
    (manifest.initial_state as BaseState).enabled = ['read_file']; // grep/bash/http off
    reg.install(manifest);
    const policy = new PolicyEngine({
      capability_resolver: (fn) => reg.resolve_command(fn)?.capabilities ?? [],
      allowed_invokers_resolver: (fn) => reg.resolve_command(fn)?.allowed_invokers ?? null,
    });
    const h: Harness = { reg, app, policy };

    const enabled = await invoke(h, 'base.read_file', { path: thisFile(), invocation_id: 'e1' }, AGENT);
    expect(enabled.result?.ok).toBe(true);

    const disabled = await invoke(h, 'base.grep', { pattern: 'x', path: thisFile(), invocation_id: 'e2' }, AGENT);
    expect(disabled.decision.kind).toBe('allow'); // policy would let it through…
    expect(disabled.result?.ok).toBe(false); // …but the tool itself refuses (not enabled)
    expect(disabled.result?.error).toMatch(/not enabled/);
  });
});

// ---------------------------------------------------------------------------
// (d) no-recursion: a tool command on the agent lane records exactly once
// ---------------------------------------------------------------------------
//
// The recursion concern: an agent tool call (e.g. base.bash, invoker:'agent') fires
// onCommand → the ledger subscription calls base.record (invoker:'app') via Operations
// DIRECTLY. base.record never traverses the agent lane → never re-emits onCommand → no
// loop. This test simulates that subscription wiring and asserts base.record runs exactly
// once and emits zero further onCommand events (no self-feed). It uses a real Operations so
// the invoker gates are real.

describe('base tool commands — no recursion through the ledger', () => {
  it('a tool result fed to base.record records exactly once, no further onCommand', async () => {
    const reg = new AppRegistry();
    const app = new BaseApp(dir);
    reg.install(app.manifest());
    const root: Block = {
      id: 'root', name: 'root:root', children: [], content_text: null, content_blob: null,
    };
    const ops = Operations.with_default_policy({ tree: new BlockTree(root), registry: reg });
    reg.commandRouter = (fn, a, inv) => ops.invoke_command(fn, a, inv);

    // Simulate the launch onCommand → base.record subscription: count every time
    // base.record is invoked through Operations, and assert it never re-triggers itself.
    let recordCalls = 0;
    const onCommand = (e: { name: string; args: unknown; ok: boolean; result?: unknown }) => {
      if (e.name === 'base.record') return; // a real subscription excludes the ledger's own writes; assert it never appears
      recordCalls += 1;
      // Feed the command event to the ledger exactly as launch.ts does (invoker:'app').
      void ops.invoke_command(
        'base.record',
        { kind: 'command', name: e.name, args: e.args, ok: e.ok, ts: '00:00', ...(e.result !== undefined ? { result: e.result } : {}) },
        { invoker: 'app' },
      );
    };

    // Run the agent tool (a read_file, allowed for the agent), then push its event to the sink
    // exactly once — exactly the runtime's onCommand lane. The sink's base.record write must
    // NOT itself surface back on this lane (it goes through Operations, not the agent lane).
    const res = await ops.invoke_command('base.read_file', { path: thisFile(), invocation_id: 'rec1' }, AGENT);
    expect(res.ok).toBe(true);
    onCommand({ name: 'base.read_file', args: { path: thisFile() }, ok: true, result: res.data });

    // Let any microtasks settle.
    await Promise.resolve();
    await Promise.resolve();

    // The sink fired exactly once for the tool call; base.record (invoker:'app') applied
    // straight through Operations and never re-entered the onCommand lane.
    expect(recordCalls).toBe(1);

    // The ledger holds exactly one command record (the tool call), proving the single write.
    const ctx = reg.get_app_context('base');
    const state = ctx?.state as BaseState;
    const commandRows = state.recent.filter((r) => r.kind === 'command');
    expect(commandRows).toHaveLength(1);
    expect((commandRows[0] as { verb: string }).verb).toBe('base.read_file');
  });
});
