/**
 * test/agent_identity.test.ts — the `agent_identity` standard App (impl-identity).
 *
 * Covers the §6.1 contract:
 *   - initial_state (role/persona/instructions) renders into the STABLE segment,
 *   - the App owns exactly the block `agent_identity:identity`,
 *   - build is deterministic (same state → byte-identical block + identical render),
 *   - the agent cannot mutate its identity (the App declares NO commands).
 *
 * Two layers: white-box (call the builder directly with a stub AppContext, the
 * same way core/renderer.ts calls it) and end-to-end (install into the REAL
 * AppRegistry, render the REAL Renderer with the App context wired, assert the
 * identity lands first in the stable tier).
 */

import { describe, expect, it } from 'vitest';

import { Renderer } from '../src/core/renderer.js';
import { BlockTree } from '../src/core/block.js';
import { Operations } from '../src/core/operations.js';
import { AppRegistry } from '../src/app/registry.js';
import {
  makeAgentIdentityApp,
  BLOCK_IDENTITY,
  type IdentityState,
} from '@block-agent/app-agent_identity/manifest.js';
import type { Block, BlockName, BlockSnapshot, InvokerContext } from '../src/core/types.js';
import type { AppContext, BuildContext } from '../src/app/types.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const SAMPLE: IdentityState = {
  role: 'a senior TypeScript reviewer',
  persona: 'terse, exacting, allergic to flattery',
  instructions: 'Prefer the smallest correct change. Cite file:line.',
};

/** A minimal AppContext carrying just the identity state — all the builder reads. */
function stubAppContext(state: IdentityState): AppContext<IdentityState> {
  return {
    app_id: 'agent_identity',
    state,
    set_state() {
      throw new Error('not used in this test');
    },
    list_commands: () => [],
    list_builders: () => [],
    list_blocks: () => [],
    invoke_command: async () => ({ ok: false, error: 'not used' }),
    read: async () => [],
    on() {},
    emit() {},
    spawn_system_agent: () => ({ id: 'stub', stop() {} }),
  };
}

/** A throwaway BuildContext; IdentityBlockBuilder ignores it (state-only build). */
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

/** The single builder the App registers (read it back off the manifest). */
function identityBuilder() {
  const app = makeAgentIdentityApp(SAMPLE);
  const builder = app.builders[0]!(app.initial_state);
  return builder;
}

/** A placeholder identity block to seed the tree so the Renderer runs the builder. */
function identityPlaceholder(): Block {
  return { id: BLOCK_IDENTITY, name: BLOCK_IDENTITY, children: [], content_text: '', content_blob: null };
}

// ===========================================================================
// Manifest shape (§6.1)
// ===========================================================================

describe('agent_identity manifest', () => {
  it('declares exactly one command: a user-only `set` (agent cannot mutate identity)', () => {
    const app = makeAgentIdentityApp(SAMPLE);
    expect(app.commands).toHaveLength(1);
    const cmd = app.commands[0]!(app.initial_state);
    expect(cmd.name).toBe('set');
    // The "who, not what" gate: only the user/UI may change identity.
    expect(cmd.allowed_invokers).toEqual(['user']);
    expect(app.id).toBe('agent_identity');
    expect(app.tree_namespace).toBe('/identity');
    expect(app.depends_on).toEqual([]);
  });

  it('requires the three identity keys in its state_schema (INV #14)', () => {
    const app = makeAgentIdentityApp(SAMPLE);
    expect(app.state_schema['required']).toEqual(['role', 'persona', 'instructions']);
  });

  it('owns exactly the block agent_identity:identity, stable + pinned (§6.1)', () => {
    const b = identityBuilder();
    expect(b.outputs).toEqual([BLOCK_IDENTITY]);
    expect(BLOCK_IDENTITY).toBe('agent_identity:identity');
    expect(b.cache_tier).toBe('stable');
    expect(b.cache_tier_pinned).toBe(true);
    expect(b.owner).toBe('system'); // INV #4: never 'agent'
    expect(b.app_id).toBe('agent_identity');
  });

  it('ships a non-agent builder owner (INV #4)', () => {
    // INV #4 (owner='agent' illegal) is enforced at the type level and at runtime
    // by AppRegistry; here we sanity-check the value we ship.
    expect(identityBuilder().owner).not.toBe('agent');
  });
});

// ===========================================================================
// Builder output (white-box)
// ===========================================================================

