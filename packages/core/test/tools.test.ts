/**
 * test/tools.test.ts — the `tools` meta-app (impl-tools). Spec: v3.1 §6.7 +
 * ARCHITECTURE.md "impl-tools → recent-N projection".
 *
 * These drive the REAL standard app `src/apps/tools.ts` through the REAL
 * `AppRegistry` + `PolicyEngine` (a temp storage dir so we never touch the repo's
 * `.block-agent`). We assert:
 *   (a) every tool is registered as a `tools.<tool>` command + a user-only set_config;
 *   (b) a tool call appends to the durable store AND updates the bounded recent
 *       window projected into the SINGLE volatile block `tools:recent` (replacing
 *       per-id `tools:tool_result.<id>` blocks);
 *   (c) the window keeps the most-recent `tool_history_count` calls, dropping the
 *       oldest deterministically (durable store keeps the FULL history);
 *   (d) `tool_history_count` is set by a user-only command (agent DENIED) + a file seed;
 *   (e) capability gating is UNCHANGED (bash → pending for the agent, http_request
 *       net:http, read_file/grep allowed, `enabled[]` gates independently);
 *   (f) the projection build is deterministic / byte-identical (INV #1 / #16).
 *
 * The live App state (which a tool call mutates via `ctx.set_state`) lives inside
 * the registry's AppContext; we capture that live handle via an `on_install` hook
 * we attach in the test, then render `tools:recent` through its owner builder with
 * the live state — exactly the (state-driven, volatile) projection the Renderer
 * runs once impl-render wires the registry's AppContexts into it.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AppRegistry } from '../src/app/registry.js';
import { PolicyEngine } from '../src/core/policy.js';
import type {
  BlockName,
  BlockSnapshot,
  InvokerContext,
} from '../src/core/types.js';
import type { AppContext, BuildContext, CommandResult } from '../src/app/types.js';
import {
  BUILTIN_TOOLS,
  RECENT_BLOCK,
  TOOLS_APP_ID,
  ToolsApp,
  type ToolsState,
} from '../src/apps/tools.js';

// ---------------------------------------------------------------------------
// Harness: install tools (temp storage) into a real registry + policy, and
// capture the live AppContext so we can render tools:recent from live state.
// ---------------------------------------------------------------------------

/** A fresh temp base dir for one test's `.block-agent/apps/tools/` storage. */
function freshBaseDir(): string {
  return mkdtempSync(join(tmpdir(), 'tools-test-'));
}

interface Harness {
  reg: AppRegistry;
  app: ToolsApp;
  policy: PolicyEngine;
  install: { installed_id: string; warnings: string[] };
  /** The registry's LIVE AppContext for the tools App (captured at install). */
  ctx: AppContext<ToolsState>;
}

/**
 * Build the registry with the tools app installed (temp storage), a PolicyEngine
 * whose resolvers read the app's `capabilities` AND `allowed_invokers` (exactly how
 * core/operations.ts wires them), and the live AppContext captured via `on_install`.
 */
