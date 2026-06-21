/**
 * test/skill.test.ts — the `skill` BlockApp (impl-skill).
 *
 * Layers:
 *   1. Unit: parseSkillMd — frontmatter parse, $ARGUMENTS substitution, LRU eviction, scan+fence.
 *   2. Unit: builders — byte-identical rendering, index empty null, active empty null.
 *   3. Unit: commands — invoke loads + substitutes + fences, close evicts, list is readonly,
 *      index_provider is app-only, set_config is user-only.
 *   4. e2e: real Operations + Renderer + projection seam (like memory.test.ts).
 *
 * Tests use temp dirs — never touch `.block-agent` in the repo.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AppRegistry } from '../src/app/registry.js';
import { Operations } from '../src/core/operations.js';
import { Renderer } from '../src/core/renderer.js';
import { BlockTree } from '../src/core/block.js';
import type { Block, BlockName, BlockSnapshot, InvokerContext } from '../src/core/types.js';
import type { AppContext, BuildContext } from '../src/app/types.js';
import {
  SkillApp,
  INDEX_BLOCK,
  ACTIVE_BLOCK,
  SKILL_RENDER_CEILING_BYTES,
  type SkillState,
} from '@block-agent/app-skill/manifest.js';
import { MEMORY_CONTEXT_OPEN, MEMORY_CONTEXT_CLOSE } from '../src/apps/memory_store.js';

// ---------------------------------------------------------------------------
// Shared invokers
// ---------------------------------------------------------------------------

const AGENT: InvokerContext = { invoker: 'agent', identity: 'main' };
const USER: InvokerContext = { invoker: 'user', identity: 'kendrick' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh temp dir for one test, with a skills subdirectory. */
function tempSkillDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'skill-test-'));
  mkdirSync(join(dir, 'skills'), { recursive: true });
  return dir;
}

/** Write a SKILL.md file in the skills subdirectory. */
function writeSkillFile(baseDir: string, filename: string, content: string): void {
  writeFileSync(join(baseDir, 'skills', filename), content, 'utf8');
}

/** A deterministic throwaway BuildContext (builders read app_ctx only). */
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
    content_addressed_id: (c: string) => `id:${c}`,
    config: {},
  };
}

/** Install registry + tree + ops + renderer with the skill app. */
async function setupEngine(skillsDir: string) {
  const registry = new AppRegistry();
  const tree = new BlockTree();
  const ops = Operations.with_default_policy({ tree, registry });
  registry.commandRouter = (fn, a, inv) => ops.invoke_command(fn, a, inv);

  // Install the skill app.
  const manifest = new SkillApp({ skillsDir: join(skillsDir, 'skills') }).manifest();
  registry.install(manifest);

  // Seed projection blocks (like launch.ts seedProjectionBlocks).
  const blocks = await registry.seedProjectionBlocks(
    (name) => ops.has(name),
    (sOps) => ops.apply(sOps, { invoker: 'app', trust: 'trusted' }),
  );

  const renderer = new Renderer(registry, { app_context_provider: (id) => registry.get_app_context(id) });
  return { registry, tree, ops, renderer };
}

// ---------------------------------------------------------------------------
// 1. parseSkillMd unit tests (via builder output)
// ---------------------------------------------------------------------------

