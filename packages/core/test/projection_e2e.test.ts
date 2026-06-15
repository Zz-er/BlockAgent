/**
 * test/projection_e2e.test.ts — live-AppContext projection seam (architect/integration).
 *
 * ACCEPTANCE HARD-GATE (lead 2026-05-26): state-driven render-builders
 * (`messages:recent` / `messages:summary` / `agent_identity:identity`)
 * project from `app_ctx.state`. The unit tests inject an AppContext directly, so they
 * pass even if the REAL loop can't supply one — the "green but the real loop is broken"
 * class we hit twice. This file proves the seam on the REAL Renderer + AppRegistry path:
 * the Renderer resolves each App's LIVE AppContext via `app_context_provider`
 * (→ `AppRegistry.get_app_context`), so a builder sees state AFTER a command mutated it.
 *
 * We drive real mutations (messages.ingest, agent_identity.set via Operations) and
 * then render through a Renderer wired exactly
 * as `index.ts` wires it — NO injected `app_contexts` Map. If the seam regresses, the
 * blocks render empty/stale and these assertions fail.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BlockTree } from '../src/core/block.js';
import { Operations } from '../src/core/operations.js';
import { Renderer } from '../src/core/renderer.js';
import { AppRegistry } from '../src/app/registry.js';
import { MessagesApp, RECENT_BLOCK as MSG_RECENT } from '@block-agent/app-messages/manifest.js';
import { BaseApp } from '@block-agent/app-base/manifest.js';
import {
  makeAgentIdentityApp,
  BLOCK_IDENTITY,
  type IdentityState,
} from '@block-agent/app-agent_identity/manifest.js';
import type { Block, BlockName, InvokerContext } from '../src/core/types.js';

const USER: InvokerContext = { invoker: 'user', identity: 'kendrick' };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blockagent-e2e-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A placeholder block so the Renderer collects the name and runs its owner builder. */
function placeholder(name: BlockName): Block {
  return { id: name, name, children: [], content_text: '', content_blob: null };
}

/** Render the full prompt and flatten its segments into one searchable string. */
async function renderText(renderer: Renderer, tree: BlockTree): Promise<string> {
  const r = await renderer.render(tree.snapshot());
  return r.segments.map((s) => (typeof s.rendered === 'string' ? s.rendered : '')).join('\n');
}

describe('live-AppContext projection seam (real Renderer + Registry path)', () => {
  it('messages:recent renders the ingested message BODY after a real ingest', async () => {
    const reg = new AppRegistry();
    const app = new MessagesApp({ dir: join(dir, 'messages') });
    reg.install(app.manifest());
    // Renderer wired EXACTLY like index.ts — no injected app_contexts Map.
    const renderer = new Renderer(reg, {
      app_context_provider: (id) => reg.get_app_context(id),
    });
    const tree = new BlockTree({
      id: 'root', name: 'root:root', content_blob: null, content_text: null,
      children: [placeholder(MSG_RECENT)],
    });

    // Mutate state through the real ingest front door.
    app.ingest({ id: 'm1', content: 'deploy the staging build please', from: 'kendrick' });

    const text = await renderText(renderer, tree);
    expect(text).toContain('deploy the staging build please');
  });

  it('a base tool command executes and returns its body in CommandResult.data', async () => {
    const reg = new AppRegistry();
    // The former `tools` app merged into `base` (display AND execution). The tool body
    // reaches the agent via CommandResult.data (which the base ledger records via
    // onCommand) under the `base.<tool>` names — there is no separate tools app/block.
    reg.install(new BaseApp(join(dir, 'base')).manifest());
    const ops = Operations.with_default_policy({ tree: new BlockTree(), registry: reg });

    // read THIS test file — a real, deterministic read.
    const path = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const res = await ops.invoke_command('base.read_file', { path, invocation_id: 't1' }, USER);
    expect(res.ok).toBe(true);
    const data = res.data as { tool?: string; result?: string };
    expect(data.tool).toBe('read_file');
    expect(data.result).toContain('live-AppContext projection seam'); // a line from THIS file
    // no tools app exists anymore — no tools:recent block.
    expect(reg.resolve_builder('tools:recent' as BlockName)).toBeNull();
  });

  it('agent_identity:identity reflects a new role after agent_identity.set (user)', async () => {
    const reg = new AppRegistry();
    const seed: IdentityState = {
      role: 'an initial role', persona: 'p', instructions: 'i',
    };
    reg.install(makeAgentIdentityApp(seed));
    const tree = new BlockTree({
      id: 'root', name: 'root:root', content_blob: null, content_text: null,
      children: [placeholder(BLOCK_IDENTITY)],
    });
    const ops = Operations.with_default_policy({ tree, registry: reg });
    const renderer = new Renderer(reg, {
      app_context_provider: (id) => reg.get_app_context(id),
    });

    // Before: the seeded role renders.
    expect(await renderText(renderer, tree)).toContain('an initial role');

    // Mutate via the user-only set command, through real Operations (PolicyEngine).
    const res = await ops.invoke_command(
      'agent_identity.set', { role: 'a release manager' }, USER,
    );
    expect(res.ok).toBe(true);

    // After: the SAME live context now renders the new role (seam picks up set_state).
    const text = await renderText(renderer, tree);
    expect(text).toContain('a release manager');
    expect(text).not.toContain('an initial role');
  });

  it('without the seam the projection is empty (guards against silent regression)', async () => {
    // Same setup but NO app_context_provider and NO app_contexts → builder gets
    // app_ctx undefined → messages:recent renders its empty projection, never the body.
    const reg = new AppRegistry();
    const app = new MessagesApp({ dir: join(dir, 'messages2') });
    reg.install(app.manifest());
    const renderer = new Renderer(reg); // <- seam intentionally NOT wired
    const tree = new BlockTree({
      id: 'root', name: 'root:root', content_blob: null, content_text: null,
      children: [placeholder(MSG_RECENT)],
    });
    app.ingest({ id: 'm1', content: 'this body must NOT appear without the seam', from: 'k' });

    const text = await renderText(renderer, tree);
    expect(text).not.toContain('this body must NOT appear without the seam');
  });
});