function setup(baseDir: string = freshBaseDir()): Harness {
  const reg = new AppRegistry();
  const app = new ToolsApp(baseDir);
  const manifest = app.manifest();
  let captured: AppContext<ToolsState> | null = null;
  // Attach a capture hook to the plain manifest object: instantiate() builds ONE
  // AppContext per instance and uses it for both on_install and route, so this is
  // the SAME live handle a tool command mutates via set_state.
  manifest.on_install = async (ctx) => {
    captured = ctx as AppContext<ToolsState>;
  };
  const install = reg.install(manifest);
  const policy = new PolicyEngine({
    capability_resolver: (fn) => reg.resolve_command(fn)?.capabilities ?? [],
    allowed_invokers_resolver: (fn) => reg.resolve_command(fn)?.allowed_invokers ?? null,
  });
  if (captured === null) throw new Error('on_install did not fire — cannot capture AppContext');
  return { reg, app, policy, install, ctx: captured };
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

/**
 * Render the `tools:recent` block via its owner builder + the live AppContext —
 * the same call core/renderer.ts makes (build(ctx, app_ctx)). Returns the block's
 * text, or '' when the builder renders nothing (empty window).
 */
async function renderRecent(h: Harness): Promise<string> {
  const builder = h.reg.resolve_builder(RECENT_BLOCK);
  if (!builder) throw new Error('no owner builder for tools:recent');
  const block = await builder.build(stubBuildContext(), h.ctx);
  return block?.content_text ?? '';
}

/** A deterministic throwaway BuildContext; RecentToolsBuilder reads app_ctx only. */
function stubBuildContext(): BuildContext {
  const snapshot = {
    root: { id: 'r', name: 'root:root' as BlockName, children: [], content_text: null, content_blob: null },
    hash: 'stub',
    get: () => null,
  } as unknown as BlockSnapshot;
  return {
    snapshot,
    read: () => null,
    deterministic_clock: () => 0,
    deterministic_random: () => 0,
    content_addressed_id: (c) => c,
    config: {},
  };
}

const AGENT: InvokerContext = { invoker: 'agent', identity: 'main' };
const USER: InvokerContext = { invoker: 'user', identity: 'kendrick' };

/** This test file's own absolute path (a real file read_file/grep can target). */
function thisFile(): string {
  return new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

/**
 * Write a tiny fixture file with NEUTRAL content and return its path. The
 * window/drop-order tests assert on which `[rN]` headers survive projection;
 * reading `thisFile()` would taint that because the source contains literal
 * `[r1]` strings, so those tests read this controlled file instead.
 */
function tinyFile(baseDir: string): string {
  const path = join(baseDir, 'fixture.txt');
  writeFileSync(path, 'fixture body line one\nfixture body line two\n', 'utf8');
  return path;
}

/** Write a tools config.json under the given base dir before install. */
function seedConfig(baseDir: string, config: Record<string, unknown>): void {
  mkdirSync(join(baseDir, TOOLS_APP_ID), { recursive: true });
  writeFileSync(join(baseDir, TOOLS_APP_ID, 'config.json'), JSON.stringify(config), 'utf8');
}

// ---------------------------------------------------------------------------
// (a) meta-app shape: each tool is a `tools.<tool>` command, plus set_config
// ---------------------------------------------------------------------------

describe('tools meta-app — command registration', () => {
  it('installs under id "tools" with the /tools namespace', () => {
    const { install, reg } = setup();
    expect(install.installed_id).toBe(TOOLS_APP_ID);
    expect(reg.get(TOOLS_APP_ID)?.tree_namespace).toBe('/tools');
  });

  it('registers every builtin tool as `tools.<tool>`, plus user-only set_config', () => {
    const { reg } = setup();
    for (const tool of BUILTIN_TOOLS) {
      const manifest = reg.resolve_command(`${TOOLS_APP_ID}.${tool}`);
      expect(manifest, `tools.${tool} should resolve`).not.toBeNull();
      expect(manifest?.name).toBe(tool);
    }
    const setConfig = reg.resolve_command('tools.set_config');
    expect(setConfig).not.toBeNull();
    expect(setConfig?.allowed_invokers).toEqual(['user']);
    expect(reg.resolve_command('tools.nope')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (b) recent-N projection: ONE volatile block tools:recent (no per-id blocks)
// ---------------------------------------------------------------------------

describe('tools meta-app — tools:recent projection', () => {
  it('the projection is ONE block tools:recent owned by a VOLATILE builder (§10.2)', () => {
    const { reg } = setup();
    expect(reg.tier_of(RECENT_BLOCK)).toBe('volatile');
    const builder = reg.resolve_builder(RECENT_BLOCK);
    expect(builder?.owner).toBe('tool'); // never 'agent' (INV #4)
    expect(builder?.cache_tier).toBe('volatile');
    // No dynamic per-id result blocks anymore (the prefix-scan gap is dissolved).
    expect(reg.resolve_builder('tools:tool_result.anything' as BlockName)).toBeNull();
  });

  it('a tool call appends to the durable store AND projects into tools:recent', async () => {
    const h = setup();
    const { result } = await invoke(h, 'tools.read_file', { path: thisFile(), invocation_id: 'r1' }, AGENT);
    expect(result?.ok).toBe(true);
    const data = result?.data as { tool?: string; id?: string; result?: string };
    expect(data.tool).toBe('read_file');
    expect(data.id).toBe('r1');
    expect(data.result).toContain('recent-N projection'); // a line from THIS file

    // Durable store has the full record.
    const all = h.app.store.readAll();
    expect(all.length).toBe(1);
    expect(all[0]?.id).toBe('r1');
    expect(all[0]?.ok).toBe(true);

    // The projection block carries it.
    const rendered = await renderRecent(h);
    expect(rendered).toContain('[r1] read_file');
  });

  it('grep records matching lines into the window', async () => {
    const h = setup();
    await invoke(h, 'tools.grep', { pattern: 'volatile', path: thisFile(), invocation_id: 'g1' }, AGENT);
    const rec = h.app.store.readAll().find((r) => r.id === 'g1');
    expect(rec?.tool).toBe('grep');
    expect((rec?.result.length ?? 0)).toBeGreaterThan(0);
    expect(await renderRecent(h)).toContain('[g1] grep');
  });
});

// ---------------------------------------------------------------------------
// (c) bounded window: keep most-recent N, drop oldest deterministically
// ---------------------------------------------------------------------------

describe('tools meta-app — bounded recent window', () => {
  it('keeps only the most-recent tool_history_count calls (drop oldest); store keeps all', async () => {
    const baseDir = freshBaseDir();
    seedConfig(baseDir, { tool_history_count: 2 });
    const h = setup(baseDir);
    const file = tinyFile(baseDir); // neutral body so headers are the only [rN]

    for (const n of [1, 2, 3]) {
      await invoke(h, 'tools.read_file', { path: file, invocation_id: `r${n}` }, AGENT);
    }
    // Durable store keeps ALL three (the full history is the store).
    expect(h.app.store.readAll().map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);

    // The projected window keeps only the most-recent 2 (r2, r3); r1 dropped. We
    // match the record HEADER `[rN] read_file` so a neutral file body can't alias it.
    const rendered = await renderRecent(h);
    expect(rendered).toContain('[r2] read_file');
    expect(rendered).toContain('[r3] read_file');
    expect(rendered).not.toContain('[r1] read_file');
  });

  it('a window of 0 renders nothing (but the store still records)', async () => {
    const baseDir = freshBaseDir();
    seedConfig(baseDir, { tool_history_count: 0 });
    const h = setup(baseDir);
    await invoke(h, 'tools.read_file', { path: thisFile(), invocation_id: 'z1' }, AGENT);
    expect(h.app.store.readAll().length).toBe(1);
    expect(await renderRecent(h)).toBe(''); // empty window → builder renders nothing
  });
});

// ---------------------------------------------------------------------------
// (d) config: user-only set_config command + file seed
// ---------------------------------------------------------------------------

describe('tools meta-app — tool_history_count config', () => {
  it('defaults to 5 when no config file is present', () => {
    const { reg } = setup();
    expect((reg.get(TOOLS_APP_ID)?.initial_state as ToolsState).tool_history_count).toBe(5);
  });

  it('is seeded from .block-agent/apps/tools/config.json', () => {
    const baseDir = freshBaseDir();
    seedConfig(baseDir, { tool_history_count: 3 });
    const { reg } = setup(baseDir);
    expect((reg.get(TOOLS_APP_ID)?.initial_state as ToolsState).tool_history_count).toBe(3);
  });

  it('set_config is DENIED for the agent (user-only invoker gate, anti-self-mod)', async () => {
    const h = setup();
    const { decision, result } = await invoke(h, 'tools.set_config', { tool_history_count: 1 }, AGENT);
    expect(decision.kind).toBe('deny');
    expect(result).toBeNull(); // gated at the chokepoint, handler never runs
    if (decision.kind === 'deny') expect(decision.reason).toMatch(/not permitted/);
  });

  it('set_config ALLOWS the user and retunes + trims the window immediately', async () => {
    const baseDir = freshBaseDir();
    const h = setup(baseDir);
    const file = tinyFile(baseDir); // neutral body so headers are the only [rN]
    for (const n of [1, 2, 3]) {
      await invoke(h, 'tools.read_file', { path: file, invocation_id: `r${n}` }, AGENT);
    }
    const { decision, result } = await invoke(h, 'tools.set_config', { tool_history_count: 1 }, USER);
    expect(decision.kind).toBe('allow');
    expect(result?.ok).toBe(true);
    expect((result?.data as { tool_history_count?: number }).tool_history_count).toBe(1);

    // The window shrank to 1 → only the most-recent call (r3) is projected.
    const rendered = await renderRecent(h);
    expect(rendered).toContain('[r3] read_file');
    expect(rendered).not.toContain('[r1] read_file');
    expect(rendered).not.toContain('[r2] read_file');
  });
});

// ---------------------------------------------------------------------------
// (e) capability gating UNCHANGED (the per-id design's security is preserved)
// ---------------------------------------------------------------------------

describe('tools meta-app — capability gating (§9.4, unchanged)', () => {
  it('bash (op:dangerous) → PENDING for the agent, handler never runs', async () => {
    const h = setup();
    const { decision, result } = await invoke(h, 'tools.bash', { command: 'rm -rf /', invocation_id: 'b1' }, AGENT);
    expect(decision.kind).toBe('pending');
    expect(result).toBeNull();
    // Gated before the handler → nothing recorded in the durable store.
    expect(h.app.store.readAll().length).toBe(0);
  });

  it('bash → ALLOW for the user; records a stubbed result (no shell spawned)', async () => {
    const h = setup();
    const { decision, result } = await invoke(h, 'tools.bash', { command: 'echo hi', invocation_id: 'b2' }, USER);
    expect(decision.kind).toBe('allow');
    expect(result?.ok).toBe(true);
    const rec = h.app.store.readAll().find((r) => r.id === 'b2');
    expect(rec?.result).toContain('[bash stub]');
    expect(rec?.result).toContain('echo hi');
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
    const rec = h.app.store.readAll().find((r) => r.id === 'h1');
    expect(rec?.result).toContain('[http_request stub]');
    expect(rec?.result).toContain('https://example.com');
    expect(
      h.reg.resolve_command('tools.http_request')?.capabilities?.some((c) => c.name === 'net:http'),
    ).toBe(true);
  });

  it('read_file / grep are not dangerous — agent is allowed directly', async () => {
    const h = setup();
    const rf = await invoke(h, 'tools.read_file', { path: thisFile(), invocation_id: 'r2' }, AGENT);
    const gr = await invoke(h, 'tools.grep', { pattern: 'a', path: thisFile(), invocation_id: 'g2' }, AGENT);
    expect(rf.decision.kind).toBe('allow');
    expect(gr.decision.kind).toBe('allow');
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
    const h: Harness = { reg, app, policy, install: { installed_id: TOOLS_APP_ID, warnings: [] }, ctx: undefined as never };

    const enabled = await invoke(h, 'tools.read_file', { path: thisFile(), invocation_id: 'e1' }, AGENT);
    expect(enabled.result?.ok).toBe(true);

    const disabled = await invoke(h, 'tools.grep', { pattern: 'x', path: thisFile(), invocation_id: 'e2' }, AGENT);
    expect(disabled.decision.kind).toBe('allow'); // policy would let it through…
    expect(disabled.result?.ok).toBe(false); // …but the tool itself refuses (not enabled)
    expect(disabled.result?.error).toMatch(/not enabled/);
  });
});

// ---------------------------------------------------------------------------
// (f) deterministic build + byte-identical projection
// ---------------------------------------------------------------------------

describe('tools meta-app — deterministic projection', () => {
  it('rendering the same recent window twice is byte-identical (INV #1)', async () => {
    const h = setup();
    await invoke(h, 'tools.read_file', { path: thisFile(), invocation_id: 'r1' }, AGENT);
    const a = await renderRecent(h);
    const b = await renderRecent(h);
    expect(a).toBe(b);
    expect(a).toContain('[r1]');
  });

  it('the same call (no explicit id) derives a stable invocation id', async () => {
    const h = setup();
    await invoke(h, 'tools.grep', { pattern: 'x', path: thisFile() }, AGENT);
    await invoke(h, 'tools.grep', { pattern: 'x', path: thisFile() }, AGENT);
    const ids = h.app.store.readAll().map((r) => r.id);
    expect(ids[0]).toBe(ids[1]); // identical (tool, args) → identical derived id
  });
});