describe('IdentityBlockBuilder.build', () => {
  it('renders role / persona / instructions from state into the block', async () => {
    const block = await identityBuilder().build(stubBuildContext(), stubAppContext(SAMPLE));
    expect(block).not.toBeNull();
    expect(block!.name).toBe(BLOCK_IDENTITY);
    const text = block!.content_text!;
    expect(text).toContain(SAMPLE.role);
    expect(text).toContain(SAMPLE.persona);
    expect(text).toContain(SAMPLE.instructions);
    // Operating constraints are pinned for the agent to read every turn.
    expect(text).toContain('command');
    expect(text.toLowerCase()).toContain('thinking');
  });

  it('is deterministic: same state -> byte-identical block', async () => {
    const b = identityBuilder();
    const first = await b.build(stubBuildContext(), stubAppContext(SAMPLE));
    const second = await b.build(stubBuildContext(), stubAppContext(SAMPLE));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('reflects a different state (content tracks role/persona/instructions)', async () => {
    const other: IdentityState = { role: 'X', persona: 'Y', instructions: 'Z' };
    const a = await identityBuilder().build(stubBuildContext(), stubAppContext(SAMPLE));
    const b = await identityBuilder().build(stubBuildContext(), stubAppContext(other));
    expect(a!.content_text).not.toBe(b!.content_text);
    expect(b!.content_text).toContain('X');
  });

  it('renders nothing when no AppContext is wired (no state source)', async () => {
    expect(await identityBuilder().build(stubBuildContext(), undefined)).toBeNull();
  });

  it('uses no clock/random — content is independent of the BuildContext', async () => {
    const b = identityBuilder();
    const withStub = await b.build(stubBuildContext(), stubAppContext(SAMPLE));
    // A different (but still stub) BuildContext must not change the output.
    const ctx2 = { ...stubBuildContext(), deterministic_clock: () => 999 };
    const withOther = await b.build(ctx2, stubAppContext(SAMPLE));
    expect(withOther!.content_text).toBe(withStub!.content_text);
  });
});

// ===========================================================================
// End-to-end: install + render through the REAL AppRegistry + Renderer
// ===========================================================================

describe('agent_identity end-to-end (registry + renderer)', () => {
  function setup(state: IdentityState = SAMPLE) {
    const reg = new AppRegistry();
    reg.install(makeAgentIdentityApp(state));
    // Wire the App context into the Renderer exactly as impl-runtime does: the
    // builder reads its state via app_contexts.get('agent_identity').
    const app_contexts = new Map<string, AppContext>([
      ['agent_identity', stubAppContext(state)],
    ]);
    const renderer = new Renderer(reg, { app_contexts });
    // Seed the placeholder block so the Renderer collects the name and runs the
    // owner builder (the Renderer renders names already present in the tree).
    const root: Block = {
      id: 'root',
      name: 'root:root',
      children: [identityPlaceholder()],
      content_text: null,
      content_blob: null,
    };
    return { renderer, tree: new BlockTree(root) };
  }

  it('renders identity into the STABLE segment (cache prefix head)', async () => {
    const { renderer, tree } = setup();
    // The registry resolves the builder + tier for the identity block.
    const r = await renderer.render(tree.snapshot());
    expect(r.segments).toHaveLength(1);
    const seg = r.segments[0]!;
    expect(seg.tier).toBe('stable');
    expect(typeof seg.rendered).toBe('string');
    expect(seg.rendered as string).toContain(SAMPLE.role);
    expect(seg.rendered as string).toContain(SAMPLE.instructions);
  });

  it('resolves builder ownership + stable tier through the registry', () => {
    const reg = new AppRegistry();
    reg.install(makeAgentIdentityApp(SAMPLE));
    expect(reg.resolve_builder(BLOCK_IDENTITY)?.name).toBe('IdentityBlockBuilder');
    expect(reg.tier_of(BLOCK_IDENTITY)).toBe('stable');
  });

  it('is byte-identical across two renders of the same snapshot (INV #1)', async () => {
    const { renderer, tree } = setup();
    const snap = tree.snapshot();
    const a = await renderer.render(snap);
    const b = await renderer.render(snap);
    expect(b.snapshot_hash).toBe(a.snapshot_hash);
    expect(JSON.stringify(b.segments)).toBe(JSON.stringify(a.segments));
  });

  it('installs the App under its own id (agent_identity is not reserved)', () => {
    const reg = new AppRegistry();
    const res = reg.install(makeAgentIdentityApp(SAMPLE));
    expect(res.installed_id).toBe('agent_identity');
    expect(res.warnings).toEqual([]);
  });
});

// ===========================================================================
// agent_identity.set through the REAL Operations + PolicyEngine (the gate)
// ===========================================================================

describe('agent_identity.set (user-only invoker gate)', () => {
  const AGENT: InvokerContext = { invoker: 'agent', identity: 'main' };
  const USER: InvokerContext = { invoker: 'user', identity: 'human' };

  function wire() {
    const reg = new AppRegistry();
    reg.install(makeAgentIdentityApp(SAMPLE));
    const root: Block = {
      id: 'root', name: 'root:root', children: [], content_text: null, content_blob: null,
    };
    const tree = new BlockTree(root);
    const ops = Operations.with_default_policy({ tree, registry: reg });
    return { reg, ops };
  }

  it('DENIES the agent (anti-jailbreak: agent cannot rewrite its own identity)', async () => {
    const { reg, ops } = wire();
    const res = await ops.invoke_command('agent_identity.set', { role: 'PWNED' }, AGENT);
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ policy: 'deny' });
    expect(res.error).toMatch(/not permitted/);
    // State is untouched — the handler never ran.
    expect(reg.get('agent_identity')?.initial_state).toMatchObject({ role: SAMPLE.role });
  });

  it('ALLOWS the user and applies a partial update via set_state', async () => {
    const { ops } = wire();
    const res = await ops.invoke_command(
      'agent_identity.set',
      { role: 'a release manager' },
      USER,
    );
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ updated: ['role'] });
  });

  it('rejects an empty/invalid patch from the user (no valid field)', async () => {
    const { ops } = wire();
    const res = await ops.invoke_command('agent_identity.set', { nonsense: 1 }, USER);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no valid field/);
  });
});