// ----------------------------------------------------------------------------
// Projection-block seeding (namespace-root seeding) — the boot seeds builder
// outputs into the empty tree so the agent's FIRST prompt is non-empty.
// HARD GATE (lead 2026-05-27): empty-tree boot must render agent_identity:identity
// from turn 1; after an ingest, messages:recent must carry the body.
// ----------------------------------------------------------------------------

describe('AppRegistry.seedProjectionBlocks (empty-tree boot is non-empty)', () => {
  /** Wire an empty-tree boot exactly like the CLI launcher (core:root, all 3 apps). */
  function bootEmpty(): { reg: AppRegistry; ops: Operations; renderer: Renderer; tree: BlockTree; msgs: MessagesApp } {
    const reg = new AppRegistry();
    reg.install(makeAgentIdentityApp({ role: 'a release manager', persona: 'terse', instructions: 'ship safely' }));
    const msgs = new MessagesApp({ dir: join(dir, 'messages-seed') });
    reg.install(msgs.manifest());
    const tree = new BlockTree(); // empty-tree boot → synthetic core:root, no children
    const ops = Operations.with_default_policy({ tree, registry: reg });
    reg.commandRouter = (fn, a, inv) => ops.invoke_command(fn, a, inv);
    const renderer = new Renderer(reg, { app_context_provider: (id) => reg.get_app_context(id) });
    return { reg, ops, renderer, tree, msgs };
  }

  it('before seeding, the empty-tree boot renders 0 segments (the gap this fixes)', async () => {
    const { renderer, tree } = bootEmpty();
    const r = await renderer.render(tree.snapshot());
    expect(r.segments).toHaveLength(0); // nothing in the tree → nothing renders
  });

  it('after seeding, the projection nodes exist and identity renders from turn 1', async () => {
    const { reg, ops, renderer, tree } = bootEmpty();
    const seeded = await reg.seedProjectionBlocks(
      (name) => ops.has(name),
      (sOps) => ops.apply(sOps, { invoker: 'app', trust: 'trusted' }),
    );
    // The apps' declared builder outputs are now live nodes in the tree. tools is
    // display-free now (no builder), so it seeds no block.
    expect(seeded).toContain(BLOCK_IDENTITY);
    expect(seeded).toContain(MSG_RECENT);
    expect(seeded).not.toContain('tools:recent');
    expect(ops.has(BLOCK_IDENTITY)).toBe(true);
    expect(ops.has(MSG_RECENT)).toBe(true);
    expect(ops.has('tools:recent' as BlockName)).toBe(false);

    // The first prompt is now non-empty and carries the agent's identity.
    const text = await renderText(renderer, tree);
    expect(text).toContain('Agent identity');
    expect(text).toContain('a release manager');
  });

  it('after seeding, a real ingest body renders in messages:recent', async () => {
    const { reg, ops, renderer, tree, msgs } = bootEmpty();
    await reg.seedProjectionBlocks(
      (name) => ops.has(name),
      (sOps) => ops.apply(sOps, { invoker: 'app', trust: 'trusted' }),
    );
    await ops.invoke_command('messages.ingest', { content: 'please cut the release' }, USER);
    const text = await renderText(renderer, tree);
    expect(text).toContain('please cut the release');
    expect(text).toContain('a release manager'); // identity still present
  });

  it('seeding is idempotent: a name already in the tree is skipped', async () => {
    const { reg, ops } = bootEmpty();
    const first = await reg.seedProjectionBlocks(
      (name) => ops.has(name),
      (sOps) => ops.apply(sOps, { invoker: 'app', trust: 'trusted' }),
    );
    expect(first.length).toBeGreaterThan(0);
    const second = await reg.seedProjectionBlocks(
      (name) => ops.has(name),
      (sOps) => ops.apply(sOps, { invoker: 'app', trust: 'trusted' }),
    );
    expect(second).toHaveLength(0); // everything already present → nothing re-seeded
  });
});