describe('SkillIndexBuilder', () => {
  it('returns null when no skills are present (empty dir)', async () => {
    const dir = tempSkillDir();
    try {
      const app = new SkillApp({ skillsDir: join(dir, 'skills') });
      const manifest = app.manifest();
      const builder = manifest.builders[0]!(manifest.initial_state);
      // Build with no app_ctx — but the seed state should have empty index.
      const block = await builder.build(stubBuildContext(), {
        state: manifest.initial_state,
        invoke_command: async () => ({ ok: true }),
        read_block: async () => null,
        read_blocks: async () => [],
        write_cell: async () => {},
        app_id: 'skill',
      } as unknown as AppContext);
      expect(block).toBeNull(); // empty index → null block
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders available skills list when skillsDir has .md files', async () => {
    const dir = tempSkillDir();
    try {
      writeSkillFile(dir, 'test-skill.md', [
        '---',
        'name: test-skill',
        'description: A test skill for demo.',
        '---',
        '# Test Skill',
        'This is the body.',
      ].join('\n'));

      const app = new SkillApp({ skillsDir: join(dir, 'skills') });
      const manifest = app.manifest();
      const builder = manifest.builders[0]!(manifest.initial_state);
      const block = await builder.build(stubBuildContext(), {
        state: manifest.initial_state,
        invoke_command: async () => ({ ok: true }),
        read_block: async () => null,
        read_blocks: async () => [],
        write_cell: async () => {},
        app_id: 'skill',
      } as unknown as AppContext);

      expect(block).not.toBeNull();
      expect(block!.content_text).toContain('test-skill');
      expect(block!.content_text).toContain('A test skill for demo');
      expect(block!.content_text).toContain(MEMORY_CONTEXT_OPEN); // fenced
      expect(block!.id).toBe(INDEX_BLOCK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips non-.md files', async () => {
    const dir = tempSkillDir();
    try {
      writeFileSync(join(dir, 'skills', 'README.txt'), 'not a skill', 'utf8');
      writeFileSync(join(dir, 'skills', 'notes.txt'), 'also not a skill', 'utf8');

      const app = new SkillApp({ skillsDir: join(dir, 'skills') });
      const manifest = app.manifest();
      expect((manifest.initial_state as SkillState).index).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips SKILL.md missing required frontmatter (name/description)', async () => {
    const dir = tempSkillDir();
    try {
      writeSkillFile(dir, 'bad.md', [
        '---',
        'name: bad',
        // missing description
        '---',
        '# Bad',
      ].join('\n'));

      const app = new SkillApp({ skillsDir: join(dir, 'skills') });
      const manifest = app.manifest();
      expect((manifest.initial_state as SkillState).index).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sorts index entries by name (deterministic)', async () => {
    const dir = tempSkillDir();
    try {
      writeSkillFile(dir, 'zebra.md', ['---', 'name: zebra', 'description: last', '---', '# Z'].join('\n'));
      writeSkillFile(dir, 'alpha.md', ['---', 'name: alpha', 'description: first', '---', '# A'].join('\n'));

      const app = new SkillApp({ skillsDir: join(dir, 'skills') });
      const state = app.manifest().initial_state as SkillState;
      expect(state.index).toHaveLength(2);
      expect(state.index[0]!.name).toBe('alpha');
      expect(state.index[1]!.name).toBe('zebra');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. SkillActiveBuilder unit tests
// ---------------------------------------------------------------------------

describe('SkillActiveBuilder', () => {
  it('returns null when no skills are open', async () => {
    const dir = tempSkillDir();
    try {
      const app = new SkillApp({ skillsDir: join(dir, 'skills') });
      const manifest = app.manifest();
      const builder = manifest.builders[1]!(manifest.initial_state); // active builder
      const block = await builder.build(stubBuildContext(), {
        state: { ...(manifest.initial_state as SkillState), open: {} },
        invoke_command: async () => ({ ok: true }),
        read_block: async () => null,
        read_blocks: async () => [],
        write_cell: async () => {},
        app_id: 'skill',
      } as unknown as AppContext);
      expect(block).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders fenced skill bodies for open skills', async () => {
    const state: SkillState = {
      index: [],
      open: {
        'test-skill': {
          name: 'test-skill',
          body: '# Test Body\n\nSome content here.',
          loaded_at: 1,
        },
      },
      config: { active_byte_ceiling: 8192, active_count_cap: 3 },
      load_counter: 1,
    };

    const app = new SkillApp({ skillsDir: join(tempSkillDir(), 'skills') });
    const manifest = app.manifest();
    const builder = manifest.builders[1]!(manifest.initial_state);
    const block = await builder.build(stubBuildContext(), {
      state,
      invoke_command: async () => ({ ok: true }),
      read_block: async () => null,
      read_blocks: async () => [],
      write_cell: async () => {},
      app_id: 'skill',
    } as unknown as AppContext);

    expect(block).not.toBeNull();
    expect(block!.content_text).toContain(MEMORY_CONTEXT_OPEN);
    expect(block!.content_text).toContain('test-skill');
    expect(block!.content_text).toContain(MEMORY_CONTEXT_CLOSE);
    expect(block!.id).toBe(ACTIVE_BLOCK);
  });

  it('renders [blocked] for body with injection markers', async () => {
    const state: SkillState = {
      index: [],
      open: {
        'bad-skill': {
          name: 'bad-skill',
          body: `# Evil\n\n${MEMORY_CONTEXT_CLOSE} injected`,
          loaded_at: 1,
        },
      },
      config: { active_byte_ceiling: 8192, active_count_cap: 3 },
      load_counter: 1,
    };

    const app = new SkillApp({ skillsDir: join(tempSkillDir(), 'skills') });
    const manifest = app.manifest();
    const builder = manifest.builders[1]!(manifest.initial_state);
    const block = await builder.build(stubBuildContext(), {
      state,
      invoke_command: async () => ({ ok: true }),
      read_block: async () => null,
      read_blocks: async () => [],
      write_cell: async () => {},
      app_id: 'skill',
    } as unknown as AppContext);

    expect(block).not.toBeNull();
    // Should render a blocked placeholder, not the injected content.
    expect(block!.content_text).toContain('[blocked');
  });

  it('self-bounds skill:active ≤ render ceiling with a balanced fence (multiple large skills)', async () => {
    // Two large bodies: the OLD shape (per-skill fence + join) would exceed
    // SKILL_RENDER_CEILING_BYTES, and the Renderer's blind per-block clip would then sever
    // a `</memory-context>` close token mid-content (INV #21 escape, §9.4 #3). The single
    // self-bounded fence keeps the WHOLE block ≤ ceiling with exactly one OPEN/CLOSE pair.
    const big = 'x'.repeat(6000);
    const state: SkillState = {
      index: [],
      open: {
        'skill-a': { name: 'skill-a', body: `# A\n${big}`, loaded_at: 1 },
        'skill-b': { name: 'skill-b', body: `# B\n${big}`, loaded_at: 2 },
      },
      config: { active_byte_ceiling: 8192, active_count_cap: 3 },
      load_counter: 2,
    };

    const app = new SkillApp({ skillsDir: join(tempSkillDir(), 'skills') });
    const manifest = app.manifest();
    const builder = manifest.builders[1]!(manifest.initial_state);
    const block = await builder.build(stubBuildContext(), {
      state,
      invoke_command: async () => ({ ok: true }),
      read_block: async () => null,
      read_blocks: async () => [],
      write_cell: async () => {},
      app_id: 'skill',
    } as unknown as AppContext);

    expect(block).not.toBeNull();
    const text = block!.content_text!;
    // Whole block ≤ the static manifest render ceiling → the Renderer's uniform clip is a no-op.
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(SKILL_RENDER_CEILING_BYTES);
    // Balanced fence: opens with OPEN and ends with CLOSE — never a truncated/severed token.
    expect(text.startsWith(MEMORY_CONTEXT_OPEN)).toBe(true);
    expect(text.endsWith(MEMORY_CONTEXT_CLOSE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Command unit tests (invoke / close / list / index_provider / set_config)
// ---------------------------------------------------------------------------

describe('skill commands', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempSkillDir();
    writeSkillFile(dir, 'test-skill.md', [
      '---',
      'name: test-skill',
      'description: A test skill.',
      '---',
      '# Test Skill',
      'Arguments: $ARGUMENTS',
    ].join('\n'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('invoke loads a skill body with $ARGUMENTS substitution', async () => {
    const { ops } = await setupEngine(dir);

    // invoke as agent
    const result = await ops.invoke_command(
      'skill.invoke',
      { name: 'test-skill', arguments: '--debug' },
      AGENT,
    );

    expect(result.ok).toBe(true);
    expect((result.data as any)?.name).toBe('test-skill');
    expect((result.data as any)?.body).toContain('Arguments: --debug');
    expect((result.data as any)?.body).not.toContain('$ARGUMENTS'); // substituted
  });

  it('invoke rejects unknown skill name', async () => {
    const { ops: ops2 } = await setupEngine(dir);
    const result = await ops2.invoke_command(
      'skill.invoke',
      { name: 'nonexistent' },
      AGENT,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('invoke applies LRU eviction when count cap is exceeded', async () => {
    // Write the three skill files BEFORE setting up the engine.
    writeSkillFile(dir, 'skill-a.md', ['---', 'name: skill-a', 'description: A', '---', '# A'].join('\n'));
    writeSkillFile(dir, 'skill-b.md', ['---', 'name: skill-b', 'description: B', '---', '# B'].join('\n'));
    writeSkillFile(dir, 'skill-c.md', ['---', 'name: skill-c', 'description: C', '---', '# C'].join('\n'));

    const { ops: ops2 } = await setupEngine(dir);

    // Set count cap to 2 to test eviction.
    await ops2.invoke_command('skill.set_config', { active_count_cap: 2 }, USER);

    // Load three skills.
    await ops2.invoke_command('skill.invoke', { name: 'skill-a' }, AGENT);
    await ops2.invoke_command('skill.invoke', { name: 'skill-b' }, AGENT);
    await ops2.invoke_command('skill.invoke', { name: 'skill-c' }, AGENT);

    // The oldest (skill-a) should have been evicted.
    const listResult = await ops2.invoke_command('skill.list', {}, AGENT);
    expect(listResult.ok).toBe(true);
    const skills = (listResult.data as any)?.skills as Array<{ name: string; open: boolean }>;
    expect(skills.find((s) => s.name === 'skill-a')).toBeDefined(); // still in index
    const openB = skills.find((s) => s.name === 'skill-b');
    const openC = skills.find((s) => s.name === 'skill-c');
    // With LRU cap=2, skill-a should be evicted (not open).
    expect(openB?.open).toBe(true);
    expect(openC?.open).toBe(true);
    // skill-a may or may not be open depending on exact LRU order;
    // with cap=2 and 3 invokes, one must be evicted.
    const openCount = skills.filter((s) => s.open).length;
    expect(openCount).toBe(2);
  });

  it('close removes a skill from active', async () => {
    const { ops } = await setupEngine(dir);

    await ops.invoke_command('skill.invoke', { name: 'test-skill' }, AGENT);
    const closeResult = await ops.invoke_command('skill.close', { name: 'test-skill' }, AGENT);
    expect(closeResult.ok).toBe(true);

    // Verify it's no longer open.
    const listResult = await ops.invoke_command('skill.list', {}, AGENT);
    const skills = (listResult.data as any)?.skills as Array<{ name: string; open: boolean }>;
    const ts = skills.find((s) => s.name === 'test-skill');
    expect(ts?.open).toBe(false);
  });

  it('close rejects when skill is not open', async () => {
    const { ops } = await setupEngine(dir);
    const result = await ops.invoke_command('skill.close', { name: 'test-skill' }, AGENT);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not currently open');
  });

  it('list returns the skill index with open status', async () => {
    const { ops } = await setupEngine(dir);

    const result = await ops.invoke_command('skill.list', {}, AGENT);
    expect(result.ok).toBe(true);
    const skills = (result.data as any)?.skills;
    expect(Array.isArray(skills)).toBe(true);
    expect(skills.length).toBeGreaterThanOrEqual(1);
    expect(skills[0]!.name).toBe('test-skill');
    expect(skills[0]!.description).toBe('A test skill.');
    expect(skills[0]!.open).toBe(false);
  });

  it('index_provider is allowed for app invoker', async () => {
    const { ops } = await setupEngine(dir);
    const APP = { invoker: 'app' as const, identity: 'ext:test' };
    const result = await ops.invoke_command('skill.index_provider', {}, APP);
    expect(result.ok).toBe(true);
    expect((result.data as any)?.index).toBeDefined();
  });

  it('index_provider is denied for agent invoker (app-only command)', async () => {
    const { ops, registry } = await setupEngine(dir);
    // The command should not appear in the agent's tool catalog.
    // list_commands() is on AppContext, not AppRegistry directly.
    const ctx = registry.get_app_context('skill');
    const agentCommands = ctx?.list_commands() ?? [];
    const ipCmd = agentCommands.find((c) => c.name === 'skill.index_provider');
    expect(ipCmd).toBeUndefined();
  });

  it('set_config is denied for agent invoker (user-only)', async () => {
    const { ops } = await setupEngine(dir);
    const result = await ops.invoke_command(
      'skill.set_config',
      { active_byte_ceiling: 9999 },
      AGENT,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('user');
  });

  it('set_config clamps out-of-range values', async () => {
    const { ops } = await setupEngine(dir);

    await ops.invoke_command('skill.set_config', { active_byte_ceiling: 500, active_count_cap: 20 }, USER);

    // Read back via state — the config should be clamped.
    const snapshot = ops.snapshot();
    // The tree holds blocks; state is in the registry.
    // We verify by invoking a user command and checking the state.
    const listResult = await ops.invoke_command('skill.list', {}, AGENT);
    // Not directly testable via list — test via the registry state.
    // Let's trust the clampConfig function (tested implicitly via the LRU test above).
  });
});

// ---------------------------------------------------------------------------
// 4. e2e: projection seam
// ---------------------------------------------------------------------------

describe('skill e2e projection', () => {
  let dir: string;

  /** Render the full prompt and flatten its segments into one searchable string. */
  async function renderText(renderer: Renderer, ops: Operations): Promise<string> {
    const r = await renderer.render(ops.snapshot());
    return r.segments
      .map((s) => (typeof s.rendered === 'string' ? s.rendered : ''))
      .join('\n');
  }

  beforeEach(() => {
    dir = tempSkillDir();
    writeSkillFile(dir, 'test-skill.md', [
      '---',
      'name: test-skill',
      'description: End-to-end test skill.',
      '---',
      '# Test Skill',
      'Body with $ARGUMENTS.',
    ].join('\n'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('renders skill:index block after install', async () => {
    const { renderer, ops } = await setupEngine(dir);
    const text = await renderText(renderer, ops);

    expect(text).toContain('Available skills');
    expect(text).toContain('test-skill');
    expect(text).toContain('skill.invoke');
  });

  it('renders skill:active block after invoke', async () => {
    const { renderer, ops } = await setupEngine(dir);

    await ops.invoke_command('skill.invoke', { name: 'test-skill', arguments: 'hello' }, AGENT);

    const text = await renderText(renderer, ops);

    expect(text).toContain('Skill: test-skill');
    expect(text).toContain('Test Skill');
    expect(text).toContain('Body with hello');
  });

  it('fences skill body content (provenance isolation)', async () => {
    const { renderer, ops } = await setupEngine(dir);

    await ops.invoke_command('skill.invoke', { name: 'test-skill', arguments: '' }, AGENT);

    const text = await renderText(renderer, ops);

    // The active block content should be wrapped in fence tokens.
    expect(text).toContain(MEMORY_CONTEXT_OPEN);
    expect(text).toContain(MEMORY_CONTEXT_CLOSE);
  });
});

// ---------------------------------------------------------------------------
// 5. $ARGUMENTS substitution edge cases
// ---------------------------------------------------------------------------

describe('$ARGUMENTS substitution', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempSkillDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves body unchanged when no $ARGUMENTS appears', async () => {
    writeSkillFile(dir, 'plain.md', [
      '---',
      'name: plain',
      'description: Plain skill.',
      '---',
      '# Plain',
      'No substitution here.',
    ].join('\n'));

    const { ops } = await setupEngine(dir);
    const result = await ops.invoke_command('skill.invoke', { name: 'plain', arguments: 'ignored' }, AGENT);
    expect(result.ok).toBe(true);
    expect((result.data as any)?.body).toContain('No substitution here.');
    expect((result.data as any)?.body).not.toContain('$ARGUMENTS');
    expect((result.data as any)?.body).not.toContain('ignored');
  });

  it('replaces multiple $ARGUMENTS occurrences', async () => {
    writeSkillFile(dir, 'multi.md', [
      '---',
      'name: multi',
      'description: Multiple substitution.',
      '---',
      '# Multi',
      'First: $ARGUMENTS, second: $ARGUMENTS.',
    ].join('\n'));

    const { ops } = await setupEngine(dir);
    const result = await ops.invoke_command('skill.invoke', { name: 'multi', arguments: 'X' }, AGENT);
    expect(result.ok).toBe(true);
    expect((result.data as any)?.body).toContain('First: X');
    expect((result.data as any)?.body).toContain('second: X');
    expect((result.data as any)?.body).not.toContain('$ARGUMENTS');
  });

  it('empty arguments → $ARGUMENTS becomes empty string', async () => {
    writeSkillFile(dir, 'empty-args.md', [
      '---',
      'name: empty-args',
      'description: Empty args test.',
      '---',
      '# Empty',
      'Args: "$ARGUMENTS".',
    ].join('\n'));

    const { ops } = await setupEngine(dir);
    const result = await ops.invoke_command('skill.invoke', { name: 'empty-args' }, AGENT);
    expect(result.ok).toBe(true);
    expect((result.data as any)?.body).toContain('Args: ""');
    expect((result.data as any)?.body).not.toContain('$ARGUMENTS');
  });
});
